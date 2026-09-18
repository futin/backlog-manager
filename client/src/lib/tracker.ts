import { elapsedSince } from './item-age';
import type { ProjectSummary, TrackersPayload } from '../../../shared/types';

/**
 * What the board says about a connected tracker (task-45, spec §5.5) — the
 * poll age, and the access reason in its place when the connection is not
 * `ok`. One home for the derivation, like every other in `lib/`: the band, the
 * item modal and the Trackers card all print the same two sentences, and three
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
 * The whole line the board's band prints for one connected project:
 * `futin/x · polled 12 s ago`, or the access reason in place of the age.
 * `null` for a project that is not a tracker — the caller filters on this
 * rather than re-asking `source`, so "which projects does this line exist for"
 * has one answer.
 */
export function trackerLine(project: ProjectSummary, now: number): string | null {
  if (project.source !== 'github') return null;
  const repo = project.repo ?? project.name;
  const reason = accessReason(project);
  if (reason !== null) return `${repo} · ${reason}`;
  const age = pollAge(project.polledAt, now);
  // Before the first successful poll there is no age to print, and printing
  // `polled 0 s ago` would claim a read that has not happened.
  return age === null ? `${repo} · connecting…` : `${repo} · polled ${age} ago`;
}

/** Whether any registered project's items come from a tracker — the board's
 *  "should I keep re-reading the payload" question (a tracker's items move on
 *  the server's poll clock, not on a person's edit), and the one place that
 *  question is asked. */
export function hasTracker(projects: ProjectSummary[] | null): boolean {
  return (projects ?? []).some((p) => p.source === 'github');
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
