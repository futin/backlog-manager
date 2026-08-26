import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { usePersistedState } from './usePersistedState';
import {
  DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, clampSettings, type Settings
} from '../lib/settings';

interface SettingsControl {
  settings: Settings;
  /** Merge a partial change. Always re-clamped, so no caller can store a bad value. */
  update: (patch: Partial<Settings>) => void;
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

  const update = useCallback(
    (patch: Partial<Settings>) => setStored(clampSettings({ ...settings, ...patch })),
    [settings, setStored]
  );

  // Theme, density and text scale are all pure CSS: everything downstream keys
  // off these three root values, so no component re-renders when they change.
  // All three are stamped pre-paint by the inline script in index.html, so this
  // effect only keeps them in step afterwards.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.density = settings.density;
    root.style.setProperty('--font-scale', String(settings.fontScale / 100));
  }, [settings.theme, settings.density, settings.fontScale]);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/**
 * The current settings. Falls back to the defaults outside a provider so a
 * component rendered in isolation (or a test) still works — the settings are a
 * preference layer, never a precondition.
 */
export function useSettings(): SettingsControl {
  const ctx = useContext(SettingsContext);
  return ctx ?? { settings: DEFAULT_SETTINGS, update: () => {} };
}
