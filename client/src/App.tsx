import { lazy, Suspense, useState } from 'react';

import { SECTIONS, SideRail, type Section } from './components/SideRail';
import { SettingsProvider, useSettings } from './hooks/useSettings';
import { usePersistedState } from './hooks/usePersistedState';

// Lazy: each section's chunk loads only when it is opened.
const BoardView = lazy(() => import('./components/board/BoardView'));
const RunsView = lazy(() => import('./components/runs/RunsView'));
const ArchiveView = lazy(() => import('./components/archive/ArchiveView'));
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
      <AppShell />
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
  const [stored, setStored] = usePersistedState<Section>(
    'backlog-manager.section', FALLBACK_SECTION
  );
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
  const [section, setSection] = useState<Section>(() =>
    resolveSection(settings.landing === 'last' ? stored : settings.landing)
  );

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  /*
    No second clamp on the way to the render below, unlike the two-way guard
    this replaced. Everything untrusted was resolved in the initializer above,
    and the only other writer is `change`, which the rail calls with one of its
    own tab ids — so `section` cannot become invalid after mount, and a clamp
    here would only hide the type error if it ever could.
  */
  return (
    <div className="shell">
      <SideRail section={section} onChange={change} />
      <main className="main">
        {/* Settings reads better narrow; every board surface wants the room for
            its columns, so the test names the narrow one and new surfaces are
            wide by default. */}
        <div className={section === 'settings' ? 'wrap' : 'wrap wide'}>
          <Suspense fallback={<SectionLoading />}>
            {section === 'board' && <BoardView />}
            {section === 'runs' && <RunsView />}
            {section === 'archive' && <ArchiveView />}
            {section === 'settings' && <SettingsView />}
          </Suspense>
        </div>
      </main>
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
