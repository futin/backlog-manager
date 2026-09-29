import { elapsedSince } from './item-age';
import { runIsLive } from './run-time';
import { CLAIM_STALE_MS, SYNC_INTERVALS } from '../../../shared/types';
import type { BacklogItem, OrchestratorRun, ProjectSummary, SyncInterval, TrackerPlatform, TrackerProjectRow, TrackersPayload } from '../../../shared/types';

/**
 * What the board says about a connected tracker (task-45, spec §5.5) — the
 * poll age, and the access reason in its place when the connection is not
 * `ok`. One home for the derivation, like every other in `lib/`: the tracker
 * chip, the item modal and the Trackers card all print the same two sentences, and three
 * copies of "is this `ok`, and if not what do I say" is three chances to
 * describe one connection two ways on one screen.
 *
 * Nothing here reads a clock of its own. `now` is passed in — REQUIRED, with
 * no `Date.now()` default, which is the difference between a rule and a
 * request: a default is how the next call site reads its own clock without
 * noticing, and then one surface ages two readings against two instants. The
 * discipline is `item-age.ts`'s, made non-optional because this module has
 * three call sites across two surfaces rather than one.
 */

const MS_PER_MINUTE = 60_000;

/**
 * How old this project's items are, as the board prints it: `12 s`, `4m`,
 * `3h`. `null` when there has been no successful poll yet — which the caller
 * renders as its own sentence rather than as an age of zero, because "we have
 * never read this repo" and "we read it a moment ago" are opposite facts.
 *
 * The seconds rung is this function's own, where `elapsedSince` starts at
 * minutes: a poll interval is fifteen seconds (`TRACKER_POLL_MS`), so a
 * minutes-only ladder would print `now` for the whole of a normal cycle and
 * say nothing about whether polling is actually happening. Above a minute it
 * delegates, so the board's vocabulary stays one vocabulary.
 */
export function pollAge(polledAt: string | null, now: number): string | null {
  if (polledAt === null || polledAt === '') return null;
  const then = Date.parse(polledAt);
  if (Number.isNaN(then)) return null;
  const ms = Math.max(0, now - then);
  if (ms < MS_PER_MINUTE) return `${Math.floor(ms / 1000)} s`;
  return elapsedSince(polledAt, now);
}

/**
 * One poll cycle as the client measures it: the server's `TRACKER_POLL_MS` (15 s, `server/src/tracker/poller.service.ts`) plus the measured length of a
 * tick (a sweep makes two requests per repo, so the stamp lands a little after the interval fires). It equals `TRACKER_POLL_WINDOW_MS` in
 * `skills/backlog-orchestrate/tools/orchestrate.mjs`, which asks the same question — "how long until a poll must have happened" — from the driver's side.
 *
 * The ONE client-side home of the cycle (the tracker strip spec, §4): the chip's bar fraction, its overdue threshold and `useTrackers`' fetch schedule all
 * read this, so the bar that reaches its end and the fetch that snaps it back cannot disagree about when the end is.
 */
export const TRACKER_CYCLE_MS = 17_000;

/**
 * One repo's cycle on its own interval (#17): one client cycle per server tick the interval spans — `TRACKER_CYCLE_MS` × interval ÷ 15 s — so `15s`, and
 * the `null` a fixture or an older payload carries, is exactly that constant and every existing reading of a 15 s repo is unchanged. `null` for `off`,
 * which has no cycle at all: nothing is due, so nothing can be late.
 *
 * Scaled, not interval plus one slack, because of how the server decides "due": `now - lastSyncAt >= interval`, checked once per tick, and a tick is 15 s
 * PLUS the sweep before it (`schedule()` runs after the sweep). So a `5m` repo is restamped on its twentieth tick, twenty sweeps late, not one — and the
 * interval-plus-2 s this first used left its countdown at `0s` for ~20 s every cycle, with `useTrackers` asking at 1 Hz through a due window the restamp
 * then missed (final review M1). `TRACKER_CYCLE_MS` is the measured length of one tick, so n of them is the honest length of n.
 */
export function syncCycleMs(interval: SyncInterval | null): number | null {
  if (interval === 'off') return null;
  return (SYNC_INTERVALS[interval ?? '15s'] / SYNC_INTERVALS['15s']) * TRACKER_CYCLE_MS;
}

