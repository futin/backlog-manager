import type { BacklogItem, TickProject } from '../../../shared/types';

/**
 * The board's reading of the plan-review pile (#367): how many plans a tick wrote unattended are waiting on a person, against the cap the tick grooms under,
 * and the text a files-project approval is copied as. Pure functions of the items index and `GET /api/ticks`, so the band chip, its title and the item
 * modal agree by construction.
 *
 * The COUNT is the items index's — fresher than any tick, since it moves the moment a person approves — and the CAP is the last counting decide's
 * (`TickProject.lastDecide`, `last-decide.json`), because `--max-plans` is a dashboard job flag only `tick.mjs decide` ever sees.
 */

/** One project with at least one open item awaiting plan review. `cap` is `null` when no tick has recorded one for that project. */
export interface PlanReviewTally {
  projectPath: string;
  name: string;
  count: number;
  cap: number | null;
  blocked: boolean;
}

/**
 * Whether an item is in the plan-review pile: OPEN and carrying the mark. The one home of that rule on the client (#387), read by three callers that must
 * agree — `planReviewTally` below (the band chip's count), the Board's `Awaiting review` filter (`BoardView`'s `matches`), and `PlanApprove` (whether the
 * modal offers Approve) — so the chip's count and the filtered board are the same set by construction. Not `shared/agent.ts`'s `planReviewBlock`, which reads
 * the mark alone, without the status, and is shared with the server's dispatch gate.
 */
export function awaitsPlanReview(item: BacklogItem): boolean {
  return item.status === 'open' && item.planReview === true;
}

/**
 * One entry per project holding ≥1 item `awaitsPlanReview` answers true for, ordered by project name. A project with none has no entry whatever its
 * `lastDecide` says — a tick at its cap a minute ago is not blocked once a person has approved the pile. `cap` comes from the tick row whose `root` is the
 * project's path (never its display name: two checkouts of one repo share a name), and `blocked` is `count >= cap`.
 */
export function planReviewTally(items: readonly BacklogItem[], ticks: readonly TickProject[]): PlanReviewTally[] {
  const byPath = new Map<string, { name: string; count: number }>();
  for (const item of items) {
    if (!awaitsPlanReview(item)) continue;
    const entry = byPath.get(item.projectPath);
    if (entry) entry.count += 1;
    else byPath.set(item.projectPath, { name: item.project, count: 1 });
  }
  const tallies: PlanReviewTally[] = [];
  for (const [projectPath, { name, count }] of byPath) {
    const cap = ticks.find((t) => t.root === projectPath)?.lastDecide?.caps.maxPlans ?? null;
    tallies.push({ projectPath, name, count, cap, blocked: cap !== null && count >= cap });
  }
  return tallies.sort((a, b) => a.name.localeCompare(b.name) || a.projectPath.localeCompare(b.projectPath));
}

const plans = (count: number): string => (count === 1 ? 'plan' : 'plans');

/**
 * The band's one string, or `null` when there is nothing to say. `projectValue` is the band's scope: a project path, or `null` for all projects (the board
 * maps its `all` sentinel to it). One project: `3/3 plans awaiting review · tick blocked`, `2/3 plans awaiting review`, or `1 plan awaiting review` when no
 * cap is known — and `null` when that project has nothing marked. All projects: the summed count, plus ` · tick blocked in <name>, <name>` in tally order.
 * `plan` is singular exactly at a count of 1, cap or not.
 */
export function planReviewReading(tallies: readonly PlanReviewTally[], projectValue: string | null): string | null {
  if (projectValue !== null) {
    const scoped = tallies.find((t) => t.projectPath === projectValue);
    if (scoped === undefined) return null;
    const n = scoped.cap === null ? `${scoped.count}` : `${scoped.count}/${scoped.cap}`;
    return `${n} ${plans(scoped.count)} awaiting review${scoped.blocked ? ' · tick blocked' : ''}`;
  }
  if (tallies.length === 0) return null;
  const total = tallies.reduce((sum, t) => sum + t.count, 0);
  const blocked = tallies.filter((t) => t.blocked).map((t) => t.name);
  return `${total} ${plans(total)} awaiting review${blocked.length > 0 ? ` · tick blocked in ${blocked.join(', ')}` : ''}`;
}

/** The band chip's title: every tally as `<name>: N/cap`, or `<name>: N` with no cap known, one per line. */
export function planReviewTitle(tallies: readonly PlanReviewTally[]): string {
  return tallies.map((t) => `${t.name}: ${t.cap === null ? t.count : `${t.count}/${t.cap}`}`).join('\n');
}

/**
 * A files item's approval, as text to paste into a Claude session — the board never writes item files. Not `backlog.mjs plan-review <id> off`: that verb
 * refuses a files project, whose approval is the frontmatter line's deletion plus a commit. The path is made relative to the project so the sentence reads
 * the way a person in that checkout would type it.
 */
export function planApprovePrompt(item: BacklogItem): string {
  const root = item.projectPath.endsWith('/') ? item.projectPath : `${item.projectPath}/`;
  const rel = item.path.startsWith(root) ? item.path.slice(root.length) : item.path;
  return `Approve the unattended plan on ${item.id} in ${item.projectPath}: delete the plan-review: true line from ${rel}'s frontmatter, then commit it.`;
}
