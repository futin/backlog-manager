import { useRef } from 'react';

import { reviewState } from '../../../shared/review';
import type { GitlabMr } from '../../../shared/types';
import { ignoreKey, pruneIgnored, readIgnoredSteps, type IgnoreEntry, type IgnoredSteps } from '../lib/ignored-steps';
import { persistedJsonStore } from './persistedStore';

/**
 * useIgnoredSteps — the Delivery tab's ignore store (Jira detail tabs spec §4.5.1): the steps this browser chose to look past, one JSON object under
 * `backlog-manager.jira-ignored-steps`. The React half of `lib/ignored-steps.ts`, which holds the shape, the repairing read, when an entry still holds and the
 * prune; this file only persists and notifies.
 *
 * A `persistedJsonStore`, for `persistedStore`'s reason and with its one listener set: the modal's Delivery tab and the page's are two mounted readers of one
 * object, and an ignore clicked in one must reach the other. The reader is `readIgnoredSteps`, so a stored value that is not JSON, or is JSON of the wrong shape,
 * reads `{}` and one malformed entry costs nothing else. A write whose `localStorage.setItem` throws (private mode, quota) still reaches every mounted reader
 * through the listeners — the click takes effect on screen and is simply forgotten at the next load.
 *
 * Every write prunes first, with the writing ticket's own MRs: entries of THIS ticket's MRs that are no longer open go, entries of every other ticket stay (they
 * are the other tickets' to prune). `ticketMrs` is `null` while that ticket's delivery is not in hand, which prunes nothing.
 */
export const JIRA_IGNORED_STEPS_KEY = 'backlog-manager.jira-ignored-steps';

const store = persistedJsonStore<IgnoredSteps>(JIRA_IGNORED_STEPS_KEY, readIgnoredSteps);

export type IgnoreStep = 'review' | 'pipeline';

/** `entry` with `step` set to the state `mr` shows right now: the review's state (`'unread'` for a `null` review) and `landedAt`, or the pipeline and `updatedAt`. */
function recorded(entry: IgnoreEntry | undefined, mr: GitlabMr, step: IgnoreStep): IgnoreEntry | null {
  if (step === 'review') {
    const state = mr.review === null ? 'unread' : reviewState(mr.review, Date.now());
    return { ...entry, review: { state, landedAt: mr.review?.landedAt ?? null } };
  }
  // A step with no pipeline to record (a `null` pipeline has nothing to look past) is not an ignore.
  if (mr.pipeline === null) return null;
  return { ...entry, pipeline: { status: mr.pipeline, updatedAt: mr.updatedAt } };
}

/** `entry` without `step`; `null` when that leaves nothing, so the caller drops the key rather than store `{}`. */
function without(entry: IgnoreEntry | undefined, step: IgnoreStep): IgnoreEntry | null {
  if (entry === undefined) return null;
  const review = step === 'review' ? undefined : entry.review;
  const pipeline = step === 'pipeline' ? undefined : entry.pipeline;
  if (review === undefined && pipeline === undefined) return null;
  return { ...(review === undefined ? {} : { review }), ...(pipeline === undefined ? {} : { pipeline }) };
}

export function useIgnoredSteps(): {
  entries: IgnoredSteps;
  ignore(mr: GitlabMr, step: IgnoreStep, ticketMrs: readonly GitlabMr[] | null): void;
  unignore(mr: GitlabMr, step: IgnoreStep, ticketMrs: readonly GitlabMr[] | null): void;
} {
  const entries = store.useValue();
  // Two writes in one event handler would both start from the render's `entries` and the second would undo the first; the ref carries the latest write.
  const latest = useRef(entries);
  latest.current = entries;

  const write = (mr: GitlabMr, step: IgnoreStep, ticketMrs: readonly GitlabMr[] | null, next: (e: IgnoreEntry | undefined) => IgnoreEntry | null): void => {
    const key = ignoreKey(mr);
    const base = pruneIgnored(latest.current, ticketMrs);
    const entry = next(base[key]);
    const others = Object.entries(base).filter(([k]) => k !== key);
    const after: IgnoredSteps = Object.fromEntries(entry === null ? others : [...others, [key, entry]]);
    latest.current = after;
    store.set(after);
  };

  return {
    entries,
    ignore: (mr, step, ticketMrs) => write(mr, step, ticketMrs, (e) => recorded(e, mr, step) ?? e ?? null),
    unignore: (mr, step, ticketMrs) => write(mr, step, ticketMrs, (e) => without(e, step))
  };
}
