import { useEffect, useRef } from 'react';

/**
 * One owner for the Escape key: a module-level LIFO stack of the dialogs that
 * are currently open, and exactly one `window` listener, which closes the top
 * entry and nothing else.
 *
 * bug-23: before this, ItemDrawer, LaunchSheet, RunDrawer and OrchestrateSheet
 * each carried their own copy of the same four-line effect, binding `keydown`
 * on `window` and calling their own `onClose` unconditionally. Two of them are
 * mounted together BY DESIGN — BoardView and ArchiveView both keep the item
 * drawer open behind the launch sheet, which is deliberate and separately
 * tested — so one press ran both callbacks and took the drawer the user
 * expected to come back to. DOM nesting cannot rank `window` listeners and a
 * bubbling `stopPropagation` cannot reach them, so ranking has to be explicit,
 * and it has to live somewhere all four dialogs can see. That is this module.
 *
 * They stay `window` listeners rather than becoming element handlers because
 * none of these overlays traps focus (RunDrawer's own comment says so): Escape
 * has to work wherever focus happens to sit, including on the card button that
 * opened the sheet. The `<dialog>` element would get topmost-only Escape from
 * the platform for free, and was rejected in grooming: it also brings its own
 * focus, scroll-locking and backdrop behaviour to four surfaces at once, which
 * is a redesign rather than this fix.
 *
 * Module state rather than a React context, the same shape `lib/view-keys.ts`
 * already uses: four suites mount these components standalone, and Board and
 * Archive are separate lazy chunks, so a provider would have to sit in
 * `App.tsx` and every isolated mount would need wrapping to keep working.
 *
 * **Ranking is by mount order — the most recently opened dialog owns Escape.**
 * That is a contract now, not an accident: the sheet mounts after the drawer it
 * layers over, so it wins, and the drawer is top again the moment it unmounts.
 * One case is knowingly out of scope: nothing traps focus, so a keyboard user
 * can tab to a card behind the sheet and open the drawer AFTER it, which makes
 * the drawer topmost in this stack while the sheet is still painted above it.
 * Ranking by paint order instead would mean a z-index registry; the bug being
 * fixed here is one press closing two dialogs, and that stays fixed either way.
 */

/** A mounted dialog's slot in the stack. The callback is a mutable field
 *  rather than the entry itself so that the entry's IDENTITY — its position —
 *  survives every re-render of its host (see the effect below). */
type Entry = { onClose: () => void };

const stack: Entry[] = [];

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (top !== undefined) top.onClose();
}

export function useDialogEscape(onClose: () => void): void {
  const entry = useRef<Entry>({ onClose });
  /* Written on every render, deliberately: all four call sites are handed an
     inline arrow (`onClose={() => setOpen(null)}`), so the callback has a new
     identity every time its host re-renders. Reading it through the ref is
     what lets the registration effect below take an empty dependency array. */
  entry.current.onClose = onClose;

  useEffect(() => {
    const mine = entry.current;
    stack.push(mine);
    /* Installed on the first entry and removed with the last, rather than kept
       permanently: an app-wide listener that outlives every dialog would make
       "removes its Escape listener when it unmounts" (launch-sheet.test.tsx)
       assert nothing, and would leave this module holding a key nobody is
       waiting on. */
    if (stack.length === 1) window.addEventListener('keydown', onKey);

    return () => {
      /* By identity, never `pop()`: a dialog can unmount while another sits
         above it — closing the drawer from its own button with the sheet still
         open — and popping would evict the wrong one. */
      const at = stack.indexOf(mine);
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKey);
    };
    /* Empty on purpose. An effect keyed on `[onClose]` would tear its entry
       down and re-push it on every render of the host, silently climbing the
       drawer back above the sheet — and BoardView re-renders on a 5s runs poll
       and on `useNow`, so that would happen while the user was just reading.
       Stack position is fixed for the dialog's mounted lifetime; only the
       callback behind it may change. */
  }, []);
}
