import { useEffect, useState, type ReactNode } from 'react';
import { VersionChip } from 'ui-kit';

import { useJiraContext } from '../hooks/JiraContext';
import { useJiraPage } from '../hooks/useJiraPage';
import { useProjectsContext } from '../hooks/ProjectsContext';
import { useFilesPage, useGithubPage } from '../hooks/useSourcePage';
import { useNarrow } from '../hooks/useNarrow';
import { useRunsMode } from '../hooks/useRunsMode';
import { useSettings } from '../hooks/useSettings';
import { JIRA_PAGES, type JiraPage } from '../lib/jira-page';
import { RUNS_MODES, type RunsMode } from '../lib/runs-mode';
import { SECTIONS, type Section } from '../lib/sections';
import { FILES_PAGES, GITHUB_PAGES, type FilesPage, type GithubPage } from '../lib/source-page';
import { SETTINGS_SCOPES, type SettingsScope } from '../lib/settings';

/**
 * Each section's label in the rail. The LIST and its order live in
 * `lib/sections.ts`; what belongs here is only the wording, because a label is
 * presentation and the rail is the only surface that draws one.
 *
 * A `Record<Section, string>` rather than an array of pairs, so a section added
 * to `SECTIONS` cannot ship without a label — the compiler asks for it. That is
 * the same guarantee the old arrangement gave from the other direction, when
 * `SECTIONS` was derived from a `TABS` list that held both halves; see
 * `lib/sections.ts` for why the halves parted.
 */
const RAIL_LABEL: Record<Section, string> = {
  files: 'Files',
  github: 'GitHub',
  jira: 'Jira',
  runs: 'Runs',
  settings: 'Settings'
};

/**
 * Re-exported so nothing that already asks the rail for the section vocabulary
 * has to be rewritten to ask `lib/sections.ts` instead — and, more to the
 * point, so a component reading `Section` keeps reading it from the component
 * layer. `lib/sections.ts` is the one definition either way.
 */
export { SECTIONS, type Section };

interface Props {
  section: Section;
  onChange: (s: Section) => void;
  /**
   * The tracker chip's narrow home (§8.0): drawn in the phone bar between the wordmark and ☰, because below 700 px the shell strip — its desktop home —
   * is not drawn at all. `App` passes it only while `useNarrow` says narrow and draws it in the strip otherwise, so the chip is one element in one
   * place, never two copies with CSS hiding one. Ignored at desktop width: the rail has no bar there to put it in.
   */
  chipSlot?: ReactNode;
  /**
   * Whether a run on this machine is working — the wordmark cursor's one input (§8.0): it blinks while this is `true` and stands solid otherwise.
   * `App` holds it from whichever view is mounted (`useReportWorking`); `undefined` — Settings, which polls nothing, or any view before its first poll
   * lands — reads as not working, because nothing that knows of a run has said there is one.
   */
  working?: boolean;
  /**
   * The version chip (DESIGN.md §8.10): the running version's label, whether a release has landed since this browser last opened the drawer, and the open.
   * Every part is `App`'s — the read, the dot's storage, the drawer — because the drawer must render outside the rail (a transformed ancestor clips a
   * `position: fixed` panel, and the phone rail hides with a transform). Absent, no chip: the checkout has no version, or the read has not answered.
   */
  releases?: { label: string; dot: boolean; onOpen: () => void };
  /**
   * Whether `section` is the shell's GUESS rather than a section the reader chose (source-sections spec, Fallback): a legacy `board`/`archive`, an
   * unrecognised stored value, or no stored value at all, all landing on GitHub before the projects answer exists. `App` owns it and clears it when it
   * settles. Required rather than defaulted, because it changes what an unknown answer draws: a held section the reader chose keeps its row, a guess draws
   * none — a GitHub row that appeared on a guess and vanished on the answer would be the rail flickering on every load of a files-only machine.
   */
  provisional: boolean;
}

