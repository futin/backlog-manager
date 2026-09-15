/**
 * Select — one of the 36 px control family (.claude/DESIGN.md §8.2, §8.6).
 *
 * A native `<select>` wearing the family's skin, not a custom listbox: this
 * board is read on a phone over a tailnet as often as on a desktop, and the
 * platform picker is the one control whose touch behaviour, keyboard handling
 * and screen-reader support are already right on every device it opens on.
 * What this component owns is the look and the label, nothing else.
 *
 * `label` becomes `aria-label` rather than a rendered `<label>` element because
 * every composer of this control already draws the name beside it — a Settings
 * row's own name, a sheet field's caption — and a second visible label would
 * state it twice.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <select className="ui-select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
