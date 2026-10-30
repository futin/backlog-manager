import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { usePersistedState } from './usePersistedState';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, clampSettings, type Settings } from '../lib/settings';

interface SettingsControl {
  settings: Settings;
  /** Merge a partial change. Always re-clamped, so no caller can store a bad value. */
  update: (patch: Partial<Settings>) => void;
  /**
   * The stored `landing` while it still names a legacy `board`/`archive` — which `settings.landing` reads as `github` — or `null`. The shell settles it on
   * the first projects answer (`App`); a write to `landing` is the only thing that ends it.
   */
  legacyLanding: 'board' | 'archive' | null;
}

const SettingsContext = createContext<SettingsControl | null>(null);

/**
 * Per-device settings for the whole app.
 *
 * Storage is `usePersistedState`, which shallow-merges the stored blob over the
 * defaults — so a value written before a field existed still picks that field's
 * default up. `clampSettings` runs on top of the merge to bound anything
 * hand-edited or left over from an older release.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = usePersistedState<Settings>(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS);
  const settings = useMemo(() => clampSettings(stored), [stored]);
  const raw = (stored as { landing?: unknown }).landing;
  const legacyLanding: SettingsControl['legacyLanding'] = raw === 'board' || raw === 'archive' ? raw : null;

  // The clamp's `board`/`archive` → `github` is a READ-time alias, and must never be written back by accident (#399): a patch that does not name `landing`
  // carries a raw legacy value through unchanged, so the first Settings change of a load cannot store `github` as a real pin before the shell has settled
  // the legacy one to the source this machine actually has. A patch that names `landing` is the reader's (or the settle's) choice, written as given.
  const update = useCallback(
    (patch: Partial<Settings>) => {
      const next = clampSettings({ ...settings, ...patch });
      setStored(legacyLanding !== null && !('landing' in patch) ? ({ ...next, landing: legacyLanding } as unknown as Settings) : next);
    },
    [settings, legacyLanding, setStored]
  );

  // Theme, density, text scale and content width are all pure CSS: everything
  // downstream keys off these four root values, so no component re-renders when
  // they change. All four are stamped pre-paint by the inline script in
  // index.html, so this effect only keeps them in step afterwards.
  //
  // Every one of them is in the dependency list, and that is load-bearing
  // rather than tidy: a stamp whose value is missing from the deps still works
  // on reload — the pre-paint script wrote it — and silently does nothing when
  // the control is clicked, which is the one shape of this bug that survives
  // being developed against, because reloading is what you do next anyway.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.density = settings.density;
    root.dataset.width = settings.contentWidth;
    root.style.setProperty('--font-scale', String(settings.fontScale / 100));
  }, [settings.theme, settings.density, settings.contentWidth, settings.fontScale]);

  const value = useMemo(() => ({ settings, update, legacyLanding }), [settings, update, legacyLanding]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/**
 * The current settings. Falls back to the defaults outside a provider so a
 * component rendered in isolation (or a test) still works — the settings are a
 * preference layer, never a precondition.
 */
export function useSettings(): SettingsControl {
  const ctx = useContext(SettingsContext);
  return ctx ?? { settings: DEFAULT_SETTINGS, update: () => {}, legacyLanding: null };
}
