import { elapsedSince } from './item-age';
import { prChips, mergeBlock, updateBlock, type PrOutcome } from './prs';
import type { DotTone } from '../components/ui/Dot';
import type { PrRepoView, PullRequestRow } from '../../../shared/types';

/**
 * What the GitHub › PRs layouts (Inbox, Matrix, Cards) say about a pull request, derived once (`.claude/DESIGN.md` §8.11; spec
 * `docs/superpowers/specs/2026-10-29-prs-layouts-design.md`: "Level of a PR", "Problems and the verdict", "Rank", "Layout key"). Pure and clock-free: the level
 * a row sits in, the sentence that says why, the order of the page and the layout a device draws all come from here, so the three layouts cannot triage one PR
 * three ways. `prChips` (`lib/prs.ts`) stays the one reading of a PR's facts for Cards and for a quiet line; nothing here re-describes them.
 *
 * **One fact list drives everything.** `levelFacts` lists the facts that put a PR in Needs you or Worth a look, in the spec's severity order — checks failure,
 * conflicting, changes-requested, then behind, review-required, pending, unknown, and an unnamed block. The level is the first fact's level, the severity its
 * index in its own level's list, and the problem sentences those facts in order. Deriving all three from one list is the point: a level, a rank and a
 * sentence that each re-tested the PR would drift the first time somebody added a fact to one of them.
 *
 * **Why the order is the order.** `draft` is tested before the list, not inside it, because a draft is somebody saying "not ready yet": red checks on it are
 * the author's business, and a triage board that shouted about every draft would bury the PRs that are waiting on a person. Pending checks demote to Quiet
 * when auto-merge is armed because GitHub will merge it on its own — nothing is left for a person to do. And `blocked` / `unstable` is a fact only when
 * nothing else names the reason, because GitHub reports a PR as blocked for exactly the reasons already listed (a missing review, running checks); saying
 * "blocked" beside them would be the same news twice, and for an armed PR waiting on checks it would put a self-merging PR in Worth a look.
 */

/** How urgent a PR is to a person: act now, glance at it, or leave it. */
export type PrLevel = 'needs-you' | 'worth-a-look' | 'quiet';

/** Every level, in the order a page lists them. */
export const LEVELS: readonly PrLevel[] = ['needs-you', 'worth-a-look', 'quiet'];

export const LEVEL_LABEL: Record<PrLevel, string> = {
  'needs-you': 'Needs you',
  'worth-a-look': 'Worth a look',
  quiet: 'Quiet'
};

/**
 * A repo the token cannot read — its last read said `forbidden` or `not-found`. Every layout, the `N open` pill and the toolbar's hidden count read this one
 * function (spec, "Reach of a repo"). A transient failure (`rate-limited`, `error`) is NOT no-access: the repo is still readable, so it stays shown, beside
 * its last answer and a line saying what went wrong.
 */
export function isNoAccess(repo: PrRepoView): boolean {
  return repo.access === 'forbidden' || repo.access === 'not-found';
}

/** The page's repos split by reach, payload order kept on both sides. A hidden repo returns by itself the next time a read answers `ok`. */
export function splitReach(repos: readonly PrRepoView[]): { shown: PrRepoView[]; hidden: PrRepoView[] } {
  const shown: PrRepoView[] = [];
  const hidden: PrRepoView[] = [];
  for (const repo of repos) (isNoAccess(repo) ? hidden : shown).push(repo);
  return { shown, hidden };
}

type FactKind = 'failure' | 'conflicting' | 'changes-requested' | 'behind' | 'review-required' | 'pending' | 'unknown' | 'blocked';

interface LevelFact {
  kind: FactKind;
  level: 'needs-you' | 'worth-a-look';
  /** The fact's index within its own level's list in the spec — the rank's severity. Lower ranks first. */
  severity: number;
  text: string;
}

