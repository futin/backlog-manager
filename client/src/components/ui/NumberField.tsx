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
 */
export function NumberField({
  value,
  min,
  max,
  unit,
  onCommit,
  label,
  disabled
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (v: number) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [commits, setCommits] = useState(0);
  return (
    <>
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
      {unit && <span className="ui-number-unit">{unit}</span>}
    </>
  );
}
