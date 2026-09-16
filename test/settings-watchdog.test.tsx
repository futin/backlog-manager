/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import { ATTEMPT_LADDER, GRACE_LADDER, TICK_LADDER, WatchdogGroup, saveErrorSlot } from '../client/src/components/settings/WatchdogGroup';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { WATCHDOG_POLL_MS } from '../client/src/hooks/useWatchdog';
import { formatSpanCompact } from '../client/src/lib/run-time';
import { DEFAULT_WATCHDOG_CONFIG, WATCHDOG_LIMITS } from '../shared/types';
import type { AgentsStatus, WatchdogStatus } from '../shared/types';

/**
 * task-7-brief.md's own table, Step 1 — `WatchdogGroup` rendered the same
 * way `test/settings-view.test.tsx` renders every other group: `SettingsView`
 * inside a real `SettingsProvider` (so `useSettings`'s localStorage path is
 * live rather than the no-op fallback it takes bare), `fetch` stubbed per
 * URL so the pre-existing `/api/agents/status` call `AgentsGroup` makes on
 * every mount and the new `/api/agents/watchdog` (+ `/config` POST) calls
 * `WatchdogGroup` makes can both be answered from one mock.
 */

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

/** A full `WatchdogStatus`, defaults everywhere a case does not care. */
function watchdogStatus(over: Partial<WatchdogStatus> = {}): WatchdogStatus {
  return {
    phase: 'idle',
    nextTickAt: null,
    config: DEFAULT_WATCHDOG_CONFIG,
    watching: [],
    events: [],
    ...over
  };
}

type JsonResponse = { ok: true; status: 200; json: () => Promise<unknown> };

function jsonOk(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
}

/**
 * The one fetch stub every case below builds on. `watchdog: 'reject'`
 * reproduces case 11 — the GET itself rejecting, not a non-2xx response —
 * because that is the shape `useWatchdog`'s own suite (`test/watchdog-hook.test.tsx`,
 * case 14) already exercises for "the fetch rejects" and this group has to
 * degrade the same way. `onConfigPost` lets cases 7/8 hand back a
 * POST-specific response (the field the save actually changed) without
 * duplicating this whole routing switch per test.
 *
 * bug-24: `onConfigPost` may also answer a FAILURE — the string `'reject'`
 * for a rejected promise, or `{ status, body }` for a non-2xx routed through
 * the same `json()` shape `jsonOk` uses. Both are how a refused save reaches
 * `useWatchdog.save`'s catch: `updateWatchdogConfig` throws on either. The
 * success shape is unchanged so the cases that predate this stay untouched.
 */
type PostFailure = 'reject' | { status: number; body: unknown };

