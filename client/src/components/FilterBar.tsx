import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Chip } from './ui/Chip';
import { Dot } from './ui/Dot';
import { Popover } from './ui/Popover';
import { Segmented } from './ui/Segmented';
import type { ProjectHues } from '../lib/project-hue';
import type { RegistryProject } from '../../../shared/types';

export type SortDir = 'asc' | 'desc';

/**
 * What the track needs to draw and drive a sort: the current key and direction, the options with the words each one is drawn with, and the two setters.
 *
 * Generic over the key so a caller's own union — Board's `SortKey` — passes straight through and `onKey` hands it back already typed; a caller with no sort
 * (Archive) never names it, and the parameter falls back to `string`.
 */
export type FilterBarSort<K extends string = string> = {
  key: K;
  dir: SortDir;
  /** `label` is the row's name and what the track's `Sort: <label> (<dir>)` reads; `hint` is the 11 px line beside it. */
  options: { value: K; label: string; hint: string }[];
  onKey: (k: K) => void;
  onDir: (d: SortDir) => void;
};

type Open = 'filter' | 'sort' | null;

/**
 * FilterBar — the band's filter and sort track and the two popovers it opens (.claude/DESIGN.md §8.3; §8.5 for Archive's use of the filter half; the
 * band-filter spec's §1 and §2).
 *
 * It replaced the band's three filter chips with the dashboard's own shape: one recessed track holding a funnel button, a divider, `Sort: <key> (<dir>)` and a
 * sort button, each button opening a 300 px panel under the track. The Board passes both halves; Archive passes no `sort`, and the track is the funnel alone —
 * Archive's contents are defined by staleness and rejection, so a sort control there would have nothing to order (§8.5).
 *
 * **One component owns which panel is open, so there can only be one.** Opening either closes the other, and a second click on the open one's button closes
 * it. The panels are two separate `Popover` mounts rather than one with its label swapped: each joins the Escape stack on mount and leaves it on unmount, and
 * a single instance re-labelled in place would carry one panel's stack entry, scroll position and focus into the other. A press on the OTHER button counts as
 * "outside" for the open panel (`Popover` ignores only its own anchor), so that press closes the open one from its `pointerdown` and the click that follows
 * opens the new one — both writes are functional updates, so the order they land in cannot leave two open or none.
 *
 * **Picks do not close the popover.** A reader narrows to a project and then flips the status, or tries three sort keys to see the order, and a panel that
 * closed on every pick would make each one a re-open. This is the dashboard's behaviour, and the reason `Clear all` leaves the panel up as well: it shows the
 * state it just reset.
 *
 * **The wrapper carries `margin-left: auto`, and the panel measures against it.** The band's right slot wraps (`.ui-band-right`), and `Popover` is
 * `position: absolute; right: 0` under whichever element is its positioned parent. Auto margin keeps the track at the right of whichever line it wraps onto, so
 * a right-aligned 300 px panel under it stays on-screen at every width above 700 px — the dashboard's `.ctlwrap` does the same for the same reason. Both panels
 * hang from this wrapper, not from their own buttons, which is what gives the filter and sort panels one shared right edge. It must also stay outside any
 * `container-type` ancestor — `Popover`'s own header says why.
 *
 * **The filter button is raised only while something is filtered.** §8's rule is that a raised control marks a state, never a button, and "a filter is set" is
 * the state; the count in the badge and in the accessible name (`Filters, 2 set`) says how many. The count is the caller's — it alone knows what "default"
 * is for its own filters, and the Board's fail-open project value must feed it, not the raw stored one.
 *
 * **This family is `.filter-bar*`, and never names a `.ui-*` class.** Guard 7 reads every class token in a selector outside the primitives block; reaching
 * the Status switch by `.ui-seg` here would be exactly the restatement it exists to catch, so `FilterSection`'s own `fill` class plus a `[role="group"]`
 * selector does the laying out, and the buttons are reached by element.
 */
