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
  label,
  pill
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** For a setting the server can't act on — the switch would flip and do nothing. */
  disabled?: boolean;
  label?: string;
  /**
   * The pill skin (DESIGN.md §8.6): a recessed `--steel` track under a raised
   * `--strip` option — the same shape `Switch` draws — instead of the row of
   * stroked chips this renders by default.
   *
   * A variant PROP rather than a restyle of the one class family, which is the
   * design spec's §12.1 ("a surface that needs a variant adds a prop, never a
   * second class family") and is load-bearing here rather than ceremonial: §8.6
   * asks Settings' pickers for the pill shape while §8.4.1 asks the Runs band's
   * range control, the same component, for a stroked chip. Two surfaces
   * disagreeing about a look is precisely what a prop settles and what a second
   * family would let drift.
   */
  pill?: boolean;
}) {
  return (
    <div className={pill ? 'ui-seg ui-seg-pill' : 'ui-seg'} role="group" aria-label={label}>
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
