import { useEffect, useState, type ReactNode } from 'react';

import { Dot } from './ui/Dot';
import { useNarrow } from '../hooks/useNarrow';
import { useRunsMode } from '../hooks/useRunsMode';
import { RUNS_MODES, type RunsMode } from '../lib/runs-mode';

/**
 * The rail's tabs, in rail order — and the one definition of what a section is.
 *
 * "Board" rather than the "Projects" this tab shipped as, and rather than
 * "Tasks": a nav entry names a place, not a type, and the place holds bugs,
 * ideas and refactors alongside tasks. Narrowing to one project is a board
 * control and lives in the board toolbar, which is what made "Projects" the
 * wrong word for a section switch in the first place.
 *
 * `as const` so `Section` can be derived from it below. Everything that needs
 * to *check* a value against the list — `resolveSection` in App.tsx, guarding
 * a stored section that outlived the build that wrote it, and `LANDINGS` in
 * lib/settings.ts, clamping the "Opens on" preference — reads `SECTIONS` from
 * here instead of hand-copying the names. A type union alone has no runtime
 * members to iterate, which is why those two used to carry duplicates of this
 * list that could silently fall out of step with the rail.
 */
const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'runs', label: 'Runs' },
  { id: 'archive', label: 'Archive' },
  { id: 'settings', label: 'Settings' }
] as const;

export type Section = (typeof TABS)[number]['id'];

/** Every section id, runtime-readable. Derived, so the rail cannot drift from it. */
export const SECTIONS: readonly Section[] = TABS.map((t) => t.id);

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: board · runs · archive · settings, and — for the
 * one section that has sub-views — the tree under it.
 *
 * .claude/DESIGN.md §8.0 is the whole specification of this component: 280 px,
 * 32 px padding-y, 36 px rows at 14/500 with a 16 px icon 12 px from the label,
 * an active row marked by a 3 px ink bar and a `--strip-hi` fill and never by a
 * colour change in the label, a sub-nav hung 24 px in and drawn only for the
 * open section, Settings under a 1 px rule, and — below 700 px — a top bar that
 * hides on a downward scroll.
 *
 * Every tab is a plain section switch and nothing more, so no tab carries
 * `aria-expanded`: a button that only navigates must not announce a panel it
 * does not hold. The Runs tree is not a panel this row opens and closes — it is
 * where that section's two views are named, drawn because the section is open
 * rather than because the row was expanded. Narrowing the board to one project
 * belongs beside the board, in the board toolbar, not in the switch that
 * decides which section is showing.
 */