/**
 * The facts that put a PR above Quiet, in severity order, IGNORING `draft` — a Matrix cell reports its own fact whatever the row's level (spec, Matrix), and
 * `prLevel` is the one place that lets a draft override. Needs you's three facts come before Worth a look's five, so the first fact is always the one that
 * decides the level.
 *
 * The unnamed block is only added when the list is otherwise empty AND the checks are not pending: running checks are a name for a `blocked` state even when
 * auto-merge being armed means they are not a fact of their own.
 */
function levelFacts(pr: PullRequestRow): LevelFact[] {
  const facts: LevelFact[] = [];
  if (pr.checks === 'failure') facts.push({ kind: 'failure', level: 'needs-you', severity: 0, text: 'Checks are failing.' });
  if (pr.mergeable === 'conflicting') facts.push({ kind: 'conflicting', level: 'needs-you', severity: 1, text: `Conflicts with ${pr.base}.` });
  if (pr.review === 'changes-requested') facts.push({ kind: 'changes-requested', level: 'needs-you', severity: 2, text: 'Changes were requested.' });
  if (pr.mergeState === 'behind') facts.push({ kind: 'behind', level: 'worth-a-look', severity: 0, text: 'Behind its base.' });
  if (pr.review === 'review-required') facts.push({ kind: 'review-required', level: 'worth-a-look', severity: 1, text: 'Waiting for a review.' });
  if (pr.checks === 'pending' && pr.autoMerge === null) facts.push({ kind: 'pending', level: 'worth-a-look', severity: 2, text: 'Checks are still running.' });
  if (pr.mergeable === 'unknown') {
    facts.push({ kind: 'unknown', level: 'worth-a-look', severity: 3, text: 'GitHub is still working out whether it can merge.' });
  }
  const blocked = pr.mergeState === 'blocked' || pr.mergeState === 'unstable';
  if (blocked && facts.length === 0 && pr.checks !== 'pending') {
    facts.push({ kind: 'blocked', level: 'worth-a-look', severity: 4, text: `GitHub reports it ${pr.mergeState}.` });
  }
  return facts;
}

/** Which of the three levels a PR sits in: a draft is Quiet before anything else is read; otherwise the first level-driving fact decides. */
export function prLevel(pr: PullRequestRow): PrLevel {
  if (pr.draft) return 'quiet';
  return levelFacts(pr)[0]?.level ?? 'quiet';
}

/** The rank within a level: the index, in the level's list, of the first fact that put the PR there. `null` for Quiet, which sorts on age alone. */
export function prSeverity(pr: PullRequestRow): number | null {
  if (pr.draft) return null;
  return levelFacts(pr)[0]?.severity ?? null;
}

/** One sentence about a PR. `calm` is a step worth reading beside a problem (the run warning, `Approved.`), not one a person has to act on. */
export interface PrProblem {
  text: string;
  calm: boolean;
}

/**
 * A PR's ordered problems: the level-driving facts (none for a draft — it is Quiet, so nothing about it is a problem yet), then the run-in-progress warning
 * verbatim (`prRunWarning`'s text, which the page derives), then the calm facts worth reading next to a problem. A calm fact is only said when true, and
 * `approved` is listed before `checks passing`, the order `prChips` reads them in.
 */
export function prProblems(pr: PullRequestRow, warning: string | null): PrProblem[] {
  const problems: PrProblem[] = pr.draft ? [] : levelFacts(pr).map((f) => ({ text: f.text, calm: false }));
  if (warning !== null) problems.push({ text: warning, calm: true });
  if (pr.review === 'approved') problems.push({ text: 'Approved.', calm: true });
  if (pr.checks === 'success') problems.push({ text: 'Checks are passing.', calm: true });
  return problems;
}

/** The first problem as the row's headline and the rest as its steps; no problems is no verdict (a quiet row says its facts instead, `quietFacts`). */
export function prVerdict(problems: readonly PrProblem[]): { verdict: string | null; steps: PrProblem[] } {
  return { verdict: problems[0]?.text ?? null, steps: problems.slice(1) };
}

/** A quiet row's one line: `prChips`' labels, joined. The same words Cards draws as chips — a PR is never described two ways. */
export function quietFacts(pr: PullRequestRow): string {
  return prChips(pr)
    .map((chip) => chip.label)
    .join(' · ');
}

