import { unwrap } from './agents';
import { formatSpanCompact } from './run-time';
import type { DashboardEntry, DashboardsView, HomeEntry, MachineOffer, MachineUsage, ProjectOffers, SuggestStrategy } from '../../../shared/types';

/**
 * The client's half of multi-dashboard (spec `2026-10-22-multi-dashboard-design.md`): the six calls the launch sheets, the card dispatch and the Settings card
 * make, and every derivation the "Run on" cards draw from what the server answered. `ProjectOffers` and `DashboardsView` arrive already decided — which machine
 * is offered, why not, which one is suggested — so nothing below re-derives a verdict; this file only turns the server's numbers into the words and the locks
 * the
 * surfaces show, and a component never does that inline (every derivation has one home in `lib/`).
 *
 * A machine id is the literal `'home'` for this machine, else the remote's name. The client OMITS `machine` from a launch request for home rather than sending
 * `'home'`, so a home-only board's request is byte-identical to what it was before this feature; that rule is the caller's (`StartOrchestrateRequest.machine`
 * and `AgentDispatchRequest.machine` are both optional for exactly that reason).
 */

export const HOME_MACHINE = 'home';

/** Where the picker's "change it" link goes: this app's own deep link (`lib/deep-link.ts`) to the Settings section, where the dashboards card lives. */
export const SETTINGS_HREF = '/?section=settings&settings=shared';

/** The line a picker draws when no machine is suggested and none is offered — the one state where every card is disabled and a launch has nowhere to go. */
export const NO_MACHINE_TEXT = 'No machine can run this project right now';

/**
 * `unwrap`'s `as T` only promises a shape; these make it true for the fields the cards and the Settings card dereference, the same posture `isTicksPayload`
 * takes — a bad body must fail the read, not draw `NaN%` on a card that then lies for as long as the hook holds it. Field-level, not exhaustive: a machine's
 * identity, its two flags and its lists, and a usage reading's two windows.
 */
function isDashboardsView(data: unknown): data is DashboardsView {
  if (typeof data !== 'object' || data === null) return false;
  const v = data as DashboardsView;
  return (
    (v.source === 'file' || v.source === 'default' || v.source === 'unreadable') &&
    typeof v.home === 'object' &&
    v.home !== null &&
    Array.isArray(v.dashboards) &&
    Array.isArray(v.order) &&
    typeof v.threshold === 'number'
  );
}

function isWindow(w: unknown): boolean {
  return typeof w === 'object' && w !== null && typeof (w as MachineUsage['fiveHour']).pct === 'number';
}

function isProjectOffers(data: unknown): data is ProjectOffers {
  if (typeof data !== 'object' || data === null) return false;
  const o = data as ProjectOffers;
  if (typeof o.project !== 'string' || !Array.isArray(o.machines)) return false;
  return o.machines.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      typeof m.machine === 'string' &&
      typeof m.label === 'string' &&
      typeof m.offered === 'boolean' &&
      Array.isArray(m.models) &&
      Array.isArray(m.efforts) &&
      (m.usage === null || (typeof m.usage === 'object' && isWindow(m.usage.fiveHour) && isWindow(m.usage.week)))
  );
}

export async function fetchDashboards(): Promise<DashboardsView> {
  const data = await unwrap<DashboardsView>(await fetch('/api/dashboards'));
  if (!isDashboardsView(data)) throw new Error('unexpected /api/dashboards response');
  return data;
}

/**
 * `project` is an absolute path on someone's disk, so it rides URL-encoded in the query like every other project read here (`fetchBranches`,
 * `fetchMergeCheck`).
 */
export async function fetchOffers(project: string): Promise<ProjectOffers> {
  const data = await unwrap<ProjectOffers>(await fetch(`/api/dashboards/offers?project=${encodeURIComponent(project)}`));
  if (!isProjectOffers(data)) throw new Error('unexpected /api/dashboards/offers response');
  return data;
}

/**
 * The four writes share one posture: a JSON POST (the server's `SameOriginPostGuard` wants the content-type), answering the fresh whole view so the card draws
 * the server's value.
 */