/**
 * Top-level section switch: files · github · jira · runs · settings (each source
 * row only while a registered project has that source, jira only while the
 * site is configured — see `drawn` below), and — for each section that has
 * sub-views — the tree under it. Board and Archive are pages under each source
 * row since the source-sections change, never rows of their own.
 *
 * .claude/DESIGN.md §8.0 is the whole specification of this component: the
 * dashboard's own rail — 240 px, 24 px padding, 36 px rows 4 px apart at 14/500
 * with a 16 px icon 12 px from the label, an active row marked by a 3 px ink
 * bar and a `--strip-hi` fill and never by a colour change in the label, the
 * prompt-cursor wordmark, a sub-nav hung 24 px in and drawn only for the
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
export function SideRail({ section, onChange, chipSlot, working, releases, provisional }: Props) {
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
  // The Settings tree's own value, and the reason it is a SETTING rather than a
  // second module-level store beside `useRunsMode`: both of its readers — this
  // tree and `SettingsView` — already sit inside `SettingsProvider`, so a store
  // here would be a second mechanism buying nothing. Runs' mode needs the store
  // because `RunsView` writes it too, from a surface with no settings context
  // in its way; nothing outside Settings ever writes this one.
  const { settings, update } = useSettings();
  // The Jira section's page — `useRunsMode`'s module store and its reason: this tree and the Board page's own `Set up` chip (threaded down from `App` as
  // `onOpenJiraPage`) are two mounted writers of one value, and a `usePersistedState` per caller would leave the other looking at a stale page.
  const [jiraPage, setJiraPage] = useJiraPage();
  /*
    The Jira row (Jira phase 2, spec §6.1) is drawn while `GET /api/jira` says `configured: true`, and in ONE other case: the status is still unknown (`data`
    null — not answered yet, or every read so far failed) and Jira is the section on screen. That is the shell's hold (`App`): a stored `jira` is kept until an
    answer says `configured: false`, and a held section with no row of its own would leave the reader on a page the rail does not name. An answer of
    `configured: false` hides the row at once, and the shell falls on the same answer — to the first drawn source row, or Runs when there is none. Unknown with
    another section open draws nothing: a row that appeared on a guess and vanished on the answer would be the rail flickering on every load of an unconfigured
    machine.
  */
  const jira = useJiraContext().data;
  /*
    The two source rows (source-sections spec) follow the Jira row's rule over the shell's projects answer: drawn while a registered project has that
    source, and — while the answer is unknown (`drawn` null: not answered yet, or every read so far failed) — only for the section on screen, which is the
    shell's hold. One more condition the Jira row has no need of: not while that section is `provisional`. A provisional GitHub is the shell's guess for a
    legacy or absent stored value, not a section anybody chose; drawing its row on the guess would show a GitHub row on a files-only machine for as long
    as the first read takes, and take it back on the answer. Read from the context directly rather than threaded through `App`, as `useJiraContext` is.
  */
  const sources = useProjectsContext().drawn;
  const drawn = (id: Section): boolean => {
    if (id === 'jira') return jira?.configured === true || (jira === null && section === 'jira');
    if (id === 'files' || id === 'github') return sources?.[id] === true || (sources === null && section === id && !provisional);
    return true;
  };
  // Each source's page — `useJiraPage`'s module store, for its reason: this tree and the shell (which settles a legacy landing onto a page) both write it.
  const [filesPage, setFilesPage] = useFilesPage();
  const [githubPage, setGithubPage] = useGithubPage();

  /*
    The wordmark (§8.0): a `BACKLOG` kicker over `› manager▌`, a terminal prompt in the one UI face — the dashboard's own, so the two neighbouring tabs
    still draw one sidebar. The cursor is the only part that moves: it blinks while a run on this machine is working and stands solid otherwise, which
    makes it a hint and never the record — RunChip and the Runs page say it in words. Reduced motion stops the blink, not the cursor.

    Rendered once, in whichever home the width picks (the rail's head, or the phone bar), so the document has exactly one <h1>. It carries the app's name
    as its `aria-label` and hides its drawn parts, because read verbatim they would be "BACKLOG › manager" and an empty box.
  */
  const brand = (
    <h1 className="rail-brand" aria-label="Backlog Manager">
      <span className="rail-kicker" aria-hidden="true">
        Backlog
      </span>
      <span className="rail-prompt" aria-hidden="true">
        <span className="rail-caret">›</span>
        manager
        <span className={working === true ? 'rail-cursor blink' : 'rail-cursor'} />
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
          {chipSlot}
          <button type="button" className="rail-menu" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            ☰
          </button>
        </div>
      ) : (
        brand
      )}

      {(!narrow || menuOpen) &&
        SECTIONS.filter(drawn).map((id) => (
          <div key={id}>
            {id === 'settings' && <div className="rail-rule" aria-hidden="true" />}
            <button
              className={section === id ? 'rail-link on' : 'rail-link'}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => {
                onChange(id);
                setMenuOpen(false);
              }}
            >
              <RailIcon section={id} />
              {RAIL_LABEL[id]}
            </button>
            {id === 'files' && treeOpen('files') && (
              <RailTree
                label="Files pages"
                section="files"
                current={section}
                items={FILES_PAGES}
                value={filesPage}
                labelFor={(p) => RAIL_SOURCE_LABEL[p]}
                onPick={setFilesPage}
                onChange={onChange}
                closeMenu={() => setMenuOpen(false)}
              />
            )}
            {id === 'github' && treeOpen('github') && (
              <RailTree
                label="GitHub pages"
                section="github"
                current={section}
                items={GITHUB_PAGES}
                value={githubPage}
                labelFor={(p) => RAIL_SOURCE_LABEL[p]}
                onPick={setGithubPage}
                onChange={onChange}
                closeMenu={() => setMenuOpen(false)}
              />
            )}
            {id === 'runs' && treeOpen('runs') && (
              <RailTree
                label="Runs views"
                section="runs"
                current={section}
                items={RUNS_MODES}
                value={runsMode}
                labelFor={(m) => RAIL_SUB_LABEL[m]}
                onPick={setRunsMode}
                onChange={onChange}
                closeMenu={() => setMenuOpen(false)}
              />
            )}
            {id === 'jira' && treeOpen('jira') && (
              <RailTree
                label="Jira pages"
                section="jira"
                current={section}
                items={JIRA_PAGES}
                value={jiraPage}
                labelFor={(p) => RAIL_JIRA_LABEL[p]}
                onPick={setJiraPage}
                onChange={onChange}
                closeMenu={() => setMenuOpen(false)}
              />
            )}
            {id === 'settings' && treeOpen('settings') && (
              <RailTree
                label="Settings pages"
                section="settings"
                current={section}
                items={SETTINGS_SCOPES}
                value={settings.settingsScope}
                labelFor={(v) => RAIL_SCOPE_LABEL[v]}
                onPick={(settingsScope) => update({ settingsScope })}
                onChange={onChange}
                closeMenu={() => setMenuOpen(false)}
              />
            )}
          </div>
        ))}

      {/* The rail's last element, sunk to its foot at desktop width; in the phone menu its last row, drawn only while the menu is open like every row.
          Status lives in the dot alone (§8.10). The chip is ui-kit's `VersionChip` and draws itself — it takes no `className` — so `.rail-release` is a
          wrapper that owns the placement and nothing else. `narrow` is the same `useNarrow()` reading the rest of the rail uses: it gives the pill its
          44 px hit area on a phone, which overhangs the pill by 8 px above and below, so nothing around this wrapper may clip (the rail's own padding and the
          wrapper's margins keep that overhang inside its padding box). A click closes the menu as a section row's does, so the drawer is not opened behind it. */}
      {releases && (!narrow || menuOpen) && (
        <div className="rail-release">
          <VersionChip
            label={releases.label}
            dot={releases.dot}
            narrow={narrow}
            onClick={() => {
              releases.onOpen();
              setMenuOpen(false);
            }}
          />
        </div>
      )}
    </nav>
  );
}

