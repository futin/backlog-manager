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
 *
 * `title` is the hover sentence a DISABLED select owes the reader (Jira phase 3's `Move to…` reads `transitions unavailable`) — the same job `Chip`'s
 * `title` does. Optional and absent by default, so no existing composer grows a tooltip it never asked for.
 *
 * An option's `group` puts it under a native `<optgroup>` of that label — the Jira launch sheet's Continue select lists the ticket's own branches before
 * every other one, and the platform picker draws that split on every device for free. Consecutive options sharing a group share one `<optgroup>`; an
 * option without one sits outside any. Absent everywhere, the markup is exactly what it was.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  title
}: {
  value: T;
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  const runs: { group: string | undefined; options: { value: T; label: string }[] }[] = [];
  for (const o of options) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group !== undefined && last.group === o.group) last.options.push(o);
    else runs.push({ group: o.group, options: [o] });
  }
  const draw = (o: { value: T; label: string }) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <select
      className="ui-select"
      aria-label={label}
      title={title}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value as T)}
    >
      {runs.map((r, i) =>
        r.group === undefined ? (
          r.options.map(draw)
        ) : (
          <optgroup key={`group:${i}:${r.group}`} label={r.group}>
            {r.options.map(draw)}
          </optgroup>
        )
      )}
    </select>
  );
}
