import { errorOf, postJson } from './http';
import { formatZonedClock } from './time-zone';

/**
 * The popover head's `Sync now` and a GitHub row's sync icon: one POST to the server's sweep route, folded into the three answers a button can act on.
 *
 * GitHub: `/api/github/sweep`, `{ repo }` when one repo is asked for. Jira: `/api/jira/sweep`, site-wide and bodiless — a Jira ROW does not come through here,
 * it keeps `/api/jira/boards/sweep`'s own callback in `JiraChip`. Both routes answer a 200 with the fresh status payload, but the caller re-reads the shell's
 * context instead of trusting it: the context's own fetch is what every other reader shares, so there is one place a cache is replaced.
 */
export type SweepService = 'github' | 'jira';

export type SweepOutcome = { ok: true } | { ok: false; status: number; message: string; retryAt: string | null };

const URLS: Record<SweepService, string> = { github: '/api/github/sweep', jira: '/api/jira/sweep' };
export const SERVICE_NAME: Record<SweepService, string> = { github: 'GitHub', jira: 'Jira' };

export async function postSweep(service: SweepService, target?: string): Promise<SweepOutcome> {
  try {
    const answer = await postJson(URLS[service], service === 'github' && target !== undefined ? { repo: target } : undefined);
    if (answer.ok) return { ok: true };
    const body = answer.body as { retryAt?: unknown; message?: unknown } | null;
    const retryAt = typeof body?.retryAt === 'string' ? body.retryAt : null;
    // A 409 and a 429 carry `message`, a 400/404 carry `error`; `errorOf` reads the second, so the first is read by hand before it falls back.
    const message = typeof body?.message === 'string' && body.message !== '' ? body.message : errorOf(body, `sweep failed (${answer.status})`);
    return { ok: false, status: answer.status, message, retryAt };
  } catch {
    return { ok: false, status: 0, message: 'API unreachable', retryAt: null };
  }
}

/** The sentence a refused sweep prints: a 429 names the clock it may be retried at, in the board's zone; anything else is the server's own words. */
export function refusalText(service: SweepService, outcome: Extract<SweepOutcome, { ok: false }>, zone: string): string {
  if (outcome.status === 429 && outcome.retryAt !== null) {
    const at = Date.parse(outcome.retryAt);
    if (!Number.isNaN(at)) return `${SERVICE_NAME[service]} asked to wait until ${formatZonedClock(at, zone)}`;
  }
  return outcome.message;
}
