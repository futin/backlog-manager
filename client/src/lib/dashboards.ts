import { unwrap } from './agents';
import { formatSpanCompact } from './run-time';
import { formatZonedClock, zonedParts } from './time-zone';
import { USAGE_FRESH_MS } from '../../../shared/agent';
import type {
  DashboardEntryInput,
  DashboardsView,
  HomeEntry,
  MachineOffer,
  MachinesStatus,
  MachineStatus,
  MachineUsage,
  ProjectOffers,
  SuggestStrategy
} from '../../../shared/types';

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

/** Where the picker's "change it" link goes: this app's own deep link (`lib/deep-link.ts`) to the Settings section's Dashboards page, where the machines list lives. */
export const SETTINGS_HREF = '/?section=settings&settings=dashboards';

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

/**
 * The machines route's answer, checked field-level the way the two guards above are: an entry's identity, its two flags the dots read, and a usage whose two
 * windows are real readings. `usage: null` is legal (past the freshness limit, or never obtained).
 */
function isMachinesStatus(data: unknown): data is MachinesStatus {
  if (typeof data !== 'object' || data === null) return false;
  const m = (data as MachinesStatus).machines;
  return (
    Array.isArray(m) &&
    m.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        typeof e.machine === 'string' &&
        typeof e.enabled === 'boolean' &&
        typeof e.reachable === 'boolean' &&
        (e.usage === null || (typeof e.usage === 'object' && isWindow(e.usage.fiveHour) && isWindow(e.usage.week)))
    )
  );
}

/** Health and usage for every machine the Dashboards page lists, home first then the remotes (the order is NOT the prefer order — `machineIds` is). */
export async function fetchMachines(): Promise<MachinesStatus> {
  const data = await unwrap<MachinesStatus>(await fetch('/api/dashboards/machines'));
  if (!isMachinesStatus(data)) throw new Error('unexpected /api/dashboards/machines response');
  return data;
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
export function saveEntry(entry: DashboardEntryInput, replaces?: string): Promise<DashboardsView> {
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
 * A machine id as a label (multi-dashboard task 10) — what `RemoteStarting.machine` carries, unlike a claim's `host`: `'home'` is this machine's own label
 * (Home's stored one, or `Home` before the view lands), a remote is its name, and an id nothing here owns is itself, so a launch on a machine since removed
 * from Settings still says where it went rather than nothing.
 */
export function machineLabelById(view: DashboardsView | null, id: string): string {
  if (id === HOME_MACHINE) return view?.home.label ?? 'Home';
  return view?.dashboards.find((d) => d.name === id)?.name ?? id;
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

/**
 * Where a narrowed select lands when its current value is not among the machine's own: the Settings default if the machine lists it (or if it is `''`),
 * else the first listed. A value already listed stays put, so a pick the person made on home that the machine also runs survives the switch.
 *
 * `''` (the "default" option) is never narrowed (final-review I4). It is not a value at all but the absence of one: `modelEffortFlags` sends no key for it,
 * and the server applies its own default — a remote's model via `remoteDefaultModel`, which only ever names a model that machine lists, and an effort not at
 * all, so the remote session runs at its account's own. That is legal on every machine, so there is nothing to narrow. Narrowing it to `list[0]` — what this
 * function did first — turned a person who chose nothing into a launch at `low` that nobody picked, and the sheet then kept `low` after the switch back home.
 * The same reasoning lands a narrowed-away explicit value on a `''` Settings default rather than on `list[0]`.
 */
export function narrowTo(value: string, list: string[], settingsDefault: string): string {
  if (value === '' || list.length === 0 || list.includes(value)) return value;
  return settingsDefault === '' || list.includes(settingsDefault) ? settingsDefault : list[0];
}

/** The hint under Finish / Merge mode while a remote is picked: the field is not the person's to change, and this says why. */
export function prRequiredText(label: string): string {
  return `Required when running on ${label}`;
}

/** What a sheet says when the machine list could not be read and it falls back to running here, which is what the sheet did before there was a picker. */
export const OFFERS_FAILED_TEXT = 'Could not load the machine list — this will run here.';

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

/**
 * The machines in prefer order — what the Settings › Dashboards list draws, top to bottom. `order` lists every machine once, but a remote the server sent and
 * the order lacks is still listed, last, rather than hidden, and an id the order names but no entry owns (a removed remote) is dropped. Home is always listed:
 * first when the order does not place it.
 */
export function machineIds(view: DashboardsView): string[] {
  const remotes = new Map(view.dashboards.map((d) => [d.name, d]));
  const ids = [...view.order.filter((id) => id === HOME_MACHINE || remotes.has(id)), ...view.dashboards.map((d) => d.name).filter((n) => !view.order.includes(n))];
  if (!ids.includes(HOME_MACHINE)) ids.unshift(HOME_MACHINE);
  return ids;
}

/** The selected machine: the one the person had picked while it is still listed (a delete or a rename can remove it), else the first. */
export function pickSelected(ids: string[], wanted: string | null): string {
  return wanted !== null && ids.includes(wanted) ? wanted : ids[0];
}

/** One machine's reading from the machines answer; `null` before the first answer lands and for an id the answer lacks, so a caller draws no dot, not a wrong one. */
export function statusFor(machines: MachinesStatus | null, id: string): MachineStatus | null {
  return machines?.machines.find((m) => m.machine === id) ?? null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * When a usage window resets, as a wall clock in the board's shared zone (#241 — the clock every run time on the board prints in): `resets 23:39` today,
 * `resets Sat 00:05` on a later day (a window is at most a week long, so a weekday names it unambiguously), `resets now` once the moment has passed — the
 * figure is then about to be replaced, and a clock in the past would read as a bug. "Today" is `now`'s calendar day in that same zone. The weekday is a fixed
 * English table rather than `Intl` so the line, and its tests, do not move with the machine's locale. `null` for no reset time or one that does not parse.
 */
export function resetClockText(resetsAt: string | null, now: number, zone: string): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  if (at <= now) return 'resets now';
  const clock = formatZonedClock(at, zone);
  const then = zonedParts(at, zone);
  const today = zonedParts(now, zone);
  const sameDay = then.year === today.year && then.month === today.month && then.day === today.day;
  return sameDay ? `resets ${clock}` : `resets ${WEEKDAYS[then.weekday]} ${clock}`;
}

/**
 * What a usage slot says when it has no figure to draw (called only when `usage` is null). Unreachable wins for an enabled machine — a switched-off one is not
 * "unreachable", it was never asked; then a figure that exists but is past `USAGE_FRESH_MS` says how old, so the person can tell "gone quiet" from "never
 * had one"; else the plain absence.
 */
export function noUsageText(s: Pick<MachineStatus, 'enabled' | 'reachable' | 'usageAgeMs'>): string {
  if (s.enabled && !s.reachable) return 'unreachable';
  if (s.usageAgeMs !== null && s.usageAgeMs > USAGE_FRESH_MS) return `no fresh figure · ${usageAgeText(s.usageAgeMs)}`;
  return 'no usage figure';
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
