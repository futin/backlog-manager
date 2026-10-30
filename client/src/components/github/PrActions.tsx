import { useId } from 'react';
import type { ReactNode } from 'react';

import { Chip } from '../ui/Chip';
import { primaryKey } from '../../lib/pr-layouts';
import { PR_KEYS, autoMergeBlock, defaultMethod, mergeBlock, updateBlock, whyLine, type PrKey, type PrOutcome } from '../../lib/prs';
import { setAutoMerge, updateBranch } from '../../lib/prs-api';
import type { PrAutoMergeRequest, PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/** The three keys that are writes; `open` is the link and has no block. */
type WriteKey = Exclude<PrKey, 'open'>;

/**
 * The one key strip every GitHub › PRs layout draws beside a pull request (.claude/DESIGN.md §8.11, "Actions and their reasons"; spec
 * `2026-10-30-prs-page-fixes-design.md`, "One key strip, one foot"): `Merge · Auto-merge · Update · Open ↗`, in `PR_KEYS` order, on every PR in every layout —
 * never one more, one fewer, or reordered. A person who has learned the strip on one row has learned it on all of them, so which keys a PR offers is not this
 * component's call: a key that cannot be used stays in its place, greyed, and says why.
 *
 * **The primary.** At most one key is filled (`ink`), the one `primaryKey` says a person most likely wants next — `Update` on a behind PR, `Merge` on a clean
 * quiet one, none on a PR with anything wrong, where the row's verdict is what the eye should land on. The rest are `outline`. `Open ↗` is never the primary:
 * it is the way out to GitHub, not a write.
 *
 * **A blocked key is `aria-disabled`, never `disabled`.** `disabled` drops a button from the tab order and so out of a screen reader's reach, and every reason
 * here is a specific, fixable thing (`sync off`, `auto-merge not enabled on the repo`, `checks failing`). So the key keeps its focus, a click guard makes it
 * inert, its reason is its `title` and — because a tooltip cannot be read on a phone or announced reliably — the text of a visually hidden span its
 * `aria-describedby` points at: `GatedChip`'s pattern, by hand here because these keys are not dispatch gates. The reasons are `lib/prs.ts`' (`mergeBlock`,
 * `autoMergeBlock`, `updateBlock`), in their precedence order; this component only places them.
 *
 * **The why-line** under the keys is `whyLine`'s: only the reasons a row does not already state elsewhere — the repo's and the token's (`sync off` once, not
 * three times), never the PR's own facts, which its chips, cells and verdict already say. `omitUpdatingReason` drops `updating…` from it for a layout that
 * prints that word in a cell of its own (Matrix's Base column), so one row does not say it twice.
 *
 * **Merge only asks.** `Merge` is the one write that cannot be taken back, so its key sends nothing: it calls `onMerge`, the page records this row as the
 * confirming one, and `PrFoot` draws the Confirm under the row — the key itself neither swaps out nor changes its label, so the strip does not jump under the
 * pointer. Auto-merge and Update do not ask: arming is undone by the same key, and an update-branch is GitHub merging base into head, which the next push or
 * merge simply includes. `Auto-merge` is a toggle — `pressed` while armed, reading `Auto-merge ✓` with the tick `aria-hidden` so its name stays `Auto-merge`
 * either way — and arms with the repo's default method, leaving `method` out of the request entirely when the repo allows none.
 *
 * **In flight.** While a write of this PR runs, `busy` sets `disabled` on the three write keys — momentary, with no reason worth reading — and `Open ↗` stays a
 * link. `busy` is the page's in-flight set (`PrLayoutProps.inFlight`) and nothing else: this component keeps no busy state of its own, because a strip that
 * unmounts (an Inbox filter, a Matrix collapse, a layout switch) would forget it, and a key that came back while the write still ran would send a head SHA the
 * write may already have moved. The write and its outcome are the page's too (`onWrite`), so an outcome outlives a row the re-read removed.
 */
export function PrActions({
  repo,
  pr,
  updating,
  outcome,
  busy,
  onMerge,
  onWrite,
  omitUpdatingReason = false
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  /** The page's word that an update-branch of this PR is still landing — `updateBlock` reads it, and so does the primary. */
  updating: boolean;
  /** This PR's last outcome, for `whyLine`: an `updating` outcome already says `updating…`, so the why-line does not. */
  outcome: PrOutcome | undefined;
  /** A write of this PR is in flight (the page's `inFlight`). */
  busy: boolean;
  /** `Merge` was clicked: the page makes this row the confirming one. Sends nothing. */
  onMerge: () => void;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
  /** Leave `updating…` off the why-line, for a layout that already prints it beside the row (Matrix's Base cell). */
  omitUpdatingReason?: boolean;
}) {
  const ids = useId();
  const primary = primaryKey(pr, repo, updating);
  const armed = pr.autoMerge !== null;

  const arm = (): void => {
    const target = { repo: repo.repo, number: pr.number };
    const method = defaultMethod(repo.methods);
    // Built rather than spread with `method: method ?? undefined`, so a repo that allows no method sends a request with no `method` key at all — what the
    // server's request shape says, rather than relying on the serializer to drop an `undefined`.
    const body: PrAutoMergeRequest = armed ? { ...target, enable: false } : method === null ? { ...target, enable: true } : { ...target, enable: true, method };
    void onWrite(() => setAutoMerge(body));
  };

  const keys: Record<WriteKey, { label: ReactNode; block: string | null; act: () => void }> = {
    merge: { label: 'Merge', block: mergeBlock(pr, repo), act: onMerge },
    'auto-merge': {
      label: armed ? (
        <>
          Auto-merge<span aria-hidden="true"> ✓</span>
        </>
      ) : (
        'Auto-merge'
      ),
      block: autoMergeBlock(pr, repo),
      act: arm
    },
    update: {
      label: 'Update',
      block: updateBlock(pr, repo, updating),
      act: () => void onWrite(() => updateBranch({ repo: repo.repo, number: pr.number, headSha: pr.headSha }))
    }
  };
  const reasonId = (key: WriteKey): string => `${ids}-${key}`;
  const blocked = (Object.keys(keys) as WriteKey[]).filter((key) => keys[key].block !== null);
  const reasons = whyLine(pr, repo, updating, outcome?.kind).filter((reason) => !(omitUpdatingReason && reason === 'updating…'));

  return (
    <div className="prs-keys-side" data-testid={`pr-keys-${repo.repo}#${pr.number}`}>
      <div className="prs-keys">
        {PR_KEYS.map((key) => {
          if (key === 'open') {
            return (
              <Chip key={key} as="a" size={28} href={pr.url}>
                Open ↗
              </Chip>
            );
          }
          const { label, block, act } = keys[key];
          return (
            <Chip
              key={key}
              size={28}
              variant={key === primary ? 'ink' : 'outline'}
              pressed={key === 'auto-merge' ? armed : undefined}
              disabled={busy}
              title={block ?? undefined}
              aria-disabled={block === null ? undefined : 'true'}
              aria-describedby={block === null ? undefined : reasonId(key)}
              onClick={() => {
                // The other half of `aria-disabled`: the browser does not stop a click on a control that is only labelled disabled, so this does.
                if (block === null) act();
              }}
            >
              {label}
            </Chip>
          );
        })}
      </div>
      {/* Siblings of the keys, not children: inside a button the reason would become part of its accessible name, and a key named `Merge checks failing`
          is not a key called Merge. Visually hidden, because the visible copy is the why-line's job and it says only what the row does not. */}
      {blocked.map((key) => (
        <span key={key} id={reasonId(key)} className="sr-only">
          {keys[key].block}
        </span>
      ))}
      {reasons.length > 0 && <p className="prs-why">{reasons.join(' · ')}</p>}
    </div>
  );
}
