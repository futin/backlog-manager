import { SECTIONS, type Section } from './sections';
import type { RunsMode } from './runs-mode';

/**
 * The one URL this app reads. Everything else it opens on comes from localStorage, which a link from outside cannot reach: Lookout's Orchestrator tile
 * (`server/src/hub/hub-widgets.ts`) opens `/?section=runs&runs=history`, and before this the viewer always landed on whatever section was stored.
 *
 * `section` names a section by its id. `runs` names a Runs page by its rail label, `history` or `watchdog`, never by the stored `'runs'` that means
 * History, and only next to `section=runs`. Anything unrecognised is ignored rather than clamped, so a bad link opens the app the way a plain load does.
 */
export interface DeepLink {
  section: Section | null;
  runsMode: RunsMode | null;
}

const RUNS_PAGES: Record<string, RunsMode> = { history: 'runs', watchdog: 'watchdog' };

const PARAMS = ['section', 'runs'] as const;

export function readDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const raw = params.get('section');
  const section = SECTIONS.includes(raw as Section) ? (raw as Section) : null;
  const page = params.get('runs');
  const runsMode = section === 'runs' && page !== null && Object.hasOwn(RUNS_PAGES, page) ? RUNS_PAGES[page] : null;
  return { section, runsMode };
}

/** The address with the deep link's two parameters gone and every other part kept, for `history.replaceState` once the link has been applied. */
export function withoutDeepLink(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  for (const p of PARAMS) params.delete(p);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