function stubFetch(opts: { watchdog: WatchdogStatus | 'reject'; onConfigPost?: (patch: Record<string, unknown>) => WatchdogStatus | PostFailure }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/agents/status')) {
      return jsonOk(AGENTS_STATUS);
    }

    if (url.endsWith('/api/agents/watchdog/config')) {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (opts.onConfigPost) {
        const answer = opts.onConfigPost(patch);
        if (answer === 'reject') return Promise.reject(new Error('config post rejected'));
        if (typeof answer === 'object' && answer !== null && 'status' in answer && 'body' in answer) {
          const fail = answer as { status: number; body: unknown };
          return Promise.resolve({
            ok: false,
            status: fail.status,
            json: () => Promise.resolve(fail.body)
          } as unknown as Response);
        }
        return jsonOk(answer);
      }
      return jsonOk(opts.watchdog === 'reject' ? watchdogStatus() : opts.watchdog);
    }

    if (url.endsWith('/api/agents/watchdog')) {
      if (opts.watchdog === 'reject') return Promise.reject(new Error('watchdog unreachable'));
      return jsonOk(opts.watchdog);
    }

    return Promise.reject(new Error(`settings-watchdog.test.tsx: unexpected fetch ${url}`));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * The watchdog card is on Settings' SHARED page since task-42 — it is the one
 * card here that writes to the server, so it sits with the other host-backed
 * card rather than among this browser's preferences. Every render through
 * `SettingsView` therefore has to say so first: `settingsScope` is read out of
 * localStorage once, when the provider mounts, and the page offers no control
 * that changes it (the rail's tree is the only one).
 */
function storeSharedPage(): void {
  localStorage.setItem('backlog-manager.settings', JSON.stringify({ settingsScope: 'shared' }));
}

function renderView(): void {
  storeSharedPage();
  render(
    <SettingsProvider>
      <SettingsView />
    </SettingsProvider>
  );
}

/* The card's title and its scope subtitle, two strings since task-39 —
   `SettingsGroup` splits what was one `Orchestrator watchdog · this server`
   line into `SheetHead`'s title and sub (DESIGN.md §8.6). Both are asserted,
   because the scope is the half that says the file this card edits is NOT this
   browser's, which is the one thing this group's own header comment argues at
   length. */
const GROUP_TITLE = 'Orchestrator watchdog';
const GROUP_SCOPE = 'this server';

describe('WatchdogGroup', () => {
  afterEach(() => {
    // Unconditional: only the "armed" case below (#3) turns fake timers on,
    // but calling this when they are already real is a harmless no-op, and
    // forgetting it on the one case that DOES enable them would leak a fake
    // clock into whatever test file jest runs next.
    jest.useRealTimers();
  });

  // --- 1: the group is knobs plus one orientation row, nothing live -------

  it('renders the group titled, names the shared config file, and points at Runs › Watchdog', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    renderView();

    // Waited on FIRST, deliberately: the group title renders on the very
    // first synchronous paint regardless of whether `useWatchdog`'s mount
    // fetch has resolved yet (both the loaded state and the `status===null`
    // fallback render it), so asserting on the title first would pass
    // before the fetch settles at all. A knob only exists once `status` has
    // actually landed, so waiting on ONE of them is what waits for the fetch.
    expect(await screen.findByLabelText('Enabled')).toBeInTheDocument();
    expect(screen.getByText(GROUP_TITLE)).toBeInTheDocument();
    expect(screen.getByText(GROUP_SCOPE)).toBeInTheDocument();

    // The hint is read as running text — same pattern
    // test/settings-view.test.tsx already relies on for AgentsStatusLines'
    // mixed-child `.set-hint` (regex search across one element's full text
    // content, not a search for a single leaf node).
    expect(screen.getByText(/~\/\.backlog-manager\/settings\/watchdog\.json/)).toBeInTheDocument();
    expect(screen.getByText(/every device/i)).toBeInTheDocument();

    // task-18: the live half moved. What stays behind is one sentence saying
    // where it went — and, crucially, NOTHING that changes on a clock.
    // task-39: and a control that OPENS it, where the sentence used to be the
    // whole of it. Both readings are asserted — the sentence still has to name
    // the destination for a reader who is only scanning, and the button is what
    // the redraw added.
    expect(screen.getByText(/The sweeper's state, the runs it is watching/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Runs › Watchdog/ })).toBeInTheDocument();
    expect(screen.queryByText(/^idle — /)).not.toBeInTheDocument();
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
  });

  /**
   * task-39 — the `Live view` row's control calls the destination it is handed
   * and nothing else.
   *
   * Asserted against the PROP rather than against a rendered Watchdog page,
   * because the destination is the rail's own and this group has no opinion
   * about it: the shell hands down the same pair the rail's sub-nav entry calls
   * (test/nav.test.tsx pins that half). A group that opened Runs › Watchdog by
   * calling `setRunsMode` itself would pass a "the page changed" assertion and
   * be exactly the second expression of one destination this prop exists to
   * prevent.
   *
   * `WatchdogGroup` is rendered directly rather than through `SettingsView`,
   * so the prop under test is the one this component actually receives.
   */
  it('opens Runs › Watchdog through the destination it is handed', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    const onOpenWatchdog = jest.fn();
    render(
      <SettingsProvider>
        <WatchdogGroup onOpenWatchdog={onOpenWatchdog} />
      </SettingsProvider>
    );
    await screen.findByRole('switch', { name: 'Enabled' });

    await userEvent.click(screen.getByRole('button', { name: /Runs › Watchdog/ }));
    expect(onOpenWatchdog).toHaveBeenCalledTimes(1);
  });

  // --- 2: off, controls not gated on phase -----------------------------------

  it('renders every control while the sweeper is off, and still says nothing about its phase', async () => {
    stubFetch({
      watchdog: watchdogStatus({ phase: 'off', reason: 'BM_AGENTS off', nextTickAt: null })
    });
    renderView();

    expect(await screen.findByLabelText('Enabled')).toBeInTheDocument();
    // The phase belongs to the monitor now — a knob is worth setting while
    // the sweeper is off, but this group no longer reports that it is.
    expect(screen.queryByText('off — BM_AGENTS off')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Check every')).toBeInTheDocument();
    expect(screen.getByLabelText('Leave a resumed run alone for')).toBeInTheDocument();
    expect(screen.getByLabelText('Give up after')).toBeInTheDocument();
  });

  // --- 4: every ladder value is inside its WATCHDOG_LIMITS clamp range ------

  it('keeps every ladder option inside its WATCHDOG_LIMITS floor/ceiling', () => {
    for (const v of TICK_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.tickMs.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.tickMs.max);
    }
    for (const v of GRACE_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.graceMs.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.graceMs.max);
    }
    for (const v of ATTEMPT_LADDER) {
      expect(v).toBeGreaterThanOrEqual(WATCHDOG_LIMITS.maxAttempts.min);
      expect(v).toBeLessThanOrEqual(WATCHDOG_LIMITS.maxAttempts.max);
    }
  });

  // RULING R8: the top grace option (3_600_000) is labelled by
  // `formatSpanCompact` exactly like every other option — it is NOT
  // hand-written as "60m". `formatSpanCompact` delegates to `formatSpan` at
  // or above one hour, and `formatSpan(3_600_000)` reads "1h 00m" (1 hour,
  // 0 minutes formatted to two digits), not "60m". Pinned here as its own
  // assertion so a future edit to either formatter's boundary is caught
  // here rather than only failing case 5/6's render assertions below.
  it('labels the top grace option "1h 00m", not "60m"', () => {
    expect(formatSpanCompact(3_600_000)).toBe('1h 00m');
    expect(GRACE_LADDER[GRACE_LADDER.length - 1]).toBe(3_600_000);
  });

  // --- 5: defaults render as 1m / 10m / 2 ------------------------------------

  it('shows the default tick/grace/attempts values through formatSpanCompact and a bare count', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    renderView();

    const tick = (await screen.findByLabelText('Check every')) as HTMLSelectElement;
    const grace = screen.getByLabelText('Leave a resumed run alone for') as HTMLSelectElement;
    const attempts = screen.getByLabelText('Give up after') as HTMLSelectElement;

    expect(tick.options[tick.selectedIndex].textContent).toBe('1m');
    expect(grace.options[grace.selectedIndex].textContent).toBe('10m');
    expect(attempts.options[attempts.selectedIndex].textContent).toBe('2');
  });

  // --- 6: an off-ladder value still renders as its own selected option ------
  //
  // Table-driven across all three fields `ladderWithSelected` is applied to
  // (`WatchdogGroup.tsx:227, 242, 257`), not only `tickMs` — the brief's own
  // case 6 fixture names `tickMs` alone, but `ladderWithSelected` itself has
  // no field-specific branch in it, so a regression scoped to only the
  // `graceMs` or `maxAttempts` call site (someone "simplifies" one `.map()`
  // into a bare `LADDER.map(...)` and drops the splice) would pass a suite
  // that only ever exercised `tickMs`, while silently breaking exactly the
  // guarantee this row exists to prove. One parameterised case beats three
  // near-identical copies for the same reason `agents-shared.test.ts`'s own
  // `it.each` tables do it: the assertion shape below is identical across
  // rows, only the fixture differs.
  //
  // Every fixture value is chosen to sit INSIDE `WATCHDOG_LIMITS` for its
  // own field, not merely off its own ladder — so this exercises the
  // select's splice-and-sort path alone, never the server's separate clamp
  // (`watchdog-config.util.ts`, which this client-only component never
  // calls):
  //   - `tickMs` 45_000 — between the 30s/1m rungs, inside [30_000, 600_000]
  //     (unchanged from the original, single-field case 6).
  //   - `graceMs` 900_000 (15m) — between the 10m/20m rungs, inside
  //     [300_000, 3_600_000].
  //   - `maxAttempts` 2.5 — `ATTEMPT_LADDER` is `[1, 2, 3, 4, 5]`, i.e.
  //     literally every integer in `WATCHDOG_LIMITS.maxAttempts`'s own
  //     [1, 5] range, so no INTEGER value can be both off-ladder and inside
  //     that range at once. A fractional value is the only fixture that is
  //     off-ladder while still landing strictly inside [1, 5] — the server's
  //     own `clampAttempts` would default a fractional value outright rather
  //     than clamp it (a fractional attempt count is not a smaller or larger
  //     count, it is not representable at all), but that clamp lives on the
  //     server and is never reached from this component; here it is simply a
  //     `WatchdogStatus.config.maxAttempts` this test hands to `WatchdogGroup`
  //     directly, exactly like every other case in this file stubs the GET
  //     response rather than running it through the real API.
  it.each([
    ['Check every', 'tickMs', 45_000, '45s', '45000'],
    ['Leave a resumed run alone for', 'graceMs', 900_000, '15m', '900000'],
    ['Give up after', 'maxAttempts', 2.5, '2.5', '2.5']
  ] as [string, 'tickMs' | 'graceMs' | 'maxAttempts', number, string, string][])(
    'shows an off-ladder %s value as an extra selected option, never snapped to a neighbour',
    async (label, field, value, expectedText, expectedValue) => {
      stubFetch({
        watchdog: watchdogStatus({ config: { ...DEFAULT_WATCHDOG_CONFIG, [field]: value } })
      });
      renderView();

      const select = (await screen.findByLabelText(label)) as HTMLSelectElement;
      expect(select.options[select.selectedIndex].textContent).toBe(expectedText);
      expect(select.value).toBe(expectedValue);
    }
  );

  // --- 7: Give up after -> exactly one POST, redraw from the response ------

  it('posts exactly {maxAttempts} on a change and redraws the select from the response', async () => {
    const responded = watchdogStatus({
      config: { ...DEFAULT_WATCHDOG_CONFIG, maxAttempts: 3 }
    });
    const fetchMock = stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => responded
    });
    renderView();

    const attempts = (await screen.findByLabelText('Give up after')) as HTMLSelectElement;

    // The "before" half of the Minor finding's call-count assertion: taken
    // only once `findByLabelText` above has resolved, i.e. only once the
    // MOUNT fetch's own promise has already settled — otherwise that GET
    // itself could be miscounted as one the save below triggers.
    const getsToWatchdog = (): number => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog')).length;
    const getsBeforeSave = getsToWatchdog();

    await userEvent.selectOptions(attempts, '3');

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog/config'));
      expect(posts).toHaveLength(1);
    });
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/agents/watchdog/config')) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ maxAttempts: 3 });

    await waitFor(() => {
      expect((screen.getByLabelText('Give up after') as HTMLSelectElement).value).toBe('3');
    });

    // The behaviour itself: `useWatchdog.save` redraws `status` straight
    // from the POST's own response and never
    // calls `reload()` afterwards, so a save must add ZERO new GETs to
    // `/api/agents/watchdog` — proven here directly by a call-count
    // assertion, rather than only inferred (as the two `waitFor`s above
    // already do) from the select's final value having come from a POST
    // response that differs from both the GET default and the ladder
    // default.
    expect(getsToWatchdog()).toBe(getsBeforeSave);
  });

  // --- 8: Enabled checkbox -> exactly one POST {enabled:false} --------------

  it('posts exactly {enabled:false} when the Enabled switch is turned off', async () => {
    const responded = watchdogStatus({
      config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: false }
    });
    const fetchMock = stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => responded
    });
    renderView();

    // A `Switch` since task-39 (§8.6's pill), not a UA checkbox: the accessible
    // name and the save call are unchanged, so what moved is `checked` →
    // `aria-checked` and `input` → `role="switch"`.
    const toggle = await screen.findByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Same "before" snapshot as case 7's — see that case's comment for why
    // it is taken only after the mount fetch has already settled.
    const getsToWatchdog = (): number => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog')).length;
    const getsBeforeSave = getsToWatchdog();

    await userEvent.click(toggle);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog/config'));
      expect(posts).toHaveLength(1);
    });
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/agents/watchdog/config')) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });

    // Same call-count proof as case 7's, for the switch's own save path.
    expect(getsToWatchdog()).toBe(getsBeforeSave);
  });

  // --- 11: the GET rejects — a one-line notice, no thrown error --------------

  it('shows a one-line unavailable notice and renders no controls when the GET rejects', async () => {
    stubFetch({ watchdog: 'reject' });

    // The render call itself must not throw — this is the assertion that
    // matters most: a component that only handles the happy path would
    // throw inside `useWatchdog`'s effect chain or on a null-config
    // dereference the very first time the API is unreachable.
    expect(() => renderView()).not.toThrow();

    // A specific substring, not a bare /watchdog/i — the group TITLE also
    // contains the word "watchdog" and renders unconditionally, so a loose
    // regex matches two elements and the query itself throws.
    expect(await screen.findByText(/Could not reach the watchdog/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Check every')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Leave a resumed run alone for')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Give up after')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument();
  });
  // --- task-18: nothing in Settings is live --------------------------------

  it('never polls the watchdog from Settings, even while the sweeper is armed', async () => {
    jest.useFakeTimers();
    const fetchMock = stubFetch({
      watchdog: watchdogStatus({
        phase: 'armed',
        nextTickAt: new Date(Date.now() + 42_000).toISOString(),
        watching: ['run-a']
      })
    });
    renderView();

    // Settle the mount fetches without advancing any fake time — the same
    // idiom test/watchdog-hook.test.tsx's own `flush` uses.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    const getsToWatchdog = (): number => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/agents/watchdog')).length;
    expect(getsToWatchdog()).toBe(1);

    // `armed` is the exact phase that USED to install a 5s interval here.
    // Two full periods, so a poll that merely starts late is still caught.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_POLL_MS * 2);
    });

    expect(getsToWatchdog()).toBe(1);
  });

  it('opens with the Live view pointer and then the four knobs, in that order', async () => {
    stubFetch({ watchdog: watchdogStatus({ phase: 'idle' }) });
    storeSharedPage();
    const { container } = render(
      <SettingsProvider>
        <SettingsView />
      </SettingsProvider>
    );
    await screen.findByLabelText('Enabled');

    // Scoped to this card alone: the Shared page renders `Claude Agents`
    // beside it, using the same `.set-name` class. Matched on the card's own
    // `SheetHead` title rather than on its text CONTENT, which would also
    // match a neighbour whose hints mention the watchdog — `Orchestrator ·
    // this device`'s did until task-42 moved that card to the other page, and
    // matching on the title is what made this immune to the move.
    const group = Array.from(container.querySelectorAll('.set-group')).find((el) => el.querySelector('.ui-sheet-title')?.textContent === GROUP_TITLE);
    const names = Array.from(group?.querySelectorAll('.set-name') ?? []).map((el) => el.textContent);
    expect(names).toEqual(['Live view', 'Enabled', 'Check every', 'Leave a resumed run alone for', 'Give up after']);
  });
  // --- bug-24: a refused save says so, beside the control that was changed --
  //
  // What made this reachable in the first place: every case above stubs a
  // SUCCEEDING POST (cases 7/8) or a rejecting GET (case 11). No case ever
  // failed a POST, so the fact that a refused save had no render site at all
  // — the only `error` render sits behind `status === null`, which a
  // successful mount GET has permanently closed — was never asserted either
  // way.

  const READ_ONLY = 'watchdog.json is read-only';

  /** The whole group loaded normally, with every POST refused 500. */
  function stubRefusedSave(): jest.Mock {
    return stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => ({ status: 500, body: { error: READ_ONLY } })
    });
  }

  it('renders a message and keeps every knob when a save is refused', async () => {
    stubRefusedSave();
    renderView();

    const attempts = (await screen.findByLabelText('Give up after')) as HTMLSelectElement;
    await userEvent.selectOptions(attempts, '3');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Not saved/);
    expect(alert).toHaveTextContent(READ_ONLY);

    // The select showing the old value is not a second defect: it is
    // controlled off `status.config`, which a failed write left at the last
    // value the server actually returned. What was missing is the line above.
    expect((screen.getByLabelText('Give up after') as HTMLSelectElement).value).toBe('2');
    expect(screen.getByLabelText('Enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('Check every')).toBeInTheDocument();
    expect(screen.getByLabelText('Leave a resumed run alone for')).toBeInTheDocument();
    // A failed WRITE is not a failed READ — the group must not collapse into
    // the load-failure notice.
    expect(screen.queryByText(/Could not reach the watchdog/)).not.toBeInTheDocument();
  });

  it("places the message in the failing control's own row", async () => {
    stubRefusedSave();
    renderView();

    const attempts = (await screen.findByLabelText('Give up after')) as HTMLSelectElement;
    await userEvent.selectOptions(attempts, '3');

    // This is the assertion a group-level banner fails, which is what makes
    // "beside the control" a tested claim rather than a comment in the file.
    const alert = await screen.findByRole('alert');
    expect(alert.previousElementSibling).toContainElement(screen.getByLabelText('Give up after'));
  });

  it('reports a refused save from the switch the same way', async () => {
    stubRefusedSave();
    renderView();

    const toggle = await screen.findByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // Still on: the control shows the value that is actually on the server,
    // which is the whole of bug-24's claim and is unaffected by the control
    // being a pill rather than a checkbox.
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true');
  });

  it('removes the message once a later save succeeds', async () => {
    const succeeded = watchdogStatus({
      config: { ...DEFAULT_WATCHDOG_CONFIG, maxAttempts: 4 }
    });
    let refuse = true;
    stubFetch({
      watchdog: watchdogStatus({ phase: 'idle' }),
      onConfigPost: () => (refuse ? { status: 500, body: { error: READ_ONLY } } : succeeded)
    });
    renderView();

    const attempts = (await screen.findByLabelText('Give up after')) as HTMLSelectElement;
    await userEvent.selectOptions(attempts, '3');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    refuse = false;
    await userEvent.selectOptions(screen.getByLabelText('Give up after'), '4');

    await waitFor(() => {
      expect((screen.getByLabelText('Give up after') as HTMLSelectElement).value).toBe('4');
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The fallback is the point, not a formality: a message with no matching
  // row must still land somewhere, because a `saveError` that renders
  // nowhere is precisely the defect being fixed here — and an unrecognised
  // field (a fifth knob added to `WatchdogConfig`, a hand-built patch) is
  // exactly how it would come back.
  it('maps every known field to its own slot and everything else to the end', () => {
    expect(saveErrorSlot('enabled')).toBe('enabled');
    expect(saveErrorSlot('tickMs')).toBe('tickMs');
    expect(saveErrorSlot('graceMs')).toBe('graceMs');
    expect(saveErrorSlot('maxAttempts')).toBe('maxAttempts');
    expect(saveErrorSlot(null)).toBe('end');
    expect(saveErrorSlot('somethingElse' as unknown as 'enabled')).toBe('end');
  });
});
