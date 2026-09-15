/**
 * NumberField — one of the 36 px control family (.claude/DESIGN.md §8.2, §8.6).
 *
 * Moved here from `settings/SettingsRow.tsx` with its behaviour untouched (the
 * design spec's §12.1). A bounded integer input that commits on blur, so a
 * half-typed number never clamps mid-keystroke, and re-seeds from `value` via
 * the `key` when the value changes from somewhere else (a Reset, a server
 * refusal handing back the stored figure).
 */
export function NumberField({
  value,
  min,
  max,
  unit,
  onCommit,
  label
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (v: number) => void;
  label?: string;
}) {
  return (
    <>
      <input
        className="ui-number"
        type="number"
        aria-label={label}
        defaultValue={value}
        min={min}
        max={max}
        key={value} /* re-seed when the value changes from elsewhere (e.g. Reset) */
        onBlur={(e) => onCommit(Number(e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {unit && <span className="ui-number-unit">{unit}</span>}
    </>
  );
}
