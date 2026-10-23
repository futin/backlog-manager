import { isSyncInterval, type SyncInterval } from '../../../../shared/types';
import { dashboardError } from '../config.util';

/** The remote board's project list is a registry read plus each project's cached tracker summary — cheap — and it is a new outbound read, held to 5 s. */
export const BOARD_TIMEOUT_MS = 5_000;

const WHAT = 'GET /api/projects';

/**
 * Where a shared project lives on another machine, read from THAT machine's backlog-manager (spec 2026-10-22-multi-dashboard-design.md, "What 'offered'
 * checks on a remote machine", and the plan's "Remote path" decision): `GET <bmUrl>/api/projects`, an array of `ProjectSummary`, and the entry whose
 * `source` is `github` and whose `repo` equals `repo` compared case-insensitively — GitHub's own owner/name comparison, so a marker written `Futin/…` on one
 * machine and `futin/…` on the other is the same project. Identity is the repo and never a disk path, because the path is exactly what differs per machine.
 *
 * Three answers, and the offers' reason ladder reads them in this order:
 * - `{ error }` — the board did not answer usably (refused, timed out, a non-2xx, a body that is not an array). Never thrown: a new outbound read's failure is
 *   data, and the offers route must answer 200 with that machine not offered rather than 500.
 * - `null` — it answered and no github entry carries this repo: not registered there, so not offered (fail closed — no path, no machine).
 * - `{ path, interval }` — the first matching entry. `interval` is `null` for anything that is not a `SyncInterval`, which the offers read as sync off; a
 *   remote whose sync is off refuses every item write there, so a session sent to it could not do its work.
 *
 * No `Authorization` header: the board is another app, not a dashboard, and a dashboard token sent to it would be a token handed to a service it was never
 * meant for. The timeout is a `setTimeout` race with an `AbortController` (the usage reader's shape, `usage.service.ts`), not `AbortSignal.timeout`, so one
 * hung board costs its caller this budget and no more, and `redirect: 'error'` keeps the read on the origin Settings named.
 */
export async function remoteProject(bmUrl: string, repo: string): Promise<{ path: string; interval: SyncInterval | null } | { error: string } | null> {
  let body: unknown;
  try {
    body = await getProjects(bmUrl);
  } catch (e) {
    return { error: dashboardError(e, WHAT, BOARD_TIMEOUT_MS) };
  }
  if (!Array.isArray(body)) return { error: `${WHAT} answered no project list` };
  const wanted = repo.toLowerCase();
  for (const entry of body) {
    if (entry === null || typeof entry !== 'object') continue;
    const { source, repo: theirs, path, interval } = entry as Record<string, unknown>;
    if (source !== 'github' || typeof theirs !== 'string' || theirs.toLowerCase() !== wanted) continue;
    // A half-shaped entry is skipped, not trusted: a launch would hand its `path` to a dashboard as the directory to start a session in.
    if (typeof path !== 'string' || path === '') continue;
    return { path, interval: isSyncInterval(interval) ? interval : null };
  }
  return null;
}

async function getProjects(bmUrl: string): Promise<unknown> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    }, BOARD_TIMEOUT_MS);
  });
  const request = (async () => {
    const res = await fetch(`${bmUrl}/api/projects`, { signal: abort.signal, redirect: 'error' });
    if (!res.ok) {
      // Released rather than left for the collector: an unread body holds its socket.
      await res.body?.cancel();
      throw new Error(`${WHAT} answered ${res.status}`);
    }
    return (await res.json()) as unknown;
  })();
  // `race` subscribes to both, so the loser's later rejection (the abort) is handled and never surfaces as an unhandled rejection.
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
