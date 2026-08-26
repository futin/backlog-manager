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
          <Suspense fallback={<div className="board-empty">loading…</div>}>
            {current === 'projects' ? <BoardView /> : <SettingsView />}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
