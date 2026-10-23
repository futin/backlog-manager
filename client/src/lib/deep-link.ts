import { SECTIONS, type Section } from './sections';
import type { RunsMode } from './runs-mode';
import { SETTINGS_SCOPES, type SettingsScope } from './settings';

/**
 * The one URL this app reads. Everything else it opens on comes from localStorage, which a link from outside cannot reach: Lookout's Orchestrator tile
 * (`server/src/hub/hub-widgets.ts`) opens `/?section=runs&runs=history`, and before this the viewer always landed on whatever section was stored.
 *
 * `section` names a section by its id. `runs` names a Runs page by its rail label, `history` or `watchdog`, never by the stored `'runs'` that means
 * History, and only next to `section=runs`. `settings` names a Settings page by its scope, `shared` or `local`, and only next to `section=settings`: the viewer's
 * stored scope defaults to `local`, so a link that means Shared Settings (the Run on card's Settings link, which points at the Dashboards card) has to say so.
 * Anything unrecognised is ignored rather than clamped, so a bad link opens the app the way a plain load does.
 */
export interface DeepLink {
  section: Section | null;
  runsMode: RunsMode | null;
  settingsScope: SettingsScope | null;
}

const RUNS_PAGES: Record<string, RunsMode> = { history: 'runs', watchdog: 'watchdog' };

const PARAMS = ['section', 'runs', 'settings'] as const;

export function readDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const raw = params.get('section');
  const section = SECTIONS.includes(raw as Section) ? (raw as Section) : null;
  const page = params.get('runs');
  const runsMode = section === 'runs' && page !== null && Object.hasOwn(RUNS_PAGES, page) ? RUNS_PAGES[page] : null;
  const scope = params.get('settings');
  const settingsScope = section === 'settings' && SETTINGS_SCOPES.includes(scope as SettingsScope) ? (scope as SettingsScope) : null;
  return { section, runsMode, settingsScope };
}

/** The address with the deep link's parameters gone and every other part kept, for `history.replaceState` once the link has been applied. */
export function withoutDeepLink(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  for (const p of PARAMS) params.delete(p);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
