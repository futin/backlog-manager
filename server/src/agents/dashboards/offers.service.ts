import { Injectable } from '@nestjs/common';

import { projectDispatchGate } from '../../../../shared/agent';
import type { AgentsStatus, MachineOffer, MachineUsage, ProjectOffers } from '../../../../shared/types';
import { ItemsService } from '../../items/items.service';
import { isRepo } from '../../tracker/github.client';
import { DashboardStatusService, type StatusBudget } from '../dashboard-status.service';
import { DashboardsService, type Machine } from './dashboards.service';
import { remoteProject } from './remote-board.util';
import { suggest } from './suggest.util';
import { UsageService } from './usage.service';

/** Every read the offers make of a REMOTE machine is a new outbound read, and every new outbound read gets 5 s (global constraints). */
export const OFFERS_TIMEOUT_MS = 5_000;
const REMOTE_BUDGET: StatusBudget = { healthMs: OFFERS_TIMEOUT_MS, managementMs: OFFERS_TIMEOUT_MS };

type Judged = { reason: string | null };

/**
 * Which machines one project can run on (spec 2026-10-22-multi-dashboard-design.md, "Which machines are offered for a project" and "What 'offered' checks on a
 * remote machine"), each with the reason it is not and, when it is, its usage — plus the suggestion among the offered ones. `GET /api/dashboards/offers`
 * answers `offers`; tasks 5–6 call `offers` and `remotePath` again at launch time, because a picker's answer is minutes old by the time Start is clicked.
 *
 * Two shapes of answer, and the first is the home-only promise (Review Focus 1): a project that is not a GitHub tracker project, or a setup with no remote
 * configured, gets HOME ALONE — judged by the same gate a launch already applies, suggested as the default when offered, and with no usage fetched at all,
 * because there is nothing to choose between and the account/profile routes are a cost the home-only board never paid. A files project cannot run remotely
 * at all (a remote session writes its items through the remote's own backlog-manager, which only a tracker project has), so it never sees a remote.
 *
 * Otherwise every configured machine is judged AT ONCE (`Promise.all`): the usage reader and the board read each cost up to 5 s when their peer hangs, and the
 * usage reader does not remember a failed refetch, so judging in sequence would add one hung machine's timeout to every machine after it (Review Focus 2).
 * Within one machine the dashboard and the board are read side by side too, and the reason is chosen afterwards in the fixed order — so with both down the
 * reason is the dashboard's, whichever answered first. Usage is read only for a machine that came out offered: a not-offered card draws no gauge, and a
 * dashboard that is down would only spend another timeout saying so.
 *
 * Nothing here throws for a peer's failure; every failure is a reason string. No token reaches the answer: `MachineOffer` is built field by field from the
 * machine, and a machine's `cfg` (which holds the token) is never spread into it (Review Focus 3).
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly dashboards: DashboardsService,
    private readonly status: DashboardStatusService,
    private readonly usage: UsageService,
    private readonly items: ItemsService
  ) {}

  async offers(project: string, nowMs: number = Date.now()): Promise<ProjectOffers> {
    const machines = this.dashboards.machines();
    const { order, strategy, threshold } = this.dashboards.settings();
    const repo = this.repoOf(project);

    if (repo === null || machines.length === 1) {
      const home = machines[0];
      const { reason } = await this.judgeHome(project, home);
      const offer = toOffer(home, reason, null, null);
      // `suggest` with no usage anywhere is exactly the default pick, worded by its one home rather than by a second copy of the sentence here.
      const candidates = [{ machine: home.id, label: home.label, usage: null }];
      const suggestion = offer.offered ? suggest({ candidates, order, strategy, threshold, homeOffered: true }) : null;
      return { project, machines: [offer], suggestion };
    }

    const judged = await Promise.all(
      machines.map(async (m) => {
        const { reason } = m.home ? await this.judgeHome(project, m) : await this.judgeRemote(project, repo, m);
        const read = reason === null ? await this.usage.read(m, nowMs) : { usage: null, ageMs: null };
        return toOffer(m, reason, read.usage, read.ageMs);
      })
    );
    // `settings().order` is complete (the reader appends every configured machine it lacks), so the fallback rank only guards a machine added between reads.
    const rank = (id: string): number => {
      const i = order.indexOf(id);
      return i === -1 ? order.length : i;
    };
    const ordered = [...judged].sort((a, b) => rank(a.machine) - rank(b.machine));
    const offered = ordered.filter((o) => o.offered);
    const suggestion = suggest({
      candidates: offered.map((o) => ({ machine: o.machine, label: o.label, usage: o.usage })),
      order,
      strategy,
      threshold,
      homeOffered: offered.some((o) => o.home)
    });
    return { project, machines: ordered, suggestion };
  }

  /**
   * The project's path on `m`, or why there is none — the board half of the reason ladder (rungs 2–4), asked again at launch time so a launch never trusts
   * a path the picker read minutes ago. Home's path is the project itself. A project with no GitHub repo has no identity another machine could know it by.
   */
  async remotePath(project: string, m: Machine): Promise<{ path: string } | { reason: string }> {
    if (m.home) return { path: project };
    const repo = this.repoOf(project);
    if (repo === null) return { reason: `${m.label} runs tracker projects only — ${project} is files-backed` };
    return fromBoard(await remoteProject(m.bmUrl as string, repo), repo, m.label);
  }

  /** Rungs 1 and 5 — home has no board. Home's dashboard is read with home's own budgets and cache, the same reads `GET /api/agents/status` makes. */
  private async judgeHome(project: string, home: Machine): Promise<Judged> {
    const status = await this.status.statusOf(home.cfg);
    return { reason: gateReason(status, home.label, project) };
  }

  private async judgeRemote(project: string, repo: string, m: Machine): Promise<Judged> {
    // `BM_AGENTS` off is the whole feature's off switch, remotes included: no egress at all, so the board is not asked either.
    const [status, board] = await Promise.all([
      this.status.statusOf(m.cfg, REMOTE_BUDGET),
      m.cfg.enabled ? remoteProject(m.bmUrl as string, repo) : Promise.resolve(null)
    ]);
    if (!status.enabled || !status.reachable) return { reason: gateReason(status, m.label, project) };
    const there = fromBoard(board, repo, m.label);
    if ('reason' in there) return there;
    return { reason: gateReason(status, m.label, there.path) };
  }

  /**
   * The project's `owner/name`, or `null` when it is not a GitHub tracker project — the marker's `repo`, through the same per-request resolution
   * `ProjectSummary.repo` and every item write read (`ItemsService.sourceOf` / `writerFor`), and only when it is a well-formed repo, as the GitHub adapter
   * requires before it reports one.
   */
  private repoOf(project: string): string | null {
    if (this.items.sourceOf(project) !== 'github') return null;
    const lookup = this.items.writerFor(project);
    if (lookup.kind !== 'writer') return null;
    return isRepo(lookup.marker.repo) ? lookup.marker.repo : null;
  }
}

