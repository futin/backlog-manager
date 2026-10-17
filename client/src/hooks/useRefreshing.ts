import { useEffect } from 'react';

import { useCoalescedFetch } from './useCoalescedFetch';

/**
 * The board's refresh cadence in one place (#285): `useCoalescedFetch`'s stable trigger, fired once on mount and once per window `focus` — the entry
 * every board poller (`useBoard`, `useAgents`, `useOrchestratorRuns`, `useWatchdog`, `useOrchestratorArchive`) goes through.
 *
 * Why mount + focus and not a timer: almost everything these hooks read changes OUTSIDE this tab — a skill run in some terminal moves an item, a
 * dashboard starts, an orchestrator run archives its `run.json` — and the moment you come back to look is exactly the moment a `focus` event fires. A
 * timer would ask the same question worse, and an idle board left open all afternoon would pay for every tick of it. The polls that do exist (a tracker
 * project, a live run, a watched sweeper) are each caller's own `armed` condition, passed straight through to `useCoalescedFetch`; mount and focus keep
 * refreshing whether or not one is armed, which is what lets a quiet board notice a brand new run the instant you switch back to the tab.
 *
 * Every trigger goes through the one coalesced poller, so a focus storm or an explicit refresh that lands mid-flight folds into one follow-up rather than
 * stacking requests (#277). The mount and focus triggers discard their promise with `void`: each caller's task already swallows its own failure, and this
 * adds no `.catch` of its own, so an explicit caller of the returned trigger receives exactly what `useCoalescedFetch` hands it.
 *
 * `useCoalescedFetch` stays the lower layer, for a caller that needs no mount/focus trigger — `useJiraBoard`, which triggers on its board id instead — and
 * it is what the tests and the invariant name.
 */
export function useRefreshing<T>(task: () => Promise<T>, opts: { armed?: boolean; intervalMs?: number } = {}): () => Promise<T> {
  const trigger = useCoalescedFetch(task, opts);

  useEffect(() => {
    void trigger();
  }, [trigger]);

  useEffect(() => {
    const onFocus = (): void => {
      void trigger();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [trigger]);

  return trigger;
}
