import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, Injectable } from '@nestjs/common';

import { AgentsService } from './agents.service';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import { dashboardSessionRow } from './dashboard-sessions.util';
import { JIRA_LIVE_GRACE_MS } from './jira-live.service';
import { RECLAIMABLE_ID, fileKey, parseFileKey, parseResolveBody, prResolveHome, readLock, readOutcome, resolveTrigger } from './pr-resolve.util';
import { PullRequestsService } from '../tracker/pulls.service';
import { projectDispatchGate } from '../../../shared/agent';
import type { PrResolveOutcome, PrResolvePayload, PrResolveState } from '../../../shared/types';

/** A lock with no session id (an unset-env resolve) cannot be asked about, so it is judged by age alone — the tool's own `--lock-ttl` default. */
const NULL_LOCK_TTL_MS = 3 * 60 * 60 * 1000;

/** One resolve this server started: `sessionId` is `null` from the reservation until the spawn answers. */
interface Entry {
  startedAt: number;
  sessionId: string | null;
}

const refuse = (error: string, status: number): never => {
  throw new HttpException({ error }, status);
};

/**
 * The board's Resolve conflicts action (spec 2026-11-17-pr-conflict-resolve-design.md): `dispatch` is `POST /api/agents/dispatch-pr-resolve`, `list` is
 * `GET /api/agents/pr-resolve`.
 *
 * The live map is memory only and lost on restart on purpose, like `StartingRunsService` and the Jira live map: a restart has no spawn in flight to cover, and
 * the skill's own lock plus its outcome file are what survive one. It lives here and not in `TrackerModule` because `GET /api/prs` cannot read it without a
 * cycle — `AgentsModule` already imports `TrackerModule` and never the other way.
 *
 * Nothing here writes a file: the outcome file and the lock are the skill's tool's (its one writer), read per call, and the trigger the session is handed is
 * composed from the fresh PR read and the lock — never from the request body, which carries a repo and a number and nothing else.
 */
@Injectable()
export class PrResolveService {
  constructor(
    private readonly agents: AgentsService,
    private readonly pulls: PullRequestsService
  ) {}

  /** `<repo>#<number>` → the entry. Only `dispatch` adds and only a judged-dead or failed one is removed. */
  private readonly live = new Map<string, Entry>();

  /**
   * The ladder, in the spec's order; every refusal is an `HttpException({ error }, status)`. Rungs 1–5 reserve nothing. Rung 6 is the only synchronous
   * check-and-set in the method — no `await` between reading the map and writing the entry — so of two clicks that both cleared rung 5, one passes. Every
   * refusal after it, and a failed spawn, drops the reservation first.
   */
  async dispatch(body: unknown): Promise<{ sessionId: string }> {
    const req = parseResolveBody(body);
    if (req === null) return refuse('body must be { repo: "owner/name", number }', 400);
    const { repo, number } = req;

    // 2 and 3: the repo's FIRST registered project (registry order, the path the PR writes resolve to), then sync off.
    const project = this.pulls.projectFor(repo);
    if (!project.ok) return refuse(project.error, project.status);

    // 4: the environment and the project's visibility to the dashboard — `projectDispatchGate`'s own sentence, never a hand copy of its ladder. 502 only when
    // dispatch is on and the dashboard is unreachable (`JiraDispatchService`'s convention), every other block is a state the reader can fix and so a 409.
    const status = await this.agents.status();
    const gate = projectDispatchGate(status, project.path);
    if (gate.control !== 'enabled') return refuse(gate.reason, status.enabled && !status.reachable ? 502 : 409);

    // 5: one fresh PR read.
    const read = await this.pulls.readOne(repo, number);
    if (!read.ok) return refuse(read.error, read.status);
    const label = `${repo}#${number}`;
    if (read.pr === null || read.pr.state !== 'OPEN') return refuse(`${label} is not open`, 409);
    if (read.pr.row.crossRepository) return refuse(`${label} is from a fork — the session cannot push to it`, 409);
    if (read.pr.row.mergeable === 'unknown') return refuse('GitHub is still computing mergeability — try again in a moment', 409);
    if (read.pr.row.mergeable === 'mergeable') return refuse(`${label} has no conflicts`, 409);

    const running = `a resolve of ${label} is already running`;
    const cfg = readAgentsConfig();
    // An entry that outlived its session would otherwise refuse every click until a GET happened to sweep it. Judged HERE, before the reservation, because the
    // judgement may ask the dashboard and rung 6 must not await.
    const old = this.live.get(label);
    if (old !== undefined && !(await this.isLive(old, repo, number, Date.now(), cfg)) && this.live.get(label) === old) this.live.delete(label);

    // 6: reserve — synchronous from here to the `set`.
    if (this.live.has(label)) return refuse(running, 409);
    const entry: Entry = { startedAt: Date.now(), sessionId: null };
    this.live.set(label, entry);
    try {
      const trigger = await this.triggerFor(repo, number, cfg, running);
      const started = await this.agents.spawnInProject(project.path, {
        prompt: trigger,
        name: `pr-resolve ${label}`,
        permissionMode: 'auto',
        maxPermission: status.spawnMaxPermission,
        remoteControl: false
      });
      entry.sessionId = started.sessionId;
      return { sessionId: started.sessionId };
    } catch (e) {
      if (this.live.get(label) === entry) this.live.delete(label);
      throw e;
    }
  }

