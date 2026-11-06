/**
 * FoldMark — the `↳ <key>` pill that says a session runs on a different ticket from the one the surface is drawn for (.claude/DESIGN.md §8.9.1).
 *
 * Two surfaces draw it, which is why it lives here and not in either of them: the deck card, where the session's own ticket is the card's key and the mark
 * names the TOP it folds under, and the List's Session cell, where the row is the top and the mark names the folded ticket the session actually runs on. The
 * arrow reads the same both ways — "this, under/over that" — and the look must not differ between them, or the same relation reads as two.
 *
 * It states a fact and is never a control, so it is a span with no role; `title` carries the whole key when a narrow cell cuts it.
 */
export function FoldMark({ issueKey }: { issueKey: string }) {
  return (
    <span className="ui-fold" title={issueKey}>
      {`↳ ${issueKey}`}
    </span>
  );
}
