import { unwrap } from './agents';
import type { TickConfig, TickProject, TickRecentEntry, TicksPayload } from '../../../shared/types';

/**
 * The client's half of the tick breaker (spec `2026-10-22-tick-breaker-design.md`, "Client"): the three calls Runs › Ticks and the Settings card make, and the
 * three derivations the Ticks page draws from a `TicksPayload`. Everything here is a pure function of what the server answered — `streak`, `halted` and
 * `haltedSince` arrive already derived, so nothing below recomputes the breaker rule (the server's `tick-breaker.util.ts` is its one client-facing home).
 */

const DAY_MS = 24 * 3_600_000;

/**
 * `unwrap`'s `as T` only promises a shape; this makes it true for the fields the Ticks page and the Settings card dereference — the same posture
 * `isWatchdogStatus` takes, and for the same reason: `useTicks` caches the payload in state, so a bad one would lie to every reader for as long as it sticks.
 * Checked at the field level (config's two fields, each project's identity, `lock` present, `recent` an array), not every entry's own keys — nothing here
 * branches on an entry beyond `at`/`outcome`, and the derivations below tolerate an `at` that does not parse.
 */
function isTicksPayload(data: unknown): data is TicksPayload {
  if (typeof data !== 'object' || data === null) return false;
  const p = data as TicksPayload;
  const c = p.config as TickConfig | undefined;
  if (typeof c !== 'object' || c === null) return false;
  if (typeof c.haltAfter !== 'number' || !(c.source === 'default' || c.source === 'file' || c.source === 'unreadable')) return false;
  if (!Array.isArray(p.projects)) return false;
  return p.projects.every(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      typeof row.root === 'string' &&
      typeof row.name === 'string' &&
      typeof row.lock !== 'undefined' &&
      Array.isArray(row.recent)
  );
}

/** Shared tail of the three calls: unwrap (so a refusal reads in the server's own words), then the shape guard, named for the route that answered. */
async function ticksFrom(res: Response, route: string): Promise<TicksPayload> {
  const data = await unwrap<TicksPayload>(res);
  if (!isTicksPayload(data)) throw new Error(`malformed ${route} response`);
  return data;
}

/** `GET /api/ticks` — every project under the tick home, with the breaker's verdict derived per project, and the effective `haltAfter`. */
export async function fetchTicks(): Promise<TicksPayload> {
  return ticksFrom(await fetch('/api/ticks'), '/api/ticks');
}

/** `POST /api/ticks/config` — the Settings card's one write. The server validates (an integer, else 400) and clamps; the answer is the whole payload, so the
 *  caller never needs a second GET to see what stuck. */
export async function updateTickConfig(haltAfter: number): Promise<TicksPayload> {
  return ticksFrom(
    await fetch('/api/ticks/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ haltAfter }) }),
    '/api/ticks/config'
  );
}

/** `POST /api/ticks/reset` — a halted project's Reset. `project` is the row's absolute `root`, which is the server's key for it. */
export async function resetTicks(project: string): Promise<TicksPayload> {
  return ticksFrom(
    await fetch('/api/ticks/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) }),
    '/api/ticks/reset'
  );
}

/** An entry's time as a number; `-Infinity` when it does not parse, so it sorts below every real time instead of poisoning a comparison with NaN. */
function atMs(at: string | undefined): number {
  const t = Date.parse(at ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/** Position within a group: a row with ticks first, then a row that has never ticked, then a row whose `state.json` could not be read. */
function rank(p: TickProject): number {
  if (p.error !== undefined) return 2;
  return p.recent.length === 0 ? 1 : 0;
}

/**
 * The Ticks page's row order: halted projects first (the ones that need a hand), then everything else; inside each, projects that have ticked newest-first,
 * then those that never have, then the unreadable ones. Ties fall to `name`, so two quiet projects never swap places between polls. `recent` is newest-first
 * (the server reversed it), so `recent[0]` is the last tick. Returns a new array.
 */
export function sortTickProjects(ps: TickProject[]): TickProject[] {
  return [...ps].sort((a, b) => {
    const halted = Number(b.halted === true) - Number(a.halted === true);
    if (halted !== 0) return halted;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 0) {
      const ta = atMs(a.recent[0]?.at);
      const tb = atMs(b.recent[0]?.at);
      // `-Infinity - -Infinity` is NaN, which a comparator must not return; equal times fall through to the name.
      if (ta !== tb) return ta > tb ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Every project's `recent` merged into one feed, newest first, capped at `max` — each row carrying its project's name and root so a row can name and link its
 *  project. An unparseable time sorts last rather than being dropped: a tick that happened is still worth a line. */
export function tickActivity(ps: TickProject[], max = 50): Array<TickRecentEntry & { project: string; root: string }> {
  const rows = ps.flatMap((p) => p.recent.map((e) => ({ ...e, project: p.name, root: p.root })));
  // `Array.prototype.sort` is stable, so equal times keep their project order and each project's own newest-first order.
  rows.sort((a, b) => {
    const ta = atMs(a.at);
    const tb = atMs(b.at);
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  });
  return rows.slice(0, max);
}

/**
 * The figure strip's counts: entries strictly newer than `now − 24 h`. `failed` and `ok` are the two outcomes the breaker reads; any other outcome (`idle`,
 * a value a future `tick.mjs` writes) counts only toward `total`. `now` is a parameter, not `Date.now()`, so the page decides which clock it renders against.
 */
export function ticksLast24h(ps: TickProject[], now: number): { total: number; ok: number; failed: number } {
  const since = now - DAY_MS;
  let total = 0;
  let ok = 0;
  let failed = 0;
  for (const p of ps) {
    for (const e of p.recent) {
      if (!(atMs(e.at) > since)) continue;
      total += 1;
      if (e.outcome === 'ok') ok += 1;
      else if (e.outcome === 'failed') failed += 1;
    }
  }
  return { total, ok, failed };
}
