import { forwardRef } from 'react';
import type { ReactNode } from 'react';

export type ChipVariant = 'outline' | 'ink' | 'flat' | 'danger';
export type ChipSize = 32 | 28;

/**
 * Chip — §7's filter chip, and the 32 px control this board carries everywhere
 * a person clicks something that is not a form field (.claude/DESIGN.md §7,
 * §8.2).
 *
 * One component for the filter chip, `RunControls`' Pause/Resume, the dispatch
 * control and `load more`, because they are one shape at four jobs: 13/500
 * label, 12 px radius, a 1 px `--hairline2` stroke on `--strip`. Four class
 * families for that would be four chances to disagree about a radius.
 *
 * `pressed` is `aria-pressed`, never a colour alone: a chip that is *on* is a
 * state, and §8's standing rule is that a raised control marks a state rather
 * than a button — so the fill moves and the label does not change colour.
 *
 * `as: 'label'` exists for the chips that wrap their own input (a filter that
 * is really a checkbox). A `<label>` takes no `aria-pressed` and no `disabled`,
 * so neither is emitted there — the control inside carries both.
 *
 * The ref reaches the BUTTON (and nothing, for `as: 'label'`). It exists for one
 * job: a chip that opens a `Popover` is that popover's `anchor` — the press on it
 * is not "outside", and Escape hands focus back to it — and the Jira board's
 * picker (Jira phase 2) is the first chip to open one. A wrapper element would
 * do for the press but not for the focus: `focus()` on a span is a no-op.
 */
export type ChipProps = {
  children: ReactNode;
  variant?: ChipVariant;
  size?: ChipSize;
  pressed?: boolean;
  as?: 'button' | 'label';
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  /*
    The pass-through is deliberately narrow: `data-*` and `aria-*` only. Every
    composing surface needs a test hook or an extra label on a chip somewhere,
    and a chip that accepted no attributes at all would grow a prop per hook —
    but a wide `Record<string, unknown>` would also let a caller hand this one
    its own `onClick` or `className` and quietly take the component's look and
    behaviour back off it, which is the drift `ui/` exists to stop.
  */
} & { [k: `data-${string}`]: string | number | boolean | undefined } & { [k: `aria-${string}`]: string | number | boolean | undefined };

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { children, variant = 'outline', size = 32, pressed, as = 'button', icon, onClick, disabled, title, type = 'button', ...rest },
  ref
) {
  const className = ['ui-chip', `ui-chip-${variant}`, size === 28 ? 'ui-chip-28' : 'ui-chip-32', pressed ? 'on' : null].filter(Boolean).join(' ');

  const body = (
    <>
      {icon && (
        <span className="ui-chip-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </>
  );

  if (as === 'label') {
    return (
      <label className={className} title={title} {...rest}>
        {body}
      </label>
    );
  }
  return (
    <button ref={ref} type={type} className={className} aria-pressed={pressed} disabled={disabled} title={title} onClick={onClick} {...rest}>
      {body}
    </button>
  );
});
