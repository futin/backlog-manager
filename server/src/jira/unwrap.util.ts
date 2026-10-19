import { HttpException } from '@nestjs/common';

import type { JiraIssueWriteResult } from '../../../shared/types';
import { jiraHttpError } from './errors.util';
import type { JiraIssueWriteOutcome, JiraResult } from './poller.service';

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

/**
 * An issue write's outcome (`assignToMe` / `transitionIssue`) as a value or an error: the poller's two own refusals first — `no identity` a 503 (a state that
 * heals on the next successful `myself`), `transition not offered` a 400 (the caller's id is wrong, and Jira was never asked to judge it) — then every other
 * failure through `unwrapJira`. Hoisted out of `jira-write.controller.ts` so the two write routes and `POST /api/agents/dispatch-jira`, which makes the same two
 * writes, answer them in the same words and statuses; the dispatch route then prefixes the step's name onto whatever this throws.
 */
export function jiraWriteOrThrow(outcome: JiraIssueWriteOutcome): JiraIssueWriteResult {
  if ('refusal' in outcome) {
    if (outcome.refusal === 'no identity') throw new HttpException({ error: 'no identity' }, 503);
    throw new HttpException({ error: 'transition not offered' }, 400);
  }
  return unwrapJira(outcome);
}
