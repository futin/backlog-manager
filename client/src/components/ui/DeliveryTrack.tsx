import type { TrackStep } from '../../lib/delivery';
import { Glyph } from './Glyphs';

/**
 * DeliveryTrack — one merge request's delivery track (GitLab connection spec §7, "Delivery track"; DESIGN.md §8.9.2, drawn in §8.4.3's stage-track
 * language): a dot per step joined by a 2 px rail, in the marks `deliveryLook` hands over. It maps over `track` and never names a step position, so project 2
 * inserting a `review` step between Pipeline and Merged changes the array and not this component.
 *
 * It lives in `components/ui/` because two surfaces draw it — Jira Detail's Delivery pane and the List's Delivery cell — and `.claude/rules/board.md` gives
 * every look more than one surface draws one home here, so the List's dots and Detail's track can never disagree on what a mark looks like.
 *
 * Two shapes, one drawing. `compact` (the List's Delivery cell, mock `List.dc.html`) is the dots alone, `aria-hidden`, because the cell's own word beside
 * it already says what the dots say. The full shape (Detail's Delivery pane, mock `OptionC.dc.html`) adds each step's label and, under it, its word — an age
 * or the pipeline's word — which the caller resolves; a step with no word draws none rather than a `—`, since the mock's dash under an unreached Merged
 * would read as "known to be nothing". It is an `<ol>` there, so a screen reader hears the steps in order with their words, and each dot carries its mark
 * as `data-mark` for the sheet to tone — the mark is never the only carrier: the words and the dot's glyph say it too.
 */

/** The step's label in the full track. `closed` takes `merged`'s place on a closed-unmerged MR (`deliveryLook`), so it has a label of its own. */
const STEP_LABEL: Record<TrackStep['step'], string> = {
  pushed: 'Pushed',
  open: 'MR open',
  pipeline: 'Pipeline',
  review: 'Review',
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
  compact
}: {
  track: TrackStep[];
  words?: Partial<Record<TrackStep['step'], string>>;
  compact: boolean;
}) {
  if (compact) {
    return (
      <span className="jira-dlv-track compact" aria-hidden="true">
        {track.map((t, i) => (
          <span key={t.step} className="jira-dlv-cell">
            {/* The rail INTO a step takes that step's mark: a reached step is joined to the one before it in its own tone, an unreached one by hairline. */}
            {i > 0 && <span className="jira-dlv-bar" data-mark={t.mark} />}
            <span className="jira-dlv-dot" data-mark={t.mark} />
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
          <li key={t.step} className="jira-dlv-step">
            {/* The rail sits behind the dot row, from the previous step's centre to this one's, so the dots stay on equal columns however long a word is. */}
            {i > 0 && <span className="jira-dlv-bar" data-mark={t.mark} aria-hidden="true" />}
            <span className="jira-dlv-dot" data-mark={t.mark} aria-hidden="true">
              {dotGlyph(t.mark)}
            </span>
            <span className="jira-dlv-step-label" data-mark={t.mark}>
              {STEP_LABEL[t.step]}
            </span>
            {word !== undefined && <span className="jira-dlv-step-word">{word}</span>}
          </li>
        );
      })}
    </ol>
  );
}
