import { createCoalescedPoll } from '../client/src/lib/coalesced-poll';

/**
 * `createCoalescedPoll` (#277) — the scheduling core of the board's three interval pollers and `useAgents`' refresh, tested on its own with fake timers and
 * tasks the test settles by hand. The hooks' own behaviour (one request pair, focus, unmount, arming conditions) is `test/poll-coalescing.test.tsx`; this
 * suite is the part that does not need React: which calls start a task, which fold into the follow-up, and when the timer may exist.
 */

interface Task {
  calls: number;
  /** Settle the Nth task started (0-based). */
  resolve: (n: number, value: string) => void;
  reject: (n: number) => void;
  fn: () => Promise<string>;
}

/** A task whose every run hangs until the test settles it. */
function controlledTask(): Task {
  const settlers: { resolve: (v: string) => void; reject: (e: Error) => void }[] = [];
  const t: Task = {
    calls: 0,
    resolve: (n, value) => settlers[n].resolve(value),
    reject: (n) => settlers[n].reject(new Error('boom')),
    fn: () => {
      t.calls += 1;
      return new Promise<string>((resolve, reject) => settlers.push({ resolve, reject }));
    }
  };
  return t;
}

/** Lets every already-queued promise reaction run, with no fake time passing. */
async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('createCoalescedPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts the task on an idle trigger and hands back its own promise', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();

    const answer = poll.trigger();
    expect(t.calls).toBe(1);
    t.resolve(0, 'a');
    await expect(answer).resolves.toBe('a');
  });

  it('starts nothing for triggers during a flight, and runs exactly one follow-up when it settles', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();

    const first = poll.trigger();
    const second = poll.trigger();
    const third = poll.trigger();
    expect(t.calls).toBe(1);
    // Every caller that asked during the flight shares the one follow-up.
    expect(third).toBe(second);

    t.resolve(0, 'old');
    await expect(first).resolves.toBe('old');
    await settle();
    expect(t.calls).toBe(2);

    t.resolve(1, 'new');
    await expect(second).resolves.toBe('new');
    await settle();
    expect(t.calls).toBe(2);
  });

  it('lets a trigger that lands in the gap between the settle and the follow-up join that follow-up', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();

    poll.trigger();
    const queued = poll.trigger();
    t.resolve(0, 'a');
    // Same microtask turn as the settle: the follow-up has not started yet.
    const late = poll.trigger();
    expect(late).toBe(queued);
    await settle();
    expect(t.calls).toBe(2);
  });

  it('arms the timer when the answer settles, not before, and re-arms from the follow-up rather than the request it queued behind', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);

    poll.trigger();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.calls).toBe(1);

    poll.trigger();
    t.resolve(0, 'a');
    await settle();
    // The follow-up is out; the timer must not exist yet, whatever time passes.
    expect(t.calls).toBe(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.calls).toBe(2);

    t.resolve(1, 'b');
    await settle();
    await jest.advanceTimersByTimeAsync(999);
    expect(t.calls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.calls).toBe(3);
  });

  it('does not tick while a tick is still unanswered, however long it takes', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);

    poll.trigger();
    t.resolve(0, 'a');
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(2);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.calls).toBe(2);
  });

  it('arms from a schedule() that arrives while idle, and waits for the settle when one arrives mid-flight', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();

    poll.trigger();
    poll.schedule(true, 1_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.calls).toBe(1);

    t.resolve(0, 'a');
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(2);

    // Idle again after the tick settles; disarm, re-arm, and the timer starts over from that call.
    t.resolve(1, 'b');
    await settle();
    poll.schedule(false, 1_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.calls).toBe(2);
    poll.schedule(true, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(3);
  });

  it('disarming clears the pending timer, and a flight in progress finishes without re-arming', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);

    poll.trigger();
    t.resolve(0, 'a');
    await settle();
    // The timer is pending now.
    poll.schedule(false, 1_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.calls).toBe(1);

    poll.schedule(true, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(2);
    poll.schedule(false, 1_000);
    t.resolve(1, 'b');
    await settle();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toBe(2);
  });

  it('stop() clears the timer and drops the queued follow-up, and its callers still get the flight’s answer', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);

    poll.trigger();
    const queued = poll.trigger();
    poll.stop();
    t.resolve(0, 'a');
    await expect(queued).resolves.toBe('a');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toBe(1);
  });

  it('survives stop() → start() on the same instance (StrictMode’s dev remount)', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);
    poll.stop();
    poll.start();

    poll.trigger();
    t.resolve(0, 'a');
    await settle();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(2);
  });

  it('a rejected task settles the flight like an answer: the timer re-arms and the next trigger starts a new request', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 1_000);

    const failed = poll.trigger();
    t.reject(0);
    await expect(failed).rejects.toThrow('boom');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.calls).toBe(2);

    t.resolve(1, 'ok');
    await settle();
    const again = poll.trigger();
    expect(t.calls).toBe(3);
    t.resolve(2, 'fine');
    await expect(again).resolves.toBe('fine');
  });

  it('a task that throws synchronously is a rejected flight, not a wedged poller', async () => {
    let calls = 0;
    const poll = createCoalescedPoll<string>(() => {
      calls += 1;
      if (calls === 1) throw new Error('sync');
      return Promise.resolve('ok');
    });
    poll.start();

    await expect(poll.trigger()).rejects.toThrow('sync');
    await expect(poll.trigger()).resolves.toBe('ok');
  });

  it('never arms with a non-positive interval', async () => {
    const t = controlledTask();
    const poll = createCoalescedPoll(t.fn);
    poll.start();
    poll.schedule(true, 0);

    poll.trigger();
    t.resolve(0, 'a');
    await settle();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toBe(1);
  });
});
