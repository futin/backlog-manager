import { useId, useState, type ReactNode } from 'react';

import { Pill } from './Pill';

import { Sheet, SheetHead } from './Sheet';

/*
  `Segmented` and `NumberField` used to live here and now live in
  `components/ui/` (the design spec's §12.1): both are controls the launch and
  orchestrate sheets want too, and a primitive that only Settings can import is
  the drift that rule exists to stop. What stays here is what is genuinely
  Settings' own — a row and a group are this card's COMPOSITION of `Sheet` plus
  rows, not patterns another surface reuses. §12.3 names both by hand for
  exactly that reason.

  They moved from `settings/` to `ui/` in Jira phase 2: the Jira Setup page
  composes the same `Sheet`-plus-rows shape for its Connection and Repositories
  cards, and a composition only Settings could import would be a second copy of
  it drawn beside this one. The names and behaviour are untouched.
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
/*
  `children` is optional since task-42, and the empty `.set-control` goes with
  it rather than being rendered hollow. The dispatch report (once the
  `Claude Agents` card, now the Dashboards page's `Dispatch` row) is a REPORT —
  it states where the host's dispatch config stands and has nothing to set — and a row is the right shape for it: the label and hint
  are exactly what such a row needs. An empty control div beside it would
  reserve the right-hand slot's width for nothing, pulling the hint in against
  a margin no control occupies.
*/
export function SettingsRow({
  name,
  hint,
  more,
  stacked,
  children
}: {
  name: string;
  /** The one-line description. Text longer than a line goes in `more` instead. */
  hint?: ReactNode;
  /** The long text, behind an `ⓘ more` button (spec §4.10). Closed by default; the button keeps its name and flips `aria-expanded`. */
  more?: ReactNode;
  /** The control under the label rather than beside it — a row whose control is a full-width track of cards. */
  stacked?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const moreId = useId();
  return (
    <div className={stacked ? 'set-row set-row-stacked' : 'set-row'}>
      <div className="set-label">
        <span className="set-name-line">
          <span className="set-name">{name}</span>
          {more && (
            <button type="button" className="set-more" aria-expanded={open} aria-controls={moreId} onClick={() => setOpen((o) => !o)}>
              ⓘ more
            </button>
          )}
        </span>
        {hint && <span className="set-hint">{hint}</span>}
        {more && open && (
          <span className="set-hint set-more-text" id={moreId}>
            {more}
          </span>
        )}
      </div>
      {children && <div className="set-control">{children}</div>}
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
 * which is §12.1's rule and `test/guards/design-guards.test.ts`'s guard 7.
 */
/*
  `right` is `SheetHead`'s own right slot, passed through, and was added for Jira › Setup's Boards card (Jira phase 2, spec §6.4): its `New board` chip sits
  in the card's head, beside the title, because it makes a row rather than belonging to one. Optional, and no Settings card passes it, so every card that
  drew before draws the same.
*/
export function SettingsGroup({
  title,
  scope,
  pill,
  right,
  children
}: {
  title: string;
  /** The sub-line. Optional since Task 8: a card that states its scope with `pill` has nothing more to say under the title. */
  scope?: string;
  /** Where the card saves, as a neutral `Pill` beside the title (spec §4.10): `this browser` is localStorage, `this machine` is the API host. */
  pill?: 'this browser' | 'this machine';
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet as="section" className="set-group">
      <SheetHead
        title={title}
        sub={scope}
        right={
          pill || right ? (
            <>
              {pill && <Pill tone="neutral">{pill}</Pill>}
              {right}
            </>
          ) : undefined
        }
      />
      {children}
    </Sheet>
  );
}
