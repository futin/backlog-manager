import { HttpException } from '@nestjs/common';

import { authHeaders, dashboardError, type AgentsConfig } from './config.util';

/** The dashboard's stop answers at once — it signals a process, it does not wait for one — so the spawn call's budget is plenty. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Asks the dashboard to stop one session. `true` for a 200, `false` for the one 404 that means the process is already gone; a 502 for anything else.
 *
 * Hoisted out of `ItemsAbortService` (#225) when Jira's `jira-stop` needed the identical call: two routes, one stop, so what counts as "stopped" and what counts
 * as "already gone" can never differ between them. The 404 that carries `remote answers disabled` is NOT "already gone" — it says nothing about the session —
 * so it is a 502 like every other answer, and the caller's entry or claim stays. `untouched` finishes the 502's sentence, naming what the refusal left
 * standing in the caller's own words: `the claim is untouched` for the item abort, `Jira is untouched` for the Jira stop.
 */
export async function stopDashboardSession(cfg: AgentsConfig, session: string, untouched: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/api/sessions/${encodeURIComponent(session)}/stop`, {
      method: 'POST',
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS)
    });
  } catch (e) {
    throw new HttpException({ error: dashboardError(e, 'the dashboard session stop', STOP_TIMEOUT_MS) }, 502);
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.ok) return true;
  if (res.status === 404 && body?.error === 'no live session') return false;
  const error = typeof body?.error === 'string' ? body.error : `answered ${res.status}`;
  throw new HttpException({ error: `the dashboard did not stop session ${session}: ${error} — ${untouched}` }, 502);
}
