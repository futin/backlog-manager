import { lazy, Suspense, useState } from 'react';

import { SideRail, type Section } from './components/SideRail';
import { SettingsProvider, useSettings } from './hooks/useSettings';
import { usePersistedState } from './hooks/usePersistedState';

// Lazy: each section's chunk loads only when it is opened.
const BoardView = lazy(() => import('./components/board/BoardView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

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
  const [stored, setStored] = usePersistedState<Section>('backlog-manager.section', 'projects');
  /*
    A `landing` other than 'last' pins the opening section. Resolved once, in the
    initializer, so there is no flash of the previously-open section — and only
    the *initial* value, never the stored one: `stored` keeps recording every
    change underneath, so switching the setting back to 'last' finds a real last
    section rather than whatever was current when the override was turned on.
  */
  const [section, setSection] = useState<Section>(() =>
    settings.landing === 'last' ? stored : settings.landing
  );

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  // Guard a hand-edited or stale stored value — an unknown section would render
  // nothing at all.
  const current: Section = section === 'settings' ? 'settings' : 'projects';

  return (
    <div className="shell">
      <SideRail section={current} onChange={change} />
      <main className="main">
        {/* The board's four columns need the room; settings reads better narrow. */}
        <div className={current === 'projects' ? 'wrap wide' : 'wrap'}>
          <Suspense fallback={<SectionLoading />}>
            {current === 'projects' ? <BoardView /> : <SettingsView />}
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
