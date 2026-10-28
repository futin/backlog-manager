import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DashboardsFileUnreadable,
  dashboardsFile,
  normaliseOrder,
  readDashboardsFile,
  tokenVar,
  validateEntry,
  writeDashboardsFile
} from '../server/src/agents/dashboards/dashboards-file.util';
import type { DashboardsFile } from '../shared/types';

// `renameSync` is swapped for a switchable wrapper (default: the real one) so a case can force the failure after the temp file was written; everything else in
// `node:fs` stays real. Assigning onto the module object is not possible — its exports are read-only getters — hence the factory.
let failRename = false;
jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  return {
    ...real,
    renameSync: (...args: unknown[]) => {
      if (failRename) throw new Error('boom');
      return real.renameSync(...args);
    }
  };
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-dashboards-'));
  file = join(dir, 'dashboards.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  url: `https://${name.toLowerCase()}.ts.net:4173`,
  bmUrl: `https://${name.toLowerCase()}.ts.net:4322`,
  host: `${name.toLowerCase()}-mac`,
  ...extra
});

describe('dashboardsFile / tokenVar', () => {
  it('BM_DASHBOARDS_FILE wins', () => {
    expect(dashboardsFile({ BM_DASHBOARDS_FILE: '/x/d.json' })).toBe('/x/d.json');
  });
  it('defaults under HOME/.backlog-manager/settings', () => {
    expect(dashboardsFile({ HOME: '/h' })).toBe('/h/.backlog-manager/settings/dashboards.json');
  });
  it('tokenVar uppercases the name', () => {
    expect(tokenVar('Pro')).toBe('BM_AGENTS_TOKEN_PRO');
    expect(tokenVar('studio2')).toBe('BM_AGENTS_TOKEN_STUDIO2');
  });
});

describe('readDashboardsFile', () => {
  it('a missing file is the default: home only, prefer, 80', () => {
    const r = readDashboardsFile(file);
    expect(r).toEqual({ source: 'default', value: { dashboards: [], order: ['home'], strategy: 'prefer', threshold: 80 }, raw: {} });
  });

  it('a file that does not parse is unreadable', () => {
    writeFileSync(file, '{');
    const r = readDashboardsFile(file);
    expect(r.source).toBe('unreadable');
    expect((r as { reason: string }).reason).toContain('does not parse as JSON');
  });

  it('a file that parses to a non-object is unreadable', () => {
    writeFileSync(file, '[]');
    expect(readDashboardsFile(file).source).toBe('unreadable');
  });

  it('a directory at the path is unreadable', () => {
    mkdirSync(file);
    expect(readDashboardsFile(file).source).toBe('unreadable');
  });

  it.each([
    ['"x"', 80],
    [0, 1],
    [250, 100],
    [55.5, 80]
  ])('threshold %p reads as %p', (raw, want) => {
    writeFileSync(file, JSON.stringify({ dashboards: [], threshold: raw }));
    const r = readDashboardsFile(file);
    expect(r.source).toBe('file');
    expect((r as { value: DashboardsFile }).value.threshold).toBe(want);
  });

  it('an unknown strategy reads as prefer', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [], strategy: 'bogus' }));
    expect((readDashboardsFile(file) as { value: DashboardsFile }).value.strategy).toBe('prefer');
  });

  it('completes a hand-edited entry that leaves out bmUrl and host with their defaults', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [{ name: 'Pro', url: 'http://pro.ts.net:4173' }] }));
    const r = readDashboardsFile(file);
    expect(r.source === 'file' && r.value.dashboards).toEqual([{ name: 'Pro', url: 'http://pro.ts.net:4173', bmUrl: 'http://pro.ts.net:5177', host: 'Pro' }]);
  });
  it('drops an entry that fails validation and keeps the rest', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [entry('Pro'), { name: '2bad' }, 'junk', entry('Studio')] }));
    const v = (readDashboardsFile(file) as { value: DashboardsFile }).value;
    expect(v.dashboards.map((d) => d.name)).toEqual(['Pro', 'Studio']);
  });

  it('keeps the first entry per lowercased name and drops the rest', () => {
    writeFileSync(
      file,
      JSON.stringify({ dashboards: [entry('Pro'), entry('Studio'), { ...entry('pro'), host: 'other' }, entry('Pro')], order: ['pro', 'Studio'] })
    );
    const v = (readDashboardsFile(file) as { value: DashboardsFile }).value;
    expect(v.dashboards.map((d) => d.name)).toEqual(['Pro', 'Studio']);
    expect(v.dashboards[0].host).toBe('pro-mac');
    expect(v.order).toEqual(['Studio', 'home', 'Pro']);
  });

  it('keeps at most the first 8 valid entries', () => {
    const names = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1'];
    writeFileSync(file, JSON.stringify({ dashboards: [{ name: '2bad' }, ...names.map((n) => entry(n))] }));
    const v = (readDashboardsFile(file) as { value: DashboardsFile }).value;
    expect(v.dashboards.map((d) => d.name)).toEqual(names.slice(0, 8));
    expect(v.order).toEqual(['home', ...names.slice(0, 8)]);
  });

  it('normalises home: label trimmed, empty account absent', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [], home: { label: '  Max  ', account: '   ', models: ['opus', 'gpt'] } }));
    const v = (readDashboardsFile(file) as { value: DashboardsFile }).value;
    expect(v.home).toEqual({ label: 'Max' });
  });

  it('a home label over 24 characters is dropped', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [], home: { label: 'x'.repeat(25), account: 'Max x5' } }));
    expect((readDashboardsFile(file) as { value: DashboardsFile }).value.home).toEqual({ account: 'Max x5' });
  });

  it('reads order with unknown ids dropped and missing ones appended, home first', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [entry('Pro'), entry('Studio')], order: ['Pro', 'ghost'] }));
    const v = (readDashboardsFile(file) as { value: DashboardsFile }).value;
    expect(v.order).toEqual(['Pro', 'home', 'Studio']);
  });

  it('is read per call: an edit between reads is seen', () => {
    writeFileSync(file, JSON.stringify({ dashboards: [], threshold: 10 }));
    expect((readDashboardsFile(file) as { value: DashboardsFile }).value.threshold).toBe(10);
    writeFileSync(file, JSON.stringify({ dashboards: [], threshold: 20 }));
    expect((readDashboardsFile(file) as { value: DashboardsFile }).value.threshold).toBe(20);
  });
});