  /**
   * Rung 7 — the PR's leftover lock, read and never written. None: the plain trigger. A lock the tool would still honour is the 409; a dead owner's lock is
   * reclaimed by naming its session in the trigger, so the new session clears the leftover trees at once instead of waiting out the 3 hours. A lock whose
   * liveness cannot be established — the dashboard throws — is the 409 too, never a reclaim; an id a prompt may not carry is the null-id rule.
   */
  private async triggerFor(repo: string, number: number, cfg: AgentsConfig, running: string): Promise<string> {
    const lock = readLock(join(prResolveHome(), 'locks', `${fileKey(repo, number)}.lock`));
    if (lock === null) return resolveTrigger(repo, number, null);
    const age = Date.now() - lock.at;
    // An id a prompt may not carry is treated as no id at all: nothing can be reclaimed by name, so the lock is honoured for the same 3 hours the tool honours
    // it and then ignored, rather than refusing forever on a file only the tool's own TTL would ever clear.
    if (lock.sessionId === null || !RECLAIMABLE_ID.test(lock.sessionId))
      return age < NULL_LOCK_TTL_MS ? refuse(running, 409) : resolveTrigger(repo, number, null);
    if (age < JIRA_LIVE_GRACE_MS) return refuse(running, 409);
    let row: Awaited<ReturnType<typeof dashboardSessionRow>>;
    try {
      row = await dashboardSessionRow(cfg, lock.sessionId);
    } catch {
      return refuse(running, 409);
    }
    return row?.processLive === true ? refuse(running, 409) : resolveTrigger(repo, number, lock.sessionId);
  }

  /**
   * The spec's live rule. An entry is dropped when an outcome file carries ITS session id (a `null` id never matches, so a terminal run's outcome cannot kill a
   * reservation still spawning), and is live while younger than the grace (a just-spawned session has no dashboard row yet) or still spawning past it. After
   * that the dashboard is asked about the one session — never its list, whose cap would read a truncated answer as "gone" — and unknown (a throw) is live, so a
   * second click cannot slip through an outage.
   */
  private async isLive(entry: Entry, repo: string, number: number, now: number, cfg: AgentsConfig): Promise<boolean> {
    const outcome = readOutcome(join(prResolveHome(), `${fileKey(repo, number)}.json`));
    if (entry.sessionId !== null && outcome?.sessionId === entry.sessionId) return false;
    if (now - entry.startedAt < JIRA_LIVE_GRACE_MS) return true;
    if (entry.sessionId === null) return true;
    try {
      const row = await dashboardSessionRow(cfg, entry.sessionId);
      return row !== null && row.processLive === true;
    } catch {
      return true;
    }
  }

  /**
   * Every outcome file under the home plus every live entry, one state per PR. The home is scanned per call (a missing directory is no outcomes), a file that
   * is not a key or does not parse is skipped, and the dashboard lookups for all the live entries run in one `Promise.all` so the route answers within one
   * lookup's budget however many there are. An entry judged dead is deleted — but only if it is still the map's, since a dispatch may have replaced it
   * while the lookup was out.
   */
  async list(now: number = Date.now()): Promise<PrResolvePayload> {
    const home = prResolveHome();
    const states = new Map<string, PrResolveState>();
    let names: string[] = [];
    try {
      names = readdirSync(home);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const target = parseFileKey(name.slice(0, -'.json'.length));
      if (target === null) continue;
      const outcome: PrResolveOutcome | null = readOutcome(join(home, name));
      if (outcome === null) continue;
      states.set(`${target.repo}#${target.number}`, { ...target, live: null, outcome });
    }

    const cfg = readAgentsConfig();
    const entries = [...this.live];
    const verdicts = await Promise.all(
      entries.map(([label, entry]) => {
        const hash = label.lastIndexOf('#');
        return this.isLive(entry, label.slice(0, hash), Number(label.slice(hash + 1)), now, cfg);
      })
    );
    entries.forEach(([label, entry], i) => {
      if (!verdicts[i]) {
        if (this.live.get(label) === entry) this.live.delete(label);
        return;
      }
      const hash = label.lastIndexOf('#');
      const existing = states.get(label);
      const live = { sessionId: entry.sessionId };
      if (existing !== undefined) existing.live = live;
      else states.set(label, { repo: label.slice(0, hash), number: Number(label.slice(hash + 1)), live, outcome: null });
    });
    return { resolves: [...states.values()].sort((a, b) => (a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1)) };
  }
}
