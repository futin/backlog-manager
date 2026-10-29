import { claimReading } from './tracker';
import { RUN_HELD_STAGES } from '../../../shared/agent';
import type { BacklogItem, OrchestratorRun, ProjectSummary, PullRequestRow, RemoteRun, RemoteStarting } from '../../../shared/types';

/**
 * The PRs page's run-in-progress warning (`.claude/DESIGN.md` §8.11): is something about to rewrite the branch this PR sits on? The ONE function the spec
 * names — the row's merge and update controls both read it, so neither can warn where the other stays quiet.
 *
 * A PR's head is `backlog/<id>` or `execute/<id>` exactly when a skill or the orchestrator made it for item `<id>`, and `backlog/run-*` when a `pr`-mode run
 * drains onto a run branch. Anything else is somebody's own branch and gets no warning: guessing from a prefix would cry wolf on every `feature/42`.
 *
 * Ids are scoped to a REPO, not just a number: item `42` of `futin/x` and item `42` of `futin/y` are different things, so a run, an item or a launch counts
 * only when its project maps to the PR's repo (`ProjectSummary.path` → `.repo`). A fork's head is never ours (`crossRepository` → `null`), whatever its name.
 * Run freshness is ignored on purpose: a crashed `running` run still holds the branch until someone stops it. A queue entry holds the branch only at a
 * HELD stage (`RUN_HELD_STAGES`): a `merged`, `branched`, `failed`, `skipped` or `ungroomed` entry has let go, and warning on it would be a stale reading.
 * `now` is required, for the reason `tracker.ts` gives.
 */

const ITEM_HEAD = /^(?:backlog|execute)\/(\d+)$/;
const RUN_HEAD = /^backlog\/run-/;

/** The context a warning is derived from: everything the Board already polls, so the page adds no request of its own. */
export interface PrRunContext {
  projects: readonly ProjectSummary[];
  items: readonly BacklogItem[];
  runs: readonly OrchestratorRun[];
  remote: readonly RemoteRun[];
  remoteStarting: readonly RemoteStarting[];
}

/** A run still owns its branches while it is working or paused; the three exits have let go. */
const runHolds = (run: Pick<OrchestratorRun, 'status'>): boolean => run.status === 'running' || run.status === 'paused';

export function prRunWarning(pr: PullRequestRow, repo: string, ctx: PrRunContext, now: number): string | null {
  if (pr.crossRepository) return null;

  const onRepo = new Set(ctx.projects.filter((p) => p.repo === repo).map((p) => p.path));
  const localRuns = ctx.runs.filter((run) => runHolds(run) && onRepo.has(run.project));
  const remoteRuns = ctx.remote.filter((run) => runHolds(run) && run.repo === repo);
  const holder = (run: RemoteRun): string => `run in progress on ${run.host ?? 'another machine'}`;

  const itemHead = ITEM_HEAD.exec(pr.head);
  if (itemHead !== null) {
    const id = itemHead[1];
    const holds = (run: Pick<OrchestratorRun, 'queue'>): boolean => run.queue.some((entry) => entry.id === id && RUN_HELD_STAGES.includes(entry.stage));
    if (localRuns.some(holds)) return 'run in progress on this machine';
    const remoteRun = remoteRuns.find(holds);
    if (remoteRun !== undefined) return holder(remoteRun);
    if (ctx.items.some((item) => item.source === 'github' && item.id === `#${id}` && onRepo.has(item.projectPath) && claimReading(item, now) === 'live')) {
      return 'claimed by a live session';
    }
    if (ctx.remoteStarting.some((entry) => entry.kind === 'dispatch' && entry.itemId === `#${id}` && onRepo.has(entry.project))) return 'launch pending';
    return null;
  }

  if (RUN_HEAD.test(pr.head)) {
    if (localRuns.some((run) => run.base === pr.head)) return 'run in progress on this machine';
    const remoteRun = remoteRuns.find((run) => run.base === pr.head);
    return remoteRun === undefined ? null : holder(remoteRun);
  }

  return null;
}
