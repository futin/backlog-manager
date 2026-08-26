/**
 * settings.ts — the per-device settings behind the Settings section.
 *
 * Everything here lives in `localStorage['backlog-manager.settings']` and never
 * reaches the server. That is the design, not laziness: a phone propped on the
 * desk wants the light theme and a larger text scale; the laptop wants the dark
 * one at 100%. Sharing them would make one device wrong.
 *
 * ⚠️ Keep this object FLAT. `usePersistedState` shallow-merges a stored value
 * over the defaults (`{ ...fallback, ...parsed }`), which is one level deep — a
 * nested object written by an older release would never gain a newly-added inner
 * field's default.
 */

import type { Section } from '../components/SideRail';

export const THEMES = [
  { id: 'midnight', label: 'Midnight Radar', hint: 'the original — deep navy scope room' },
  { id: 'graphite', label: 'Graphite', hint: 'neutral dark, no blue cast' },
  { id: 'amber', label: 'Amber CRT', hint: 'black glass and amber phosphor' },
  { id: 'nightshift', label: 'Nightshift', hint: 'deep green radar scope' },
  { id: 'daylight', label: 'Daylight Strip', hint: 'light manila paper, dark ink' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type Density = 'comfortable' | 'compact';
/**
 * Which section opens on load. `last` restores whatever you were on, which is
 * the default because a board you come back to should still be showing the
 * backlog you left. Built on `Section` rather than a parallel string union so a
 * section added to the rail cannot be silently missing here.
 */
export type Landing = Section | 'last';

export interface Settings {
  theme: ThemeId;
  /** Spacing only — never a colour, never a font size, so it composes with every theme. */
  density: Density;
  /** Percent. Applied as a `zoom` factor on `.shell`. */
  fontScale: number;
  landing: Landing;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  density: 'comfortable',
  fontScale: 100,
  landing: 'last'
};

/**
 * Allowed ranges.
 *
 * `fontScale` is ours alone: nothing outside this app reads it, so the bounds
 * only have to keep `.shell{zoom}` in a range the layout survives. Wider than
 * the stops below on purpose — a value typed into localStorage by hand is worth
 * honouring rather than snapping.
 */
export const LIMITS = {
  fontScale: { min: 80, max: 130 }
} as const;

/** The stops the Text size row offers. A subset of LIMITS, not its definition. */
export const FONT_SCALES = [90, 100, 110, 120];

/** The key this app's own settings live under. */
export const SETTINGS_STORAGE_KEY = 'backlog-manager.settings';

function pickOne<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const THEME_IDS = THEMES.map((t) => t.id);
const DENSITIES = ['comfortable', 'compact'] as const;
/**
 * Every value `landing` may hold. Listed rather than derived because `Section`
 * is a type and has no runtime members to iterate — so a section added to the
 * rail has to be added here too, or it stays unpickable.
 */
const LANDINGS = ['last', 'projects', 'settings'] as const;

/**
 * Coerce anything — a stored blob from an older release, a hand-edited
 * localStorage value — into usable settings. Pure, and every field falls back
 * independently so one bad key cannot discard the rest.
 */
export function clampSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    theme: pickOne(s.theme, THEME_IDS, DEFAULT_SETTINGS.theme),
    density: pickOne(s.density, DENSITIES, DEFAULT_SETTINGS.density),
    fontScale: clampInt(
      s.fontScale, DEFAULT_SETTINGS.fontScale,
      LIMITS.fontScale.min, LIMITS.fontScale.max
    ),
    landing: pickOne(s.landing, LANDINGS, DEFAULT_SETTINGS.landing)
  };
}