export function FilterBar<K extends string = string>({
  count,
  onClear,
  children,
  sort
}: {
  /** How many filters are set. Zero draws no badge and no raised look and makes `Clear all` inert. */
  count: number;
  onClear: () => void;
  /** The filter popover's body, drawn under its `Filters` / `Clear all` header — the caller's sections. */
  children: ReactNode;
  sort?: FilterBarSort<K>;
}) {
  const [open, setOpen] = useState<Open>(null);
  // Each panel's anchor: a press on its own button is not "outside" it — the button's click is what toggles — so `Popover` is told which element that is.
  const filterButton = useRef<HTMLButtonElement>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const close = (): void => setOpen(null);

  const sortLabel = sort === undefined ? '' : (sort.options.find((o) => o.value === sort.key)?.label ?? sort.key);

  return (
    <div className="filter-bar-wrap">
      <div className="filter-bar">
        <button
          ref={filterButton}
          type="button"
          className={count > 0 ? 'filter-bar-btn on' : 'filter-bar-btn'}
          title="Filters"
          aria-label={count > 0 ? `Filters, ${count} set` : 'Filters'}
          aria-haspopup="dialog"
          aria-expanded={open === 'filter'}
          onClick={() => setOpen((o) => (o === 'filter' ? null : 'filter'))}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" />
          </svg>
          {count > 0 && <span className="filter-bar-badge">{count}</span>}
        </button>
        {sort !== undefined && (
          <>
            <i className="filter-bar-sep" aria-hidden="true" />
            <span className="filter-bar-sortlab">
              Sort: <b>{sortLabel}</b> ({sort.dir})
            </span>
            <button
              ref={sortButton}
              type="button"
              className="filter-bar-btn"
              title="Change sort"
              aria-label="Change sort"
              aria-haspopup="dialog"
              aria-expanded={open === 'sort'}
              onClick={() => setOpen((o) => (o === 'sort' ? null : 'sort'))}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M6 4v12M6 16l-2.5-2.5M6 16l2.5-2.5M14 16V4M14 4l-2.5 2.5M14 4l2.5 2.5" />
              </svg>
            </button>
          </>
        )}
      </div>

      {open === 'filter' && (
        <Popover label="Filters" width={300} anchor={filterButton} onClose={close}>
          <div className="filter-bar-head">
            <span>Filters</span>
            {/* `aria-disabled`, not `disabled`: an inert control stays in the tab order, so a keyboard reader lands on it and hears that there is nothing to
                clear, rather than the button vanishing from the sequence the moment the last filter is reset. The handler is the other half of the promise. */}
            <button
              type="button"
              className="filter-bar-clear"
              aria-disabled={count === 0 || undefined}
              onClick={() => {
                if (count > 0) onClear();
              }}
            >
              Clear all
            </button>
          </div>
          {children}
        </Popover>
      )}

      {open === 'sort' && sort !== undefined && (
        <Popover label="Sort by" width={300} anchor={sortButton} onClose={close}>
          <div className="filter-bar-head">
            <span>Sort by</span>
          </div>
          {sort.options.map((o) => {
            const chosen = o.value === sort.key;
            // The `aria-label` is the bare label. Without it the name is the row's whole text, `Created when it was filed`, which no exact lookup of `Created`
            // finds and a screen reader reads as one run-on word; the hint is still visible text, it just is not part of the name.
            return (
              <button
                key={o.value}
                type="button"
                className={chosen ? 'filter-bar-opt on' : 'filter-bar-opt'}
                aria-pressed={chosen}
                aria-label={o.label}
                onClick={() => sort.onKey(o.value)}
              >
                {o.label}
                <span className="filter-bar-opt-hint">{o.hint}</span>
                <svg className="filter-bar-tick" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 10.5l4 4 8-9" />
                </svg>
              </button>
            );
          })}
          <div className="filter-bar-rule" />
          <Segmented<SortDir>
            pill
            label="Direction"
            value={sort.dir}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' }
            ]}
            onChange={sort.onDir}
          />
          {/* This board's own line. The dashboard's sort popover has none because its sessions have no live-first rank; here a running card always leads its
              column whatever the key, and a reader who flips the direction and watches the live card stay put should be told that is deliberate. */}
          <p className="filter-bar-foot">Live cards always sort first, whatever the order.</p>
        </Popover>
      )}
    </div>
  );
}

