import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

import { useDialogEscape } from '../../hooks/useDialogEscape';
import { useNarrow } from '../../hooks/useNarrow';

/**
 * Popover — the panel that hangs under a control (.claude/DESIGN.md §8.7's overlays; the band-filter spec's shared `Popover`).
 *
 * The tracker strip's popover was this component's only instance until the band's Filters and Sort buttons wanted the same panel, and a second copy of the
 * dismissal and the phone geometry — both of which took a bug to get right — is how two panels come to behave differently. So it lives in `ui/`, one family
 * (`.ui-popover`), and its callers pass what differs: the accessible name, the width, the element that opened it.
 *
 * **Dismissal has two owners on purpose.** Escape goes through `useDialogEscape`, exactly as `ui/Confirm` does: the stack is the only Escape listener in the
 * client, so a popover opened over the item modal takes the key from the modal and hands it back when it closes. Click-outside is this component's own
 * `pointerdown` listener, because the stack owns a KEY, not the pointer — the dashboard's `useDismiss` bundles the two and is exactly what must not be copied
 * here. Mounted only while open, the way `Confirm` is, so the entry joins the stack on mount and leaves it, by identity, on unmount: a closed popover costs
 * nothing and cannot hold the key.
 *
 * **The anchor is ignored on `pointerdown`.** The control that opened the popover toggles it from its own click. If the outside-press listener treated the
 * anchor as outside, a press on it would close the panel first and the click that follows would open it again — the button would appear to do nothing.
 * Ignoring it leaves the toggle in one place, the click handler that already owns it.
 *
 * **It measures nothing and portals nothing.** The caller renders it inside a `position: relative` wrapper that also holds the anchor, and CSS puts it
 * `100% + 8px` below that wrapper, right edges together; there is no `getBoundingClientRect`, no resize observer and no portal to `body` — a portal would
 * need the positioning arithmetic CSS already does. The one thing that costs is a placement rule: the phone shape is `position: fixed`, so a caller must not
 * render it under a `container-type` ancestor (§8.4.1's `.runs-frame` is one), whose layout containment would pin it to that box instead of the viewport.
 *
 * **It is not a dialog, whatever its role says.** `role="dialog"` names it for a screen reader (the opening button carries `aria-haspopup="dialog"` and
 * `aria-expanded`), but it paints no scrim, traps no focus and is not counted among the three dialogs `useDialogEscape` ranks — the same standing `Confirm`
 * has. §8.7's "one modal, and nothing else floats" admits these panels for that reason: they float, but over nothing they hide.
 *
 * **The width travels as a custom property, never as an inline `width`.** `--ui-popover-width` is read by the base rule, and the phone rule
 * (`.ui-popover-narrow`, applied from `useNarrow` — the one place JS knows the 700 px breakpoint, so no `@media` rule of this family's own) sets
 * `width: auto`. An inline `width` outranks every stylesheet rule, so it would keep a 420 px panel 420 px wide in a 351 px rail bar; and since no suite loads
 * the stylesheet into jsdom, every render test would stay green while it did. The width lives in CSS for the same reason `.tracker-pop`'s always did.
 */
export function Popover({
  label,
  width,
  anchor,
  onClose,
  children
}: {
  /** The dialog's accessible name — the panel's own header word (`Filters`, `Sort by`, `Tracker`), not the opening button's. */
  label: string;
  /** Desktop width in px. Becomes `--ui-popover-width`; the phone shape ignores it. */
  width: number;
  /** The opening control. A `pointerdown` on it (or anything inside it) is not "outside": its click is what toggles the panel. */
  anchor: RefObject<HTMLElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const narrow = useNarrow();
  const panel = useRef<HTMLDivElement>(null);
  useDialogEscape(onClose);

  /* Read through a ref so the listener below is added once, on mount, and not torn down and re-added on every render of a host that hands an inline arrow
     (`useDialogEscape` makes the same trade for the same reason). Written during render, like that hook's own. */
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [anchor]);

  return (
    <div
      ref={panel}
      className={narrow ? 'ui-popover ui-popover-narrow' : 'ui-popover'}
      role="dialog"
      aria-label={label}
      style={{ '--ui-popover-width': `${width}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}
