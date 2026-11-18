/**
 * FoldMark — the `↳ <key>` pill that names another ticket a surface's own one hangs under or runs on (.claude/DESIGN.md §8.9.1).
 *
 * Three surfaces draw it, which is why it lives here and not in any of them: the deck card, where the session's own ticket is the card's key and the mark
 * names that ticket's direct parent; an on-board lane header, where it names the header issue's own kept parent (parent-lanes spec §3.2); and the List's
 * on-board header row, which says the same thing in its Summary cell (§4.2). The arrow reads the same every way — "this, under/over that" — and the look
 * must not differ between them, or the same relation reads as two.
 *
 * It states a fact and is never a control, so it is a span with no role. `title` is the hover text: the whole key by default, for a narrow cell that cuts
 * it, or what the caller knows about that ticket — the lane header passes the parent's summary, since the key is already on the pill.
 */
export function FoldMark({ issueKey, title }: { issueKey: string; title?: string }) {
  return (
    <span className="ui-fold" title={title ?? issueKey}>
      {`↳ ${issueKey}`}
    </span>
  );
}