/**
 * One sub-nav tree, drawn for whichever section has one (§8.0).
 *
 * ONE render path rather than a block per section, because the markup carries
 * three details that must not drift: the `rail-sub`/`rail-sublink` class pair,
 * `aria-current="true"` rather than `"page"`, and closing the phone menu on a
 * pick. Copied for a second section those become two things free to disagree,
 * and the disagreement would be silent — two trees that merely LOOK the same.
 *
 * `aria-current="true"` and not `"page"`: the section row above holds `page`,
 * and two elements claiming to be the current page would leave a reader with
 * two answers to one question. A tree entry is the current ITEM within that
 * page, which is what the bare `true` means.
 *
 * What legitimately differs per section is only three things, so those are what
 * the call sites supply: the item list, which of them is current, and what a
 * pick writes. `current` is the SECTION the reader is actually on, kept apart
 * from this tree's own `section` because below 700 px every tree is drawn at
 * once — a tree whose section is not current must mark nothing, or the rail
 * would announce a current item on a page nobody is looking at.
 */
function RailTree<T extends string>({
  label,
  section,
  current,
  items,
  value,
  labelFor,
  onPick,
  onChange,
  closeMenu
}: {
  label: string;
  section: Section;
  current: Section;
  items: readonly T[];
  value: T;
  labelFor: (item: T) => string;
  onPick: (item: T) => void;
  onChange: (s: Section) => void;
  closeMenu: () => void;
}) {
  return (
    <div className="rail-sub" role="group" aria-label={label}>
      {items.map((item) => {
        const on = value === item && current === section;
        return (
          <button
            key={item}
            type="button"
            className={on ? 'rail-sublink on' : 'rail-sublink'}
            aria-current={on ? 'true' : undefined}
            onClick={() => {
              onPick(item);
              // A tree entry is a destination as well as a choice: picked from
              // another section it has to bring the reader along, or it would
              // persist a view nobody can see.
              onChange(section);
              closeMenu();
            }}
          >
            {labelFor(item)}
          </button>
        );
      })}
    </div>
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
 * makes in App.tsx: five paths do not justify shipping a font or a component
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
  watchdog: 'Watchdog',
  ticks: 'Ticks'
};

/**
 * The Settings tree's labels, and — exactly like `RAIL_SUB_LABEL` above — the
 * only labels these three pages have: Settings draws no in-page switch at any
 * width, so there is no second wording for this one to fall out of step with.
 *
 * `Local` and `Shared` name the SCOPE rather than the contents, because that is
 * the question a reader is answering when they pick one: whether what they are
 * about to change affects anybody but themselves. `Dashboards` is the one label
 * that names contents — the page is the machines list, and what it writes is the
 * host's like Shared's. The page's own scope pill
 * spells the same distinction out in words (`this browser` / `this machine`).
 */
const RAIL_SCOPE_LABEL: Record<SettingsScope, string> = {
  local: 'Local',
  shared: 'Shared',
  dashboards: 'Dashboards'
};

/**
 * The Jira tree's labels (Jira phase 2, spec §6.1; DESIGN.md §8.9) — `RAIL_SUB_LABEL`'s rule: the only labels these two pages have, because neither page
 * draws a switch of its own at any width. `Open board` on Setup and the empty board's chip to Setup are this tree's own navigation handed down through
 * `App` (`onOpenJiraPage`), not second controls with wording of their own to keep in step.
 *
 * `Board` repeats the source trees' word on purpose: under the `Jira` row it reads as Jira's board, and the page it opens is a board — three columns of
 * cards — in the same sense Files › Board and GitHub › Board are.
 */
const RAIL_JIRA_LABEL: Record<JiraPage, string> = {
  board: 'Board',
  setup: 'Setup'
};

/**
 * Both source trees' labels (source-sections spec), one map because the two trees name the same pages the same way — Board and Archive are the views the
 * root rows of those names used to open, now one per source, GitHub's Settings is the tracker settings that lived on Shared Settings, and GitHub's PRs is
 * its open pull requests (§8.11) — `PRs`, the word GitHub's own tabs use, not `Pull requests`, which would be the tree's one two-word label. `RAIL_SUB_LABEL`'s
 * rule: these are the only labels the pages have, because no source page draws a switch of its own.
 */
const RAIL_SOURCE_LABEL: Record<FilesPage | GithubPage, string> = {
  board: 'Board',
  prs: 'PRs',
  archive: 'Archive',
  settings: 'Settings'
};

const ICON_PATHS: Record<Section, ReactNode> = {
  // Three columns — the board's own shape, which was the root Board row's icon: Files is where a plain backlog's board lives now.
  files: (
    <>
      <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v11h-3z" />
    </>
  ),
  // A branch — two commits on one line and a third forked off it: what a git host deals in, drawn as a shape rather than any product's mark.
  github: (
    <>
      <circle cx="5" cy="3.75" r="1.5" />
      <circle cx="5" cy="12.25" r="1.5" />
      <circle cx="11" cy="5.5" r="1.5" />
      <path d="M5 5.25v5.5M11 7c0 2.5-6 2-6 3.75" />
    </>
  ),
  // A play triangle inside a circle: a run is something that is going.
  runs: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.75 5.75 10.5 8l-3.75 2.25z" />
    </>
  ),
  // A ticket — a notched stub and a tear line: the unit an issue tracker deals in, drawn as a shape rather than any product's mark.
  jira: (
    <>
      <path d="M2.5 4.5h11v2.25a1.25 1.25 0 0 0 0 2.5v2.25h-11V9.25a1.25 1.25 0 0 0 0-2.5z" />
      <path d="M10 4.5v7" strokeDasharray="1.5 1.5" />
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