/** A PR placed on the page: its key (`<repo>#<number>`, the id outcomes and update marks use), where it lives, and the two numbers the order came from. */
export interface RankedPr {
  key: string;
  repo: PrRepoView;
  pr: PullRequestRow;
  level: PrLevel;
  severity: number | null;
}

/**
 * Every PR of the given repos in page order: level, then severity ascending, then newest `updatedAt` first, then key ascending. The key is the last resort so
 * two PRs the data cannot tell apart (same level, severity and second) still land in one order on every render and every machine.
 */
export function rankPrs(repos: readonly PrRepoView[]): RankedPr[] {
  const ranked: RankedPr[] = repos.flatMap((repo) =>
    repo.prs.map((pr) => ({ key: `${repo.repo}#${pr.number}`, repo, pr, level: prLevel(pr), severity: prSeverity(pr) }))
  );
  return ranked.sort(
    (a, b) =>
      LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) ||
      (a.severity ?? 0) - (b.severity ?? 0) ||
      (Date.parse(b.pr.updatedAt) || 0) - (Date.parse(a.pr.updatedAt) || 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** How many ranked PRs sit in each level — zero included, so a tile for an empty level still has a number to draw. */
export function levelCounts(ranked: readonly RankedPr[]): Record<PrLevel, number> {
  const counts: Record<PrLevel, number> = { 'needs-you': 0, 'worth-a-look': 0, quiet: 0 };
  for (const r of ranked) counts[r.level] += 1;
  return counts;
}

export type PrLayout = 'inbox' | 'matrix' | 'cards';

/** The persisted choice, under the board's `backlog-manager.` prefix like every other per-device setting (`usePersistedState`). */
export const PR_LAYOUT_KEY = 'backlog-manager.prs-layout';

/** A stored value read back as a layout: anything that is not one of the three — a hand edit, an older build's word, a non-string — is the default, Inbox. */
export function parseLayout(v: unknown): PrLayout {
  return v === 'matrix' || v === 'cards' ? v : 'inbox';
}

/**
 * The layout a window can draw. Matrix is wide-only, so a narrow window draws a stored `matrix` as Inbox — and the stored value is not rewritten, so the
 * choice comes back the next time the window is wide (the dashboard's `drawableGitLayout` rule).
 */
export function drawableLayout(stored: PrLayout, narrow: boolean): PrLayout {
  return narrow && stored === 'matrix' ? 'inbox' : stored;
}

/** The switcher's options: Matrix only where it can be drawn. */
export function layoutOptions(narrow: boolean): { value: PrLayout; label: string }[] {
  const all: { value: PrLayout; label: string }[] = [
    { value: 'inbox', label: 'Inbox' },
    { value: 'matrix', label: 'Matrix' },
    { value: 'cards', label: 'Cards' }
  ];
  return narrow ? all.filter((o) => o.value !== 'matrix') : all;
}

/** Shown repos whose last read failed for a reason that may pass (`rate-limited`, `error`): still drawn, with what went wrong beside the last answer. */
export function transientFailures(shown: readonly PrRepoView[]): PrRepoView[] {
  return shown.filter((repo) => repo.access !== 'ok');
}

/** The most recent successful read across the shown repos — the one `polled … ago` the toolbar draws — or `null` when none has read yet. */
export function newestPolledAt(shown: readonly PrRepoView[]): string | null {
  let best: string | null = null;
  for (const repo of shown) {
    if (repo.polledAt !== null && (best === null || (Date.parse(repo.polledAt) || 0) > (Date.parse(best) || 0))) best = repo.polledAt;
  }
  return best;
}

/** How many departed lines a repo keeps: the newest ones. A page left open through a dozen merges would otherwise grow a dozen lines at the repo's foot (#396). */
export const DEPARTED_KEEP = 3;

/**
 * The finished outcomes of PRs a write of this page took off the list (merged), still owed a line: the key's repo is shown, the PR is no longer listed, and the
 * outcome is not `updating…` (an updating PR with no row left has nothing to be updating). Lifted from `RepoSheet` so a page-level layout can say them too.
 * Matched on `<repo>#`, never a bare prefix, so `a/x` does not claim `a/xy#1`.
 *
 * Only the newest `DEPARTED_KEEP` per repo are returned, in the order they were recorded. "Newest" is the record's own key order: `PullRequestsView` deletes a
 * key when its next write leaves and re-adds it when that write settles, so insertion order is completion order — no timestamp is stored to sort by.
 */
export function departedOutcomes(outcomes: Record<string, PrOutcome>, shown: readonly PrRepoView[]): { key: string; outcome: PrOutcome }[] {
  const listed = new Set(shown.flatMap((repo) => repo.prs.map((pr) => `${repo.repo}#${pr.number}`)));
  const departed = Object.entries(outcomes).filter(
    ([key, outcome]) => outcome.kind !== 'updating' && !listed.has(key) && shown.some((repo) => key.startsWith(`${repo.repo}#`))
  );
  const left = new Map<string, number>();
  const kept: { key: string; outcome: PrOutcome }[] = [];
  for (let i = departed.length - 1; i >= 0; i -= 1) {
    const [key, outcome] = departed[i];
    const repo = key.slice(0, key.lastIndexOf('#'));
    const n = left.get(repo) ?? 0;
    if (n >= DEPARTED_KEEP) continue;
    left.set(repo, n + 1);
    kept.unshift({ key, outcome });
  }
  return kept;
}

/** A key on a row's compact action strip: the three writes `PrActions` offers, which `lib/prs.ts`' `*Block`s disable with a reason. */
export type PrKey = 'merge' | 'update' | 'auto-merge';

/**
 * Which keys a PR's compact strip offers and which one is the primary (the filled one). This only PICKS: whether a key is disabled, and the reason it says,
 * stays `mergeBlock` / `updateBlock` / `autoMergeBlock`'s, so a compact strip and the full one cannot disagree about what is refused.
 *
 * `merge` is always offered. `update` is offered when GitHub says the PR is behind. `auto-merge` is offered when the repo allows it OR the PR already has it
 * armed — an armed PR on a repo whose setting was turned off since must still offer the way to disarm it (`autoMergeBlock`'s own rule).
 *
 * The primary is the one thing a person most likely wants to do: update a behind PR (nothing else is sensible until it has) — but only when `updateBlock`
 * would let the click through, since a filled key that is disabled is the opposite of a primary; a draft that is behind still qualifies, because
 * `updateBlock` does not refuse a draft. Else merge a PR that is Quiet, not a draft, not blocked by this page's own reasons and whose checks are not still
 * running: a Quiet PR with checks pending is one whose auto-merge is armed (an unarmed one is Worth a look), and GitHub will merge that one itself — a
 * manual merge is likely refused while required checks run. A PR with anything wrong has no primary — the row's verdict is what the eye should land on, not a
 * bright Merge button. The primary is listed first; the rest keep `merge, update, auto-merge` order.
 */
export function compactKeys(pr: PullRequestRow, repo: PrRepoView): { keys: PrKey[]; primary: PrKey | null } {
  const offered: PrKey[] = ['merge'];
  if (pr.mergeState === 'behind') offered.push('update');
  if (repo.autoMergeAllowed || pr.autoMerge !== null) offered.push('auto-merge');
  let primary: PrKey | null = null;
  if (pr.mergeState === 'behind' && updateBlock(pr, repo, false) === null) primary = 'update';
  else if (prLevel(pr) === 'quiet' && !pr.draft && pr.checks !== 'pending' && mergeBlock(pr, repo) === null) primary = 'merge';
  const keys = primary === null ? offered : [primary, ...offered.filter((k) => k !== primary)];
  return { keys, primary };
}

/** How a Matrix cell is drawn: healthy, needs you, worth a look, in motion (pending / computing / updating), and not applicable. Colour is for failure only. */
export type CellTone = 'ok' | 'bad' | 'meh' | 'live' | 'na';

export interface MatrixCell {
  text: string;
  tone: CellTone;
}

export const MATRIX_COLUMNS = ['checks', 'review', 'mergeable', 'base', 'autoMerge'] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export const MATRIX_LABEL: Record<MatrixColumn, string> = {
  checks: 'Checks',
  review: 'Review',
  mergeable: 'Mergeable',
  base: 'Base',
  autoMerge: 'Auto-merge'
};

const NA: MatrixCell = { text: '—', tone: 'na' };

/**
 * A PR's five Matrix cells. Each cell reports ITS OWN fact and ignores `draft` and the row's level (spec, Matrix): a draft with failing checks has a red Checks
 * cell — the dot says Quiet, because the dot is the triage and the cells are the evidence. `updating` is the page's mark (`isUpdating`), which Base shows in
 * place of `behind` because the update has been asked for.
 *
 * Mergeable carries the one fact no other column can: a `blocked` / `unstable` state nothing else names. That is `levelFacts`' own unnamed-block test, so the
 * cell and the level cannot disagree about whether a block has a name.
 */
export function matrixCells(pr: PullRequestRow, updating: boolean): Record<MatrixColumn, MatrixCell> {
  const checks: MatrixCell =
    pr.checks === 'success'
      ? { text: 'passing', tone: 'ok' }
      : pr.checks === 'failure'
        ? { text: 'failing', tone: 'bad' }
        : pr.checks === 'pending'
          ? { text: 'running', tone: 'live' }
          : NA;
  const review: MatrixCell =
    pr.review === 'approved'
      ? { text: 'approved', tone: 'ok' }
      : pr.review === 'changes-requested'
        ? { text: 'changes', tone: 'bad' }
        : pr.review === 'review-required'
          ? { text: 'required', tone: 'meh' }
          : NA;
  const unnamedBlock = levelFacts(pr).some((f) => f.kind === 'blocked');
  const mergeable: MatrixCell =
    pr.mergeable === 'conflicting'
      ? { text: 'conflicts', tone: 'bad' }
      : pr.mergeable === 'unknown'
        ? { text: 'computing', tone: 'live' }
        : unnamedBlock
          ? { text: pr.mergeState, tone: 'meh' }
          : { text: 'mergeable', tone: 'ok' };
  const base: MatrixCell = updating
    ? { text: 'updating…', tone: 'live' }
    : pr.mergeState === 'behind'
      ? { text: 'behind', tone: 'meh' }
      : { text: 'up to date', tone: 'ok' };
  const autoMerge: MatrixCell = pr.autoMerge === null ? NA : { text: pr.autoMerge.method, tone: 'live' };
  return { checks, review, mergeable, base, autoMerge };
}

/** Per column, how many rows' cells are `bad` or `meh` — the number a Matrix header shows. `updating` is asked by key, the way the rows themselves ask it. */
export function columnCounts(ranked: readonly RankedPr[], updating: (key: string) => boolean): Record<MatrixColumn, number> {
  const counts: Record<MatrixColumn, number> = { checks: 0, review: 0, mergeable: 0, base: 0, autoMerge: 0 };
  for (const r of ranked) {
    const cells = matrixCells(r.pr, updating(r.key));
    for (const column of MATRIX_COLUMNS) if (cells[column].tone === 'bad' || cells[column].tone === 'meh') counts[column] += 1;
  }
  return counts;
}

/** A level's `Dot` tone. Quiet is `undefined` on purpose: `Dot` draws no tone as a toneless grey, which is the level's own look. */
export const LEVEL_DOT: Record<PrLevel, DotTone | undefined> = {
  'needs-you': 'crashed',
  'worth-a-look': 'paused',
  quiet: undefined
};

/**
 * `3h ago`, `just now`; `null` when the timestamp cannot be aged, in which case the caller leaves the age out. Inbox's meta line and Matrix's Updated column
 * share it.
 */
export function ageText(updatedAt: string, now: number): string | null {
  const age = elapsedSince(updatedAt, now);
  return age === null ? null : age === 'now' ? 'just now' : `${age} ago`;
}