describe('normaliseOrder', () => {
  it('drops unknown, appends missing in configured order with home first', () => {
    expect(normaliseOrder(['Pro', 'ghost'], ['Pro', 'Studio'])).toEqual(['Pro', 'home', 'Studio']);
  });
  it('absent order is home then configured', () => {
    expect(normaliseOrder(undefined, ['Pro', 'Studio'])).toEqual(['home', 'Pro', 'Studio']);
  });
  it('holds each id exactly once', () => {
    expect(normaliseOrder(['Pro', 'Pro', 'home', 'home'], ['Pro'])).toEqual(['Pro', 'home']);
  });
  it('home alone when nothing is configured', () => {
    expect(normaliseOrder(['x'], [])).toEqual(['home']);
  });
});

describe('validateEntry', () => {
  it('accepts a full entry and stores origins', () => {
    expect(
      validateEntry({
        ...entry('Pro'),
        url: 'https://a.ts.net:4173/x?y',
        bmUrl: 'http://b.ts.net:4322/#z',
        account: ' Pro ',
        models: ['opus'],
        efforts: ['low']
      })
    ).toEqual({
      name: 'Pro',
      url: 'https://a.ts.net:4173',
      bmUrl: 'http://b.ts.net:4322',
      host: 'pro-mac',
      account: 'Pro',
      models: ['opus'],
      efforts: ['low']
    });
  });
  it('url path and query are dropped', () => {
    const r = validateEntry({ ...entry('Pro'), url: 'https://a.ts.net:4173/x?y' });
    expect((r as { url: string }).url).toBe('https://a.ts.net:4173');
  });
  it('rejects a name that does not match the rule', () => {
    expect(validateEntry({ ...entry('Pro'), name: '2pro' })).toBe('name must match ^[A-Za-z][A-Za-z0-9]{0,23}$');
  });
  it('rejects a name over 24 characters', () => {
    expect(validateEntry({ ...entry('Pro'), name: 'A'.repeat(25) })).toBe('name must match ^[A-Za-z][A-Za-z0-9]{0,23}$');
  });
  it('reserves home in any case', () => {
    expect(validateEntry({ ...entry('Pro'), name: 'HOME' })).toBe('name "home" is reserved');
  });
  it('rejects a non-http(s) url', () => {
    expect(validateEntry({ ...entry('Pro'), url: 'ftp://a' })).toBe('url must be an http(s) origin');
  });
  it('rejects a non-http(s) bmUrl', () => {
    expect(validateEntry({ ...entry('Pro'), bmUrl: 'not a url' })).toBe('bmUrl must be an http(s) origin');
  });
  it('rejects a host with whitespace', () => {
    expect(validateEntry({ ...entry('Pro'), host: 'a b' })).toBe('host must be 1–64 characters with no whitespace');
  });
  it('stores the name as the host when host is absent, null, empty or whitespace', () => {
    const { host: _host, ...noHost } = entry('Pro');
    for (const body of [noHost, { ...noHost, host: null }, { ...noHost, host: '' }, { ...noHost, host: '  ' }])
      expect((validateEntry(body) as { host: string }).host).toBe('Pro');
  });
  it('stores the dashboard host on http :5177 as bmUrl when bmUrl is absent, null, empty or whitespace — an https url too', () => {
    const { bmUrl: _bmUrl, ...noBoard } = entry('Pro');
    for (const body of [noBoard, { ...noBoard, bmUrl: null }, { ...noBoard, bmUrl: '' }, { ...noBoard, bmUrl: ' ' }])
      expect((validateEntry(body) as { bmUrl: string }).bmUrl).toBe('http://pro.ts.net:5177');
    expect((validateEntry({ ...noBoard, url: 'http://[fd7a::1]:4173' }) as { bmUrl: string }).bmUrl).toBe('http://[fd7a::1]:5177');
  });
  it('name + url alone is a whole entry', () => {
    expect(validateEntry({ name: 'Pro', url: 'http://pro.tail1.ts.net:4173' })).toEqual({
      name: 'Pro',
      url: 'http://pro.tail1.ts.net:4173',
      bmUrl: 'http://pro.tail1.ts.net:5177',
      host: 'Pro'
    });
  });
  it('an explicit bmUrl or host still wins over its default', () => {
    expect(validateEntry({ name: 'Pro', url: 'http://a:4173', bmUrl: 'http://b:6000', host: 'pro-mac' })).toMatchObject({
      bmUrl: 'http://b:6000',
      host: 'pro-mac'
    });
  });
  it('rejects a model outside the list', () => {
    expect(validateEntry({ ...entry('Pro'), models: ['gpt'] })).toBe('models must be a non-empty subset of opus, sonnet, haiku, fable');
  });
  it('rejects an empty models list', () => {
    expect(validateEntry({ ...entry('Pro'), models: [] })).toBe('models must be a non-empty subset of opus, sonnet, haiku, fable');
  });
  it('rejects an effort outside the list', () => {
    expect(validateEntry({ ...entry('Pro'), efforts: ['extreme'] })).toBe('efforts must be a non-empty subset of low, medium, high, xhigh, max');
  });
  it('rejects an account over 40 characters', () => {
    expect(validateEntry({ ...entry('Pro'), account: 'a'.repeat(41) })).toBe('account must be at most 40 characters');
  });
  it('rejects a body that is not an object', () => {
    expect(validateEntry(null)).toBe('entry must be an object');
    expect(validateEntry([])).toBe('entry must be an object');
  });
});

