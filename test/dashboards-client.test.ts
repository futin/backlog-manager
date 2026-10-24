/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  deleteEntry,
  fetchDashboards,
  fetchMachines,
  fetchOffers,
  lockedFor,
  machineIds,
  machineLabelByHost,
  narrowTo,
  noUsageText,
  pickSelected,
  prRequiredText,
  resetClockText,
  saveEntry,
  saveHome,
  saveSuggestion,
  statusFor
} from '../client/src/lib/dashboards';
import { dispatchAgent, startOrchestrate } from '../client/src/lib/agents';
import { useDashboards } from '../client/src/hooks/useDashboards';
import { useOffers } from '../client/src/hooks/useOffers';
import type { DashboardsView, MachineOffer, MachineStatus, MachinesStatus, ProjectOffers } from '../shared/types';

/**
 * Task 8's client half of the multi-dashboard feature: the six calls, the two derivations the launch surfaces share, and the two hooks that read them. Every
 * assertion here is about what crosses the wire or what a derivation answers; how the cards look is `run-on.test.tsx`'s.
 */

const VIEW: DashboardsView = {
  source: 'file',
  file: '/home/me/.backlog-manager/settings/dashboards.json',
  home: { label: 'Home', url: 'http://127.0.0.1:4310', account: null, models: [], efforts: [], tokenVar: 'BM_AGENTS_TOKEN', tokenSet: false },
  dashboards: [
    {
      name: 'Pro',
      url: 'http://pro.local:4310',
      bmUrl: 'http://pro.local:4322',
      host: 'pro-mac',
      tokenVar: 'BM_AGENTS_TOKEN_PRO',
      tokenSet: true,
      models: ['sonnet'],
      efforts: ['low', 'medium']
    }
  ],
  order: ['home', 'Pro'],
  strategy: 'prefer',
  threshold: 80
};

function offer(patch: Partial<MachineOffer>): MachineOffer {
  return { machine: 'home', label: 'Home', home: true, account: null, offered: true, reason: null, usage: null, usageAgeMs: null, models: [], efforts: [], ...patch };
}

