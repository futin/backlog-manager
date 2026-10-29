import { HttpException } from '@nestjs/common';

import type { WriterLookup } from './items.service';

/*
 * write-gate.util.ts — the request-field and project gates every item write route applies: `writable` (may this project's items be written to at all), and
 * `text`, `required` and `optional` (one body field, read as a trimmed string). Shared by the ten routes in `items-write.controller.ts` and the eleventh,
 * `abort`, in `agents/items-abort.controller.ts` and `agents/items-abort.service.ts`.
 *
 * Its own file rather than functions exported from the controller for the layering reason #351 named: `items-abort.service.ts` used to import `writable`
 * from `items-write.controller.ts`, which is a service depending on a controller — loading the abort route dragged the whole write controller, its guard
 * and its Nest decorators in with it, and the next helper anyone needed would have gone the same way. A controller is an HTTP edge that only its module
 * names (`test/server-layering.test.ts` holds that line); the gates are plain functions, so they live where `answer` already moved for the same kind of
 * reason in #270 (`write-answer.util.ts`).
 */

/**
 * The project gate, in one place for all eleven (the second, third and fourth
 * refusals). Throws rather than returning a union, because every caller does
 * the identical thing with a failure and an eleventh copy of that branch is
 * eleven chances for one of them to answer 404 where the others answer 400.
 *
 * Exported since #225, so the abort route in `agents/` gates a project exactly as these routes do; in this util since #388.
 */
export function writable(lookup: WriterLookup): Extract<WriterLookup, { kind: 'writer' }> {
  // 404 rather than 400: a path this server was never told about is, as far
  // as this caller is concerned, not a project — the same answer
  // `uncommitted` and `mergeCheck` already give an unregistered path.
  if (lookup.kind === 'unregistered') throw new HttpException({ error: 'not found' }, 404);
  if (lookup.kind === 'files') {
    throw new HttpException({ error: "this project's items are files — the skills write them directly" }, 400);
  }
  // `resolveSource`'s own reason, already prefixed with the marker's absolute
  // path, rather than a sentence composed here: it is the same string
  // `ItemsIndex.errors` carries for the same project, and two wordings for
  // one fact is how a reader ends up believing they are two facts.
  if (lookup.kind === 'unsupported') throw new HttpException({ error: lookup.reason }, 400);
  return lookup;
}

/** A field read as a trimmed string, `''` for anything that is not one. The
 *  shape every identifier-ish field on these routes takes — never a spread of
 *  the caller's object, the rule `AgentsController.dispatch` already follows. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** …and the same, refusing an empty one by name, because a missing `project`
 *  and a missing `id` are different mistakes and a caller should be told which
 *  it made. */
export function required(value: unknown, field: string): string {
  const trimmed = text(value);
  if (trimmed === '') throw new HttpException({ error: `${field} is required` }, 400);
  return trimmed;
}

/**
 * A field that may be absent, but must be a non-empty string when it is there
 * — `host`'s rule (bug-46), which is `required`'s minus the requirement.
 *
 * The middle case is the one worth the helper: a caller that sent `host: 7` or
 * `host: '  '` has made a mistake, and answering 400 says so where dropping
 * the field would publish a claim that is silently missing the one thing this
 * field exists to carry. `undefined` is the only value that means "did not
 * send one", so a `null` is a 400 too.
 */
export function optional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = text(value);
  if (trimmed === '') throw new HttpException({ error: `${field} must be a non-empty string` }, 400);
  return trimmed;
}