describe('writeDashboardsFile', () => {
  it('round-trips and leaves no temp file', () => {
    const next: DashboardsFile = {
      home: { label: 'Max', account: 'Max x5' },
      dashboards: [validateEntry(entry('Pro')) as never],
      order: ['Pro', 'home'],
      strategy: 'headroom',
      threshold: 60
    };
    writeDashboardsFile(next, file);
    const r = readDashboardsFile(file);
    expect(r).toEqual({ source: 'file', value: next, raw: JSON.parse(JSON.stringify(next)) });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the directory', () => {
    const nested = join(dir, 'a', 'b', 'dashboards.json');
    writeDashboardsFile({ dashboards: [], strategy: 'prefer', threshold: 80 }, nested);
    expect(readDashboardsFile(nested).source).toBe('file');
  });

  it('removes its temp file and rethrows when the rename fails', () => {
    failRename = true;
    try {
      expect(() => writeDashboardsFile({ dashboards: [], strategy: 'prefer', threshold: 80 }, file)).toThrow('boom');
    } finally {
      failRename = false;
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses over an unreadable file and leaves its bytes unchanged', () => {
    writeFileSync(file, '{ not json');
    expect(() => writeDashboardsFile({ dashboards: [], strategy: 'prefer', threshold: 80 }, file)).toThrow(DashboardsFileUnreadable);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(readdirSync(dir)).toEqual(['dashboards.json']);
  });
});
