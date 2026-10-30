import { useState } from 'react';

import { Confirm } from '../ui/Confirm';
import { Select } from '../ui/Select';
import { PrOutcomeLine, hasOutcomeLine } from './PrOutcomeLine';
import { defaultMethod, mergeBlock, type PrOutcome } from '../../lib/prs';
import { mergePr } from '../../lib/prs-api';
import type { MergeMethod, PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * The foot of a GitHub › PRs row (.claude/DESIGN.md §8.11, "Row anatomy" and "The outcome line"; spec `2026-10-30-prs-page-fixes-design.md`, "One key strip,
 * one foot"): the one slot under a pull request where the merge Confirm and a write's outcome appear, in that order, in every layout. Each layout places it
 * directly under the row's text at the row's full width — never inside the keys column, where a select and a question do not fit — so a person who has seen
 * a Confirm in Inbox finds it in the same place in Matrix and in Cards.
 *
 * **The Confirm.** Drawn while the page names this row as the confirming one AND `mergeBlock` lets the merge through: a re-read that blocks the merge (checks
 * turned red, a draft, no method left on the repo) takes the Confirm away under the person rather than leaving an accept that would send a merge the strip
 * now refuses. Its question carries the method `Select` — the strip no longer does — then `Merge #<n> into <base>?`; `Confirm` joins `useDialogEscape`
 * itself, so this binds no key. Accept hands the merge to `onWrite` once and does nothing else: the page's `write` clears the confirming key when it matches,
 * before the call, so the Confirm is gone while the POST is still out and an in-flight row has no Confirm to accept twice. Dismiss and Escape are `onDismiss`.
 *
 * Renders nothing at all when neither the Confirm nor the outcome line draws, so a quiet row carries no empty foot for a layout to space around.
 */
export function PrFoot({
  repo,
  pr,
  outcome,
  updating,
  confirming,
  onDismiss,
  onWrite
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  outcome: PrOutcome | undefined;
  /** The page's word that an update-branch of this PR is still landing; an `updating` outcome is drawn only while it holds (`hasOutcomeLine`). */
  updating: boolean;
  /** The page names this row as the confirming one. */
  confirming: boolean;
  /** Cancel or Escape: the page clears the confirming key. Sends nothing. */
  onDismiss: () => void;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
}) {
  const asking = confirming && mergeBlock(pr, repo) === null;
  if (!asking && !hasOutcomeLine(outcome, updating)) return null;
  return (
    <div className="prs-foot">
      {asking && <MergeConfirm repo={repo} pr={pr} onDismiss={onDismiss} onWrite={onWrite} />}
      <PrOutcomeLine outcome={outcome} updating={updating} />
    </div>
  );
}

/**
 * The Confirm itself, its own component so the picked method lives exactly as long as one Confirm does: each open starts on the repo's default
 * (`defaultMethod`), the spec's "preselected", rather than on a method picked for a merge that was cancelled. While it is open, the pick is honoured only
 * while the repo still allows it — a setting changed on github.com between two reads must not leave the select sending a method GitHub would refuse, so a
 * stale pick falls back to the default rather than being kept.
 */
function MergeConfirm({
  repo,
  pr,
  onDismiss,
  onWrite
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  onDismiss: () => void;
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
}) {
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const method = picked !== null && repo.methods.includes(picked) ? picked : defaultMethod(repo.methods);
  // Unreachable in practice — `mergeBlock` answers `no merge method allowed` for a repo with none, so a Confirm the foot draws always has a default — and
  // here for the type: `mergePr` takes a method, never `null`.
  if (method === null) return null;
  return (
    <Confirm
      label={`Confirm merge of #${pr.number}`}
      testId="pr-merge-confirm"
      acceptLabel="Merge"
      dismissLabel="Cancel"
      onDismiss={onDismiss}
      onAccept={() => void onWrite(() => mergePr({ repo: repo.repo, number: pr.number, method, headSha: pr.headSha }))}
    >
      <Select<MergeMethod> label="Merge method" value={method} options={repo.methods.map((m) => ({ value: m, label: m }))} onChange={setPicked} />{' '}
      {`Merge #${pr.number} into ${pr.base}?`}
    </Confirm>
  );
}
