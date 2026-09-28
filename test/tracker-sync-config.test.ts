import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { intervalFor, readSyncConfig, syncConfigFile, writeSyncInterval } from '../server/src/tracker/sync-config.util';
import { DEFAULT_SYNC_INTERVAL, SYNC_INTERVALS, isSyncInterval } from '../shared/types';

// Every case points BM_TRACKER_SYNC_FILE at a fresh path under its own temp
// directory, and the `settings/` level in it does not exist until a write makes
// it — the production file's parent is a nested mount that a fresh install has
// not created either. Spec §4's table is the list below, one case per row.

let dir: string;
let file: string;
const saved = process.env.BM_TRACKER_SYNC_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-sync-config-'));
  file = join(dir, 'settings', 'tracker-sync.json');
  process.env.BM_TRACKER_SYNC_FILE = file;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BM_TRACKER_SYNC_FILE;
  else process.env.BM_TRACKER_SYNC_FILE = saved;
});

function put(text: string): void {
  writeSyncInterval('seed/seed', '15s'); // creates settings/, then overwrite it raw
  writeFileSync(file, text);
}

describe('SYNC_INTERVALS', () => {
  it('is the four tokens, in picker order, with their milliseconds', () => {
    expect(Object.keys(SYNC_INTERVALS)).toEqual(['15s', '1m', '5m', 'off']);
    expect(Object.values(SYNC_INTERVALS)).toEqual([15000, 60000, 300000, null]);
    expect(DEFAULT_SYNC_INTERVAL).toBe('15s');
  });

  it('isSyncInterval accepts exactly the four tokens', () => {
    for (const t of ['15s', '1m', '5m', 'off']) expect(isSyncInterval(t)).toBe(true);
    for (const v of ['15', '1M', 15000, null, undefined, 'toString', '__proto__']) expect(isSyncInterval(v)).toBe(false);
  });
});

describe('syncConfigFile', () => {
  it('honours BM_TRACKER_SYNC_FILE, else lands under ~/.backlog-manager/settings/', () => {
    expect(syncConfigFile()).toBe(file);
    expect(syncConfigFile({})).toMatch(/\.backlog-manager[/\\]settings[/\\]tracker-sync\.json$/);
  });
});

describe('reading', () => {
  it('a missing file reads every repo as 15s and the config as empty', () => {
    expect(intervalFor('a/b')).toBe('15s');
    expect(readSyncConfig()).toEqual({});
  });

  it('a file that is not JSON reads as 15s, without throwing', () => {
    put('not json');
    expect(intervalFor('a/b')).toBe('15s');
    expect(readSyncConfig()).toEqual({});
  });

  it.each([['[]'], ['null'], ['"15s"']])('a JSON value that is not an object (%s) reads as 15s', (text) => {
    put(text);
    expect(intervalFor('a/b')).toBe('15s');
    expect(readSyncConfig()).toEqual({});
  });

  it('a bad value reads 15s for that repo only, and is left out of the config', () => {
    put('{"a/b":"off","c/d":"2m"}');
    expect(intervalFor('a/b')).toBe('off');
    expect(intervalFor('c/d')).toBe('15s');
    expect(readSyncConfig()).toEqual({ 'a/b': 'off' });
  });

  it('keys match by exact string — a wrong-case key is not the repo (Review Focus 5)', () => {
    put('{"Futin/Guide-Manager":"off"}');
    expect(intervalFor('futin/guide-manager')).toBe('15s');
    // and reading never rewrites the file
    expect(readFileSync(file, 'utf8')).toBe('{"Futin/Guide-Manager":"off"}');
  });

  it('is read fresh on every call, never cached', () => {
    writeSyncInterval('a/b', '1m');
    expect(intervalFor('a/b')).toBe('1m');
    writeFileSync(file, '{"a/b":"5m"}');
    expect(intervalFor('a/b')).toBe('5m');
  });
});

describe('writing', () => {
  it('creates the file and its settings/ directory when both are missing', () => {
    expect(existsSync(join(dir, 'settings'))).toBe(false);
    writeSyncInterval('a/b', '5m');
    expect(intervalFor('a/b')).toBe('5m');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'a/b': '5m' });
  });

  it('keeps every key it did not write — a disconnected repo, a wrong-case key', () => {
    put('{"gone/repo":"off","Futin/X":"1m"}');
    writeSyncInterval('a/b', '1m');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'gone/repo': 'off', 'Futin/X': '1m', 'a/b': '1m' });
  });

  it('a write over a malformed file replaces it with the written key alone', () => {
    put('not json');
    writeSyncInterval('a/b', 'off');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'a/b': 'off' });
  });

  it('leaves no temp file beside the target', () => {
    writeSyncInterval('a/b', '1m');
    writeSyncInterval('a/b', 'off');
    expect(readdirSync(join(dir, 'settings'))).toEqual(['tracker-sync.json']);
  });
});
