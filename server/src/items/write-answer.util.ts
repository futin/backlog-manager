import { HttpException } from '@nestjs/common';

import type { WriteOutcome, WriteRefusal } from './sources/source';

/*
 * write-answer.util.ts — the ONE mapping from an `ItemWriter` refusal to an HTTP status, shared by the nine write routes in `items-write.controller.ts`,
 * `abort` (`agents/items-abort.service.ts`, through the controller's re-export) and the read route `GET /api/items/claim` (`ItemsService.readClaim`).
 * Its own file rather than a function in the controller because the service needs it, and the controller injects the service.
 */

/**
 * One `WriteOutcome` → the response, or the exception. The ONE mapping from
 * `refused` to a status, so no route can invent its own.
 *
 * Each status is chosen for what the READER can do about it: 503 for a
 * credential this machine is missing (fix the environment), 404 for an issue
 * that is not there (fix the id), 409 for a race or a stale read (re-read and
 * retry), 429 for a budget with a time on it (wait), 502 for anything else
 * GitHub said (nothing local to fix).
 *
 * Exported since #225, for the reason `writable` gives; in its own file since #270, because the one READ route, `GET /api/items/claim`
 * (`ItemsService.readClaim`), refuses for the same reasons and owes its caller the same statuses — it used to answer 502 for everything but a
 * `not-found`, so `backlog.mjs stop` read a missing token and a rate limit as "GitHub failed".
 */
export function answer<T>(outcome: WriteOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  const r: WriteRefusal = outcome.refusal;
  switch (r.refused) {
    case 'no-token':
      throw new HttpException({ error: r.error }, 503);
    case 'not-found':
      throw new HttpException({ error: r.error }, 404);
    case 'conflict':
      // `holder` and `updatedAt` ride along when the adapter set them: each
      // is what the caller needs in order to do something other than give up
      // — who holds the claim, or the stamp to re-read against.
      throw new HttpException({ error: r.error, holder: r.holder, updatedAt: r.updatedAt }, 409);
    case 'rate-limited':
      throw new HttpException({ error: r.error, resetAt: r.resetAt ?? null }, 429);
    case 'sync-off':
      // No `code`: the app's two coded 409s (`RUN_IN_PROGRESS_CODE`, `RESUME_LOCKED_CODE`) each mean a different fact. The sentence names the repo and the fix.
      throw new HttpException({ error: r.error }, 409);
    default:
      throw new HttpException({ error: r.error, status: r.status ?? null }, 502);
  }
}
