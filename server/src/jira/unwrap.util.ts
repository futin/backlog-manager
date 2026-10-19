import { jiraHttpError } from './errors.util';
import type { JiraResult } from './poller.service';

/**
 * The value of a poller outcome, or the §8 error for its failure — `retryAt` handed through verbatim so a refused call never slides the 429 window, and
 * `access` where the poller knows better than the status (an `unsupported` site). Shared by the read controller (`jira.controller.ts`) and the issue-write
 * routes (`jira-write.controller.ts`, phase 3) so a failure means the same thing on every route; it is here and not in `errors.util.ts` because it names
 * the poller's `JiraResult`, and `errors.util.ts` stays free of poller types (the poller itself imports it).
 */
export function unwrapJira<T>(result: JiraResult<T>): T {
  if (result.ok) return result.value;
  throw jiraHttpError(result.response, { retryAt: result.retryAt, access: result.access });
}
