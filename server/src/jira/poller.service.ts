import { homedir } from 'node:os';

import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import {
  SYNC_INTERVALS,
  isJiraKey,
  type JiraAccess,
  type JiraBoard,
  type JiraBoardFailure,
  type JiraIssue,
  type JiraIssueDetail,
  type JiraStatusPayload,
  type JiraTransition
} from '../../../shared/types';
import { adfToMarkdown } from './adf';
import { readJiraConfig, type JiraConfig } from './config.util';
import { jiraEnv } from './env.util';
import { JIRA_RATE_LIMIT_DEFAULT_MS, accessOf } from './errors.util';
import { JiraBootState } from './identity';
import { JiraClient, jqlString, type JiraAuth, type JiraResponse } from './jira.client';
import { JIRA_ISSUE_FIELDS, categoryOf, mapJiraIssue, pickSprintField, type MapContext } from './map-issue';

/**
 * poller.service.ts — the Jira ticker, the per-board caches, and the handful of fresh reads the routes make (Jira phase 1; spec §3 `poller.service.ts` and
 * `identity.ts`, §5's read routes, §8's error mapping). The shape is `tracker/poller.service.ts`'s, deliberately: one `setTimeout` chain whose next link is
 * made only after the current sweep's awaits finish, an in-flight promise that `tick()` hands back instead of starting a second sweep, `unref` on the timer,
 * and `stopped` on shutdown. Every route answers from the cache this file fills, or from ONE fresh read this file performs — nothing else in the server
 * talks to Jira, so the 429 window and the 401 reset below have one place to be true.
 *
 * ## The arming rule — three clauses (§3)
 *
 * The chain runs while the site is configured (all three env vars) AND any of:
 * 1. some board's interval is not `off` — it will be due again;
 * 2. some board is still owed its cold sweep — an `off` board that has never had its list replaced;
 * 3. the boot is unanswered — `cloudId`, `serverInfo`, `me` or the sprint field is still missing, so the back-off has a retry to make.
 * Clause 3 has one exception (P5): `unsupported` is a site that is not Jira Cloud, which no retry can change, so it disarms and stays disarmed until restart.
 * The rule is judged at the END of every sweep, after its awaits, against `jira.json` READ AGAIN there — the tracker poller's reasoning: `arm()` returns
 * early while a sweep is in flight, trusting that sweep to schedule its successor, so a board saved (and `arm()`ed) mid-sweep is seen only if the sweep's
 * last look at the file comes after it. Due-ness, by contrast, is judged on the file as read at the top of the sweep: a board added mid-tick is swept from
 * the next tick, never half-way through this one. A chain with nothing owed stops on the tick that finds it.
 *
 * ## Why `off` still gets one cold sweep
 *
 * `off` means "do not poll", not "show nothing": a board whose list was never fetched would render empty, which reads as "nothing on this board" — a lie.
 * One sweep per process gives it a real list with an honest `polledAt` age beside it. A cold sweep that failed whole-board (Jira unreachable) has not
 * replaced anything, so the board is still owed and the chain stays armed for it; one that got far enough to replace the list has succeeded, per-entry
 * `failures` included, because those are part of the answer, not a reason to ask again.
 *
 * ## Why the Done window applies at map time
 *
 * `mapJiraIssue` drops a `done` issue older than the window as it is mapped (that is `map-issue.ts`'s rule and its constant). The poller hands it `now`
 * for the sweep and `null` for every fresh read: the board is "what is live", so an expired child must never reach the cache, the payload or the client —
 * but the modal and the roots picker ask about a SPECIFIC issue and must get it however old it is. Dropping at map time also means the walk still sees the
 * dropped key: the next `parent in` round names every key Jira returned, mapped or not, so a closed story's open subtask stays on the board.
 *
 * ## Why a sweep failure keeps the last good list
 *
 * A whole-board failure (transport, a 5xx, a 401, a 429) says nothing about the issues — only that this sweep could not see them. Replacing the cache with
 * an empty list would make every card vanish for the length of an outage and flash back afterwards; keeping the list, with its `polledAt` unmoved, lets the
 * board say what it last knew and how old that is, while `access` and `detail` say why it is not newer. Such a failure also ends the sweep for that tick: the
 * next board would meet the same outage, and each extra call against a failing site is one more against its rate limit. A per-entry failure (a 400, 403 or
 * 404 on one root or one query) is different — Jira answered, and the answer is about that entry — so it becomes a `failures` row and the rest proceeds.
 *
 * ## Why the 429 window refuses reads up front
 *
 * After a 429, every call made before `Retry-After` runs out is a call Jira has already said it will refuse, and making it is how a client earns a longer
 * window. So the window is stored once (`JiraBootState.retryAt`, from whichever caller met the 429 — a sweep or a route) and every caller checks it before
 * sending: the sweep makes NO call inside it, and a route's read is refused with a synthesised 429 carrying the STORED instant (P1), so two reads a second
 * apart answer the same `retryAt` rather than one that slides forward with the clock.
 *
 * Checking before sending is not enough on its own, because calls already in flight when the window opens still land inside it. So `openWindow` is the one
 * home of the rule that the stored end never moves while it is in force: a second 429 inside it (two route reads that passed the gate together, a boot call
 * that was already out) restamps `last429At` and nothing else; a synthesised refusal (`synthetic`, remembered in `SYNTHETIC`) opens nothing at all, because
 * Jira never sent it; the boot asks nothing more once a window is in force, and a boot or sweep 5xx or transport failure that lands inside one does not
 * overwrite `rate-limited` — a sweep 401 still records `unauthorized`, because a 401 is evidence about the credentials, not the window. When the window ends,
 * the verdict it covered comes back (`beforeWindow`) unless the boot has since answered in full — a 401 that was in force when the 429 arrived is still the
 * truth about the credentials, and `ok` would hide it.
 *
 * Every instant here — `polledAt`, `last429At`, the window, the back-off — comes from `Date.now()`, never `new Date()`, so a suite that mocks `Date.now`
 * controls the only clock this file reads.
 *
 * ## Why a saved board is swept at once, and waited for (phase 2, R2)
 *
 * A board save lands in `jira.json`; the client reloads the board and `GET /api/jira` on the route's answer. If the route answered first, the client would read
 * the pre-save list with nothing on its own clock to ask again for up to a whole interval (or ever, for `off`). So `boardSaved(id)` sweeps that board now and
 * resolves when the sweep is done — raced against `JIRA_SAVE_SWEEP_WAIT_MS`, so a slow Jira holds the sheet for a bounded time and no longer: past the cap the
 * save has still landed and the sweep still runs to its end, and the next status poll catches the list up. It never rejects.
 *
 * "Now" is `forced`, a map from board id to the generation of the save that asked — NOT a reset of the cache's `polledAt`, which would empty the board's last
 * good list (`coldOwed` reads it, and an edit that fails to sweep must keep showing what the board last knew). `due()` honours it and `owed()` counts it. A
 * sweep spends the force only when it SUCCEEDS on the board, so every way of not getting an answer — the boot unanswered, a 429 window caught at the top of
 * the loop or opened mid-board, a 401, a 5xx, a transport error — leaves the board forced, owed, and retried on the next tick until Jira answers; for an `off`
 * board that is the only thing that would ever replace the list swept from the pre-edit definition.
 *
 * A sweep already in flight is not the answer: it read `jira.json` at its top, before the save. Each sweep notes the generation it read the file under, and
 * spends only a force no newer than that — so a sweep that reaches the board after the save, but on the older copy of it, answers nothing and spends nothing.
 * `boardSaved` waits the in-flight sweep out and then runs one that STARTED after the call.
 */

