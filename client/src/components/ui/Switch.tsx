/**
 * Switch — the pill member of the 36 px control family (.claude/DESIGN.md §8.2,
 * §8.6: "a recessed `--steel` track under a raised `--strip` option").
 *
 * The on/off rows take this rather than a bare checkbox, and the shape states
 * §8's standing rule outright: a raised control marks a STATE, never a button.
 * The raised option is the one that is selected; the track it slides on is
 * recessed, so "on" is legible from the geometry before any colour is read —
 * which is what the amber CRT theme needs, having no second hue to spend.
 *
 * `role="switch"` with `aria-checked`, not `aria-pressed`: this is a setting
 * with two states that persists, not a button that stays down. Both halves of
 * the track are labelled so the control announces what each end means rather
 * than leaving a reader to infer it from the word beside the row.
 */
export function Switch({
  checked, onChange, label, disabled, onLabel = 'On', offLabel = 'Off'
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <button
      type="button"
      className={checked ? 'ui-switch on' : 'ui-switch'}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-opt" aria-hidden="true">{offLabel}</span>
      <span className="ui-switch-opt" aria-hidden="true">{onLabel}</span>
    </button>
  );
}
