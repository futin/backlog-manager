import type { ReactNode } from 'react';

import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { deliveryLook, mrRepo, type DeliveryNext, type TrackStep } from '../../lib/delivery';
import { polledPhrase } from '../../lib/jira';
import { reviewStepTitleSuffix, reviewStepWord } from '../../lib/review-copy';
import { pollAge } from '../../lib/tracker';
import type { GitlabMr, JiraIssue } from '../../../../shared/types';
import { DeliveryTrack } from '../ui/DeliveryTrack';

/**
 * DeliveryPane — one Delivery row's expanded pane: one target's lead MR (Jira detail tabs spec §4.2; GitLab connection spec §7.1; DESIGN.md §8.9.6, Delivery
 * › the expanded row). The head (the `!iid ↗` link out, `<repo> → <target>`, and `polled <age>` of the MR's own project pushed right), the full track with
 * each step's word, then `children` — the row's next row (`NextRow`). The ticket's delivery is NOT resolved here any more: `JiraDeliveryTab` resolves it
 * once, draws the no-MR and unknown sentences, groups the MRs into targets and draws one of these per open row, so the pane is a drawing of one MR it is
 * handed. The `Also:` line is gone with it — the other targets are rows of their own and the rest of a target are its older MRs (§4.3). `via <parent>` is the
 * tab's head line's, once, not every pane's (§4.2).
 *
 * Every word and tone comes from `lib/delivery.ts`: `deliveryLook` gives the marks, `deliveryNext` (handed in as `next`) which step is ringed and which are
 * ignored. The ringed step's word is `next · <word>` (`next` alone with no word) in place of its own, and an ignored step's word is `ignored`, a button that
 * un-ignores it (§4.5.1) — drawn for every step the entry still holds, whichever step is ringed. Links go out in a new tab with no referrer, the
 * `Open in Jira ↗` link's rule: a GitLab page must not learn the board's address from the click.
 *
 * **The Review step** (CodeRabbit review spec §5.1): its word is `reviewStepWord`'s and its `title` carries `reviewStepTitleSuffix` when the latest read
 * failed; Pipeline keeps its own word whatever the review says, so `pipeline passed` and `2 open · 1 major` sit side by side.
 */

/**
 * The word under each step (spec §7.1): Pushed and MR open carry the MR's created-at age — the moment its branch was pushed and the MR opened are one GitLab
 * fact, and the payload has no earlier one — Merged its merged-at age, and Pipeline the table's word for an open, non-draft MR. A draft's word, `draft`, sits
 * at MR open, where its grey mark is (spec §7, "A draft MR is `draft` at MR open"). A merged MR's Pipeline step is drawn reached with no word, and a closed
 * MR's is `off`: pipeline status is not read for either (§6.3), and a word there would be a guess.
 */
function stepWords(mr: GitlabMr, now: number): Partial<Record<TrackStep['step'], ReactNode>> {
  const created = pollAge(mr.createdAt, now) ?? undefined;
  const words: Partial<Record<TrackStep['step'], ReactNode>> = { pushed: created, open: created };
  if (mr.state === 'merged') {
    const merged = mr.mergedAt === null ? null : pollAge(mr.mergedAt, now);
    if (merged !== null) words.merged = merged;
  } else if (mr.state === 'opened') {
    if (mr.draft) words.open = 'draft';
    else words.pipeline = deliveryLook(mr, now).pipelineWord;
    // A draft is read for review too (spec §5.3), so its Review step carries the word as an open MR's does.
    const review = reviewStepWord(mr.review, now);
    if (review !== null) words.review = review;
  }
  return words;
}

/** The Review step's hover text: its word and, when the latest read failed, how old the facts are — so a stale count never reads as current. */
function stepTitles(mr: GitlabMr, now: number): Partial<Record<TrackStep['step'], string>> {
  const suffix = mr.state === 'opened' ? reviewStepTitleSuffix(mr.review, now) : '';
  const word = suffix === '' ? null : reviewStepWord(mr.review, now);
  return word === null ? {} : { review: `${word}${suffix}` };
}

/** An MR's link out: `!iid` with the arrow beside it, `aria-hidden` so the link's name is the MR it opens and not a glyph. */
export function MrLink({ mr, className }: { mr: GitlabMr; className: string }) {
  return (
    <a className={className} href={mr.webUrl} target="_blank" rel="noopener noreferrer" title={mr.title}>
      {`!${mr.iid}`}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

const IGNORED_TITLE = 'ignored in this browser — click to stop ignoring';

export function DeliveryPane({
  mr,
  now,
  next,
  onUnignore,
  children
}: {
  /** One target's lead MR. */
  mr: GitlabMr;
  now: number;
  /** `deliveryNext` for `mr` — what is ringed and what is ignored. */
  next: DeliveryNext;
  /** The `ignored` word's click: drop that step's ignore for this MR. */
  onUnignore: (step: 'review' | 'pipeline') => void;
  /** The next row, drawn under the track. */
  children?: ReactNode;
}) {
  const index = useDeliveryIndex();
  const words = stepWords(mr, now);
  if (next.step !== null) words[next.step] = next.word === null ? 'next' : `next · ${next.word}`;
  const ignored: Partial<Record<TrackStep['step'], boolean>> = {};
  for (const step of ['review', 'pipeline'] as const) {
    if (!next.ignored[step]) continue;
    ignored[step] = true;
    words[step] = (
      <button type="button" className="jira-dlv-ignored" title={IGNORED_TITLE} onClick={() => onUnignore(step)}>
        ignored
      </button>
    );
  }
  const polledAt = index?.byPath.get(mr.project)?.polledAt ?? null;
  return (
    <section className="jira-dlv" aria-label={`!${mr.iid} into ${mr.targetBranch}`}>
      <div className="jira-dlv-head">
        <MrLink mr={mr} className="jira-dlv-link" />
        <span className="jira-dlv-meta jira-dlv-target">{`${index === null ? mr.project : mrRepo(mr, index)} → ${mr.targetBranch}`}</span>
        <span className="jira-dlv-meta jira-dlv-polled">{polledPhrase(polledAt, now)}</span>
      </div>
      <DeliveryTrack track={deliveryLook(mr, now).track} words={words} titles={stepTitles(mr, now)} compact={false} next={next.step} ignored={ignored} />
      {children}
    </section>
  );
}
