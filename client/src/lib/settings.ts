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

import { EFFORTS, MODELS } from '../../../shared/agent';
import { SECTIONS, type Section } from '../components/SideRail';

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

/**
 * A preselected launch flag, or `''` for "send no flag and let the `claude` CLI
 * decide". Not a union of MODELS' members: `MODELS` is a `readonly string[]`
 * here (shared/agent.ts keeps it that way on purpose, so an unknown name costs
 * the flag rather than failing to compile), so there is no literal union to
 * derive. `clampSettings` is what actually enforces membership at runtime,
 * which is the check that matters for a value read back out of localStorage.
 */
export type DispatchDefault = string;

export interface Settings {
  theme: ThemeId;
  /** Spacing only — never a colour, never a font size, so it composes with every theme. */
  density: Density;
  /** Percent. Applied as a `zoom` factor on `.shell`. */
  fontScale: number;
  landing: Landing;
  /**
   * Where *this device* reaches ../claude-agents-dashboard, used only to build
   * the link to a launched session. Per-device because it genuinely differs:
   * the laptop reaches it on loopback, the phone on a tailnet name. The API's
   * own outbound call uses BM_AGENTS_URL server-side and never this.
   */
  linkBase: string;
  /**
   * Preselected in the launch sheet's model picker; `''` leaves it on
   * "default". Copied from the dashboard's own `spawnDefaultModel`, and
   * per-device for the same reason everything else here is: the laptop that
   * runs the long executes and the phone that fires off quick grooms do not
   * want the same answer.
   *
   * This is NOT the launch sheet remembering your last pick — that was
   * rejected outright, because a sticky `max` from last week quietly spending
   * on a trivial groom is exactly what a per-launch control exists to prevent.
   * A default you set once in Settings, and can see there, is the opposite
   * arrangement: nothing changes it behind your back, and the sheet still lets
   * you override it per launch.
   */
  dispatchDefaultModel: DispatchDefault;
  /** Same as `dispatchDefaultModel`, for the effort picker. */
  dispatchDefaultEffort: DispatchDefault;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  density: 'comfortable',
  fontScale: 100,
  landing: 'last',
  linkBase: 'http://127.0.0.1:5174',
  dispatchDefaultModel: '',
  dispatchDefaultEffort: ''
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

/**
 * An http(s) origin, or the fallback. Narrow on purpose: this string becomes an
 * href, so a hand-edited `javascript:` in localStorage must not survive to
 * reach the DOM. URL parsing, not a regex — the browser's own parser is the
 * one that decides what an href means.
 */
function clampOrigin(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname.replace(/\/+$/, '')}`
      : fallback;
  } catch {
    return fallback;
  }
}

const THEME_IDS = THEMES.map((t) => t.id);
const DENSITIES = ['comfortable', 'compact'] as const;
/**
 * Every value `landing` may hold: the rail's own sections, plus `last`.
 *
 * Derived now rather than listed. This used to be a hand-copied literal, under
 * a comment warning that a section added to the rail had to be added here too
 * or it stayed unpickable — a warning nothing enforced. `SideRail` exports
 * `SECTIONS` for exactly this, so the warning and the failure mode go together.
 *
 * A stored `landing` naming a section this build no longer has — `'projects'`,
 * from before the rail said Board — falls back to `last` rather than being
 * aliased across the way `resolveSection` aliases the stored *section*. The
 * two are not the same problem: a section key with no matching tab would leave
 * `main` rendering nothing, so it has to be mapped onto something, whereas
 * `last` is a real preference that means "open where I left off" and is the
 * honest answer to a pin this build can no longer honour.
 */
const LANDINGS: readonly Landing[] = ['last', ...SECTIONS];

/**
 * `''` first, then the lists the launch sheet's own pickers are built from —
 * the same `MODELS`/`EFFORTS` the sheet renders and the server validates
 * against, so a stored default can never name something the sheet cannot show.
 * A name outside them falls back to `''` rather than being kept: the sheet
 * would render a select whose value matches no option, which renders as blank
 * and silently sends a flag nothing on screen admits to.
 */
const DISPATCH_MODELS = ['', ...MODELS];
const DISPATCH_EFFORTS = ['', ...EFFORTS];

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
    landing: pickOne(s.landing, LANDINGS, DEFAULT_SETTINGS.landing),
    linkBase: clampOrigin(s.linkBase, DEFAULT_SETTINGS.linkBase),
    dispatchDefaultModel: pickOne(
      s.dispatchDefaultModel, DISPATCH_MODELS, DEFAULT_SETTINGS.dispatchDefaultModel
    ),
    dispatchDefaultEffort: pickOne(
      s.dispatchDefaultEffort, DISPATCH_EFFORTS, DEFAULT_SETTINGS.dispatchDefaultEffort
    )
  };
}
