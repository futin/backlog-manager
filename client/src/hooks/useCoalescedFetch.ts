import { useEffect, useRef } from 'react';

import { createCoalescedPoll, type CoalescedPoll } from '../lib/coalesced-poll';

/**
 * The React shell around `lib/coalesced-poll.ts` (#277): the stable `trigger` a hook calls for its mount, its focus and its explicit refresh — one
 * request in flight, every trigger that lands during it folded into one follow-up — plus, when `armed`, the timer chain that re-asks `intervalMs` after
 * each answer settles. See that module's header for why the chain is armed by an answer rather than by the clock.
 *
 * `armed` is each caller's OWN condition for "there is something moving worth polling" (a live run, a syncing tracker, an armed sweeper), passed in
 * unchanged from what its `setInterval` effect used to guard on. Flipping it false clears the pending timer on that render; a request already in flight
 * may still land and set state, but nothing re-arms after it. Leaving it out is a hook with no clock at all (`useAgents`): mount and focus only, with the
 * in-flight coalescing and nothing else.
 *
 * The hook that calls this owns what a settled request DOES — its state, and its `useMountedRef` guard on that state. What this owns is only WHEN the
 * next request may start. Unmount clears the timer and drops a queued follow-up; the request already in the air finishes into the caller's guard.
 *
 * Convention, not a requirement: callers declare this hook above the effect that does their mount fetch. Nothing depends on it — every effect of a commit
 * flushes before any fetch can settle, and a request that settles after the lifecycle effect has run finds the poller active either way.
 *
 * `task` is read through a ref, so a caller may pass a fresh closure on every render without re-arming anything; the returned `trigger` is stable.
 */
export function useCoalescedFetch<T>(task: () => Promise<T>, opts: { armed?: boolean; intervalMs?: number } = {}): () => Promise<T> {
  const { armed = false, intervalMs = 0 } = opts;

  const taskRef = useRef(task);
  taskRef.current = task;

  const pollRef = useRef<CoalescedPoll<T> | null>(null);
  if (pollRef.current === null) pollRef.current = createCoalescedPoll(() => taskRef.current());
  const poll = pollRef.current;

  useEffect(() => {
    poll.start();
    return () => poll.stop();
  }, [poll]);

  useEffect(() => {
    poll.schedule(armed, intervalMs);
  }, [poll, armed, intervalMs]);

  return poll.trigger;
}
