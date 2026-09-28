/**
 * Meter — the strip chip's line meter (.claude/DESIGN.md §8.0's shell strip; §7's meter row, at the chip's size). The dashboard's `.m`/`.mtop`/`.mini`
 * triple, named for this board: a label over a value, both 11 px, and a 3.5 px track under them.
 *
 * 11 px rather than the dashboard's 9.5 px label because design guard 3 floors every px font-size in `styles.css` at 11 — which is also why the default
 * width is 56 px, not 52: the value needs the room so `overdue` does not wrap (the tracker strip spec, §2.3).
 *
 * **No transition on the fill.** The POLL meter advances once a second, and a one-second tween would smear every reading into the next — the bar would
 * always be drawing where the clock was, never where it is. `ProgressRow`'s `.2s` suits a bar that moves when work lands; this one moves on a clock.
 *
 * The text is the reading and the bar is decoration, so the track is `aria-hidden` and there is no `progressbar` role: unlike `ProgressRow` this meter's
 * value is already a sentence (`12s`, `overdue`, `1.4%`), and a second, numeric statement of it would be the one a screen reader got wrong.
 *
 * `fraction` is clamped rather than trusted, for `ProgressRow`'s reason: a bar drawn past its own track looks like a rendering bug rather than a number
 * being large. `null` draws the empty track — "nothing to read yet", which is not the same as a reading of zero.
 *
 * `width` is px, or `'fill'` for a meter that spans its container — the popover's API bar, whose panel is 420 px on a desktop and the viewport less its
 * inset on a phone, so no one number is right for both.
 */
export function Meter({
  label,
  value,
  fraction,
  tone = 'green',
  width = 56
}: {
  label: string;
  value: string;
  fraction: number | null;
  tone?: 'green' | 'amber' | 'red';
  width?: number | 'fill';
}) {
  const pct = fraction === null ? 0 : Math.min(Math.max(fraction, 0), 1) * 100;
  return (
    <span className="ui-meter" data-tone={tone} style={{ width: width === 'fill' ? '100%' : `${width}px` }}>
      <span className="ui-meter-head">
        <span className="ui-meter-label">{label}</span>
        <span className="ui-meter-value">{value}</span>
      </span>
      <span className="ui-meter-track" aria-hidden="true">
        <span className="ui-meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