export function SideRail({ section, onChange }: Props) {
  const narrow = useNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const hidden = useRailHidden(narrow, menuOpen);
  // The one control that SWITCHES the Runs section's two views since task-38
  // took the in-page segmented control away (§8.0: the tree replaces it at
  // every width). It is not the only writer of the key — `RunsView`'s own
  // Watchdog row click writes `runs` to jump back to History with a run
  // selected — which is exactly why this goes through `useRunsMode`: a
  // module-level value every mounted reader subscribes to, so the rail and the
  // page can never be looking at different views. `lib/runs-mode.ts` stays the
  // one home of the key, the member list and the guard.
  const [runsMode, setRunsMode] = useRunsMode();

  const brand = (
    <h1 className="rail-brand">
      <span className="rail-kicker">Backlog</span>
      <span className="rail-word">
        Manager
        {/* Decoration, not status (§8.0) — which is why it is a Dot with no
            tone that means anything and no text of its own. */}
        <Dot tone="done" />
      </span>
    </h1>
  );

  // Below 700 px every tree stands open, so a sub-view is a tap away rather
  // than behind an accordion (§8.0).
  const treeOpen = (id: Section): boolean => narrow || section === id;

  return (
    <nav className="rail" aria-label="Sections" data-hidden={hidden ? 'true' : undefined}>
      {narrow ? (
        <div className="rail-bar">
          {brand}
          <button type="button" className="rail-menu" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            ☰
          </button>
        </div>
      ) : (
        brand
      )}

      {(!narrow || menuOpen) &&
        TABS.map((t) => (
          <div key={t.id}>
            {t.id === 'settings' && <div className="rail-rule" aria-hidden="true" />}
            <button
              className={section === t.id ? 'rail-link on' : 'rail-link'}
              aria-current={section === t.id ? 'page' : undefined}
              onClick={() => {
                onChange(t.id);
                setMenuOpen(false);
              }}
            >
              <RailIcon section={t.id} />
              {t.label}
            </button>
            {t.id === 'runs' && treeOpen('runs') && (
              /* `aria-current="true"` on the open tree entry, not `"page"`: the
               section row above it is what holds `page`, and two elements
               claiming to be the current page would leave a reader with two
               answers to one question. The tree entry is the current ITEM
               within that page, which is what the bare `true` means. */
              <div className="rail-sub" role="group" aria-label="Runs views">
                {RUNS_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={runsMode === m && section === 'runs' ? 'rail-sublink on' : 'rail-sublink'}
                    aria-current={runsMode === m && section === 'runs' ? 'true' : undefined}
                    onClick={() => {
                      setRunsMode(m);
                      onChange('runs');
                      setMenuOpen(false);
                    }}
                  >
                    {RAIL_SUB_LABEL[m]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
    </nav>
  );
}

/**
 * The phone bar's hide-on-scroll (§8.0): away on a downward scroll, back on the
 * first upward one, and pinned open while the menu is — the menu hangs off the
 * bar, so a bar that slid away would take it along.
 *
 * The 4 px dead band is not tuning for its own sake: iOS reports sub-pixel
 * scroll deltas on a rubber-band bounce at the top of a document, and without
 * it the bar flickers in and out of view while the page is standing still.
 */
function useRailHidden(narrow: boolean, menuOpen: boolean): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!narrow || menuOpen) {
      setHidden(false);
      return;
    }
    let last = window.scrollY;
    const onScroll = (): void => {
      const y = window.scrollY;
      if (y > last + 4) setHidden(true);
      else if (y < last - 4) setHidden(false);
      last = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [narrow, menuOpen]);

  return hidden;
}

/**
 * One 16 px outline icon per section (§6: ~1.5 px stroke, rounded joins,
 * `--ink` at every row weight — an icon names the section, never its state).
 *
 * Inline SVG rather than an icon package, the same bargain `SectionLoading`
 * makes in App.tsx: four paths do not justify shipping a font or a component
 * library through the bundle.
 */
function RailIcon({ section }: { section: Section }) {
  return (
    <svg
      className="rail-ic"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[section]}
    </svg>
  );
}

/**
 * The tree's own labels, and the ONLY labels these two views have: task-38
 * deleted `runs-mode.ts`'s `MODE_BUTTON` pair along with the in-page control it
 * named, so there is no second wording left to disagree with this one.
 *
 * `History` rather than `Runs` for the first: the row directly above already
 * says Runs, so a child repeating it would name its parent rather than the
 * view — and the page under it carries the live runs and the selected run as
 * well as the past ones, so it is named for what a person is looking for when
 * they arrive with nothing running (§8.4.1's own "Why the name"). The mode
 * VALUES are `RUNS_MODES`', so the key and its guard stay single
 * implementations.
 */
const RAIL_SUB_LABEL: Record<RunsMode, string> = {
  runs: 'History',
  watchdog: 'Watchdog'
};

const ICON_PATHS: Record<Section, ReactNode> = {
  // Three columns — the board's own shape.
  board: (
    <>
      <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v11h-3z" />
    </>
  ),
  // A play triangle inside a circle: a run is something that is going.
  runs: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.75 5.75 10.5 8l-3.75 2.25z" />
    </>
  ),
  // A lidded box.
  archive: (
    <>
      <path d="M2 4.5h12v2.5H2zM3 7v6.5h10V7" />
      <path d="M6.5 9.5h3" />
    </>
  ),
  // A slider row — two tracks, two handles.
  settings: (
    <>
      <path d="M2.5 5.5h11M2.5 10.5h11" />
      <circle cx="6" cy="5.5" r="1.75" />
      <circle cx="10.5" cy="10.5" r="1.75" />
    </>
  )
};
