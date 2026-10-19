/**
 * LiveStrip — the 24 px band across a card's top edge that says somebody is on this right now (.claude/DESIGN.md §8.3; the Jira card's use of it is §8.9.1).
 *
 * It was `ItemCard`'s inline markup until the Jira card needed the same band for a live session (Jira phase 5): two surfaces drawing one look is the
 * `ui/` rule's whole trigger, and a second copy would be a second place to forget `.hatch`, the label/reading split or the `stale` exception. The class
 * family is still `.board-card-live` (the stylesheet's, declared once) — this component owns the MARKUP, not a new look.
 *
 * `tone` rides in `data-tone` for anything that needs the caller's verdict in the markup; the stylesheet reads exactly one value, `stale` (#227), which is
 * not a live state at all, so it also drops `.hatch` here. Every other tone is the one `--fill-live` band: this design marks state by ink and never by
 * accent (§5, §8.3), and the WORD carries the distinction. `mark` is the elapsed (or `starting`) reading on the right; absent rather than blank when it
 * cannot be produced, because half a marker beats a lie.
 *
 * It must sit OUTSIDE `.board-card-face`, as the first child of the card, so it can reach the card's own left and right edges — a strip inset by the
 * face's padding reads as a chip, not as a state the whole card is in. That placement is the caller's.
 */
export function LiveStrip({ tone, label, mark, title }: { tone: string; label: string; mark: string | null; title?: string }) {
  return (
    <div className={tone === 'stale' ? 'board-card-live' : 'board-card-live hatch'} data-tone={tone} title={title}>
      <span>{label}</span>
      {mark !== null && <span className="board-card-live-mark">{mark}</span>}
    </div>
  );
}