/** Rungs 2–4 of the ladder, from a `remoteProject` answer: the first that applies, or the remote path when none does. */
function fromBoard(board: Awaited<ReturnType<typeof remoteProject>>, repo: string, label: string): { path: string } | { reason: string } {
  if (board !== null && 'error' in board) return { reason: `board unreachable — ${board.error}` };
  if (board === null) return { reason: `${repo} is not registered on ${label}` };
  if (board.interval === null || board.interval === 'off') return { reason: `sync is off for ${repo} on ${label}` };
  return { path: board.path };
}

/**
 * Rung 1 and rung 5 — the existing per-dashboard gate (`projectDispatchGate`), against `path` as THAT dashboard knows it. Its unreachable line is reworded
 * to the offers' copy and its project-visibility line names the machine; its other environment lines (agents off, no `CLAUDE_BIN`, remote answers off) are
 * kept word for word, because a reader acts on each of them differently and the gate is their one home.
 */
function gateReason(status: AgentsStatus, label: string, path: string): string | null {
  if (status.enabled && !status.reachable) return `dashboard unreachable — ${status.error ?? 'no answer'}`;
  const gate = projectDispatchGate(status, path);
  if (gate.control === 'enabled') return null;
  if (gate.control === 'disabled') return `${label}'s dashboard does not list ${path}`;
  return gate.reason;
}

function toOffer(m: Machine, reason: string | null, usage: MachineUsage | null, usageAgeMs: number | null): MachineOffer {
  return {
    machine: m.id,
    label: m.label,
    home: m.home,
    account: m.account,
    offered: reason === null,
    reason,
    usage,
    usageAgeMs,
    models: m.models,
    efforts: m.efforts
  };
}
