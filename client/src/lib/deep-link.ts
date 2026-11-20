import { SECTIONS, type Section } from './sections';
import type { RunsMode } from './runs-mode';
import { SETTINGS_SCOPES, type SettingsScope } from './settings';
import { isJiraKey } from '../../../shared/types';

/**
 * The one URL this app reads. Everything else it opens on comes from localStorage, which a link from outside cannot reach: Lookout's Orchestrator tile
 * (`server/src/hub/hub-widgets.ts`) opens `/?section=runs&runs=history`, and before this the viewer always landed on whatever section was stored.
 *
 * `section` names a section by its id. `runs` names a Runs page by its rail label, `history` or `watchdog`, never by the stored `'runs'` that means
 * History, and only next to `section=runs`. `settings` names a Settings page by its scope, `local`, `shared` or `dashboards`, and only next to `section=settings`: the viewer's
 * stored scope defaults to `local`, so a link that means another page (the Run on card's Settings link, which points at the Dashboards page) has to say so.
 * `ticket` names one Jira ticket by key, and only next to `section=jira`: the pair is the one address of the ticket page, which `App` keeps in the address
 * while that page is on screen (so a reload, a bookmark or a pasted link reopens it). A key is valid only as that pair AND `isJiraKey`, decided here and nowhere else.
 * Anything unrecognised is ignored rather than clamped, so a bad link opens the app the way a plain load does.
 */
export interface DeepLink {
  section: Section | null;
  runsMode: RunsMode | null;
  settingsScope: SettingsScope | null;
  ticket: string | null;
}

const RUNS_PAGES: Record<string, RunsMode> = { history: 'runs', watchdog: 'watchdog' };

const PARAMS = ['section', 'runs', 'settings', 'ticket'] as const;

export function readDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const raw = params.get('section');
  const section = SECTIONS.includes(raw as Section) ? (raw as Section) : null;
  const page = params.get('runs');
  const runsMode = section === 'runs' && page !== null && Object.hasOwn(RUNS_PAGES, page) ? RUNS_PAGES[page] : null;
  const scope = params.get('settings');
  const settingsScope = section === 'settings' && SETTINGS_SCOPES.includes(scope as SettingsScope) ? (scope as SettingsScope) : null;
  const key = params.get('ticket');
  const ticket = section === 'jira' && key !== null && isJiraKey(key) ? key : null;
  return { section, runsMode, settingsScope, ticket };
}

/** The address with the deep link's parameters gone and every other part kept, for `history.replaceState` once the link has been applied. */
export function withoutDeepLink(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  for (const p of PARAMS) params.delete(p);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
