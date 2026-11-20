import type { ReactNode } from 'react';

import type { TrackStep } from '../../lib/delivery';
import { Glyph } from './Glyphs';

/**
 * DeliveryTrack — one merge request's delivery track (GitLab connection spec §7, "Delivery track"; DESIGN.md §8.9.2, drawn in §8.4.3's stage-track
 * language): a dot per step joined by a 2 px rail, in the marks `deliveryLook` hands over. It maps over `track` and never names a step position, so project 2
 * inserting a `review` step between MR open and Pipeline changes the array and not this component.
 *
 * It lives in `components/ui/` because two surfaces draw it — Jira Detail's Delivery pane and the List's Delivery cell — and `.claude/rules/board.md` gives
 * every look more than one surface draws one home here, so the List's dots and Detail's track can never disagree on what a mark looks like.
 *
 * Two shapes, one drawing. `compact` (the List's Delivery cell, mock `List.dc.html`) is the dots alone, `aria-hidden`, because the cell's own word beside
 * it already says what the dots say. The full shape (Detail's Delivery pane, mock `OptionC.dc.html`) adds each step's label and, under it, its word — an age
 * or the pipeline's word — which the caller resolves; a step with no word draws none rather than a `—`, since the mock's dash under an unreached Merged
 * would read as "known to be nothing". It is an `<ol>` there, so a screen reader hears the steps in order with their words, and each dot carries its mark
 * as `data-mark` for the sheet to tone — the mark is never the only carrier: the words and the dot's glyph say it too.
 *
 * **The next step and an ignored one** (Jira detail tabs spec §4.5, §4.5.1; DESIGN.md §8.9.6) are Detail's alone, so both props are optional and the List's
 * cell passes neither. `next` rings that step's dot — `data-next` on the dot (both shapes) and on the full shape's `<li>` and word, which the sheet draws as
 * a dashed `--cyan` outline and a cyan word, dashed so it never reads as a reached green step — and the caller hands the `next · <word>` text in `words`.
 * `ignored` draws a step grey with a tick, whatever `deliveryLook` marked it, because the reader has said it is done for them; the word (`ignored`, a
 * button the caller builds) comes through `words` too, which is why a word is a node and not a string.
 */

/** The step's label in the full track. `closed` takes `merged`'s place on a closed-unmerged MR (`deliveryLook`), so it has a label of its own. */
const STEP_LABEL: Record<TrackStep['step'], string> = {
  pushed: 'Pushed',
  open: 'MR open',
  review: 'Review',
  pipeline: 'Pipeline',
  merged: 'Merged',
  closed: 'Closed'
};

/**
 * The mark inside a full-size dot: a tick on a reached step (plain `on`, a passed pipeline, every step of a merged MR) and a cross on a failed pipeline. Amber
 * and grey draw an empty filled dot — `running`, `canceled`, `draft` and `Closed` are words, not verdicts, and a glyph there would claim more than the word.
 */
function dotGlyph(mark: TrackStep['mark']) {
  if (mark === 'on' || mark === 'green' || mark === 'magenta') return <Glyph name="tick" size={10} />;
  if (mark === 'red') return <Glyph name="cross" size={10} />;
  return null;
}

export function DeliveryTrack({
  track,
  words = {},
  titles = {},
  compact,
  next = null,
  ignored = {}
}: {
  track: TrackStep[];
  words?: Partial<Record<TrackStep['step'], ReactNode>>;
  /** A step's hover text, where its word is not the whole story (the Review step's `not refreshed since <age>`). Full shape only. */
  titles?: Partial<Record<TrackStep['step'], string>>;
  compact: boolean;
  /** The step `deliveryNext` rings, or `null` (nothing is next: a waiting or a done MR). Detail only. */
  next?: TrackStep['step'] | null;
  /** The steps the reader ignored in this browser, drawn grey with a tick. Detail only. */
  ignored?: Partial<Record<TrackStep['step'], boolean>>;
}) {
  // An ignored step's mark is grey whatever the MR says; the rail INTO it keeps the MR's own mark, since what reached it did happen.
  const markOf = (t: TrackStep): TrackStep['mark'] => (ignored[t.step] ? 'grey' : t.mark);
  const glyphOf = (t: TrackStep) => (ignored[t.step] ? <Glyph name="tick" size={10} /> : dotGlyph(t.mark));
  const ring = (t: TrackStep): true | undefined => (t.step === next ? true : undefined);
  if (compact) {
    return (
      <span className="jira-dlv-track compact" aria-hidden="true">
        {track.map((t, i) => (
          <span key={t.step} className="jira-dlv-cell">
            {/* The rail INTO a step takes that step's mark: a reached step is joined to the one before it in its own tone, an unreached one by hairline. */}
            {i > 0 && <span className="jira-dlv-bar" data-mark={t.mark} />}
            <span className="jira-dlv-dot" data-mark={markOf(t)} data-next={ring(t)} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <ol className="jira-dlv-track">
      {track.map((t, i) => {
        const word = words[t.step];
        return (
          <li key={t.step} className="jira-dlv-step" title={titles[t.step]} data-next={ring(t)}>
            {/* The rail sits behind the dot row, from the previous step's centre to this one's, so the dots stay on equal columns however long a word is. */}
            {i > 0 && <span className="jira-dlv-bar" data-mark={t.mark} aria-hidden="true" />}
            <span className="jira-dlv-dot" data-mark={markOf(t)} data-next={ring(t)} aria-hidden="true">
              {glyphOf(t)}
            </span>
            <span className="jira-dlv-step-label" data-mark={markOf(t)}>
              {STEP_LABEL[t.step]}
            </span>
            {word !== undefined && (
              <span className="jira-dlv-step-word" data-next={ring(t)}>
                {word}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