/** Where a poll clock stands: how much of the cycle has elapsed (0–1), the whole seconds left until the next sweep, and whether two whole cycles have gone
 *  by with no poll at all. */
export interface PollProgress {
  fraction: number;
  leftS: number;
  overdue: boolean;
}

/**
 * The strip chip's line timer for one stamp (spec §5). Parses the way `pollAge` does — the same three `null` exits, the same clamp of a future stamp to
 * zero — because the two read one field and must agree on when it means nothing.
 *
 * The bar stops FULL at one cycle rather than wrapping: a bar that restarted on its own would claim a poll the server never made. It only snaps back when a
 * fresh `polledAt` arrives. `overdue` waits a second whole cycle so that one slow tick — the server's own jitter, a fetch that landed late — reads as a full
 * bar at `0s`, not as an alarm.
 */
export function pollProgress(polledAt: string | null, now: number, cycleMs: number = TRACKER_CYCLE_MS): PollProgress | null {
  if (polledAt === null || polledAt === '') return null;
  const then = Date.parse(polledAt);
  if (Number.isNaN(then)) return null;
  const elapsed = Math.max(0, now - then);
  return {
    fraction: Math.min(elapsed / cycleMs, 1),
    leftS: Math.max(Math.ceil((cycleMs - elapsed) / 1000), 0),
    overdue: elapsed >= 2 * cycleMs
  };
}

/**
 * The chip's one clock for every connected repo: `pollProgress` of the NEWEST github stamp. One sweep polls every repo, so the newest stamp is when the
 * last sweep landed; an older one belongs to a repo that failed in that sweep, which the caller reads from `access` (the red pip and bar), not from its
 * age. `files` rows never carry a meaningful stamp and are skipped whatever they hold. `null` when no github row has polled yet.
 *
 * Since #17 a sweep no longer polls every repo, so "the newest stamp" is taken among the repos on the FASTEST interval present, and run on that interval's
 * cycle. A `5m` repo synced a moment after a `15s` one would otherwise flip the bar to a five-minute countdown for one sweep; and a board of `5m` repos
 * alone would read `overdue` at 34 s. `off` repos are skipped outright — their stamp is when sync stopped, not when the next one lands — and a board whose
 * every repo is off is `null` here, which the chip reads as `sync off` before it ever asks this.
 */
export function sweepProgress(projects: readonly Pick<TrackerProjectRow, 'source' | 'polledAt' | 'interval'>[], now: number): PollProgress | null {
  let fastest = Infinity;
  for (const p of projects) {
    const cycle = p.source === 'github' ? syncCycleMs(p.interval) : null;
    if (cycle !== null && cycle < fastest) fastest = cycle;
  }
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const p of projects) {
    if (p.source !== 'github' || p.polledAt === null || syncCycleMs(p.interval) !== fastest) continue;
    const ms = Date.parse(p.polledAt);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newest = p.polledAt;
    newestMs = ms;
  }
  return fastest === Infinity ? null : pollProgress(newest, now, fastest);
}

/** The hourly API budget as the chip and popover read it. */
export interface ApiUsage {
  /** Used share of the limit, 0–1. */
  fraction: number;
  /** `1.4%`, or `<1%` for any use under one percent. */
  label: string;
  /** Requests left, as the platform last reported them. */
  left: number;
  /** `reset` as a local `HH:MM`, or `null` when the platform has not said. */
  resetsAt: string | null;
}

/**
 * The `API` meter's reading (spec §2.2, §5). `null` until the platform has reported a positive limit — the numbers come off response headers, so before
 * the first request there is nothing to read, and a zero limit would divide into `NaN%`. A `remaining` above the limit (a reset landing between two reads)
 * clamps to nothing used rather than drawing a negative bar.
 *
 * `<1%` rather than `0.3%` or `0%` below one percent: the meter must never claim zero use once a request has been made, and a tenth of a percent is more
 * precision than a 56 px bar can show. Tone is the caller's, like `sweepProgress`' — the thresholds are a look, not a derivation.
 */
