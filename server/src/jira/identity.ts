import type { JiraAccess, JiraTokenKind } from '../../../shared/types';

/**
 * identity.ts — what the poller has learned about the site at boot, and the back-off it retries the unanswered part on (Jira phase 1; spec §3 `identity.ts`
 * and the poller's arming rule, §14 P13/P14, preflight rulings P2 and P5).
 *
 * Four answers make a site usable, and each is asked until it comes back, then never again for the life of the process:
 *
 * - `cloudId` — from the unauthenticated `tenant_info`. Every other call goes through the gateway path it names, so nothing else can be asked without it.
 * - `serverInfo` — `deploymentType: 'Cloud'`. Anything else (or a 404, which is what a Server/DC site behind the gateway answers) is `unsupported`, and that
 *   one is FINAL: no retry of a Server/DC site will ever make it Cloud, so the poller disarms rather than back off forever (P5).
 * - `me` — the gateway `myself`. The one answer that can be LOST again: a 401 on any later call means the credentials stopped working, so `reset()` drops
 *   it and the retry starts over. Beside it, once, the token kind: the same `myself` asked of the site's own URL (classic answers 200 there, scoped 401). It
 *   is asked only after the gateway `myself` answered 200 (P2) — a bad token is a 401 everywhere, and asking first would record it as `scoped`.
 * - the sprint field — from `GET field`. A board searched without it would fill a cache whose every `sprint` is `null`, and the next sweep (with the field)
 *   would disagree with it on every card; so no board is searched until this is in, alongside the other three.
 *
 * The state lives in a class of its own, not in the poller, so the back-off arithmetic is a thing a suite can pin without a sweep around it and so the
 * routes' "answer from the boot state" (P3) reads the same fields the status payload does.
 *
 * The back-off is the GitHub poller's identity pacing made explicit: 15 s doubling to a 5 min cap. Fifteen seconds is the base tick, so the first retry
 * costs no extra wake-up; the cap keeps a site that is down for an afternoon from being asked every tick, while still noticing it came back within five
 * minutes. A failure that is not a verdict on the connection — a 400 or a 404 on a boot call, which no Jira answers on a healthy site — is still a reason
 * the board cannot load, so `fail(null, …)` records it as `unreachable` with the status in `detail` rather than letting `access` claim `ok`.
 */

export const JIRA_BACKOFF_MIN_MS = 15_000;
export const JIRA_BACKOFF_MAX_MS = 300_000;

/** The wait after a failure, given the wait after the previous one: 15 s first, then doubling, never past 5 min. */
export function nextBackoff(previous: number | null): number {
  if (previous === null) return JIRA_BACKOFF_MIN_MS;
  return Math.min(previous * 2, JIRA_BACKOFF_MAX_MS);
}

export class JiraBootState {
  cloudId: string | null = null;
  serverInfoOk = false;
  me: { accountId: string; name: string } | null = null;
  /** `null` until the site probe answers 200 or 401 — and for the rest of the process when it answered anything else (asked once, never retried). */
  tokenKind: JiraTokenKind | null = null;
  /** Whether the site probe has been sent. Separate from `tokenKind` because "asked, and the answer said nothing" must not be asked again. */
  tokenProbed = false;
  sprintField: string | null = null;
  fieldsOk = false;
  /** The site-level verdict the status payload shows. The sweep's board failures and a route's 401/429 write it too — it is one value for one site. */
  access: JiraAccess = 'ok';
  /** `connecting` until the first boot call has been asked: an honest `ok` with nothing to show yet, not a silent `null` that reads as healthy. */
  detail: string | null = 'connecting';
  failedAt: number | null = null;
  backoffMs: number | null = null;
  /** The end of a known 429 window, epoch ms. Every Jira call — sweep or route — is refused up front until `Date.now()` reaches it. */
  retryAt: number | null = null;

  /** Every boot answer is in: boards may be searched. */
  answered(): boolean {
    return this.cloudId !== null && this.serverInfoOk && this.me !== null && this.fieldsOk;
  }

  /** Whether the unanswered boot calls may be asked now: never failed, or the back-off since the last failure has run out. */
  due(now: number): boolean {
    return this.failedAt === null || this.backoffMs === null || this.failedAt + this.backoffMs <= now;
  }

  /** Record a failed boot call (or a 401 that undid `me`). `null` access is a 400/404 — see the header. */
  fail(access: JiraAccess | null, detail: string, now: number): void {
    this.access = access ?? 'unreachable';
    this.detail = detail;
    this.failedAt = now;
    this.backoffMs = nextBackoff(this.backoffMs);
  }

  /** The boot is whole: clear the failure and the back-off, so the NEXT failure waits 15 s again rather than where the last streak left off. */
  succeed(): void {
    this.access = 'ok';
    this.detail = null;
    this.failedAt = null;
    this.backoffMs = null;
  }

  /** What a 401 on a later call does: the credentials no longer resolve to anybody, so `me` is asked again. The token kind is not re-probed. */
  reset(): void {
    this.me = null;
  }
}
