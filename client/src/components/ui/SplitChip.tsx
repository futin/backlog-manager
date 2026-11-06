import type { ReactNode, RefObject, KeyboardEvent, MouseEvent } from 'react';
import { Chevron } from './Chevron';

export type SplitChipProps = {
  /** The main half's accessible name. */
  label: string;
  /** The chevron half's accessible name. */
  labelMore: string;
  /** The main half's visible content. */
  children: ReactNode;
  icon?: ReactNode;
  /** Absent when `href` is set: the main half is then a link and has nothing to call. */
  onMain?: () => void;
  onMore: () => void;
  /** The chevron's `aria-expanded`; the mark turns `up` while it is true. */
  open: boolean;
  /** The main half becomes a new-tab link named by `label`. While `disabled` it falls back to a disabled button — an anchor has no `disabled`. */
  href?: string;
  /** `ink` (default) is the solid pill; `outline` is `Chip`'s outline look, for a primary that is not asking for a person. */
  variant?: 'ink' | 'outline';
  /**
   * Id of the element that says why the main half cannot act. The half gets `aria-disabled` + `aria-describedby`, stays focusable (a disabled button drops out of
   * Tab, and the reason must be reachable) and its click is swallowed. It wins over `href`: an anchor cannot be meaningfully aria-disabled, so the main half is
   * the button form. The chevron is untouched — a blocked Merge still has Update branch and auto-merge behind it.
   */
  mainBlockedBy?: string;
  disabled?: boolean;
  dashed?: boolean;
  size?: 28 | 32;
  /** On the group and on both halves — a disabled button swallows hover in some browsers, so the group must carry it too. */
  title?: string;
  /** The chevron button: the Popover's anchor, and where Escape hands focus back. */
  moreRef?: RefObject<HTMLButtonElement>;
};

/*
  A card is the usual parent of one of these, and a card is itself clickable and keyboard-activatable. Click alone is not enough to keep a press off it:
  Enter and Space on a focused button fire a click on the button AND a keydown that bubbles to the card's own handler, so both are stopped on each half.
*/
const stopClick = (e: MouseEvent) => e.stopPropagation();
const stopKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
};

/**
 * SplitChip — one ink pill that is two buttons: the main half does the thing (opens the repo), the chevron half opens a picker for it. Two real buttons in a
 * `role="group"` rather than one button with a click-position check, so each half has its own name, focus stop and disabled state.
 */
export function SplitChip({ label, labelMore, children, icon, onMain, onMore, open, disabled, dashed, size = 28, title, moreRef, href, variant = 'ink', mainBlockedBy }: SplitChipProps) {
  const className = ['ui-split', size === 28 ? 'ui-split-28' : null, dashed ? 'ui-split-dashed' : null, variant === 'outline' ? 'ui-split-outline' : null].filter(Boolean).join(' ');
  const face = (
    <>
      {icon && (
        <span className="ui-split-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </>
  );
  return (
    <span role="group" className={className} title={title}>
      {href !== undefined && !disabled && mainBlockedBy === undefined ? (
        <a className="ui-split-main" aria-label={label} href={href} target="_blank" rel="noreferrer" title={title} onClick={stopClick} onKeyDown={stopKey}>
          {face}
        </a>
      ) : (
        <button
          type="button"
          className="ui-split-main"
          aria-label={label}
          disabled={disabled}
          aria-disabled={mainBlockedBy !== undefined ? true : undefined}
          aria-describedby={mainBlockedBy}
          title={title}
          onClick={(e) => {
            stopClick(e);
            if (mainBlockedBy === undefined) onMain?.();
          }}
          onKeyDown={stopKey}
        >
          {face}
        </button>
      )}
      <button
        type="button"
        ref={moreRef}
        className="ui-split-more"
        aria-label={labelMore}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={(e) => {
          stopClick(e);
          onMore();
        }}
        onKeyDown={stopKey}
      >
        <Chevron dir={open ? 'up' : 'down'} />
      </button>
    </span>
  );
}