async function post(path: string, body: unknown): Promise<DashboardsView> {
  const data = await unwrap<DashboardsView>(
    await fetch(`/api/dashboards/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  );
  if (!isDashboardsView(data)) throw new Error(`unexpected /api/dashboards/${path} response`);
  return data;
}

/** Upsert one remote. `replaces` is the existing entry's name when this is a rename — the server keeps its position in the prefer order. */
export function saveEntry(entry: DashboardEntry, replaces?: string): Promise<DashboardsView> {
  return post('entries', replaces === undefined ? { entry } : { entry, replaces });
}

export function deleteEntry(name: string): Promise<DashboardsView> {
  return post('entries/delete', { name });
}

/** Home's presentation as a patch: an omitted key keeps what is stored, `null` clears it back to its default (the server's `setHome`). */
export function saveHome(patch: { [K in keyof HomeEntry]?: HomeEntry[K] | null }): Promise<DashboardsView> {
  return post('home', patch);
}

/** Strategy, threshold and prefer order — named for what they decide, the suggestion, though the route is `/settings`. */
export function saveSuggestion(patch: { strategy?: SuggestStrategy; threshold?: number; order?: string[] }): Promise<DashboardsView> {
  return post('settings', patch);
}

/**
 * The name of the remote whose `host` matches — what a remote run's claims carry, so a run row or a card can say "on Pro" instead of a hostname. Remotes only:
 * home is never named (a card says nothing about running where you are), and neither is a host no entry owns. `null` for no view yet, the same answer.
 */
export function machineLabelByHost(view: DashboardsView | null, host: string | undefined): string | null {
  if (!view || !host) return null;
  return view.dashboards.find((d) => d.host === host)?.name ?? null;
}

/**
 * What picking a machine locks on the launch sheet: a remote machine takes PR mode only (merge mode / Finish) and runs only its own account's models and
 * efforts.
 * Empty lists mean "no narrowing" — callers treat them so. Home returns empty lists although its own offer carries some: a home launch is the request it always
 * was, and the server drops an unknown model or effort on home silently rather than refusing it, so narrowing the home sheet would be a rule only the client
 * enforced. `null` (offers not loaded yet) is home, never a remote: a sheet opened before the answer lands must not start locked.
 */
export function lockedFor(offer: MachineOffer | null): { prOnly: boolean; models: string[]; efforts: string[] } {
  if (!offer || offer.home) return { prOnly: false, models: [], efforts: [] };
  return { prOnly: true, models: offer.models, efforts: offer.efforts };
}

/** The picker draws when two or more machines are configured for the project, reachable or not — an unreachable one is a disabled card, not a missing one. */
export function showsPicker(offers: ProjectOffers): boolean {
  return offers.machines.length >= 2;
}

/**
 * The machine a sheet should start on: the suggestion if it is still an offered one, else the first offered machine in prefer order, else home. Home last
 * rather than null because a launch with nothing offered is a state the picker already says out loud (`NO_MACHINE_TEXT`) and the launch refuses on its own.
 */
export function defaultMachine(offers: ProjectOffers | null): string {
  if (!offers) return HOME_MACHINE;
  const wanted = offers.suggestion?.machine;
  if (wanted && offers.machines.some((m) => m.machine === wanted && m.offered)) return wanted;
  return offers.machines.find((m) => m.offered)?.machine ?? HOME_MACHINE;
}

/**
 * A utilisation as a whole percent, clamped to the 0–100 a bar can draw: the dashboard reports above 100 when a window is blown, and `130%` on a card reads as
 * a bug.
 */
export function usagePercent(pct: number): number {
  return Number.isFinite(pct) ? Math.round(Math.min(Math.max(pct, 0), 100)) : 0;
}

/**
 * Bar colour by how much of the window is gone. The offers carry no threshold, so these are fixed: amber when a window is three-quarters used, red at nine-
 * tenths.
 */
export function usageTone(pct: number): 'green' | 'amber' | 'red' {
  const p = usagePercent(pct);
  return p >= 90 ? 'red' : p >= 75 ? 'amber' : 'green';
}

/**
 * `5 h resets in 2h 14m`, `5 h resets now` once the stamp has passed, and `null` for a window with no (or an unparseable) reset time. `now` is the caller's
 * clock.
 */
export function fiveHourResetText(usage: MachineUsage, now: number): string | null {
  const at = usage.fiveHour.resetsAt === null ? NaN : Date.parse(usage.fiveHour.resetsAt);
  if (!Number.isFinite(at)) return null;
  return at <= now ? '5 h resets now' : `5 h resets in ${formatSpanCompact(at - now)}`;
}

/** `usage 40 s ago`, `usage 4 min ago`, `usage 2 h ago` — whole units, rounded down, the way the dashboard words its own freshness. */
export function usageAgeText(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return `usage ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `usage ${m} min ago`;
  return `usage ${Math.floor(m / 60)} h ago`;
}

/**
 * The group's top-right age: the OLDEST reading on the cards, so the line is never fresher than the stalest figure beside it. `null` when no card has a
 * reading.
 */
export function oldestUsageAgeMs(offers: ProjectOffers): number | null {
  const ages = offers.machines.map((m) => m.usageAgeMs).filter((a): a is number => a !== null);
  return ages.length ? Math.max(...ages) : null;
}
