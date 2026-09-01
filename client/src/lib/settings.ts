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
  /**
   * Days. How long an open item may go untouched before it leaves the Board
   * for Archive (`client/src/lib/item-stale.ts`).
   *
   * A client setting rather than a server one, and per-device like everything
   * else here, because Board-versus-Archive is a VIEW decision: the server
   * already returns the whole corpus and the split is drawn over it here. It
   * writes nothing to any item file, so two devices disagreeing about the
   * window costs nothing but two different readings of the same store —
   * which is the point, since the phone glancing at what is live this week
   * and the laptop planning a quarter want different answers.
   */
  staleDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  density: 'comfortable',
  fontScale: 100,
  landing: 'last',
  linkBase: 'http://127.0.0.1:5174',
  dispatchDefaultModel: '',
  dispatchDefaultEffort: '',
  staleDays: 30
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
  fontScale: { min: 80, max: 130 },
  /**
   * A day, not an hour, is the floor: the stamp this window is compared
   * against can be a bare `YYYY-MM-DD` (see item-stale.ts), so anything
   * finer than a day is a precision the data cannot answer to. The ceiling
   * is ten years, which is not a real preference so much as the point past
   * which "archive on staleness" has been turned off — and a value that
   * large means exactly that, so it is honoured rather than rejected.
   */
  staleDays: { min: 1, max: 3650 }
} as const;

/** The stops the Text size row offers. A subset of LIMITS, not its definition. */
export const FONT_SCALES = [90, 100, 110, 120];

/**
 * The stops the staleness row offers — a subset of LIMITS, same as
 * FONT_SCALES. A week is "what is live right now", a fortnight is a sprint,
 * a month is the default the design argued for, and a quarter is for a board
 * nobody wants narrowed much at all. A hand-edited value between or beyond
 * them still works; these are the four worth one click.
 */
export const STALE_WINDOWS = [7, 14, 30, 90];

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
 * A bounded count of days, or the DEFAULT — not the nearest bound — for
 * anything at or below zero.
 *
 * That asymmetry with `clampInt` above is the whole reason this is its own
 * function. `fontScale: 10` plainly means "as small as you allow", so
 * snapping it to the minimum honours the intent. A staleness window of `0`
 * or `-5` has no such reading: taken literally it would empty the Board of
 * every refactor, idea and bug at once, on the strength of a value nobody
 * can have meant, and the reader would be left staring at a board that looks
 * broken with no clue that a number in localStorage is why. Above the
 * ceiling is the opposite case and clamps normally — `99999` and `3650` mean
 * the same thing (never archive), so there is nothing to second-guess.
 */
function clampDays(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  const days = Math.round(n);
  return days < min ? fallback : Math.min(max, days);
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
    ),
    staleDays: clampDays(
      s.staleDays, DEFAULT_SETTINGS.staleDays,
      LIMITS.staleDays.min, LIMITS.staleDays.max
    )
  };
}
