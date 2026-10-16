import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { SectionBoundary } from './components/SectionBoundary';
import { ReleasesDrawer } from './components/ReleasesDrawer';
import { SideRail } from './components/SideRail';
import { JiraChip } from './components/JiraChip';
import { TrackerChip } from './components/TrackerChip';
import { SECTIONS, type Section } from './lib/sections';
import { chipLabel, dotState, readLastSeen, writeLastSeen } from './lib/releases';
import type { JiraPage } from './lib/jira-page';
import { JiraProvider, useJiraContext } from './hooks/JiraContext';
import { setJiraPage } from './hooks/useJiraPage';
import { SettingsProvider, useSettings } from './hooks/useSettings';
import { TrackersProvider } from './hooks/TrackersContext';
import { useNarrow } from './hooks/useNarrow';
import { useReleases } from './hooks/useReleases';
import { usePersistedState } from './hooks/usePersistedState';
import { setRunsMode } from './hooks/useRunsMode';

// Lazy: each section's chunk loads only when it is opened.
const BoardView = lazy(() => import('./components/board/BoardView'));
const RunsView = lazy(() => import('./components/runs/RunsView'));
const ArchiveView = lazy(() => import('./components/archive/ArchiveView'));
const JiraView = lazy(() => import('./components/jira/JiraView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

/** Where an unrecognised section name lands. See `resolveSection`. */
const FALLBACK_SECTION: Section = 'board';

/**
 * Coerce a section name that came from outside this build into one the rail
 * actually has.
 *
 * Both of its inputs are untrusted in the same way: the stored
 * `backlog-manager.section` key and the `landing` preference are strings this
 * build reads back out of a localStorage some *other* build wrote. The name
 * that matters right now is `'projects'` — what the Board tab was called
 * before the rail grew Archive, and therefore what sits in the section key of
 * every install that existed before this change. Mapping it onto Board rather
 * than dropping it is the whole reason this function exists: an upgrade must
 * not open on a blank main area.
 *
 * Anything else unrecognised lands on Board too — a value typed into
 * localStorage by hand, or a section some later release removes. There is no
 * safe "leave it alone" branch here: `main` renders exactly one of the three
 * sections, so a name outside them renders nothing at all, and Board is the
 * section this app is for.
 *
 * This replaces `section === 'settings' ? 'settings' : 'projects'`, which was
 * a two-way clamp and could not express a third section — left in place it
 * would have collapsed Archive to Board on every render, making the new tab
 * look wired up and do nothing.
 */
export function resolveSection(raw: unknown): Section {
  return SECTIONS.includes(raw as Section) ? (raw as Section) : FALLBACK_SECTION;
}

export function App() {
  return (
    <SettingsProvider>
      {/* The shell's one `useTrackers` (the tracker strip spec, §4): the strip chip and Settings' Trackers card read one answer on one clock. */}
      <TrackersProvider>
        {/* The shell's one `useJira` (Jira phase 2, spec §6.1), beside the trackers' for the same reason: the rail's Jira row, the shell's hold-and-fall
            below, the chip and both Jira pages read one answer on one clock. Above `AppShell`, because the fall is decided there. */}
        <JiraProvider>
          <AppShell />
        </JiraProvider>
      </TrackersProvider>
    </SettingsProvider>
  );
}

/**
 * Inside the provider — `useSettings` cannot be called in `App` itself, and the
 * landing preference has to be readable before the first section paints.
 */
function AppShell() {
  const { settings } = useSettings();
  // Remembered across loads: reopening on the section you left is what you want
  // from a board you come back to.
  const [stored, setStored] = usePersistedState<Section>('backlog-manager.section', FALLBACK_SECTION);
  /*
    A `landing` other than 'last' pins the opening section. Resolved once, in the
    initializer, so there is no flash of the previously-open section — and only
    the *initial* value, never the stored one: `stored` keeps recording every
    change underneath, so switching the setting back to 'last' finds a real last
    section rather than whatever was current when the override was turned on.

    `resolveSection` wraps both arms rather than just the stored one. `landing`
    is clamped by `clampSettings` already, so in practice it arrives valid — but
    running one guard over whichever value wins is what makes "the section this
    renders is always a real section" true by construction here, instead of true
    only as long as two files keep agreeing about it.
  */
  const [section, setSection] = useState<Section>(() => resolveSection(settings.landing === 'last' ? stored : settings.landing));

  /*
    Whether a run on this machine is working, for the rail's wordmark cursor (§8.0). Reported up by whichever of Board, Runs and Archive is mounted
    (`useReportWorking`) rather than polled here: each of the three already runs a `useOrchestratorRuns()`, every call is its own 5 s poller, and a fourth
    in the shell would double the requests on all three pages to learn what the page on screen already knows. `undefined` is "nobody has said" — Settings,
    which polls nothing, and any view before its first report — and the rail reads it as not working.

    A view that unmounts reports nothing on its way out, so a report has to be dropped for it. `change` does that on a section CHANGE, so a Board that
    said `true` neither blinks the cursor over Settings nor comes back with the Board before the new mount has said anything — and only on a change: a
    click on the section already open (the rail's own row, a Runs tree pick) leaves the view mounted, its report effect has no reason to run again, and
    resetting there would stand the cursor solid over a run that is still working. Every report also carries the section that made it, read back only
    while that section is open, because the reset alone can lose a race: a poll that landed just before the click leaves the old view's report effect
    pending, React flushes it after the click's own update is queued, and the old view's `true` lands on top of the reset. Tagged, it lands and is
    ignored.
  */
  const [pulse, setPulse] = useState<{ section: Section; working: boolean } | null>(null);
  const working = pulse !== null && pulse.section === section ? pulse.working : undefined;
  // One stable callback per reporting section: the views' report effect lists `onWorking` as a dependency, and an inline arrow would re-run it on
  // every render of this shell.
  const report = useMemo(() => {
    const reportFor = (from: Section) => (w: boolean) => setPulse({ section: from, working: w });
    return { board: reportFor('board'), runs: reportFor('runs'), archive: reportFor('archive') };
  }, []);

  const change = (s: Section): void => {
    if (s !== section) setPulse(null);
    setSection(s);
    setStored(s);
  };

  /*
    The Jira section's hold-and-fall (Jira phase 2, spec §6.1). `resolveSection` takes a stored `jira` like any section — it runs in the initializer above,
    long before `GET /api/jira` has answered — so whether Jira is really there is decided here, on the status, and only one answer decides it: an answer
    that says `configured: false` while Jira is the section moves the shell to Board, through `change`, so the section key records `board` too. Nothing
    else moves it. While the status is unknown (not answered yet, or every read so far failed: `data` null) the section is HELD, drawn in `JiraView`'s
    loading or unavailable shape, and the rail keeps its row — a network blip at load must not throw away the section a reader left on a configured
    machine (Review Focus 5). A failure after a `configured: true` keeps that answer (`useJira` keeps the last payload), so it holds as well.

    Keyed on the STATE (`configured === false` with `jira` current) rather than on a remembered previous value: it fires on the transition into
    `configured: false`, which is the case the spec names, and also covers the one other way the pair could arise — a `change('jira')` landing while the
    status already says unconfigured — where falling is equally right, since the rail draws no row there to stand on. `change` is left out of the
    dependencies: it is a fresh closure every render, and the two values it reads are the two listed.

    A `landing: 'jira'` preference takes the same fall: it seeds the initializer exactly as a stored section does, and the preference itself is left as
    set — the machine may get its credentials back.
  */
  const jiraConfigured = useJiraContext().data?.configured;
  useEffect(() => {
    if (jiraConfigured === false && section === 'jira') change('board');
  }, [jiraConfigured, section]);

  /*
    What the Jira section's two in-page links open (`Open board` on Setup, the empty board's chip to Setup): the same PAIR the rail's Jira tree calls, in
    the same order — the page store first, then this shell's `change` — exactly as `onOpenWatchdog` below is the Runs tree's pair. Handed down rather than
    rebuilt inside the pages, so a link and a tree entry mean the same thing by construction and the section key is recorded in one place.
  */
  const onOpenJiraPage = (p: JiraPage): void => {
    setJiraPage(p);
    change('jira');
  };

  /*
    The tracker chip has ONE home at a time, chosen here from the same `useNarrow` reading the rail uses (§8.0; the tracker strip spec, §1.2): the
    shell strip at desktop width, the rail's phone bar below 700 px, where the strip is not drawn. Never both, hidden by CSS — two mounted chips would
    be two one-second clocks and two popovers able to join the Escape stack. A change of home remounts it, which is what closes an open popover
    rather than leaving it anchored to a chip that moved.
  */
  const narrow = useNarrow();

  /*
    The version chip and the What's new drawer (DESIGN.md §8.10, docs/subsystems/releases.md). The shell owns all of it: the read, the unseen dot over
    `localStorage`, and the drawer, which renders here beside the rail rather than inside it — the phone rail hides with a transform, and a transformed
    ancestor turns a `position: fixed` panel into one positioned inside it. `seen` mirrors storage in memory so a storage that throws still behaves: the seed
    is written (or swallowed) and the dot computes against it, never against a value that cannot be read back. Opening the drawer re-reads, and while it is
    open the newest version on screen is the one marked seen — a refresh that lands mid-read marks what it brought. Which value to store, and whether to dot,
    is `dotState`'s call; the shell only writes what it answers.
  */
  const releases = useReleases();
  const [seen, setSeen] = useState<string | null>(() => readLastSeen());
  const [whatsNew, setWhatsNew] = useState(false);
  const newest = releases.data?.releases[0]?.version ?? null;
  const { dot, seed } = dotState(newest, seen, whatsNew);
  useEffect(() => {
    if (seed === null || seed === seen) return;
    writeLastSeen(seed);
    setSeen(seed);
  }, [seed, seen]);
  const current = releases.data?.current ?? null;
  const releaseChip = current
    ? {
        label: chipLabel(current),
        dot,
        onOpen: () => {
          releases.refresh();
          setWhatsNew(true);
        }
      }
    : undefined;

  // Both chips are one home's occupants: the Jira chip draws only while Jira is configured, as the tracker chip only while a tracker is connected, and each
  // renders `null` otherwise — so the strip (always in the tree) and the rail bar hold zero, one or two chips, never a hidden one.
  const chip = (
    <>
      <TrackerChip section={section} />
      <JiraChip section={section} />
    </>
  );

  /*
    No second clamp on the way to the render below, unlike the two-way guard
    this replaced. Everything untrusted was resolved in the initializer above,
    and the only other writer is `change`, which the rail calls with one of its
    own tab ids — so `section` cannot become invalid after mount, and a clamp
    here would only hide the type error if it ever could.
  */
  return (
    <div className="shell">
      <SideRail section={section} onChange={change} chipSlot={narrow ? chip : undefined} working={working} releases={releaseChip} />
      {whatsNew && releases.data && <ReleasesDrawer data={releases.data} onClose={() => setWhatsNew(false)} />}
      {/* The strip over the well (§8.0). `.maincol` is the rail's paper, so the rail and the strip are one white L and the well's 24 px top-left
          curve is drawn against white — it was grey on grey while `.main` made its own gap with a margin, because `body` is --board and stays so.
          The strip is always in the tree, empty without a tracker, so its height (`--main-gap`, which `.runs-board` subtracts) never depends on
          whether one is connected; CSS hides it below 700 px. */}
      <div className="maincol">
        <div className="topstrip">{narrow ? null : chip}</div>
        <main className="main">
          {/* One measure for every section since task-42. Settings used to be the
            exception — a narrow `wrap`, on the grounds that a column of
            label-and-control rows reads better that way — and the Local/Shared
            split took the exception away: both of its pages are two
            hand-balanced columns of cards now, the same shape every other
            section draws, and the narrow wrap folded them to one at every
            width. The cap itself is released entirely under
            `contentWidth: 'full'`, which is a stylesheet rule keyed off
            `<html>` and nothing this expression has to know about. */}
          <div className="wrap wide">
            {/* Keyed by section so a switch clears one section's failure rather than carrying it onto the next (#270, `SectionBoundary`). */}
            <SectionBoundary key={section}>
              <Suspense fallback={<SectionLoading />}>
                {/* The board's run chip (DESIGN.md §8.3) navigates, and this is
                  the setter it navigates with — the same `change` the rail's own
                  Runs entry calls, handed down rather than reimplemented, so the
                  two cannot come to disagree about what opening Runs does (and
                  so the chip's click is recorded in `backlog-manager.section`
                  exactly as the rail's is). */}
                {section === 'board' && <BoardView onOpenRuns={() => change('runs')} onWorking={report.board} />}
                {section === 'runs' && <RunsView onWorking={report.runs} />}
                {section === 'archive' && <ArchiveView onWorking={report.archive} />}
                {section === 'jira' && <JiraView onOpenJiraPage={onOpenJiraPage} />}
                {/* Settings' watchdog card carries a `Live view` link to Runs ›
                  Watchdog (DESIGN.md §8.6), and this is what it opens with — the
                  same PAIR the rail's own Watchdog sub-nav entry calls, in the
                  same order: `setRunsMode` (the module-level store every mounted
                  reader subscribes to, `hooks/useRunsMode.ts`) and then this
                  shell's own `change`. Handed down rather than reimplemented in
                  Settings, for the reason the board's chip is handed `change`:
                  two expressions of "open Runs › Watchdog" would be two things
                  free to disagree, and the section key is recorded here. */}
                {section === 'settings' && (
                  <SettingsView
                    onOpenWatchdog={() => {
                      setRunsMode('watchdog');
                      change('runs');
                    }}
                  />
                )}
              </Suspense>
            </SectionBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The fallback for a section's chunk. An icon rather than bare text because this
 * is the one spinner that can be on screen for a whole network round trip — the
 * chunk is still being fetched, so there is nothing else painted in `main` to
 * say the app is alive.
 *
 * Inline SVG, not an icon package: this is the app's only icon, and a dependency
 * for one 32-byte arc would ship a whole font or component library through the
 * bundle the fallback exists to cover.
 *
 * `aria-hidden` on the mark and a live region around the word: a screen reader
 * should hear "loading…" once, not a nameless graphic beside it. The rotation is
 * CSS, so the global `prefers-reduced-motion` rule in styles.css freezes it with
 * everything else and the text still carries the meaning.
 */
function SectionLoading() {
  return (
    <div className="board-empty" role="status">
      <svg className="spinner" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        {/* Track first, arc over it — the gap in the arc is what reads as motion. */}
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".25" />
        <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      loading…
    </div>
  );
}
