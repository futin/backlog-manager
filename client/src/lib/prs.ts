import { MERGE_METHODS, PR_UPDATING_MS } from '../../../shared/types';
import type { PillTone } from '../components/ui/Pill';
import type { MergeMethod, PrRepoView, PrWriteResult, PullRequestRow } from '../../../shared/types';

/**
 * What the GitHub › PRs page says about a pull request, derived once (`.claude/DESIGN.md` §8.11). Pure and clock-free except where a caller hands `now` in:
 * the chips on a row, the reason a write control is disabled, the repo order, and the sentence a finished write leaves behind all come from here, so the row,
 * its action menu and the page's status line cannot describe one PR three ways.
 *
 * Every reason is a value a control can hang a `title` on and a caller can test for `null` — a block is never thrown and never a boolean, because a disabled
 * button that cannot say why reads as a broken one. Each `*Block` lists its reasons in precedence order, first match wins: a person who cannot act at all (sync
 * off) is told that, not the narrower thing behind it.
 */

/** The one line a row says about its last write: a finished outcome, the server's refusal verbatim, or the `updating…` an update-branch leaves. */
export interface PrOutcome {
  text: string;
  kind: 'ok' | 'error' | 'updating';
}

/**
 * An `update-requested` mark: the head SHA the update was asked at, and when the row stops saying `updating…` if that head never moved. Here rather than in the
 * page because every layout reads it through `isUpdating`, and a layout switch mid-update must keep the mark.
 */
export interface UpdateMark {
  sha: string;
  until: number;
}

/** A chip a row draws: the label is the whole claim, the tone is `Pill`'s vocabulary. */
export interface PrChip {
  label: string;
  tone: PillTone;
}

/**
 * The chips of one row, in the order a person reads a PR: is it a draft, what do reviewers say, what do the checks say, can it merge, is it behind, is
 * auto-merge armed. `checks: 'none'` draws nothing — a repo with no checks has nothing to say, and `checks passing` there would be a claim GitHub never made.
 * `mergeable: 'unknown'` draws nothing either: GitHub is still computing it, which is a moment, not a state worth a chip.
 */
export function prChips(pr: PullRequestRow): PrChip[] {
  const chips: PrChip[] = [];
  if (pr.draft) chips.push({ label: 'draft', tone: 'neutral' });
  if (pr.review === 'approved') chips.push({ label: 'approved', tone: 'done' });
  else if (pr.review === 'changes-requested') chips.push({ label: 'changes requested', tone: 'bad' });
  else if (pr.review === 'review-required') chips.push({ label: 'review required', tone: 'warn' });
  if (pr.checks === 'success') chips.push({ label: 'checks passing', tone: 'done' });
  else if (pr.checks === 'failure') chips.push({ label: 'checks failing', tone: 'bad' });
  else if (pr.checks === 'pending') chips.push({ label: 'checks pending', tone: 'warn' });
  if (pr.mergeable === 'conflicting') chips.push({ label: 'conflicts', tone: 'bad' });
  if (pr.mergeState === 'behind') chips.push({ label: 'behind base', tone: 'warn' });
  if (pr.autoMerge !== null) chips.push({ label: `auto-merge · ${pr.autoMerge.method}`, tone: 'live' });
  return chips;
}

/**
 * Why Merge is disabled, or `null`. `sync off` is a short label, not the repo's sentence: the view draws `repo.syncOff` (the server's `syncOffBlock`, its
 * one home) once in the repo's heading, so three copies of it per row would only repeat the fix. `checks failing` is the page's courtesy, not GitHub's rule:
 * a repo whose branch protection lets a red PR through still gets the reason before the click rather than after it.
 */
export function mergeBlock(pr: PullRequestRow, repo: PrRepoView): string | null {
  if (repo.syncOff !== null) return 'sync off';
  if (pr.draft) return 'draft';
  if (pr.mergeable === 'conflicting') return 'not mergeable';
  if (pr.checks === 'failure') return 'checks failing';
  if (repo.methods.length === 0) return 'no merge method allowed';
  return null;
}

