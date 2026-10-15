/**
 * One request at a time, one follow-up at most, and a timer that is only ever armed by an answer (#277). The scheduling half of every board poller that
 * used to be a `setInterval`; `hooks/useCoalescedFetch.ts` is the React shell around it, and `hooks/useTrackers.ts` — which aims its own timer at the
 * server's clock and is the shape this was lifted from — deliberately is not built on it.
 *
 * Why a timer chain instead of an interval. A `setInterval` ticks on the wall clock whether or not the last request has come back. While the server was
 * stalled (2026-10-15: a slow bind-mount froze the event loop, `/api/health` took 23 s) that stacked a fresh request on every tick, so the moment the
 * server recovered it had a queue of identical questions to answer, each one a git spawn. Here the next tick is armed when the current request SETTLES,
 * `intervalMs` later — a slow answer slows the poll instead of piling onto it, and at most one timer is ever pending.
 *
 * Why a follow-up instead of a drop. A mount, a window focus or an explicit refresh that lands while a request is in flight must not start a second one —
 * but it must not be swallowed either, because the request already in the air was issued BEFORE whatever the trigger is about (the resume click's spawn,
 * the tab you just came back to) and may answer the old state. So the trigger marks the poller dirty, and when the in-flight request settles exactly ONE
 * follow-up runs at once, however many triggers arrived meanwhile. Every caller that asked during the flight is handed that same follow-up promise, which
 * resolves with an answer that was requested after it asked.
 *
 * The timer re-arms from the LAST request of a chain — the follow-up if there is one — never from the one it queued behind, so a focus storm cannot make
 * the poll tick sooner than `intervalMs` after the answer the screen is actually showing.
 *
 * Pure of React on purpose: it is tested directly (`test/coalesced-poll.test.ts`) with fake timers and a promise the test resolves by hand.
 */
export interface CoalescedPoll<T> {
  /**
   * Ask now. Idle → starts the task and returns its promise. A request already in flight (or a follow-up already queued) → starts nothing and returns the
   * follow-up's promise, which runs once the flight settles. Never starts two tasks at once.
   */
  trigger: () => Promise<T>;
  /** Set whether the timer chain runs, and how long after each settle it fires. Disarming clears the pending timer at once; an in-flight task finishes. */
  schedule: (armed: boolean, intervalMs: number) => void;
  /** Mounted: timers and follow-ups are allowed. Re-callable — React's dev StrictMode runs start → stop → start on the same instance. */
  start: () => void;
  /** Unmounted: clears the timer and drops the queued follow-up. A task already in flight is left alone; its owner guards the state it would set. */
  stop: () => void;
}

export function createCoalescedPoll<T>(task: () => Promise<T>): CoalescedPoll<T> {
  let active = false;
  let armed = false;
  let intervalMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The task currently running, and the one follow-up queued behind it. `pending` stays set across the microtask gap between the flight settling and the
  // follow-up starting, so a trigger landing in that gap joins the follow-up instead of starting a third request.
  let flight: Promise<T> | null = null;
  let pending: Promise<T> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  // Idle means nothing running and nothing queued — the only state a timer may be pending in.
  const idle = (): boolean => flight === null && pending === null;

  const arm = (): void => {
    clearTimer();
    if (!active || !armed || intervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      // Re-checked at fire time: the condition that armed this may have flipped between the settle that set the timer and now.
      if (active && armed) trigger().catch(() => {});
    }, intervalMs);
  };

  const begin = (): Promise<T> => {
    clearTimer();
    let p: Promise<T>;
    try {
      p = task();
    } catch (e) {
      p = Promise.reject(e);
    }
    flight = p;
    // Registered before anything else can chain on `p`, so it runs first when `p` settles: the flight is over before a follow-up (or a caller) sees it.
    const settled = (): void => {
      flight = null;
      if (pending === null) arm();
    };
    p.then(settled, settled);
    return p;
  };

  const trigger = (): Promise<T> => {
    if (idle()) return begin();
    if (pending === null) {
      const behind = flight as Promise<T>;
      const next = (): Promise<T> => {
        pending = null;
        // Unmounted while queued: the follow-up is dropped, and its callers get the answer of the flight they queued behind rather than hanging.
        return active ? begin() : behind;
      };
      pending = behind.then(next, next);
    }
    return pending;
  };

  return {
    trigger,
    schedule(nextArmed, nextIntervalMs) {
      armed = nextArmed;
      intervalMs = nextIntervalMs;
      if (!armed) clearTimer();
      else if (idle()) arm();
    },
    start() {
      active = true;
      if (idle()) arm();
    },
    stop() {
      active = false;
      clearTimer();
    }
  };
}
