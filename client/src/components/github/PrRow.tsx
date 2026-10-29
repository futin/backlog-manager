import { useId, useState } from 'react';

import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Pill } from '../ui/Pill';
import { Select } from '../ui/Select';
import { useMountedRef } from '../../hooks/useMountedRef';
import { autoMergeBlock, defaultMethod, mergeBlock, prChips, updateBlock, type PrOutcome } from '../../lib/prs';
import { mergePr, setAutoMerge, updateBranch } from '../../lib/prs-api';
import type { MergeMethod, PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * One open pull request on GitHub › PRs (.claude/DESIGN.md §8.11, "Row anatomy").
 *
 * Reads, top to bottom: `#<n>` (a link to github.com, in a new tab — the page manages the PR, it does not replace GitHub's view of it) and the title; the
 * author and `head → base`; the state chips (`prChips`) and, when something on this machine or another is still working the branch, the warn-toned
 * warning (`prRunWarning`, derived by the page and handed in) — a warning, never a refusal, so every action stays as enabled as it would be without it; the
 * three actions; and one outcome line.
 *
 * A blocked action is disabled AND says why in text beside it (`.prs-why`), wired to the button as its `aria-describedby` — a reason only in a tooltip
 * cannot be read on a phone, which is half of where this board is read. The reasons are `lib/prs.ts`' (`mergeBlock`, `updateBlock`, `autoMergeBlock`), in
 * their precedence order; this row only places them. A sync-off repo's reason is the short `sync off` on each action, because the repo heading already
 * carries the server's full sentence once.
 *
 * Merge is the one write that cannot be taken back, so it asks first through `Confirm` — inline, in place of the Merge chip, naming the PR, its base and
 * the method the click would use. `Confirm` joins `useDialogEscape` itself; this row binds no key. Auto-merge and update branch do not ask: arming is undone
 * by the same control, and an update-branch is GitHub merging base into head, which the next push or merge simply includes.
 *
 * While a write is in flight every action on the row is disabled, until the page's re-read after it lands: a second click would send the head SHA the
 * first write may already have moved, and GitHub's 409 for that is a refusal the page caused itself. The write and its outcome are the page's
 * (`onWrite`), so an outcome outlives a row the re-read removed — a merged PR leaves the open list, and `PullRequestsView` keeps its line.
 */
export function PrRow({
  repo,
  pr,
  warning,
  outcome,
  updating,
  onWrite
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  /** `prRunWarning`'s reading for this PR, or `null`. */
  warning: string | null;
  outcome: PrOutcome | undefined;
  /** `isUpdating` for this PR's mark — the page owns the mark and its clock. */
  updating: boolean;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
}) {
  const ids = useId();
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /* The picked method, honoured only while the repo still allows it: a repo setting changed on github.com between two reads must not leave the select
     sending a method GitHub would refuse, so a stale pick falls back to the repo's default rather than being kept. */
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const method = picked !== null && repo.methods.includes(picked) ? picked : defaultMethod(repo.methods);

  const run = (call: () => Promise<PrWriteResult>): void => {
    setBusy(true);
    void onWrite(call).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  const merge = mergeBlock(pr, repo);
  const update = updateBlock(pr, repo);
  const autoMerge = autoMergeBlock(pr, repo);
  const armed = pr.autoMerge !== null;
  const key = `${repo.repo}#${pr.number}`;

  /** A blocked action's reason, beside it and named as its description. */
  const why = (reason: string | null, suffix: string) =>
    reason === null ? null : (
      <span id={`${ids}-${suffix}`} className="prs-why">
        {reason}
      </span>
    );
  const describedBy = (reason: string | null, suffix: string): string | undefined => (reason === null ? undefined : `${ids}-${suffix}`);

  const line = outcome === undefined || (outcome.kind === 'updating' && !updating) ? null : outcome;

  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
      <div className="prs-row-title">
        <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
          #{pr.number}
        </a>
        <span className="prs-title">{pr.title}</span>
      </div>
      <div className="prs-meta">
        <span>{pr.author ?? 'ghost'}</span>
        <span aria-hidden="true">·</span>
        <span className="prs-branches">{`${pr.head} → ${pr.base}`}</span>
      </div>
      {(prChips(pr).length > 0 || warning !== null) && (
        <div className="prs-chips">
          {prChips(pr).map((chip) => (
            <Pill key={chip.label} tone={chip.tone}>
              {chip.label}
            </Pill>
          ))}
          {warning !== null && <Pill tone="warn">{warning}</Pill>}
        </div>
      )}
      <div className="prs-actions">
        {method !== null && (
          <Select<MergeMethod>
            label="Merge method"
            value={method}
            options={repo.methods.map((m) => ({ value: m, label: m }))}
            onChange={setPicked}
            disabled={busy || confirming}
          />
        )}
        <span className="prs-action">
          {confirming && method !== null ? (
            <Confirm
              label={`Confirm merge of #${pr.number}`}
              acceptLabel="Merge"
              dismissLabel="Cancel"
              testId="pr-merge-confirm"
              onDismiss={() => setConfirming(false)}
              onAccept={() => {
                setConfirming(false);
                run(() => mergePr({ repo: repo.repo, number: pr.number, method, headSha: pr.headSha }));
              }}
            >
              {`Merge #${pr.number} into ${pr.base} (${method})?`}
            </Confirm>
          ) : (
            <Chip size={28} variant="ink" disabled={busy || merge !== null} aria-describedby={describedBy(merge, 'merge')} onClick={() => setConfirming(true)}>
              Merge
            </Chip>
          )}
          {!confirming && why(merge, 'merge')}
        </span>
        <span className="prs-action">
          <Chip
            size={28}
            disabled={busy || autoMerge !== null}
            aria-describedby={describedBy(autoMerge, 'auto')}
            onClick={() =>
              run(() =>
                setAutoMerge(
                  armed ? { repo: repo.repo, number: pr.number, enable: false } : { repo: repo.repo, number: pr.number, enable: true, method: method ?? undefined }
                )
              )
            }
          >
            {armed ? 'Disable auto-merge' : 'Enable auto-merge'}
          </Chip>
          {why(autoMerge, 'auto')}
        </span>
        <span className="prs-action">
          <Chip
            size={28}
            disabled={busy || update !== null}
            aria-describedby={describedBy(update, 'update')}
            onClick={() => run(() => updateBranch({ repo: repo.repo, number: pr.number, headSha: pr.headSha }))}
          >
            Update branch
          </Chip>
          {why(update, 'update')}
        </span>
      </div>
      {line !== null && (
        <p className={line.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'} data-testid="pr-outcome" role="status">
          {line.text}
        </p>
      )}
    </li>
  );
}