const PRO = offer({ machine: 'Pro', label: 'Pro', home: false, models: ['sonnet'], efforts: ['low', 'medium'] });

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** A fetch that answers every call with `body` and keeps the calls for the assertions. */
function stubFetch(body: unknown, status = 200): jest.Mock {
  const fn = jest.fn(() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function lastCall(fn: jest.Mock): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[fn.mock.calls.length - 1] as [string, RequestInit];
  return { url, init };
}

describe('machineLabelByHost', () => {
  it('names the remote whose host matches', () => {
    expect(machineLabelByHost(VIEW, 'pro-mac')).toBe('Pro');
  });

  it('is null for home, for an unknown host, for no host and for no view', () => {
    expect(machineLabelByHost(VIEW, 'home')).toBeNull();
    expect(machineLabelByHost(VIEW, 'elsewhere')).toBeNull();
    expect(machineLabelByHost(VIEW, undefined)).toBeNull();
    expect(machineLabelByHost(null, 'pro-mac')).toBeNull();
  });
});

describe('lockedFor', () => {
  it('leaves home unlocked and unnarrowed', () => {
    expect(lockedFor(offer({ models: ['opus', 'sonnet'], efforts: ['high'] }))).toEqual({ prOnly: false, models: [], efforts: [] });
  });

  it('locks any remote to PR and hands back that machine’s lists', () => {
    expect(lockedFor(PRO)).toEqual({ prOnly: true, models: ['sonnet'], efforts: ['low', 'medium'] });
  });

  it('treats no offer yet as home, with empty lists', () => {
    expect(lockedFor(null)).toEqual({ prOnly: false, models: [], efforts: [] });
  });
});

describe('the dashboards calls', () => {
  it('fetchDashboards reads GET /api/dashboards', async () => {
    const fn = stubFetch(VIEW);
    await expect(fetchDashboards()).resolves.toEqual(VIEW);
    expect(lastCall(fn).url).toBe('/api/dashboards');
  });

  it('fetchOffers puts the project path in the query, encoded', async () => {
    const offers: ProjectOffers = { project: '/a b/c', machines: [offer({})], suggestion: null };
    const fn = stubFetch(offers);
    await expect(fetchOffers('/a b/c')).resolves.toEqual(offers);
    expect(lastCall(fn).url).toBe('/api/dashboards/offers?project=%2Fa%20b%2Fc');
  });

  it('saveEntry posts { entry } and, for a rename, { replaces }', async () => {
    const fn = stubFetch(VIEW);
    const entry = VIEW.dashboards[0];
    await saveEntry({ name: entry.name, url: entry.url, bmUrl: entry.bmUrl, host: entry.host });
    let { url, init } = lastCall(fn);
    expect(url).toBe('/api/dashboards/entries');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ entry: { name: 'Pro', url: 'http://pro.local:4310', bmUrl: 'http://pro.local:4322', host: 'pro-mac' } });

    await saveEntry({ name: 'Work', url: entry.url, bmUrl: entry.bmUrl, host: entry.host }, 'Pro');
    ({ url, init } = lastCall(fn));
    expect(JSON.parse(init.body as string)).toEqual({ entry: { name: 'Work', url: entry.url, bmUrl: entry.bmUrl, host: entry.host }, replaces: 'Pro' });
  });

  it('deleteEntry posts { name } to /entries/delete', async () => {
    const fn = stubFetch(VIEW);
    await deleteEntry('Pro');
    const { url, init } = lastCall(fn);
    expect(url).toBe('/api/dashboards/entries/delete');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Pro' });
  });

  it('saveHome posts the patch as it is, null included, to /home', async () => {
    const fn = stubFetch(VIEW);
    await saveHome({ label: 'Studio', account: null });
    const { url, init } = lastCall(fn);
    expect(url).toBe('/api/dashboards/home');
    expect(JSON.parse(init.body as string)).toEqual({ label: 'Studio', account: null });
  });

  it('saveSuggestion posts strategy / threshold / order to /settings', async () => {
    const fn = stubFetch(VIEW);
    await saveSuggestion({ strategy: 'headroom', threshold: 70, order: ['Pro', 'home'] });
    const { url, init } = lastCall(fn);
    expect(url).toBe('/api/dashboards/settings');
    expect(JSON.parse(init.body as string)).toEqual({ strategy: 'headroom', threshold: 70, order: ['Pro', 'home'] });
  });

  it('a refusal rejects with the server’s own message and status', async () => {
    stubFetch({ error: 'dashboards.json cannot be read' }, 409);
    await expect(saveHome({ label: 'x' })).rejects.toMatchObject({ message: 'dashboards.json cannot be read', status: 409 });
  });

  it('a body that is not a DashboardsView is refused rather than cached', async () => {
    stubFetch({ strategy: 'prefer' });
    await expect(fetchDashboards()).rejects.toThrow(/dashboards/i);
  });

  it('a body that is not a ProjectOffers is refused rather than cached', async () => {
    stubFetch({ project: '/p' });
    await expect(fetchOffers('/p')).rejects.toThrow(/offers/i);
  });
});

describe('the launch requests carry machine', () => {
  it('dispatchAgent sends machine when the caller names one and leaves the body alone otherwise', async () => {
    const fn = stubFetch({ ok: true });
    await dispatchAgent({ project: '/p', itemId: 'bug-1', machine: 'Pro' } as never);
    expect(JSON.parse(lastCall(fn).init.body as string)).toMatchObject({ machine: 'Pro' });
    await dispatchAgent({ project: '/p', itemId: 'bug-1' } as never);
    expect(JSON.parse(lastCall(fn).init.body as string)).not.toHaveProperty('machine');
  });

  it('startOrchestrate sends machine when the caller names one and leaves the body alone otherwise', async () => {
    const fn = stubFetch({ ok: true });
    await startOrchestrate({ project: '/p', machine: 'Pro' });
    expect(JSON.parse(lastCall(fn).init.body as string)).toMatchObject({ machine: 'Pro' });
    await startOrchestrate({ project: '/p' });
    expect(JSON.parse(lastCall(fn).init.body as string)).not.toHaveProperty('machine');
  });
});

