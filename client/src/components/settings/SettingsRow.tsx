import type { ReactNode } from 'react';

import { Sheet, SheetHead } from '../ui/Sheet';

/*
  `Segmented` and `NumberField` used to live here and now live in
  `components/ui/` (the design spec's §12.1): both are controls the launch and
  orchestrate sheets want too, and a primitive that only Settings can import is
  the drift that rule exists to stop. What stays here is what is genuinely
  Settings' own — a row and a group are this card's COMPOSITION of `Sheet` plus
  rows, not patterns another surface reuses. §12.3 names both by hand for
  exactly that reason.
*/

/**
 * One labelled setting: name + explanation on the left, the control on the
 * right (DESIGN.md §8.6).
 *
 * Boxless since task-39 — 16 px of vertical padding and a hairline between
 * rows, with no fill, no stroke and no radius of its own. The card under it is
 * what tells this group from the page; a row that drew its own box as well made
 * five boxes inside one box, which is the "a card inside a card" shape §5
 * refuses. The hairline is drawn between rows rather than under each, so the
 * last row in a card does not end on a rule with nothing beneath it.
 */
export function SettingsRow({ name, hint, children }: { name: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{name}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/**
 * A group of rows as one card (DESIGN.md §8.6): the `Sheet` primitive —
 * borderless `--strip`, 16 px radius, 24 px padding — under a `SheetHead`
 * carrying the title and its one-line subtitle.
 *
 * `title` and `scope` are two props rather than the one `Display · this device`
 * string this took until task-39, and the split is the point rather than
 * formatting: the scope half answers a different question from the name half —
 * whether changing this setting affects anybody but the person changing it —
 * and §7's title+subtitle pair is where that answer belongs. Every one of the
 * five scopes is deliberately distinct (`this device`, `this machine`, `this
 * server`), so collapsing them back into the title would put three different
 * claims in the same 19/500 line as the name.
 *
 * `as="section"` so the card is still a landmark-eligible element, which the
 * `<section>` this replaced already was. `.set-group` rides beside `Sheet`'s own
 * class purely to LAY the card out (the rows' gap) — never to restate its look,
 * which is §12.1's rule and `test/design-guards.test.ts`'s guard 7.
 */
export function SettingsGroup({ title, scope, children }: { title: string; scope: string; children: ReactNode }) {
  return (
    <Sheet as="section" className="set-group">
      <SheetHead title={title} sub={scope} />
      {children}
    </Sheet>
  );
}
