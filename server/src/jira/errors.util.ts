import { HttpException } from '@nestjs/common';

import type { JiraAccess } from '../../../shared/types';
import type { JiraResponse } from './jira.client';

/**
 * The one mapping from a Jira response to what this API says about it (Jira phase 1, spec §8). Two functions, because two questions are asked of the same
 * response and must not drift: `accessOf` — what does this say about the site's access state? — and `jiraHttpError` — what HTTP error does a route answer?
 * Every route, and the poller when it refuses a read inside a 429 window, goes through here, so a status never means one thing on one route and another
 * on the next.
 *
 * Every body is `{ error, access?, retryAt? }`. `error` because it is this API's one error key (120 sites say `{ error: … }`, and the client's shared
 * unwrapper reads `data.error`); `access` only where `accessOf` has an opinion, so a 400 or a 404 — which say something about the QUERY or the ISSUE and
 * nothing about the credentials — can never be mistaken for a change in the site's state.
 */

/** How long a 429 without `Retry-After` closes the window for. The one home of the number; the poller reads it. */
export const JIRA_RATE_LIMIT_DEFAULT_MS = 60_000;

/**
 * What a response says about access, or `null` when it says nothing: 2xx is `ok`, 401 `unauthorized`, 403 `forbidden`, 429 `rate-limited`, a transport
 * failure (`0`) or a 5xx `unreachable`. Any other status — a 400, a 404 — is `null`, because a rejected query or a missing issue is the answer to a
 * question, not a verdict on the connection.
 */
export function accessOf(res: JiraResponse<unknown>): JiraAccess | null {
  const s = res.status;
  if (s >= 200 && s < 300) return 'ok';
  if (s === 401) return 'unauthorized';
  if (s === 403) return 'forbidden';
  if (s === 429) return 'rate-limited';
  if (s === 0 || s >= 500) return 'unreachable';
  return null;
}

/**
 * The HTTP error a route answers for a non-success `res` (§8's table):
 *
 * | Jira                      | HTTP | `error`                                   |
 * | ------------------------- | ---- | ----------------------------------------- |
 * | 401                       | 503  | `Jira rejected the credentials`           |
 * | 403                       | 502  | `Jira refused: <message>`                 |
 * | 429                       | 503  | `Jira rate limit — retry after <instant>` |
 * | 0 (transport, timeout)    | 502  | `Jira unreachable: <message>`             |
 * | 400                       | 409  | `Jira refused: <message>`                 |
 * | 404                       | 404  | `issue not found`                         |
 * | any other 5xx             | 502  | `Jira answered <status>`                  |
 *
 * A status the table does not list (a 410, a 3xx) is `502 Jira answered <status>` with no `access`: it is Jira being surprising, not a state.
 *
 * `opts.retryAt` is for a read refused INSIDE a known 429 window: the poller hands back a synthesised 429 and the STORED instant, and it is used verbatim.
 * Recomputing it from the clock would make every refused read answer a later instant than the one before, and the window would appear to slide forever.
 * Without it the instant is now plus `Retry-After`, or plus `JIRA_RATE_LIMIT_DEFAULT_MS` when Jira sent none.
 */
export function jiraHttpError(res: JiraResponse<unknown>, opts?: { retryAt?: string }): HttpException {
  const access = accessOf(res);
  const message = res.message ?? `Jira answered ${res.status}`;
  const body = (error: string, extra: { retryAt?: string } = {}): Record<string, unknown> => ({ error, ...(access === null ? {} : { access }), ...extra });

  switch (res.status) {
    case 401:
      return new HttpException(body('Jira rejected the credentials'), 503);
    case 403:
      return new HttpException(body(`Jira refused: ${message}`), 502);
    case 429: {
      const retryAt = opts?.retryAt ?? new Date(Date.now() + (res.retryAfter !== null ? res.retryAfter * 1000 : JIRA_RATE_LIMIT_DEFAULT_MS)).toISOString();
      return new HttpException(body(`Jira rate limit — retry after ${retryAt}`, { retryAt }), 503);
    }
    case 0:
      return new HttpException(body(`Jira unreachable: ${message}`), 502);
    case 400:
      return new HttpException(body(`Jira refused: ${message}`), 409);
    case 404:
      return new HttpException(body('issue not found'), 404);
    default:
      return new HttpException(body(`Jira answered ${res.status}`), 502);
  }
}
