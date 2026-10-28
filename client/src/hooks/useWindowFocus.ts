import { useEffect } from 'react';

/**
 * `callback` on every window `focus`, unsubscribed on unmount and re-subscribed when the callback's identity changes — the one `focus` listener in
 * `hooks/` (#376).
 *
 * Three hooks refetch on focus: `useRefreshing`, the layer every `useCoalescedFetch` board poller enters through, and `useTrackers` and `useJira`, the
 * two deliberate exceptions to that layer (#231 — they aim their timer at the server's own poll clock and let reads overlap under a newest-read-wins
 * counter, which `useCoalescedFetch` exists to prevent). The exception is about how a fetch is SCHEDULED, not about when one is asked for, so the
 * subscription itself is the same in all three and lives here once rather than as three hand-rolled effects that could drift — one forgetting its
 * cleanup, say, and leaking a listener per remount.
 *
 * The callback is called with no arguments, never handed the `FocusEvent`: every caller passes a trigger or a `reload` whose own parameters (if a later
 * one grows some) must not silently receive an event object. A caller that wants a stable subscription passes a stable callback — each of the three
 * already does, a `useCallback` or `useCoalescedFetch`'s stable trigger.
 */
export function useWindowFocus(callback: () => void): void {
  useEffect(() => {
    const onFocus = (): void => {
      callback();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [callback]);
}
