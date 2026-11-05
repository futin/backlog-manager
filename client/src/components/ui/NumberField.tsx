import { useState } from 'react';

/**
 * NumberField — one of the 36 px control family (.claude/DESIGN.md §8.2, §8.6).
 *
 * Moved here from `settings/SettingsRow.tsx` with its behaviour untouched (the
 * design spec's §12.1). A bounded integer input that commits on blur, so a
 * half-typed number never clamps mid-keystroke, and re-seeds from `value` via
 * the `key` when the value changes from somewhere else (a Reset, a server
 * refusal handing back the stored figure). `disabled` is for a card that can
 * show its figure but cannot save one (the Dashboards page on an unreadable
 * file); absent, the markup is what it always was.
 *
 * The key also carries a commit counter, bumped on a blur whose text differs
 * from `value`: a commit the parent clamps back to the value it already holds
 * leaves `value` unchanged, and a key of `value` alone kept the out-of-range
 * number on screen (#350). A blur that typed nothing new leaves the node
 * alone — remounting it then re-seeds nothing and only swaps the element out
 * from under whoever holds it.
 *
 * The stepper (`− value unit +`, the Watchdog and Tick rows of `SettingsMore.dc.html`): `step` (default 1) moves a free value by one press, clamped to
 * `[min, max]`, and commits at once — a press is a whole intention, unlike a keystroke. `ladder` replaces the free input with a list of allowed rungs shown
 * as text (`format` words them: `1m`); a press commits the neighbouring rung, and a `value` that is not on the ladder is placed in order so a stored
 * off-ladder figure still steps sensibly. A button at its bound, and both while `disabled`, are disabled.
 */

export function NumberField({
  value,
  min,
  max,
  unit,
  onCommit,
  label,
  disabled,
  step = 1,
  ladder,
  format
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (v: number) => void;
  label?: string;
  disabled?: boolean;
  step?: number;
  ladder?: readonly number[];
  format?: (v: number) => string;
}) {
  const [commits, setCommits] = useState(0);

  // The value a press would commit, or null at the bound. Ladder: the nearest rung strictly below / above `value`; free: value ∓ step clamped.
  let down: number | null;
  let up: number | null;
  if (ladder) {
    const below = ladder.filter((r) => r < value);
    const above = ladder.filter((r) => r > value);
    down = below.length ? Math.max(...below) : null;
    up = above.length ? Math.min(...above) : null;
  } else {
    down = value > min ? Math.max(min, value - step) : null;
    up = value < max ? Math.min(max, value + step) : null;
  }

  const noun = label ? ` ${label}` : '';
  return (
    <span className="ui-number-stepper">
      <button type="button" className="ui-number-step" aria-label={`Decrease${noun}`} disabled={disabled || down === null} onClick={() => down !== null && onCommit(down)}>
        −
      </button>
      {ladder ? (
        <span className="ui-number-value" aria-label={label}>
          {format ? format(value) : value}
        </span>
      ) : (
        <input
          className="ui-number"
          type="number"
          aria-label={label}
          defaultValue={value}
          min={min}
          max={max}
          disabled={disabled}
          key={`${value}:${commits}`} /* re-seed when the value changes from elsewhere (e.g. Reset), and after a commit of new text */
          onBlur={(e) => {
            const typed = e.currentTarget.value;
            onCommit(Number(typed));
            if (typed !== String(value)) setCommits((n) => n + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
      {unit && <span className="ui-number-unit">{unit}</span>}
      <button type="button" className="ui-number-step" aria-label={`Increase${noun}`} disabled={disabled || up === null} onClick={() => up !== null && onCommit(up)}>
        +
      </button>
    </span>
  );
}