/** The base tick, the GitHub poller's. Every `SyncInterval` is a whole number of these, so the tick is the resolution and no board needs its own timer. */
export const JIRA_POLL_MS = 15_000;
/** The longest a board save waits for its own sweep (R2); past it the route answers and the sweep finishes on its own. */
export const JIRA_SAVE_SWEEP_WAIT_MS = 20_000;
/** Issues kept per saved query. Silent: spec §3 ties `truncated` to the board cap alone, and the band's copy says `first 500 shown`. */
export const JIRA_QUERY_CAP = 200;
/** Issues kept per root walk, the root itself counting as the first. Silent, for the same reason. */
export const JIRA_ROOT_CAP = 200;
/** Issues kept per board, after dedupe; the one cap `truncated` reports. */
export const JIRA_BOARD_CAP = 500;
/** `parent in` rounds below a root: epic → story → subtask. An initiative-level root reaches its epics and stories, not their subtasks (§3). */
export const JIRA_DESCENDANT_ROUNDS = 2;
/** The roots picker's result count. */
export const JIRA_SEARCH_LIMIT = 20;
/** The longest `q` the search route accepts; the route enforces it, this is its one home. */
export const JIRA_SEARCH_MAX_CHARS = 100;
/** `maxResults` on every sweep search page — Jira Cloud's ceiling for the enhanced search with this many fields. */
export const JIRA_PAGE_SIZE = 100;

const UNSUPPORTED = 'Jira Server/DC is not supported';

/** One board's last good sweep. Replaced whole, or not at all. */
export interface JiraBoardCache {
  issues: JiraIssue[];
  polledAt: string | null;
  truncated: boolean;
  failures: JiraBoardFailure[];
}

/**
 * A fresh read's outcome. `retryAt` rides only on a 429 (fresh or refused inside the window) and is the stored window end, verbatim (P1). `access` rides
 * only where the response's status would say the wrong thing — an `unsupported` site refused up front is a synthesised `0`, which `accessOf` reads as
 * `unreachable`, while `GET /api/jira` says `unsupported`.
 */
export type JiraResult<T> = { ok: true; value: T } | { ok: false; response: JiraResponse<unknown>; retryAt?: string; access?: JiraAccess };

/** A failed fresh read, as the routes receive it. */
type JiraRefusal = { ok: false; response: JiraResponse<unknown>; retryAt?: string; access?: JiraAccess };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const iso = (ms: number): string => new Date(ms).toISOString();
const ok = (res: JiraResponse<unknown>): boolean => res.status >= 200 && res.status < 300;

/** A response that says the SITE could not be read (as opposed to one entry): transport, a 5xx, a 401, a 429. Those end the sweep. */
const wholeBoard = (res: JiraResponse<unknown>): boolean => res.status === 0 || res.status === 401 || res.status === 429 || res.status >= 500;

/**
 * The `detail` a failure records: the transport error's own text for `0`; `Jira answered <status>` for a 5xx or a status `accessOf` has no opinion on (a
 * 5xx body is a gateway page, not a sentence); Jira's own sentence otherwise.
 */