export function apiUsage(platform: Pick<TrackerPlatform, 'limit' | 'remaining' | 'reset'>): ApiUsage | null {
  const { limit, remaining, reset } = platform;
  if (limit === null || limit <= 0 || remaining === null) return null;
  const used = Math.max(0, limit - remaining);
  const fraction = used / limit;
  const pct = fraction * 100;
  return {
    fraction,
    label: pct < 1 ? '<1%' : `${pct.toFixed(1)}%`,
    left: remaining,
    resetsAt: reset === null ? null : resetClock(reset)
  };
}

/** GitHub sends the reset as Unix SECONDS; the board shows a local wall clock, because the question it answers is "how long do I wait" and a reader is
 *  looking at their own clock while asking it. Moved here from `TrackersGroup.tsx` when the strip chip became its second reader, so the card and the
 *  popover print one clock. */
export function resetClock(reset: number): string {
  return new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The sentence for an access state other than `ok`, or `null` for `ok` and for
 * a project with no connection at all.
 *
 * `detail` rides along where it adds something — the rate limit's reset time,
 * the error text — and is deliberately NOT appended blindly: `forbidden` and
 * `not-found` carry GitHub's own message, which is usually "Not Found" and
 * says less than the state does.
 */
export function accessReason(project: Pick<ProjectSummary, 'access' | 'detail'>): string | null {
  switch (project.access) {
    case 'no-token':
      // The fix, not the symptom: this is the one access state an operator
      // can clear from their own machine, and the card is where they are
      // standing when they read it.
      return 'no token — set BM_GITHUB_TOKEN and restart';
    case 'rate-limited':
      return project.detail ?? 'rate limited';
    case 'forbidden':
      return 'this token cannot read that repo';
    case 'not-found':
      // GitHub answers 404 for a repo that does not exist AND for one the
      // token cannot see, deliberately, so this app says both.
      return 'repo not found, or not visible to this token';
    case 'error':
      return project.detail ?? 'unreachable';
    default:
      return null;
  }
}

/**
 * Why nothing may be written to this project's tracker from this machine, or `null` (#17, spec §8): the sentence the server's `syncOffBlock` composes, byte
 * for byte, and the client's ONE home of it. The client cannot import the server's composer, so both sides pin the literal in a test and a wording change
 * goes red on both. `null` for every interval but `off`, and for a row with no repo — a files project has no sync to turn off.
 */
export function syncOffReason(project: Pick<ProjectSummary, 'repo' | 'interval'>): string | null {
  if (project.interval !== 'off' || project.repo === null) return null;
  return `sync is off for ${project.repo} — turn it on in Settings › Shared › Trackers`;
}

/**
 * `syncOffReason` for the project an item belongs to, looked up by `projectPath` — the stable key, since two checkouts of one repo share a name but never
 * a path. The board and the Archive both hand it to `DispatchButton` beside the run block, so the lookup lives here once rather than in each view.
 */
export function itemSyncOff(item: Pick<BacklogItem, 'projectPath'>, projects: readonly ProjectSummary[] | null): string | null {
  const project = (projects ?? []).find((p) => p.path === item.projectPath);
  return project === undefined ? null : syncOffReason(project);
}

/**
 * The state half of a tracker's line — everything after the repo — shared by the item modal's `trackerLine` and the Trackers card's row, which print one
 * connection the same way. Precedence: an access reason (a broken token is the more urgent reading, and the fix it names is the one owed first), then
 * `sync off` beside the age of the last poll, then the age alone.
 */
export function trackerState(project: Pick<ProjectSummary, 'access' | 'detail' | 'polledAt' | 'interval'>, now: number): string {
  const reason = accessReason(project);
  if (reason !== null) return reason;
  const age = pollAge(project.polledAt, now);
  if (project.interval === 'off') return age === null ? 'sync off · never polled' : `sync off · polled ${age} ago`;
  // Before the first successful poll there is no age to print, and printing
  // `polled 0 s ago` would claim a read that has not happened.
  return age === null ? 'connecting…' : `polled ${age} ago`;
}

/**
 * The whole poll-age line for one connected project, as the item modal prints it:
 * `futin/x · polled 12 s ago`, or the access reason in place of the age.
 * `null` for a project that is not a tracker — the caller filters on this
 * rather than re-asking `source`, so "which projects does this line exist for"
 * has one answer.
 */
export function trackerLine(project: ProjectSummary, now: number): string | null {
  if (project.source !== 'github') return null;
  return `${project.repo ?? project.name} · ${trackerState(project, now)}`;
}

/**
 * What the card says about an `orchestrator:queued` label (the orchestrator:queued spec, §4.2): `'live'` while a live run holds the item's project, `'stale'`
 * when none does, `null` when there is no label. The fourth tracker reading on the card, and a reading only — the label is advisory, so nothing on the board
 * gates on this, and a `'stale'` badge is a prompt to clear the label, not a block.
 *
 * `runs` is the caller's concatenation of this machine's runs and `remote.map(remoteAsLive)`. A remote run carries THIS machine's registry path for its repo
 * (`RemoteRunsService.list`), so one `project === projectPath` match covers both, and a run on another machine that died without its Stop reads stale here
 * exactly as a crashed local one does: its claim comments stop being refreshed, its `updatedAt` stops moving, and `runIsLive` ages it out on the same
 * `RUN_STALE_MS` line the band already draws.
 *
 * `paused` is accepted on its own, whatever its heartbeat, because `runIsLive` is `running`-only and a paused run is still the run that queued the item — it
 * will pick it up on `unpause`, and a board that called its whole queue stale for the length of a pause would be telling the operator to clear labels the run
 * is about to need. Only `running` is aged, since a crashed run leaves `status: "running"` in `run.json` forever and freshness is the only thing that says so.
 *
 * Matches on the project, not on the run's queue: the driver labels every queued item within `--max`, and whether this item is still `pending` in that queue
 * or was never in it (a hand-added label) is not something the badge distinguishes — a live run on the project is the one fact that makes the label mean
 * what it says. `now` is required, for the reason this module's header gives.
 */
export function queuedReading(
  item: Pick<BacklogItem, 'queued' | 'projectPath'>,
  runs: readonly Pick<OrchestratorRun, 'project' | 'status' | 'updatedAt'>[],
  now: number
): 'live' | 'stale' | null {
  if (item.queued !== true) return null;
  const held = runs.some((run) => run.project === item.projectPath && (run.status === 'paused' || runIsLive(run, now)));
  return held ? 'live' : 'stale';
}

/**
 * Whether a tracker item's holder is live by the reader's clock (#227): `live` inside `CLAIM_STALE_MS` of its heartbeat, `stale` at or past it — or when
 * the heartbeat does not parse, since nothing can call that fresh — and `null` for a files item (the skills own its stamp) and for an item nobody holds.
 *
 * The protocol's own second question, and the one the board never used to ask. The mapper sets `holder` for ANY unreleased claim, deliberately (an item
 * shown as free while `claim` still has to fight for it is the other lie), so "unreleased" is all the payload says; whether it is also live is decided here,
 * against the reader's clock, by the rule the server's `isLive` (`server/src/tracker/claim.ts`) applies. Every surface that treats a claim differently once
 * it has gone stale — the claim control, the card's bar, the column rank, the dispatch block and the dispatch sheet's take-over line — reads this, so no two
 * of them can disagree about one item at one instant. `now` is required, for the reason this module's header gives.
 */
export function claimReading(item: Pick<BacklogItem, 'source' | 'holder'>, now: number): 'live' | 'stale' | null {
  const holder = item.holder;
  if (item.source !== 'github' || holder === undefined) return null;
  const beat = Date.parse(holder.heartbeat);
  return Number.isFinite(beat) && now - beat < CLAIM_STALE_MS ? 'live' : 'stale';
}

/** Enough of a session id to tell two apart in one sentence; the whole id is on the claim comment. */
export function shortSession(session: string): string {
  return session.length > 8 ? session.slice(0, 8) : session;
}

/**
 * Which claim control the item modal draws for a tracker item's holder (#225, #227): `stop-release` when this server dispatched the holding session — the
 * board started it, so **Stop & release** stops it through the dashboard and then releases, whatever the heartbeat age, because a `claude -p` waiting on a
 * reply has no process and sends no heartbeat — `release` for any other live claim, `release-stale` for any other stale one, and `null` when there is
 * nothing the board may do.
 *
 * `null` for a files item, for an item nobody holds, and for a claim a RUN holds, live or stale: the run owns its items for the whole item, and a stale run
 * claim is a crashed run, which the watchdog and `--resume` own — stop the run, not the item. `release-stale` is its own answer rather than `release` because
 * the two confirms say different things: a live claim's release needs proof the session ended, a stale one is already forfeit by protocol (any `start`, on
 * any machine, retires it). The server re-decides every one of these at click time (`ItemsAbortService`); this only decides whether to offer the click.
 */
export function claimControl(item: Pick<BacklogItem, 'source' | 'holder'>, now: number): 'stop-release' | 'release' | 'release-stale' | null {
  const reading = claimReading(item, now);
  const holder = item.holder;
  if (reading === null || holder === undefined || holder.run !== undefined) return null;
  if (holder.dispatched === true) return 'stop-release';
  return reading === 'live' ? 'release' : 'release-stale';
}

/**
 * The dispatch sheet's one line when a launch goes ahead over a stale claim (#227), or `null` when it does not. Only a stale HAND claim is taken over —
 * `progressBlock` still blocks a run-held one and a board-dispatched one — and the spawned session's own `start` retires it, exactly as it would from a
 * terminal. The sheet says so because the launch is ending somebody's claim, and the reader should see whose before pressing it. The age clause drops out
 * for a heartbeat that cannot be aged, the host clause for a claim that recorded none.
 */
export function staleTakeover(item: Pick<BacklogItem, 'source' | 'holder'>, now: number): string | null {
  const holder = item.holder;
  if (claimReading(item, now) !== 'stale' || holder === undefined || holder.run !== undefined || holder.dispatched === true) return null;
  const age = elapsedSince(holder.heartbeat, now);
  const host = holder.host === undefined || holder.host === '' ? '' : ` on ${holder.host}`;
  return `takes over a stale claim — session ${shortSession(holder.session)}${host}, no heartbeat${age === null ? '' : ` ${age}`}`;
}

/* `projectIsFiles` lived here from task-46 until task-47 and is gone.
 *
 * It answered "can an orchestrator run drain this project at all", and for one
 * phase the answer for a tracker project was no. Phase 4a made it yes, so the
 * predicate had exactly one job and that job is over — its own doc comment
 * said as much, which is why this is a deletion rather than a function that
 * now returns `true`. The server's matching refusal
 * (`orchestrating a tracker project arrives in phase 4`) went at the same
 * time; the two were always one rule stated twice.
 */

/** Whether any registered project's items come from a tracker — the "is there
 *  a tracker to draw" question: the strip chip's visibility and the board's
 *  clock for the item modal's poll age. The "should I keep re-reading the
 *  payload" question was this function's too until #17 and is now
 *  `hasSyncingTracker`'s below, since an `off` repo is still a tracker but has
 *  nothing moving it. Takes anything with a `source`, so the strip chip asks it
 *  of the `/api/trackers` rows it already holds — the shell has no `useBoard`
 *  to borrow `ProjectSummary[]` from. */
export function hasTracker(projects: readonly Pick<ProjectSummary, 'source'>[] | null): boolean {
  return (projects ?? []).some((p) => p.source === 'github');
}

/** `hasTracker` narrowed to the repos this machine still syncs (#17) — the question a re-read schedule asks, since a payload whose every tracker is `off`
 *  has nothing on the server moving it. `hasTracker` keeps the "is there a tracker to draw" callers: an off repo is still a tracker, and still shown. */
export function hasSyncingTracker(projects: readonly Pick<ProjectSummary, 'source' | 'interval'>[] | null): boolean {
  return (projects ?? []).some((p) => p.source === 'github' && p.interval !== 'off');
}

/**
 * `GET /api/trackers`' body, checked before anything renders from it — the
 * same trade `isAgentsStatus` and `isOrchestratorRunsPayload` (`lib/agents.ts`)
 * already make, at the one place a JSON body becomes this type.
 *
 * The two arrays are all this checks, and they are the two the card MAPS over:
 * a body with either one missing throws a `TypeError` inside a render rather
 * than a clean failure the card can report, and React unmounts the whole page
 * when it does — which is exactly how a stubbed or proxied answer took the
 * Shared Settings page down during task-45's own test run. Everything past the
 * arrays is read field by field with null-safe expressions, so a wrong-shaped
 * ROW degrades to a row that says less rather than to a crash.
 */
export function isTrackersPayload(value: unknown): value is TrackersPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as { platforms?: unknown; projects?: unknown };
  return Array.isArray(payload.platforms) && Array.isArray(payload.projects);
}