/**
 * One section of the filter popover — a 12 px `--ink2` heading, the optional `--ink3` hint after it, then the children (the band-filter spec's §2).
 *
 * Every section heading in the panel comes from here — Project's, inside `ProjectPicks`, and the Board's Status — so two pages' panels cannot come to draw a
 * heading in two sizes. The title sits in a span of its own, apart from the hint, so a group that wants naming from the title alone (`ProjectPicks`) has
 * something to name it from that does not swallow `· one at a time — Orchestrate needs one`.
 *
 * `fill` marks a section whose child is a switch to be laid out the panel's full width. It only adds a class; the stylesheet's `.filter-bar-section-fill`
 * rule does the stretching, reaching the switch by `[role="group"]` so no `.ui-seg` token appears outside the primitives block (guard 7). It is for the Status
 * switch and never for the Project picks, whose chips are content-sized and wrap — stretched, a three-letter project would be as wide as a long one.
 */
export function FilterSection({ title, hint, fill, children }: { title: string; hint?: string; fill?: boolean; children: ReactNode }) {
  return (
    <div className={fill ? 'filter-bar-section filter-bar-section-fill' : 'filter-bar-section'}>
      <div className="filter-bar-heading">
        <span>{title}</span>
        {hint !== undefined && (
          <>
            {' '}
            <span className="filter-bar-hint">{hint}</span>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The `Project` section both pages draw — `All projects`, then one chip per registered project with its hue dot, in registry order (the band-filter spec's §2;
 * .claude/DESIGN.md §8.3, §8.5).
 *
 * **Chips are keyed, and report, by path.** Two checkouts of one repo share a name and never a path, so a name-keyed list would collapse them into one chip, or
 * collide on the React key and drop one; both render here, each handing back its own path. The label and the dot's hue are the name — the hue because that is
 * what the cards' own pills hash (`ProjectHues` is keyed on the name for exactly this), so two same-named checkouts share a colour as they share a pill.
 *
 * **`value` is whatever the caller already made fail-open.** A stored path whose project has since been unregistered must read as `All projects`, not as no
 * chip pressed at all; that resolution lives with the caller's `projectValue`, and passing the raw stored value here would leave nothing pressed.
 *
 * The pressed chip is `Chip`'s own pressed look (`--strip-hi` under an `--ink3` stroke), deliberately not an ink fill: §8.3 makes Orchestrate the page's
 * one ink chip, and an ink pick in a panel just below it would be a second. `hint` is the Board's `· one at a time — Orchestrate needs one`; Archive has no
 * Orchestrate control and passes none.
 */
export function ProjectPicks({
  projects,
  value,
  allValue,
  hues,
  hint,
  onPick
}: {
  projects: RegistryProject[];
  /** The picked project's path, or `allValue`. */
  value: string;
  /** The sentinel that means no project is picked — the caller's own `ALL`, so this component never hard-codes it. */
  allValue: string;
  hues: ProjectHues;
  hint?: string;
  onPick: (path: string) => void;
}) {
  return (
    <FilterSection title="Project" hint={hint}>
      {/* Named from the title alone: the group's name is a literal and not the heading's text, which would carry the hint with it. */}
      <div className="filter-bar-picks" role="group" aria-label="Project">
        <Chip size={28} pressed={value === allValue} onClick={() => onPick(allValue)}>
          All projects
        </Chip>
        {projects.map((p) => (
          <Chip key={p.path} size={28} pressed={value === p.path} icon={<Dot hue={hues.hueFor(p.name)} />} onClick={() => onPick(p.path)}>
            {p.name}
          </Chip>
        ))}
      </div>
    </FilterSection>
  );
}