/**
 * Why Update branch is disabled, or `null`. `canUpdateBranch` is GitHub's `viewerCanUpdateBranch`, which is false for "already up to date" and for "this
 * token may not" alike — so the row's `mergeState` tells them apart: a PR GitHub says is BEHIND its base is not up to date, and the only reason left is
 * that this token may not update it. Any other state reads up to date, which is what it almost always is.
 */
export function updateBlock(pr: PullRequestRow, repo: PrRepoView): string | null {
  if (repo.syncOff !== null) return 'sync off';
  if (pr.crossRepository && !pr.maintainerCanModify) return 'fork does not allow edits';
  if (!pr.canUpdateBranch) return pr.mergeState === 'behind' ? 'no permission to update' : 'already up to date';
  return null;
}

/**
 * Why the auto-merge toggle is disabled, or `null`. Only ENABLING needs the repo's setting: disarming an armed one must stay possible after somebody turns
 * the repo setting off, or a PR would be left armed with no way to take it back from this page. `sync off` blocks both directions, as it blocks every write.
 */
export function autoMergeBlock(pr: PullRequestRow, repo: PrRepoView): string | null {
  if (repo.syncOff !== null) return 'sync off';
  if (pr.autoMerge === null && !repo.autoMergeAllowed) return 'auto-merge not enabled on the repo';
  return null;
}

/** The method the merge control starts on: the first the repo allows, in `MERGE_METHODS` order (squash, merge, rebase), or `null` when it allows none. */
export function defaultMethod(methods: readonly MergeMethod[]): MergeMethod | null {
  return MERGE_METHODS.find((method) => methods.includes(method)) ?? null;
}

/**
 * How long a row says `updating…` after an update-branch was accepted. GitHub answers 202 and does the merge later; the row stays marked until the head SHA
 * moves (the poll saw it land) or this runs out, whichever is first, so a slow update does not leave the spinner up forever. The number lives in `shared/`
 * (`PR_UPDATING_MS`) because the server makes the repo's cache entry due again at the same moment — the page's one re-read must reach GitHub, not the TTL.
 */
export const UPDATING_MS = PR_UPDATING_MS;

/** Is this PR still waiting on an update-branch it asked for? The mark is keyed by the head SHA it was made at, so a head that moved clears it by itself. */
export function isUpdating(mark: { sha: string; until: number } | undefined, pr: PullRequestRow, now: number): boolean {
  return mark !== undefined && pr.headSha === mark.sha && now < mark.until;
}

function newest(prs: readonly PullRequestRow[]): number {
  return prs.reduce((max, pr) => Math.max(max, Date.parse(pr.updatedAt) || 0), 0);
}

/**
 * The page's repo order: repos with open PRs first, the one touched most recently on top; then the empty ones by name. Inside a repo the PRs are newest
 * update first. The server already sorts a repo's rows that way, but the page does not trust a payload's order for what it shows people. Returns copies.
 */
export function groupRepos(repos: readonly PrRepoView[]): PrRepoView[] {
  const sorted = repos.map((repo) => ({ ...repo, prs: [...repo.prs].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)) }));
  const withPrs = sorted.filter((repo) => repo.prs.length > 0).sort((a, b) => newest(b.prs) - newest(a.prs));
  const empty = sorted.filter((repo) => repo.prs.length === 0).sort((a, b) => a.repo.localeCompare(b.repo));
  return [...withPrs, ...empty];
}

/** The one line a finished write leaves on the page. `pr` and `reread` are the row's business; this is only what happened. */
export function outcomeLine(result: PrWriteResult): string {
  switch (result.outcome) {
    case 'merged':
      return 'merged';
    case 'already-merged':
      return 'already merged';
    case 'auto-merge-enabled':
      return 'auto-merge armed';
    case 'auto-merge-disabled':
      return 'auto-merge off';
    case 'noop':
      return 'no auto-merge was armed';
    case 'update-requested':
      return 'updating…';
  }
}