function detailOf(res: JiraResponse<unknown>): string {
  if (res.status === 0) return res.message ?? 'Jira unreachable';
  if (res.status >= 500 || accessOf(res) === null) return `Jira answered ${res.status}`;
  return res.message ?? `Jira answered ${res.status}`;
}

/** A `failures` row's message: Jira's own sentence about that root or query — the reason a person can act on — never a bare status when Jira sent one. */
function entryMessage(res: JiraResponse<unknown>): string {
  return res.message ?? `Jira answered ${res.status}`;
}

/**
 * Every response this file made up rather than received. Held by identity, not by a field on the response, so `JiraResponse` stays the client's shape and a
 * synthesised 429 can never be told apart from Jira's by anything but this set — which `openWindow` consults, so only Jira can open a window (header).
 */
const SYNTHETIC = new WeakSet<JiraResponse<unknown>>();

/** A synthesised response, for an answer this file gives without asking Jira (P3, the 429 window). */
function synthetic(status: number, message: string | null): JiraResponse<unknown> {
  const res: JiraResponse<unknown> = { status, data: null, message, retryAfter: null };
  SYNTHETIC.add(res);
  return res;
}

interface Pages {
  /** Every key Jira returned, mapped or dropped by the Done window — what the next `parent in` round names. */
  raw: string[];
  issues: JiraIssue[];
  failure: JiraResponse<unknown> | null;
}

