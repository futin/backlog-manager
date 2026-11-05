import type { StateTone } from './tones';
import { pollAge } from './tracker';
import { DEFAULT_SYNC_INTERVAL, SYNC_INTERVALS, type SyncInterval } from '../../../shared/types';

/**
 * What the shell's two status pills (GitHub, Jira) say, in one place so the pill's dot, its accessible name and the popover cannot disagree about "late".
 *
 * **Late is judged against each row's OWN interval, never the 15 s tick.** A `5m` repo polled four minutes ago is on time; a `15s` one polled 31 s ago is not.
 * The threshold is twice the interval, so one slow sweep (a sweep makes two requests per repo and stamps a little after the interval fires) is not an alarm,
 * and a row set to `off` is not judged at all — nothing was asked of it. A row never polled is not "late" either: a fresh process has not had its first
 * sweep, and grey ("nothing polled yet") is the honest reading until one lands.
 */
export interface ServiceRow {
  polledAt: string | null;
  /** `null` for a row that carries no interval of its own (a Jira row always has one); read as the default, the poller's own 15 s. */
  interval: SyncInterval | null;
}

export interface ServiceInput {
  /** The service cannot be reached at all: no token, or access refused. Decided by the caller, because what "down" means differs per service. */
  down: boolean;
  rows: readonly ServiceRow[];
  /** The service is inside a rate-limit window — alive, but behind. */
  limited: boolean;
}

/** Twice a sync interval, in ms, or `null` for `off`. */
const lateAfter = (interval: SyncInterval | null): number | null => {
  const ms = SYNC_INTERVALS[interval ?? DEFAULT_SYNC_INTERVAL];
  return ms === null ? null : 2 * ms;
};

export function serviceTone(input: ServiceInput, now: number): StateTone {
  if (input.down) return 'red';
  const live = input.rows.filter((r) => (r.interval ?? DEFAULT_SYNC_INTERVAL) !== 'off');
  if (!live.some((r) => r.polledAt !== null)) return 'grey';
  if (input.limited) return 'amber';
  const late = live.some((r) => {
    const limit = lateAfter(r.interval);
    const at = r.polledAt === null ? NaN : Date.parse(r.polledAt);
    return limit !== null && !Number.isNaN(at) && now - at > limit;
  });
  return late ? 'amber' : 'green';
}

/** How long ago the newest of the rows was polled, in `pollAge`'s vocabulary (`12 s`, `3m`), or `null` before any poll. Off rows count: a manual sync is a poll. */
export function newestAge(rows: readonly Pick<ServiceRow, 'polledAt'>[], now: number): string | null {
  let newest: string | null = null;
  for (const r of rows) {
    if (r.polledAt !== null && (newest === null || Date.parse(r.polledAt) > Date.parse(newest))) newest = r.polledAt;
  }
  return pollAge(newest, now);
}

/** The word a screen reader hears for a tone — the pill's dot never carries the state on colour alone. */
export const TONE_WORD: Record<StateTone, string> = { green: 'on time', amber: 'late', red: 'down', grey: 'not polled yet' };

/** GitHub is down when there is no token, or every row's access is something other than ok, rate-limited or unknown (`null`: not read yet). */
export function githubDown(hasToken: boolean, accesses: readonly (string | null)[]): boolean {
  if (!hasToken) return true;
  return accesses.length > 0 && accesses.every((a) => a !== 'ok' && a !== 'rate-limited' && a !== null);
}

/** Jira is down when access is anything but ok or rate-limited. */
export const jiraDown = (access: string): boolean => access !== 'ok' && access !== 'rate-limited';

/** The shortest non-off interval among the rows, as the popover's "every …", or `off` when all are. */
export function fastestInterval(rows: readonly ServiceRow[]): SyncInterval {
  let best: SyncInterval = 'off';
  for (const r of rows) {
    const i = r.interval ?? DEFAULT_SYNC_INTERVAL;
    const ms = SYNC_INTERVALS[i];
    if (ms !== null && (SYNC_INTERVALS[best] === null || ms < (SYNC_INTERVALS[best] as number))) best = i;
  }
  return best;
}
