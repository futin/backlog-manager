/**
 * Segmented — one of the 36 px control family (.claude/DESIGN.md §8.2, §8.6).
 *
 * Moved here from `settings/SettingsRow.tsx` unchanged in behaviour (the design
 * spec's §12.1): it was a Settings-local component that the launch and
 * orchestrate sheets already wanted, which is the drift this directory exists
 * to stop. Its markup and its props are the ones Settings has been shipping —
 * only the class family moved, from `.set-seg` to this file's own `.ui-seg`, so
 * the look has exactly one home.
 *
 * Used instead of a `<select>` wherever there are three or four options and
 * seeing them all at once is worth the width — density, text scale, on/off.
 *
 * `aria-pressed` rather than a radio group: these are buttons that apply
 * immediately, and a radiogroup would promise a form submit that never comes.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  label
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** For a setting the server can't act on — the switch would flip and do nothing. */
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? 'on' : undefined}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