@Injectable()
export class JiraPollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private readonly boot = new JiraBootState();
  private readonly caches = new Map<string, JiraBoardCache>();
  /**
   * Boards a save asked to have swept now (header), each with the generation (`forceSeq`) of the save that asked. `due()` honours it, `owed()` counts it,
   * and a sweep spends it only when it SUCCEEDS on the board and read `jira.json` after that save (`run()`).
   */
  private readonly forced = new Map<string, number>();
  /** Bumped by every `boardSaved`; a sweep remembers the value it read the file under, so it can tell a save it saw from one that landed after. */
  private forceSeq = 0;
  /** The calls the last sweep made, for the chip's CALLS meter (§6). */
  private sweepCalls = 0;
  private last429At: string | null = null;
  /** The verdict a 429 window covered, restored when the window ends with the boot still unanswered (header). `null` while no window is open. */
  private beforeWindow: { access: JiraAccess; detail: string | null } | null = null;

  constructor(private readonly client: JiraClient) {}

  /** A tick is scheduled. Derived from the timer, for the reason the tracker poller gives: two sources of truth for "is a tick coming" drift apart. */
  get armed(): boolean {
    return this.timer !== null;
  }

  onApplicationBootstrap(): void {
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Start the chain if anything is owed, or confirm it is running. Idempotent — phase 2's board saves call it after they write. */
  arm(): void {
    if (this.stopped) return;
    if (!jiraEnv().configured || !this.owed(readJiraConfig())) {
      this.clearTimer();
      return;
    }
    // A pending timer OR a tick mid-flight both mean the chain is alive: a tick clears its own timer on entry, so checking the timer alone would let a
    // concurrent `arm()` start a second chain in that window.
    if (this.timer !== null || this.inFlight !== null) return;
    void this.tick();
  }

  /** Drops the pending link. Not a hard stop: a sweep in flight still schedules its successor when it ends — `onApplicationShutdown` is the hard stop. */
  disarm(): void {
    this.clearTimer();
  }

  /** One sweep, or the one already running — a caller awaiting `tick()` is asking "has a sweep including right now finished". */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.sweep().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  /**
   * A board was saved: sweep it now and resolve when a sweep that includes it has finished, or after `JIRA_SAVE_SWEEP_WAIT_MS`, whichever is first. Never
   * rejects — a save has already landed by the time this is called, and a failing Jira is the board's `access`, not the route's error. Where the sweep cannot
   * run (boot unanswered, a 429 window, `unsupported`) it returns early, as `run()` does, and this resolves with the board still owed.
   */
  async boardSaved(id: string): Promise<void> {
    if (this.stopped) return;
    this.forced.set(id, ++this.forceSeq);
    const swept = (async (): Promise<void> => {
      // The in-flight sweep read the file before the save, so it cannot spend this force (its generation is older); the sweep after it can.
      if (this.inFlight !== null) await this.inFlight.catch(() => undefined);
      // `tick()` is `sweep()`, which clears the pending link on entry — the one place that is done.
      await this.tick();
    })().catch(() => undefined);

    let cap: NodeJS.Timeout | undefined;
    const capped = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, JIRA_SAVE_SWEEP_WAIT_MS);
      cap.unref?.();
    });
    try {
      await Promise.race([swept, capped]);
    } finally {
      clearTimeout(cap);
    }
  }

  /** A board was deleted: its cache goes now, not at the next sweep's hygiene pass — a board re-created under the same id must start cold. */
  boardDeleted(id: string): void {
    this.caches.delete(id);
    this.forced.delete(id);
  }

  /** `GET /api/jira`. No outbound call: everything here is memory, the env and `jira.json`. The credentials never appear (§10). */
  status(): JiraStatusPayload {
    const env = jiraEnv();
    if (!env.configured) {
      return {
        configured: false,
        configUnreadable: null,
        site: null,
        me: null,
        tokenKind: null,
        access: 'unconfigured',
        detail: env.detail,
        boards: [],
        repos: {},
        projects: [],
        skills: [],
        calls: { sweep: 0, last429At: null },
        live: {},
        armed: false,
        home: null
      };
    }
    this.expireWindow(Date.now());
    const config = readJiraConfig();
    const boards = config.boards.map((board) => {
      const cache = this.caches.get(board.id);
      return {
        ...board,
        polledAt: cache?.polledAt ?? null,
        count: cache?.issues.length ?? 0,
        truncated: cache?.truncated ?? false,
        failures: cache?.failures ?? []
      };
    });
    return {
      configured: true,
      configUnreadable: config.unreadable,
      site: env.site,
      // Shown only once the boot is whole: an identity beside a board that cannot be swept yet (the sprint field still missing) would read as a working
      // connection. The boot state keeps the answer, so the retry asks only what is still missing.
      me: this.boot.answered() ? this.boot.me : null,
      tokenKind: this.boot.tokenKind,
      access: this.boot.access,
      detail: this.boot.detail,
      boards,
      repos: config.repos,
      projects: this.projectsOf(config),
      skills: config.skills,
      calls: { sweep: this.sweepCalls, last429At: this.last429At },
      live: {},
      armed: this.armed,
      home: homedir()
    };
  }

  /** A board's cached list: `null` for a board `jira.json` does not hold, an empty list with `polledAt: null` for one not swept yet. */
  boardIssues(id: string): { issues: JiraIssue[]; polledAt: string | null } | null {
    if (!readJiraConfig().boards.some((b) => b.id === id)) return null;
    const cache = this.caches.get(id);
    return cache === undefined ? { issues: [], polledAt: null } : { issues: cache.issues, polledAt: cache.polledAt };
  }

  /** The ids of the boards (in `jira.json` order) whose cache holds `key`. Read against the config so a deleted board stops answering at once. */
  boardsHolding(key: string): string[] {
    return readJiraConfig()
      .boards.filter((b) => this.caches.get(b.id)?.issues.some((i) => i.key === key) ?? false)
      .map((b) => b.id);
  }

  /** `GET /api/jira/issue/:key`: the issue, its children and its transitions, read fresh, the Done window off. Any of the three failing fails it (P4). */
  async issueDetail(key: string): Promise<JiraResult<JiraIssueDetail>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const { auth } = gate;
    const ctx: MapContext = { site: auth.site, sprintField: this.boot.sprintField, now: null };

    const res = await this.client.issue(auth, key, [...this.sweepFields(), 'description']);
    if (!ok(res)) return this.routeFailed(res);
    const issue = mapJiraIssue(res.data, ctx);
    if (issue === null) return this.routeFailed(synthetic(0, 'Jira sent an issue this server cannot read'));

    const children = await this.pages(auth, `parent in (${jqlString(key)})`, ctx, JIRA_ROOT_CAP);
    if (children.failure !== null) return this.routeFailed(children.failure);

    // A window opened (by a sweep, or another route) while the first two calls were out: the third is one Jira has already said it will refuse.
    const refused = this.windowRefusal();
    if (refused !== null) return refused;
    const offered = await this.client.transitions(auth, key);
    if (!ok(offered)) return this.routeFailed(offered);
    const transitions: JiraTransition[] = (Array.isArray(offered.data?.transitions) ? offered.data.transitions : []).filter(isObj).map((t) => {
      const to = isObj(t.to) ? t.to : {};
      return {
        id: str(t.id),
        name: str(t.name),
        to: { name: str(to.name), category: categoryOf(isObj(to.statusCategory) ? to.statusCategory.key : undefined) }
      };
    });

    const fields = isObj(res.data?.fields) ? res.data.fields : {};
    return {
      ok: true,
      value: {
        ...issue,
        // `null` on a ticket with no description; `adfToMarkdown` folds any non-document to '' (Review Focus 5).
        description: adfToMarkdown(fields.description).markdown,
        children: children.issues,
        transitions,
        boards: this.boardsHolding(key),
        session: null
      }
    };
  }

  /**
   * The roots picker: an exact key when `q` (trimmed, upper-cased) is one, else a summary prefix match, `JIRA_SEARCH_LIMIT` at most, the Done window off.
   * Blank is `[]` with no call. The length bound is the route's to enforce (`JIRA_SEARCH_MAX_CHARS`).
   */
  async search(q: string): Promise<JiraResult<JiraIssue[]>> {
    const text = q.trim();
    if (text === '') return { ok: true, value: [] };
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const upper = text.toUpperCase();
    const jql = isJiraKey(upper) ? `key = ${jqlString(upper)}` : `summary ~ ${jqlString(`${text}*`)}`;
    const res = await this.client.search(gate.auth, { jql, fields: this.sweepFields(), maxResults: JIRA_SEARCH_LIMIT });
    if (!ok(res)) return this.routeFailed(res);
    const ctx: MapContext = { site: gate.auth.site, sprintField: this.boot.sprintField, now: null };
    const issues = (Array.isArray(res.data?.issues) ? res.data.issues : [])
      .map((raw) => mapJiraIssue(raw, ctx))
      .filter((i): i is JiraIssue => i !== null)
      .slice(0, JIRA_SEARCH_LIMIT);
    return { ok: true, value: issues };
  }

  /**
   * Every project the credentials can see, sorted by key. Paged by `startAt` (P13), never by following the `nextPage` URL Jira hands back: the client builds
   * every URL itself, so Basic auth is never sent to an address that came out of a response body.
   */
  async projects(): Promise<JiraResult<{ key: string; name: string }[]>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const byKey = new Map<string, string>();
    let startAt = 0;
    for (;;) {
      const res = await this.client.projects(gate.auth, startAt);
      if (!ok(res)) return this.routeFailed(res);
      const values = Array.isArray(res.data?.values) ? res.data.values : [];
      for (const v of values) {
        if (isObj(v) && typeof v.key === 'string' && !byKey.has(v.key)) byKey.set(v.key, str(v.name) || v.key);
      }
      // An empty page ends it too: a Jira that says `isLast: false` and sends nothing would otherwise be asked for the same page forever.
      if (res.data?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    const value = [...byKey].map(([key, name]) => ({ key, name })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { ok: true, value };
  }

  /**
   * The board sheet's check line: Jira's strict parse first (an unknown field is an error there, not an empty result), then the approximate count — which
   * is where an unbounded query is refused, since it parses fine (P8). Both of those answers are `ok: true` with a verdict inside; only a failure to ASK is
   * a `JiraResult` failure.
   */
  async checkJql(jql: string): Promise<JiraResult<{ ok: true; count: number } | { ok: false; message: string }>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const parsed = await this.client.parseJql(gate.auth, jql);
    if (!ok(parsed)) return this.routeFailed(parsed);
    const first = Array.isArray(parsed.data?.queries) ? parsed.data.queries[0] : undefined;
    const errors = isObj(first) && Array.isArray(first.errors) ? first.errors.filter((e): e is string => typeof e === 'string' && e !== '') : [];
    if (errors.length > 0) return { ok: true, value: { ok: false, message: errors.join('; ') } };

    const counted = await this.client.approximateCount(gate.auth, jql);
    if (counted.status === 400) return { ok: true, value: { ok: false, message: counted.message ?? 'Jira answered 400' } };
    if (!ok(counted)) return this.routeFailed(counted);
    return { ok: true, value: { ok: true, count: typeof counted.data?.count === 'number' ? counted.data.count : 0 } };
  }

  // ── the chain ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) return;
    // `unref()` so a pending poll never keeps the process alive on its own — the tracker poller's and the watchdog's treatment.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, JIRA_POLL_MS);
    this.timer.unref?.();
  }

  /** Make sure a link is coming — for a route that just put the boot back into "owed" (a 401). A sweep in flight schedules its own successor. */
  private wake(): void {
    if (this.timer === null && this.inFlight === null) this.schedule();
  }

  /** The arming rule (header). `unsupported` is final (P5). */
  private owed(config: JiraConfig): boolean {
    if (this.boot.access === 'unsupported') return false;
    if (!this.boot.answered()) return true;
    return config.boards.some((b) => b.interval !== 'off' || this.coldOwed(b) || this.forced.has(b.id));
  }

  private coldOwed(board: JiraBoard): boolean {
    return (this.caches.get(board.id)?.polledAt ?? null) === null;
  }

  /** Never swept (or never successfully) is due at any interval — the cold sweep; otherwise one interval since the last good sweep (§3). */
  private due(board: JiraBoard, now: number): boolean {
    if (this.coldOwed(board) || this.forced.has(board.id)) return true;
    const ms = SYNC_INTERVALS[board.interval];
    if (ms === null) return false;
    return now - Date.parse(this.caches.get(board.id)!.polledAt!) >= ms;
  }

  private inWindow(now: number): boolean {
    return this.boot.retryAt !== null && now < this.boot.retryAt;
  }

  /**
   * A 429 window that has run out is not a verdict any more. Expired where the state is READ — `status()`, the read gate, the sweep — not by a timer:
   * a route can open the window while the chain is disarmed (no boards, or only `off` boards already swept — the ordinary phase-1 state), and a
   * verdict that only a sweep could clear would then read `rate-limited` with a past instant for the life of the process.
   */
  private expireWindow(now: number): void {
    if (this.boot.retryAt === null || now < this.boot.retryAt) return;
    this.boot.retryAt = null;
    const before = this.beforeWindow;
    this.beforeWindow = null;
    if (this.boot.access !== 'rate-limited') return;
    if (this.boot.answered()) {
      this.boot.access = 'ok';
      this.boot.detail = null;
    } else if (before !== null && before.access !== 'ok' && before.access !== 'rate-limited') {
      // The boot is still missing something, and what the window covered said why: a 401 or an outage is still the last thing Jira told us.
      this.boot.access = before.access;
      this.boot.detail = before.detail;
    } else {
      this.boot.access = 'ok';
      this.boot.detail = 'connecting';
    }
  }

  private async sweep(): Promise<void> {
    // Consumed by this tick, before any await, so `armed` cannot read true for a chain whose next link this tick has not created yet.
    this.clearTimer();
    const env = jiraEnv();
    // Unconfigured is the whole "off" state; `unsupported` is final (P5). Neither schedules a successor.
    if (!env.configured || this.boot.access === 'unsupported') return;

    const config = readJiraConfig();
    // Taken next to the read: a force whose generation is at most this was set before the file was read, so this sweep sees the save it asked for.
    const seen = this.forceSeq;
    // Memory hygiene only — every reader filters by the config anyway. An unreadable file prunes nothing: it reads as no boards, and the caches of the
    // boards it still holds must survive until it parses again.
    if (config.unreadable === null) {
      for (const id of [...this.caches.keys()]) if (!config.boards.some((b) => b.id === id)) this.caches.delete(id);
      for (const id of [...this.forced.keys()]) if (!config.boards.some((b) => b.id === id)) this.forced.delete(id);
    }

    // The calls the routes made since the last tick are not this sweep's.
    this.client.takeCalls();
    try {
      await this.run(env, config, seen);
    } finally {
      this.sweepCalls = this.client.takeCalls();
    }
    // Re-read after the awaits — see the header: an `arm()` that landed mid-sweep returned early and is honoured only here.
    if (this.owed(readJiraConfig())) this.schedule();
  }

  private async run(creds: { site: string; email: string; token: string }, config: JiraConfig, seen: number): Promise<void> {
    const now = Date.now();
    this.expireWindow(now);
    if (this.inWindow(now)) return;

    // No board is searched until every boot answer is in — see `identity.ts` for why the sprint field is one of them.
    if (!this.boot.answered()) {
      if (!this.boot.due(now)) return;
      if (!(await this.runBoot(creds))) return;
    }

    const auth: JiraAuth = { ...creds, cloudId: this.boot.cloudId! };
    for (const board of config.boards) {
      // A route may have met a 429 while this sweep awaited: honour the window from the next board on.
      if (this.inWindow(Date.now())) return;
      // ...or a 401: `me` is gone, and no board is searched without it.
      if (!this.boot.answered()) return;
      if (!this.due(board, Date.now())) continue;
      const force = this.forced.get(board.id);
      if (!(await this.sweepBoard(board, auth))) return;
      // Spent only by a success on a file read after the save (header): a whole-board failure — a 429 window opening mid-board, a 401, a 5xx — replaced
      // nothing, so the board is still owed, and a save that landed after this sweep read the file is a newer force than the one it just answered.
      if (force !== undefined && force <= seen && this.forced.get(board.id) === force) this.forced.delete(board.id);
    }
    // Every due board answered, so an earlier board-level `unreachable` is over — and only that verdict: a 429 or a 401 a ROUTE recorded while this sweep
    // awaited is evidence this sweep does not have, and clearing it would read `ok` while the routes are refused (§8: only those two move the state).
    if (this.boot.access === 'unreachable') {
      this.boot.access = 'ok';
      this.boot.detail = null;
    }
  }

  /** The boot calls still owed, in order, stopping at the first failure. True when the boot is whole afterwards. */
  private async runBoot(creds: { site: string; email: string; token: string }): Promise<boolean> {
    if (this.boot.cloudId === null) {
      const res = await this.client.tenantInfo(creds.site);
      if (!this.bootAnswered(res)) return false;
      const cloudId = res.data?.cloudId;
      if (typeof cloudId !== 'string' || cloudId === '') {
        this.bootFail(null, 'tenant_info carried no cloudId');
        return false;
      }
      this.boot.cloudId = cloudId;
    }
    const auth: JiraAuth = { ...creds, cloudId: this.boot.cloudId };
    // Every later step asks this first: a route may have met a 429 while the step before awaited, and the boot makes no call inside a window (header). No
    // `fail` either — the window already says when to ask again, and the boot resumes from the step it stopped at.
    const windowOpen = (): boolean => this.inWindow(Date.now());

    if (!this.boot.serverInfoOk) {
      if (windowOpen()) return false;
      const res = await this.client.serverInfo(auth);
      // A 404 is what the gateway answers for a site that is not Cloud; a `deploymentType` other than `Cloud` is Server/DC saying so itself. Both are
      // FINAL, so only an explicit answer counts: a 2xx with no `deploymentType` (a proxy's page, a body that did not parse) is a retryable failure.
      const deployment = res.data?.deploymentType;
      if (res.status === 404 || (ok(res) && typeof deployment === 'string' && deployment !== 'Cloud')) {
        this.boot.access = 'unsupported';
        this.boot.detail = UNSUPPORTED;
        return false;
      }
      if (!this.bootAnswered(res)) return false;
      if (deployment !== 'Cloud') {
        this.bootFail(null, 'serverInfo carried no deploymentType');
        return false;
      }
      this.boot.serverInfoOk = true;
    }

    if (this.boot.me === null) {
      if (windowOpen()) return false;
      const res = await this.client.myself(auth);
      if (!this.bootAnswered(res)) return false;
      const accountId = res.data?.accountId;
      if (typeof accountId !== 'string' || accountId === '') {
        this.bootFail(null, 'myself carried no accountId');
        return false;
      }
      this.boot.me = { accountId, name: str(res.data?.displayName) };
    }

    // Only once the gateway's `myself` has answered 200 (P2): a bad token is a 401 at the site too, and would otherwise be recorded as `scoped`. Its own
    // step rather than a tail of the one above, so a window that opens between the two still gets the probe asked when it ends.
    if (!this.boot.tokenProbed && this.boot.me !== null) {
      if (windowOpen()) return false;
      this.boot.tokenProbed = true;
      const probe = await this.client.myselfAtSite(auth);
      this.boot.tokenKind = ok(probe) ? 'classic' : probe.status === 401 ? 'scoped' : null;
    }

    if (!this.boot.fieldsOk) {
      if (windowOpen()) return false;
      const res = await this.client.fields(auth);
      if (!this.bootAnswered(res)) return false;
      const fields = (Array.isArray(res.data) ? res.data : []).filter(
        (f): f is { id: string; name: string; schema?: { custom?: string } } => isObj(f) && typeof f.id === 'string'
      );
      this.boot.sprintField = pickSprintField(fields);
      this.boot.fieldsOk = true;
    }

    // A route 401 during one of the awaits above reset `me`: the boot is not whole, whatever the last call here answered.
    if (!this.boot.answered()) return false;
    this.boot.succeed(Date.now());
    return true;
  }

  /** True on a 2xx; otherwise records the failure (a 429 opens the window rather than the back-off — the window already says when to ask again). */
  private bootAnswered(res: JiraResponse<unknown>): boolean {
    if (ok(res)) return true;
    if (res.status === 429) {
      this.openWindow(res);
      return false;
    }
    this.bootFail(accessOf(res), detailOf(res));
    return false;
  }

  /** `boot.fail`, except inside a 429 window: a boot call that was already out when a route opened one must not overwrite `rate-limited` (header). */
  private bootFail(access: JiraAccess | null, detail: string): void {
    if (this.inWindow(Date.now())) return;
    this.boot.fail(access, detail, Date.now());
  }

  /**
   * The one place a window opens, and the one place it is kept from moving (P1, header): only a 429 Jira sent opens one, and a 429 met while one is in force
   * restamps `last429At` — it is still the last 429 Jira sent — and leaves the stored end, `access` and `detail` alone.
   */
  private openWindow(res: JiraResponse<unknown>): void {
    if (SYNTHETIC.has(res)) return;
    const now = Date.now();
    this.last429At = iso(now);
    // A window that ran out but was not yet expired where it is read restores its verdict first, so the one captured below is not `rate-limited`.
    this.expireWindow(now);
    if (this.inWindow(now)) return;
    const until = now + (res.retryAfter !== null ? res.retryAfter * 1000 : JIRA_RATE_LIMIT_DEFAULT_MS);
    this.beforeWindow = { access: this.boot.access, detail: this.boot.detail };
    this.boot.retryAt = until;
    this.boot.access = 'rate-limited';
    this.boot.detail = `Jira rate limit — retry after ${iso(until)}`;
  }

  /** What a whole-board failure does to the site-level state. The cache is not touched — see the header. */
  private boardFailed(res: JiraResponse<unknown>): false {
    if (res.status === 401) {
      this.boot.reset();
      // Once per streak, as in `routeFailed`: a route that met the 401 while this search awaited has already restarted the boot retry.
      if (this.boot.access !== 'unauthorized') this.boot.fail('unauthorized', detailOf(res), Date.now());
    } else if (res.status === 429) {
      // `openWindow` keeps an open window's end and ignores the synthetic refusal from `pages` (P1).
      this.openWindow(res);
    } else if (!this.inWindow(Date.now())) {
      // Inside a window a route opened while this search was out, `rate-limited` is the newer and more useful verdict.
      this.boot.access = 'unreachable';
      this.boot.detail = detailOf(res);
    }
    return false;
  }

  /**
   * One board: its queries in order, then its roots in order with their walks; deduped by key (first occurrence wins), capped at `JIRA_BOARD_CAP`, and
   * swapped into the cache whole. False when a whole-board failure ended it (and the sweep with it).
   */
  private async sweepBoard(board: JiraBoard, auth: JiraAuth): Promise<boolean> {
    const ctx: MapContext = { site: auth.site, sprintField: this.boot.sprintField, now: Date.now() };
    const seen = new Set<string>();
    const list: JiraIssue[] = [];
    const failures: JiraBoardFailure[] = [];
    const add = (issues: JiraIssue[]): void => {
      for (const issue of issues) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        list.push(issue);
      }
    };

    for (const q of board.queries) {
      const got = await this.pages(auth, q.jql, ctx, JIRA_QUERY_CAP);
      if (got.failure !== null && wholeBoard(got.failure)) return this.boardFailed(got.failure);
      // A per-entry failure keeps what that entry returned before it; the `failures` row is what stops a partial list reading as a whole one.
      if (got.failure !== null) failures.push({ kind: 'query', id: q.id, message: entryMessage(got.failure) });
      add(got.issues);
    }

    for (const root of board.roots) {
      const got = await this.walk(auth, root, ctx);
      if (got.failure !== null && wholeBoard(got.failure)) return this.boardFailed(got.failure);
      if (got.failure !== null) failures.push({ kind: 'root', id: root, message: entryMessage(got.failure) });
      else if (got.unknown) failures.push({ kind: 'root', id: root, message: `Jira knows no issue ${root}` });
      add(got.issues);
    }

    this.caches.set(board.id, {
      issues: list.slice(0, JIRA_BOARD_CAP),
      // The instant the board's last call answered.
      polledAt: iso(Date.now()),
      truncated: list.length > JIRA_BOARD_CAP,
      failures
    });
    return true;
  }

  /**
   * A root and its descendants: `key = "K"`, then `JIRA_DESCENDANT_ROUNDS` rounds of `parent in (…)` over every key the previous round RETURNED (mapped or
   * dropped by the Done window), stopping early at `JIRA_ROOT_CAP` kept issues or an empty round. A root Jira answers with no issue at all is `unknown`
   * (P3 — Jira says 200 with nothing for a key it does not know); a root the window dropped is not unknown, and its walk still runs.
   */
  private async walk(auth: JiraAuth, root: string, ctx: MapContext): Promise<Pages & { unknown: boolean }> {
    const first = await this.pages(auth, `key = ${jqlString(root)}`, ctx, JIRA_ROOT_CAP);
    if (first.failure !== null) return { ...first, unknown: false };
    if (first.raw.length === 0) return { ...first, unknown: true };
    const issues = [...first.issues];
    let parents = first.raw;
    for (let round = 0; round < JIRA_DESCENDANT_ROUNDS && parents.length > 0 && issues.length < JIRA_ROOT_CAP; round++) {
      const got = await this.pages(auth, `parent in (${parents.map(jqlString).join(', ')})`, ctx, JIRA_ROOT_CAP - issues.length);
      issues.push(...got.issues);
      if (got.failure !== null) return { raw: [], issues, failure: got.failure, unknown: false };
      parents = got.raw;
    }
    return { raw: [], issues, failure: null, unknown: false };
  }

  /**
   * One JQL, paged by `nextPageToken`, until `room` issues are kept, Jira says `isLast`, or a page names no next token — a page claiming `isLast: false`
   * with no token ends the walk there rather than asking for the first page again forever (Review Focus 3).
   */
  private async pages(auth: JiraAuth, jql: string, ctx: MapContext, room: number): Promise<Pages> {
    const raw: string[] = [];
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    while (issues.length < room) {
      // A route may have opened a 429 window while this walk awaited; the sweep makes no call inside it (the header).
      if (this.inWindow(Date.now())) return { raw, issues: issues.slice(0, room), failure: synthetic(429, null) };
      const res = await this.client.search(auth, { jql, fields: this.sweepFields(), maxResults: JIRA_PAGE_SIZE, nextPageToken });
      if (!ok(res)) return { raw, issues: issues.slice(0, room), failure: res };
      const page = Array.isArray(res.data?.issues) ? res.data.issues : [];
      for (const r of page) {
        if (isObj(r) && typeof r.key === 'string') raw.push(r.key);
        const issue = mapJiraIssue(r, ctx);
        if (issue !== null) issues.push(issue);
      }
      const next = res.data?.nextPageToken;
      if (res.data?.isLast !== false || typeof next !== 'string' || next === '') break;
      nextPageToken = next;
    }
    return { raw, issues: issues.slice(0, room), failure: null };
  }

  /** The sweep's field list (§4) plus the discovered sprint field, when the site has one. */
  private sweepFields(): string[] {
    return this.boot.sprintField === null ? [...JIRA_ISSUE_FIELDS] : [...JIRA_ISSUE_FIELDS, this.boot.sprintField];
  }

  /** The union of project keys on the cached boards and the mapped keys, sorted; a name from a cached issue when there is one, else the key. */
  private projectsOf(config: JiraConfig): { key: string; name: string }[] {
    const names = new Map<string, string>();
    for (const board of config.boards) {
      for (const issue of this.caches.get(board.id)?.issues ?? []) if (!names.has(issue.project.key)) names.set(issue.project.key, issue.project.name);
    }
    for (const key of Object.keys(config.repos)) if (!names.has(key)) names.set(key, key);
    return [...names]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // ── the fresh reads' shared edges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether a fresh read may be sent, and with what. Refused with NO call: inside a 429 window (the stored instant, P1); before boot has a `cloudId` — there
   * is no gateway path to ask — answering from the boot state (P3: a 401 state is the 401, anything else `unreachable` with the boot's detail); and for an
   * `unsupported` site, which no read can change. Unconfigured never reaches here past the routes (they answer 503 first), but is refused all the same.
   */
  private gate(): { auth: JiraAuth } | { refused: JiraRefusal } {
    const env = jiraEnv();
    if (!env.configured) return { refused: { ok: false, response: synthetic(0, env.detail) } };
    const inWindow = this.windowRefusal();
    if (inWindow !== null) return { refused: inWindow };
    if (this.boot.access === 'unsupported') return { refused: { ok: false, response: synthetic(0, UNSUPPORTED), access: 'unsupported' } };
    if (this.boot.cloudId === null) {
      const detail = this.boot.detail ?? 'connecting';
      return { refused: { ok: false, response: this.boot.access === 'unauthorized' ? synthetic(401, detail) : synthetic(0, detail) } };
    }
    return { auth: { site: env.site, email: env.email, token: env.token, cloudId: this.boot.cloudId } };
  }

  /** The refusal a read gets inside a 429 window — a synthesised 429 and the STORED instant (P1) — or `null` when none is in force. */
  private windowRefusal(): JiraRefusal | null {
    this.expireWindow(Date.now());
    if (!this.inWindow(Date.now())) return null;
    return { ok: false, response: synthetic(429, null), retryAt: iso(this.boot.retryAt!) };
  }

  /**
   * A fresh read's failure. Only a 401 (the credentials stopped working: `me` reset, the boot retry restarts) and a 429 (the window opens) move the
   * site-level state; a 0, 5xx, 400, 403 or 404 on a route answers its mapping and leaves `access` to the sweep (§8).
   */
  private routeFailed(res: JiraResponse<unknown>): JiraRefusal {
    if (res.status === 401) {
      this.boot.reset();
      // Once per streak: a read refused again while already `unauthorized` must not double the back-off and slide the boot's retry out to the cap.
      if (this.boot.access !== 'unauthorized') this.boot.fail('unauthorized', detailOf(res), Date.now());
      this.wake();
    }
    if (res.status === 429) {
      this.openWindow(res);
      // The stored end on every 429 path (P1) — the one this 429 opened, or the one already in force that it did not move. A synthesised 429 whose window
      // has somehow ended carries none, and `jiraHttpError` falls back to the default.
      return this.boot.retryAt === null ? { ok: false, response: res } : { ok: false, response: res, retryAt: iso(this.boot.retryAt) };
    }
    return { ok: false, response: res };
  }
}
