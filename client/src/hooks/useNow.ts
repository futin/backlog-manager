import { useEffect, useState } from 'react';

/**
 * A clock that re-renders its caller on a fixed period, and only while it has
 * something to be a clock for.
 *
 * The board's data refreshes on mount and on window focus (`useBoard`,
 * `useAgents`), which is the right cadence for items: what changes them happens
 * outside this tab. An in-progress card's elapsed label is the one thing on the
 * board that goes stale with no event at all — `20m` becomes wrong sixty
 * seconds later whether or not anybody touches anything. So the label needs a
 * timer, and nothing else does.
 *
 * `enabled` exists so a board with nothing in progress installs no interval:
 * every card is then a pure function of props that cannot change, and a wakeup
 * a minute forever to re-render identical output is pure cost. The caller
 * decides — it is the one that knows whether any rendered item is live.
 *
 * Returned as a value rather than each card calling `Date.now()` itself so the
 * cards stay pure functions of their props: the board's tests pin the clock by
 * passing a number, and only this hook's own suite has to fake timers.
 */
export function useNow(enabled: boolean, periodMs: number = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    // Read the clock fresh on enable as well as on every tick: the value may
    // have been frozen for a long time while this was disabled, and the first
    // render after switching on should not show that stale number for up to a
    // whole period.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [enabled, periodMs]);

  return now;
}
