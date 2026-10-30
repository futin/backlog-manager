import { useId, useState } from 'react';

import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Select } from '../ui/Select';
import { useMountedRef } from '../../hooks/useMountedRef';
import { compactKeys, type PrKey } from '../../lib/pr-layouts';
import { autoMergeBlock, defaultMethod, mergeBlock, updateBlock } from '../../lib/prs';
import { mergePr, setAutoMerge, updateBranch } from '../../lib/prs-api';
import type { MergeMethod, PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * The three writes a pull request offers on GitHub › PRs, as one strip every layout draws (.claude/DESIGN.md §8.11, "Row anatomy" and "Layouts"; spec
 * `2026-10-29-prs-layouts-design.md`, "Writes and outcomes"). `variant="full"` is the strip Cards has always had: the merge-method select, Merge, Enable /
 * Disable auto-merge and Update branch. `variant="compact"` is Inbox's: the two or three keys `compactKeys` picked for this PR, the primary one filled, plus
 * an `Open ↗` link — a front for this same component, never a second implementation of the writes, so the two cannot disagree about what is refused or sent.
 *
 * A blocked action is disabled AND says why in text beside it (`.prs-why`), wired to the button as its `aria-describedby` — a reason only in a tooltip
 * cannot be read on a phone, which is half of where this board is read. The reasons are `lib/prs.ts`' (`mergeBlock`, `updateBlock`, `autoMergeBlock`), in
 * their precedence order; this component only places them. A sync-off repo's reason is the short `sync off` on each action, because the repo heading already
 * carries the server's full sentence once. The compact strip shows the same reasons, so a disabled key is never a silent dead end.
 *
 * Merge is the one write that cannot be taken back, so it asks first through `Confirm` — inline, in place of the Merge chip, naming the PR, its base and the
 * method the click would use. `Confirm` joins `useDialogEscape` itself; this component binds no key. Auto-merge and update branch do not ask: arming is undone
 * by the same control, and an update-branch is GitHub merging base into head, which the next push or merge simply includes. The compact `Merge…` is not the
 * merge: it opens the full strip in place, where the method is visible and the Confirm is one click further, so a small key can never merge by itself.
 *
 * While a write is in flight every action is disabled, until the page's re-read after it lands: a second click would send the head SHA the first write may
 * already have moved, and GitHub's 409 for that is a refusal the page caused itself. The write and its outcome are the page's (`onWrite`) — this component
 * hands it the call and records nothing — so an outcome outlives a row the re-read removed. `busy`, `confirming` and the picked method live here and survive
 * the compact strip opening into the full one, so a click on `Merge…` never forgets a write already in flight. They do NOT survive this component unmounting,
 * which is why the page's in-flight set arrives as the `busy` prop: a fold, a collapse or a layout switch drops the local state and the page's answer holds
 * the keys until its re-read lands.
 */
export function PrActions({
  repo,
  pr,
  onWrite,
  variant,
  onOpen,
  busy: pending = false
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
  variant: 'full' | 'compact';
  /**
   * Called once when the compact strip's `Merge…` opens the full one, so a layout can give the opened strip the room it needs (Inbox: the item's full width).
   */
  onOpen?: () => void;
  /**
   * The page's own word that a write of THIS PR is still running, OR'd with the local one. The local `busy` dies with this component — an Inbox fold, a Matrix
   * collapse and a layout switch each unmount the strip — and a key that came back while its write was still in flight would send a head SHA the write may
   * already have moved. The page owns the in-flight set (`PrLayoutProps.inFlight`), so a strip drawn after the write started is born disabled.
   */
  busy?: boolean;
}) {
  const ids = useId();
  const mounted = useMountedRef();
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || pending;
  const [confirming, setConfirming] = useState(false);
  /* The compact strip's `Merge…` opens the full strip in place; nothing closes it again, because the page's re-read is what changes a PR's keys. */
  const [expanded, setExpanded] = useState(false);
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
  const update = updateBlock(pr, repo, false);
  const autoMerge = autoMergeBlock(pr, repo);
  const armed = pr.autoMerge !== null;

  /** A blocked action's reason, beside it and named as its description. */
  const why = (reason: string | null, suffix: string) =>
    reason === null ? null : (
      <span id={`${ids}-${suffix}`} className="prs-why">
        {reason}
      </span>
    );
  const describedBy = (reason: string | null, suffix: string): string | undefined => (reason === null ? undefined : `${ids}-${suffix}`);

  const runUpdate = (): void => run(() => updateBranch({ repo: repo.repo, number: pr.number, headSha: pr.headSha }));
  const runAutoMerge = (): void =>
    run(() =>
      setAutoMerge(
        armed ? { repo: repo.repo, number: pr.number, enable: false } : { repo: repo.repo, number: pr.number, enable: true, method: method ?? undefined }
      )
    );
  const autoLabel = armed ? 'Disable auto-merge' : 'Enable auto-merge';

  if (variant === 'compact' && !expanded) {
    const { keys, primary } = compactKeys(pr, repo);
    const spec: Record<PrKey, { label: string; reason: string | null; suffix: string; onClick: () => void }> = {
      merge: {
        label: 'Merge…',
        reason: merge,
        suffix: 'merge',
        onClick: () => {
          setExpanded(true);
          onOpen?.();
        }
      },
      update: { label: 'Update branch', reason: update, suffix: 'update', onClick: runUpdate },
      'auto-merge': { label: autoLabel, reason: autoMerge, suffix: 'auto', onClick: runAutoMerge }
    };
    return (
      <div className="prs-actions">
        {keys.map((key) => {
          const s = spec[key];
          return (
            <span key={key} className="prs-action">
              <Chip
                size={28}
                variant={key === primary ? 'ink' : undefined}
                disabled={busy || s.reason !== null}
                aria-describedby={describedBy(s.reason, s.suffix)}
                onClick={s.onClick}
              >
                {s.label}
              </Chip>
              {why(s.reason, s.suffix)}
            </span>
          );
        })}
        <a className="prs-open" href={pr.url} target="_blank" rel="noreferrer">
          Open ↗
        </a>
      </div>
    );
  }

  return (
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
        <Chip size={28} disabled={busy || autoMerge !== null} aria-describedby={describedBy(autoMerge, 'auto')} onClick={runAutoMerge}>
          {autoLabel}
        </Chip>
        {why(autoMerge, 'auto')}
      </span>
      <span className="prs-action">
        <Chip size={28} disabled={busy || update !== null} aria-describedby={describedBy(update, 'update')} onClick={runUpdate}>
          Update branch
        </Chip>
        {why(update, 'update')}
      </span>
    </div>
  );
}
