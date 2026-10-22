import { fetchTicks, resetTicks, sortTickProjects, tickActivity, ticksLast24h, updateTickConfig } from '../client/src/lib/ticks';
import type { TickProject, TickRecentEntry, TicksPayload } from '../shared/types';

/**
 * `client/src/lib/ticks.ts` — the Runs › Ticks page's derivations and its three fetchers. Fixture times are offsets from a `NOW` this suite pins itself (the
 * repo's "a fixture date is relative to the clock the assertion runs under" rule), so none of it can rot into the past.
 */

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function entry(agoMs: number, outcome = 'ok', id = 'bug-1'): TickRecentEntry {
  return { at: ago(agoMs), id, kind: 'execute', outcome, reason: '' };
}

function proj(name: string, over: Partial<TickProject> = {}): TickProject {
  return { root: `/r/${name}`, name, lock: null, recent: [], ...over };
}

describe('sortTickProjects', () => {
  it('puts halted first, then ticking, then empty, then error — newest last tick first inside a group', () => {
    const haltedOlder = proj('halted-older', { halted: true, streak: 3, recent: [entry(5 * HOUR, 'failed')] });
    const haltedNewer = proj('halted-newer', { halted: true, streak: 3, recent: [entry(1 * HOUR, 'failed')] });
    const ticking = proj('ticking', { halted: false, streak: 0, recent: [entry(30 * 60_000)] });
    const empty = proj('empty');
    const broken = proj('broken', { error: 'state.json unreadable' });
    const sorted = sortTickProjects([broken, empty, ticking, haltedOlder, haltedNewer]);
    expect(sorted.map((p) => p.name)).toEqual(['halted-newer', 'halted-older', 'ticking', 'empty', 'broken']);
  });

  it('orders two ticking projects by newest last tick, newest first', () => {
    const a = proj('a', { recent: [entry(3 * HOUR)] });
    const b = proj('b', { recent: [entry(1 * HOUR)] });
    expect(sortTickProjects([a, b]).map((p) => p.name)).toEqual(['b', 'a']);
  });

  it('breaks ties by name — two empty rows, and two rows with the same last tick', () => {
    const at = entry(HOUR);
    expect(sortTickProjects([proj('zeta'), proj('alpha')]).map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(sortTickProjects([proj('zeta', { recent: [at] }), proj('alpha', { recent: [at] })]).map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(sortTickProjects([proj('zeta', { error: 'x' }), proj('alpha', { error: 'x' })]).map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate its input', () => {
    const input = [proj('b'), proj('a')];
    sortTickProjects(input);
    expect(input.map((p) => p.name)).toEqual(['b', 'a']);
  });

  it('sinks a project whose newest entry has an unparseable time below the ones that parse, rather than throwing', () => {
    const bad = proj('bad', { recent: [{ ...entry(HOUR), at: 'not a date' }] });
    const good = proj('good', { recent: [entry(10 * HOUR)] });
    expect(sortTickProjects([bad, good]).map((p) => p.name)).toEqual(['good', 'bad']);
  });
});

describe('tickActivity', () => {
  it('merges projects newest first, tagging each row with its project name and root', () => {
    const a = proj('a', { recent: [entry(1 * HOUR, 'ok', 'a-new'), entry(4 * HOUR, 'failed', 'a-old')] });
    const b = proj('b', { recent: [entry(2 * HOUR, 'ok', 'b-new'), entry(5 * HOUR, 'ok', 'b-old')] });
    const rows = tickActivity([a, b]);
    expect(rows.map((r) => r.id)).toEqual(['a-new', 'b-new', 'a-old', 'b-old']);
    expect(rows[1]).toMatchObject({ project: 'b', root: '/r/b', outcome: 'ok' });
  });

  it('caps at max', () => {
    const a = proj('a', { recent: [entry(1 * HOUR, 'ok', '1'), entry(4 * HOUR, 'ok', '3')] });
    const b = proj('b', { recent: [entry(2 * HOUR, 'ok', '2'), entry(5 * HOUR, 'ok', '4')] });
    expect(tickActivity([a, b], 3).map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('defaults the cap to 50', () => {
    const many = proj('many', { recent: Array.from({ length: 80 }, (_, i) => entry(i * 60_000, 'ok', String(i))) });
    expect(tickActivity([many])).toHaveLength(50);
  });

  it('puts an unparseable time last instead of dropping or throwing', () => {
    const a = proj('a', { recent: [{ ...entry(HOUR), at: 'garbage', id: 'bad' }, entry(2 * HOUR, 'ok', 'good')] });
    expect(tickActivity([a]).map((r) => r.id)).toEqual(['good', 'bad']);
  });
});

describe('ticksLast24h', () => {
  it('counts only entries newer than now - 24h, splitting ok and failed, and other outcomes only in total', () => {
    const a = proj('a', {
      recent: [entry(1 * HOUR, 'ok'), entry(2 * HOUR, 'failed'), entry(3 * HOUR, 'idle'), entry(24 * HOUR + 1, 'ok'), entry(30 * HOUR, 'failed')]
    });
    const b = proj('b', { recent: [entry(23 * HOUR, 'ok'), entry(25 * HOUR, 'ok')] });
    expect(ticksLast24h([a, b], NOW)).toEqual({ total: 4, ok: 2, failed: 1 });
  });

  it('excludes an entry exactly 24h old and ignores an unparseable time', () => {
    const a = proj('a', { recent: [entry(24 * HOUR, 'ok'), { ...entry(HOUR), at: 'nope' }] });
    expect(ticksLast24h([a], NOW)).toEqual({ total: 0, ok: 0, failed: 0 });
  });

  it('is zero for no projects', () => {
    expect(ticksLast24h([], NOW)).toEqual({ total: 0, ok: 0, failed: 0 });
  });
});

describe('fetchers', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const payload: TicksPayload = { config: { haltAfter: 3, source: 'default' }, projects: [proj('a')] };
  function stub(body: unknown, ok = true, status = 200): jest.Mock {
    const fn = jest.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response));
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('fetchTicks GETs /api/ticks and returns the payload', async () => {
    const fn = stub(payload);
    await expect(fetchTicks()).resolves.toEqual(payload);
    expect(fn).toHaveBeenCalledWith('/api/ticks');
  });

  it('updateTickConfig POSTs {haltAfter} as JSON', async () => {
    const fn = stub(payload);
    await updateTickConfig(5);
    expect(fn).toHaveBeenCalledWith('/api/ticks/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ haltAfter: 5 })
    });
  });

  it('resetTicks POSTs {project} as JSON', async () => {
    const fn = stub(payload);
    await resetTicks('/r/a');
    expect(fn).toHaveBeenCalledWith('/api/ticks/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: '/r/a' })
    });
  });

  it('rejects a malformed body from all three', async () => {
    for (const bad of [
      null,
      {},
      { config: { haltAfter: 'x', source: 'file' }, projects: [] },
      { config: payload.config, projects: 'no' },
      { config: { haltAfter: 3, source: 'nope' }, projects: [] }
    ]) {
      stub(bad);
      await expect(fetchTicks()).rejects.toThrow('malformed /api/ticks response');
      await expect(updateTickConfig(3)).rejects.toThrow('malformed /api/ticks/config response');
      await expect(resetTicks('/r/a')).rejects.toThrow('malformed /api/ticks/reset response');
    }
  });

  it('rejects a project row missing its recent array or lock key shape', async () => {
    stub({ config: payload.config, projects: [{ root: '/r/a', name: 'a', lock: null }] });
    await expect(fetchTicks()).rejects.toThrow('malformed');
  });

  it("surfaces the server's own error wording on a non-2xx", async () => {
    stub({ error: 'haltAfter must be an integer' }, false, 400);
    await expect(updateTickConfig(3)).rejects.toThrow('haltAfter must be an integer');
  });
});
