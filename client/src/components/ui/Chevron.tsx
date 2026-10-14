/**
 * Chevron — the one disclosure mark (.claude/DESIGN.md §6's chevrons, §8.0's tracker chip caret). Ported from the dashboard's `Chevron`, which replaced the
 * text triangles (▸ ▾ ▴) there because a glyph a few pixels tall was hard to see and its size depended on whichever font the platform fell back to.
 *
 * One 10×10 stroked path, `M2 4l3 3 3-3`; `up` and `right` are rotations of it (`.chev-up`, `.chev-right`), never a second drawing, so the three directions
 * can not drift apart. Colour is `currentColor`, so the wrapper — the chip's `--ink3` caret, the dispatch word's tone — decides it and the mark takes no
 * accent of its own (§6: icons never take accent colour).
 *
 * Drawn at 11 px where the dashboard's is 9: the board's caret has been 11 px since §8.0 wrote it down, and guard 3's 11 px floor is the same number.
 * `aria-hidden` always — the mark is a cue beside a control that already carries its own name, and a "chevron" announcement would be noise.
 *
 * A consumer that opens and closes (the tracker chip) passes `dir` rather than rotating the element from CSS: the rotation lives on `.chev-<dir>` alone, so
 * a second rule turning the same element — `[aria-expanded="true"] … { rotate(180deg) }` did, on the old glyph — would turn an `up` chevron back down.
 *
 * Default export, as the interface for this component was specified; the other `ui/` primitives are named exports.
 */
export default function Chevron({ dir = 'down', className }: { dir?: 'down' | 'up' | 'right'; className?: string }) {
  return (
    <svg className={`chev chev-${dir}${className ? ` ${className}` : ''}`} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 4l3 3 3-3" />
    </svg>
  );
}