describe('useDashboards', () => {
  it('reads once on mount, never polls, and refresh asks again', async () => {
    jest.useFakeTimers();
    try {
      const fn = stubFetch(VIEW);
      const { result } = renderHook(() => useDashboards());
      expect(result.current.view).toBeNull();
      await waitFor(() => expect(result.current.view).toEqual(VIEW));
      expect(result.current.error).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(10 * 60_000);
      });
      expect(fn).toHaveBeenCalledTimes(1);
      await act(async () => {
        await result.current.refresh();
      });
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed read leaves view null and says why', async () => {
    stubFetch({ error: 'boom' }, 500);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.view).toBeNull();
  });

  it('keeps the last good view when a later refresh fails', async () => {
    stubFetch(VIEW);
    const { result } = renderHook(() => useDashboards());
    await waitFor(() => expect(result.current.view).toEqual(VIEW));
    stubFetch({ error: 'down' }, 500);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.view).toEqual(VIEW);
    expect(result.current.error).toBe('down');
  });
});

describe('useOffers', () => {
  const OFFERS: ProjectOffers = { project: '/p', machines: [offer({}), PRO], suggestion: { machine: 'Pro', reason: 'why', basis: 'default' } };

  it('asks nothing while there is no project', async () => {
    const fn = stubFetch(OFFERS);
    const { result } = renderHook(() => useOffers(null));
    expect(result.current.offers).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('fetches when the project becomes non-null and again for a different one', async () => {
    const fn = stubFetch(OFFERS);
    const { result, rerender } = renderHook(({ p }: { p: string | null }) => useOffers(p), { initialProps: { p: null as string | null } });
    rerender({ p: '/p' });
    await waitFor(() => expect(result.current.offers).toEqual(OFFERS));
    expect(lastCall(fn).url).toBe('/api/dashboards/offers?project=%2Fp');
    rerender({ p: '/q' });
    // The old project's answer never shows under the new key.
    expect(result.current.offers).toBeNull();
    await waitFor(() => expect(lastCall(fn).url).toBe('/api/dashboards/offers?project=%2Fq'));
  });

  it('a failed read leaves offers null and says why; refresh asks again', async () => {
    stubFetch({ error: 'nope' }, 502);
    const { result } = renderHook(() => useOffers('/p'));
    await waitFor(() => expect(result.current.error).toBe('nope'));
    expect(result.current.offers).toBeNull();
    stubFetch(OFFERS);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.offers).toEqual(OFFERS);
    expect(result.current.error).toBeNull();
  });
});

// Task 9's three small derivations the launch sheets share: where a narrowed select lands, and the two hints a remote pick draws.
describe('narrowTo', () => {
  it('keeps a value the list already holds, and any value when there is no list', () => {
    expect(narrowTo('sonnet', ['opus', 'sonnet'], 'opus')).toBe('sonnet');
    expect(narrowTo('haiku', [], 'opus')).toBe('haiku');
    expect(narrowTo('', [], '')).toBe('');
  });

  it('falls to the Settings default when it is listed, else to the first listed', () => {
    expect(narrowTo('haiku', ['opus', 'sonnet'], 'sonnet')).toBe('sonnet');
    expect(narrowTo('haiku', ['opus', 'sonnet'], 'max')).toBe('opus');
  });

  // Final-review I4: '' is the Settings "default" — no pick, which a remote launch sends as no value and the server fills (a model) or omits (an effort).
  // It is legal on every machine, so it is never narrowed, and an explicit value narrowed away lands on it when that is the Settings default.
  it("never narrows '' (the default), and lands a narrowed-away value on a '' Settings default", () => {
    expect(narrowTo('', ['low', 'high'], '')).toBe('');
    expect(narrowTo('', ['low', 'high'], 'high')).toBe('');
    expect(narrowTo('max', ['low', 'high'], '')).toBe('');
  });
});

describe('hint text', () => {
  it('names the machine', () => {
    expect(prRequiredText('Pro')).toBe('Required when running on Pro');
  });
});

/** The Settings › Dashboards page's derivations (task 4): which machines it lists and in what order, which one is selected, and the words a card's usage slot shows. */
describe('machineIds', () => {
  const view = (order: string[], names: string[]): DashboardsView => ({ ...VIEW, order, dashboards: names.map((name) => ({ ...VIEW.dashboards[0], name })) });

  it('follows the prefer order, then appends a remote the order lacks', () => {
    expect(machineIds(view(['Pro', 'home'], ['Pro', 'Linux']))).toEqual(['Pro', 'home', 'Linux']);
  });

  it('puts home first when the order does not name it', () => {
    expect(machineIds(view(['Pro'], ['Pro']))).toEqual(['home', 'Pro']);
  });

  it('drops an id the order names but no entry owns', () => {
    expect(machineIds(view(['home', 'Gone', 'Pro'], ['Pro']))).toEqual(['home', 'Pro']);
  });
});

describe('pickSelected', () => {
  it('keeps the wanted id when it is listed, else the first', () => {
    expect(pickSelected(['home', 'Pro'], 'Pro')).toBe('Pro');
    expect(pickSelected(['home', 'Pro'], 'Gone')).toBe('home');
    expect(pickSelected(['home', 'Pro'], null)).toBe('home');
  });
});

describe('statusFor', () => {
  const status = (machine: string): MachineStatus => ({
    machine,
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: null,
    usage: null,
    usageAgeMs: null
  });
  const answer: MachinesStatus = { machines: [status('home'), status('Pro')] };

  it('answers the entry for the id, or null', () => {
    expect(statusFor(answer, 'Pro')?.machine).toBe('Pro');
    expect(statusFor(answer, 'Gone')).toBeNull();
    expect(statusFor(null, 'Pro')).toBeNull();
  });
});

describe('resetClockText', () => {
  // A local-constructor clock so the suite does not depend on the machine's zone; 2026-10-23 is a Friday.
  const now = new Date(2026, 9, 23, 10, 0).getTime();
  const at = (...a: [number, number, number, number, number]): string => new Date(...a).toISOString();

  it('says the clock time for later today', () => {
    expect(resetClockText(at(2026, 9, 23, 23, 39), now)).toBe('resets 23:39');
  });

  it('prefixes a fixed English weekday for a later day', () => {
    expect(resetClockText(at(2026, 9, 24, 0, 5), now)).toBe('resets Sat 00:05');
    expect(resetClockText(at(2026, 9, 25, 5, 59), now)).toBe('resets Sun 05:59');
    expect(resetClockText(at(2026, 9, 29, 9, 0), now)).toBe('resets Thu 09:00');
  });

  it('says now for a reset at or before now', () => {
    expect(resetClockText(at(2026, 9, 23, 9, 59), now)).toBe('resets now');
    expect(resetClockText(new Date(now).toISOString(), now)).toBe('resets now');
  });

  it('is null for a missing or unparseable time', () => {
    expect(resetClockText(null, now)).toBeNull();
    expect(resetClockText('soon', now)).toBeNull();
  });
});

describe('noUsageText', () => {
  it('names an unreachable enabled machine', () => {
    expect(noUsageText({ enabled: true, reachable: false, usageAgeMs: null })).toBe('unreachable');
  });

  it('says how old a stale figure is, and otherwise that there is none', () => {
    expect(noUsageText({ enabled: true, reachable: true, usageAgeMs: 14 * 60_000 })).toBe('no fresh figure · usage 14 min ago');
    expect(noUsageText({ enabled: true, reachable: true, usageAgeMs: 40_000 })).toBe('no usage figure');
    expect(noUsageText({ enabled: true, reachable: true, usageAgeMs: null })).toBe('no usage figure');
  });

  it('does not call a switched-off machine unreachable', () => {
    expect(noUsageText({ enabled: false, reachable: false, usageAgeMs: null })).toBe('no usage figure');
  });
});

describe('fetchMachines', () => {
  it('resolves a well-formed answer from the machines route', async () => {
    const body = {
      machines: [
        { machine: 'home', enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: null, usage: null, usageAgeMs: null }
      ]
    };
    const fn = stubFetch(body);
    await expect(fetchMachines()).resolves.toEqual(body);
    expect(fn.mock.calls[0][0]).toBe('/api/dashboards/machines');
  });

  it('refuses an entry missing its flags', async () => {
    stubFetch({ machines: [{ machine: 'home' }] });
    await expect(fetchMachines()).rejects.toThrow('unexpected /api/dashboards/machines response');
  });

  it('refuses a usage whose windows are not readings', async () => {
    stubFetch({ machines: [{ machine: 'home', enabled: true, reachable: true, usage: { fiveHour: null, week: null }, usageAgeMs: 1 }] });
    await expect(fetchMachines()).rejects.toThrow('unexpected /api/dashboards/machines response');
  });
});
