/**
 * @jest-environment jsdom
 */
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Confirm } from '../client/src/components/ui/Confirm';
import { Popover } from '../client/src/components/ui/Popover';
import { readStyles, ruleBlock } from './helpers/css-rule';

/**
 * The anchor, the panel and a sibling outside both — the three places a pointer can land. The caller's contract is what the harness reproduces: the popover
 * is mounted conditionally and rendered inside a wrapper that also holds the anchor (the wrapper is `position: relative` in a real caller, which is what the
 * panel's `top: calc(100% + 8px)` measures against; jsdom has no layout, so here it is only the DOM shape).
 *
 * `confirm` mounts a `ui/Confirm` AFTER the popover, which is how a second `useDialogEscape` entry gets above it without any of the dialog shells.
 */
function Harness({
  open,
  onClose,
  width = 300,
  confirm
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  confirm?: { onDismiss: () => void };
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <div>
        <button type="button" ref={anchor}>
          anchor
        </button>
        {open && (
          <Popover label="Filters" width={width} anchor={anchor} onClose={onClose}>
            <button type="button">inside</button>
          </Popover>
        )}
        {open && confirm !== undefined && (
          <Confirm label="Stop?" acceptLabel="Stop" dismissLabel="Keep" onAccept={() => {}} onDismiss={confirm.onDismiss} testId="confirm">
            Really?
          </Confirm>
        )}
      </div>
      <p>outside</p>
    </div>
  );
}

/** `useNarrow` reads `window.matchMedia`, which jsdom does not implement; the stub is the shape `ui-modal.test.tsx` uses. */
function stubNarrow(matches: boolean): void {
  const matchMedia = jest.fn().mockReturnValue({ matches, addEventListener: jest.fn(), removeEventListener: jest.fn() });
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
}

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('Popover', () => {
  it('is a dialog named by its label that holds its children, and is absent while not mounted', () => {
    const { rerender } = render(<Harness open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<Harness open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(dialog).toHaveClass('ui-popover');
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'inside' }));
  });

  it('calls onClose once on Escape', async () => {
    const onClose = jest.fn();
    render(<Harness open onClose={onClose} />);

    await userEvent.setup().keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /* Escape unmounts the panel under a focused pick; without a hand-off the browser drops focus to `body` and the next Tab starts from the top of the
     document. The harness closes the way a real host does — by unmounting on `onClose` — so the case is the whole path, not just the call. */
  it('returns focus to the anchor when Escape closes the panel with focus inside it', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return <Harness open={open} onClose={() => setOpen(false)} />;
    }
    render(<Host />);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'inside' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'inside' }));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'anchor' }));
  });

  it('leaves focus alone when Escape closes the panel with focus outside it, and when a press outside closes it', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return <Harness open={open} onClose={() => setOpen(false)} />;
    }
    const { unmount } = render(<Host />);
    const user = userEvent.setup();
    // Focus on the anchor already is "outside the panel": nothing to hand back, and nothing may be stolen from elsewhere.
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(other);
    unmount();

    // A press outside is the user choosing somewhere else to be: focus must not be pulled back to the anchor.
    render(<Host />);
    screen.getByRole('button', { name: 'inside' }).focus();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'anchor' }));
    other.remove();
  });

  it('gives Escape to a Confirm mounted after it and not to the popover', async () => {
    const onClose = jest.fn();
    const onDismiss = jest.fn();
    render(<Harness open onClose={onClose} confirm={{ onDismiss }} />);

    await userEvent.setup().keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a pointerdown outside, and ignores one inside the panel or on the anchor', () => {
    const onClose = jest.fn();
    render(<Harness open onClose={onClose} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'inside' }));
    fireEvent.pointerDown(screen.getByRole('dialog'));
    // The anchor's own click toggles the popover; closing on its pointerdown first would reopen it on the click.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'anchor' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves no Escape entry and no pointerdown listener behind when it unmounts', async () => {
    const onClose = jest.fn();
    const { rerender } = render(<Harness open onClose={onClose} />);
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Harness open={false} onClose={onClose} />);
    await userEvent.setup().keyboard('{Escape}');
    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls the onClose of its latest render, not the first one', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Harness open onClose={first} />);
    rerender(<Harness open onClose={second} />);

    fireEvent.pointerDown(document.body);
    await userEvent.setup().keyboard('{Escape}');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  describe('shape', () => {
    it('takes its modifier class from useNarrow: present stubbed narrow, absent otherwise', () => {
      const { unmount } = render(<Harness open onClose={() => {}} />);
      expect(screen.getByRole('dialog')).not.toHaveClass('ui-popover-narrow');
      unmount();

      stubNarrow(true);
      render(<Harness open onClose={() => {}} />);
      expect(screen.getByRole('dialog')).toHaveClass('ui-popover', 'ui-popover-narrow');
      expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 700px)');
    });

    /* The only guard against the inline-width trap: no suite loads styles.css into jsdom, so a `style={{ width }}` here would put an inline width above
       `.ui-popover-narrow { width: auto }` and the phone panel would come out 420 px wide in a 351 px rail bar with every other case still green. */
    it.each([
      ['desktop', false],
      ['narrow', true]
    ])('carries its width as --ui-popover-width and never as an inline width (%s)', (_name, narrow) => {
      if (narrow) stubNarrow(true);
      render(<Harness open width={300} onClose={() => {}} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog.style.getPropertyValue('--ui-popover-width')).toBe('300px');
      expect(dialog.style.width).toBe('');
    });
  });
});

/**
 * The geometry lives in the stylesheet and jsdom performs no layout, so the facts that make the phone shape work are read off the source — the way
 * `rail-bar-style.test.ts` reads the tracker's. Not that suite's media-block slicing, though: `.ui-popover-narrow` is a modifier class inside the ui primitives
 * block, applied by `useNarrow`, and there is no `@media` rule of this family's own to slice (guard 7 counts the bare `.ui-popover` selector over the whole
 * sheet). Comments are blanked first so a selector named inside one can never be the "first block" `ruleBlock` returns.
 */
describe('Popover stylesheet rules', () => {
  const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  /** `prop → value` for one rule body, whitespace-normalised, so `top: auto` is checked as a declaration and not as a substring of `margin-top: auto`. */
  function declarations(selector: string): Record<string, string> {
    const body = ruleBlock(css, selector);
    expect({ selector, found: body !== null }).toEqual({ selector, found: true });
    const out: Record<string, string> = {};
    for (const decl of (body as string).split(';')) {
      const at = decl.indexOf(':');
      if (at === -1) continue;
      out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim().replace(/\s+/g, ' ');
    }
    return out;
  }

  it('.ui-popover floats under its anchor at the dialogs’ z-order, its width read from the custom property', () => {
    const base = declarations('.ui-popover');
    expect(base).toMatchObject({
      position: 'absolute',
      top: 'calc(100% + 8px)',
      right: '0',
      'z-index': '20',
      width: 'var(--ui-popover-width)'
    });
    // The viewport cap is divided by --font-scale like every other fixed measure in the sheet (.shell's zoom leaves a viewport unit pre-zoom).
    expect(base['max-width']).toBe('calc(100vw / var(--font-scale, 1) - 48px)');
  });

  it('.ui-popover-narrow is fixed, drops the base top, spans the viewport less 12 px a side and lets the cap go', () => {
    expect(declarations('.ui-popover-narrow')).toMatchObject({
      position: 'fixed',
      top: 'auto',
      left: '12px',
      right: '12px',
      width: 'auto',
      'max-width': 'none',
      'max-height': '70vh',
      'overflow-y': 'auto'
    });
  });
});
