import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JIRA_ID_RE, JIRA_JQL_MAX_CHARS, JIRA_PROJECT_KEY_RE, isJiraId, jiraConfigFile, readJiraConfig } from '../server/src/jira/config.util';

// Spec §2: jira.json is read per ENTRY. Every case writes its own file under a fresh temp directory and hands the path to the reader, so nothing here depends
// on (or can touch) the real ~/.backlog-manager/settings/jira.json. The reader warns once per dropped entry; each case that expects drops silences and counts
// that warning rather than letting it litter the run.

let dir: string;
let file: string;
let warn: jest.SpyInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-config-'));
  file = join(dir, 'jira.json');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const EMPTY = { boards: [], repos: {}, repoDefaults: {}, skills: [], unreadable: null };

function put(value: unknown): void {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const validBoard = {
  id: 'b_0123abcd',
  name: 'Sprint 42',
  roots: ['PAY-120'],
  queries: [{ id: 'q_0123abcd', label: 'mine', jql: 'assignee = currentUser()' }],
  interval: '1m'
};

describe('readJiraConfig — the file as a whole', () => {
  it('reads a missing file as empty, not unreadable', () => {
    expect(readJiraConfig(file)).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads {} and a file with only unknown keys as empty', () => {
    put({});
    expect(readJiraConfig(file)).toEqual(EMPTY);
    put({ boards: [], other: 1 });
    expect(readJiraConfig(file)).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a full valid file back equal, arrays in file order', () => {
    const repos = { PAY: ['/w/payments-api', '/w/payments-web'] };
    const skills = [{ id: 's_0123abcd', name: 'Groom', prompt: '/jira-groom {key}' }];
    put({ boards: [validBoard], repos, skills });
    expect(readJiraConfig(file)).toEqual({ boards: [validBoard], repos, repoDefaults: {}, skills, unreadable: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a file that changed between two reads as the second content — cached nowhere', () => {
    put({ skills: [{ id: 's_0123abcd', name: 'one', prompt: 'p' }] });
    expect(readJiraConfig(file).skills.map((s) => s.name)).toEqual(['one']);
    put({ skills: [{ id: 's_0123abcd', name: 'two', prompt: 'p' }] });
    expect(readJiraConfig(file).skills.map((s) => s.name)).toEqual(['two']);
  });
});

describe('readJiraConfig — unreadable', () => {
  it('reports a file that does not parse, with no boards', () => {
    put('{not json');
    expect(readJiraConfig(file)).toEqual({ ...EMPTY, unreadable: 'does not parse as JSON' });
  });

  it('reports a path that cannot be read (a directory)', () => {
    mkdirSync(file);
    expect(readJiraConfig(file)).toEqual({ ...EMPTY, unreadable: 'cannot be read' });
  });

  it('folds a parsed non-object into nothing, not into unreadable — the writers replace it the way writeSyncInterval does', () => {
    put([1, 2]);
    expect(readJiraConfig(file)).toEqual(EMPTY);
    put('null');
    expect(readJiraConfig(file)).toEqual(EMPTY);
    put('"x"');
    expect(readJiraConfig(file)).toEqual(EMPTY);
  });
});

describe('readJiraConfig — boards', () => {
  it('drops a bad entry and keeps its neighbours, defaulting an unknown or missing interval', () => {
    put({
      boards: [
        validBoard,
        { id: 'b_x', name: 'bad id' },
        'a string',
        null,
        { id: 'b_0000ffff', name: '', roots: [] },
        { id: 'b_0000aaaa', name: 'no interval', roots: ['PAY-1'], queries: [] },
        { ...validBoard, id: 'b_0000bbbb', interval: '2h' }
      ]
    });
    const { boards } = readJiraConfig(file);
    expect(boards.map((b) => [b.id, b.interval])).toEqual([
      ['b_0123abcd', '1m'],
      ['b_0000aaaa', '1m'],
      ['b_0000bbbb', '1m']
    ]);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('keeps a valid interval other than the default', () => {
    put({ boards: [{ ...validBoard, interval: '15s' }] });
    expect(readJiraConfig(file).boards[0].interval).toBe('15s');
  });

  it('drops a bad root or query and keeps its board, even when both lists end empty', () => {
    put({
      boards: [
        {
          ...validBoard,
          roots: ['PAY-1', 'pay-2', 7, 'PAY-3'],
          queries: [
            { id: 'q_0123abcd', label: 'ok', jql: 'x' },
            { id: 'q_1', label: 'bad id', jql: 'x' },
            { id: 'q_0123abce', label: '', jql: 'x' },
            { id: 'q_0123abcf', label: 'no jql' }
          ]
        },
        { id: 'b_0000cccc', name: 'all bad', roots: ['nope'], queries: [{}] }
      ]
    });
    const { boards } = readJiraConfig(file);
    expect(boards[0].roots).toEqual(['PAY-1', 'PAY-3']);
    expect(boards[0].queries).toEqual([{ id: 'q_0123abcd', label: 'ok', jql: 'x' }]);
    expect(boards[1]).toEqual({ id: 'b_0000cccc', name: 'all bad', roots: [], queries: [], interval: '1m' });
  });

  it('reads a board whose roots or queries are missing or not arrays as having none', () => {
    put({ boards: [{ id: 'b_0000dddd', name: 'bare' }, { id: 'b_0000eeee', name: 'odd', roots: 'PAY-1', queries: {} }] });
    expect(readJiraConfig(file).boards.map((b) => [b.roots, b.queries])).toEqual([
      [[], []],
      [[], []]
    ]);
  });

  it('reads a non-array "boards" as none and still reads the rest of the file — one bad key never costs the others', () => {
    put({ boards: {}, repos: { PAY: ['/a'] }, skills: [{ id: 's_0123abcd', name: 'ok', prompt: 'p' }] });
    const config = readJiraConfig(file);
    expect(config.boards).toEqual([]);
    expect(config.unreadable).toBeNull();
    expect(config.repos).toEqual({ PAY: ['/a'] });
    expect(config.skills).toHaveLength(1);
  });
});

describe('readJiraConfig — repos', () => {
  it('dedups, drops bad keys, non-arrays, non-string and empty paths, and emptied lists', () => {
    put({ repos: { PAY: ['/a', '/a', '/b'], 'bad key': ['/x'], OPS: '/y', AM: ['/z', 7, ''], EMPTY: [] } });
    expect(readJiraConfig(file).repos).toEqual({ PAY: ['/a', '/b'], AM: ['/z'] });
  });

  it('skips __proto__ as a key without touching the result prototype', () => {
    put('{ "repos": { "__proto__": ["/evil"], "PAY": ["/a"] } }');
    const { repos } = readJiraConfig(file);
    expect(repos).toEqual({ PAY: ['/a'] });
    expect(Object.getPrototypeOf(repos)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(repos, '__proto__')).toBe(false);
  });

  it('reads an array "repos" as none', () => {
    put({ repos: [] });
    expect(readJiraConfig(file).repos).toEqual({});
  });
});

describe('readJiraConfig — repoDefaults', () => {
  it('keeps a path with a base and a pattern, and one with only one of them', () => {
    const repoDefaults = {
      '/r': { base: 'develop', namePattern: 'feature/{key}-{slug}' },
      '/only-base': { base: 'release/1.2' },
      '/only-pattern': { namePattern: '{KEY}_{slug}' }
    };
    put({ repoDefaults });
    expect(readJiraConfig(file).repoDefaults).toEqual(repoDefaults);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops an entry whose key is not an absolute normalised path, warning once each', () => {
    put({
      repoDefaults: {
        relative: { base: 'develop' },
        '~/home': { base: 'develop' },
        '/a/': { base: 'develop' },
        '/a//b': { base: 'develop' },
        '/a/../b': { base: 'develop' },
        '/keep': { base: 'develop' }
      }
    });
    expect(readJiraConfig(file).repoDefaults).toEqual({ '/keep': { base: 'develop' } });
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it('drops a pattern that fails Table E but keeps that entry\'s valid base, and the reverse', () => {
    put({ repoDefaults: { '/a': { base: 'develop', namePattern: '{slug}' }, '/b': { base: '-x', namePattern: '{key}-{slug}' } } });
    expect(readJiraConfig(file).repoDefaults).toEqual({ '/a': { base: 'develop' }, '/b': { namePattern: '{key}-{slug}' } });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops an entry left with no value, and one that is not an object, and a non-string value', () => {
    put({ repoDefaults: { '/a': { base: 'a b' }, '/b': 'develop', '/c': [], '/d': { base: 7, namePattern: null }, '/e': {}, '/f': { base: 'ok' } } });
    expect(readJiraConfig(file).repoDefaults).toEqual({ '/f': { base: 'ok' } });
  });

  it('skips __proto__ without touching the result prototype, and reads a non-object repoDefaults as none', () => {
    put('{ "repoDefaults": { "__proto__": { "base": "x" }, "/a": { "base": "develop" } } }');
    const { repoDefaults } = readJiraConfig(file);
    expect(repoDefaults).toEqual({ '/a': { base: 'develop' } });
    expect(Object.getPrototypeOf(repoDefaults)).toBe(Object.prototype);
    put({ repoDefaults: [] });
    expect(readJiraConfig(file).repoDefaults).toEqual({});
    put({ repoDefaults: 'x' });
    expect(readJiraConfig(file).repoDefaults).toEqual({});
  });

  it('is empty, not an error, for an unreadable file', () => {
    put('{ nope');
    expect(readJiraConfig(file)).toMatchObject({ repoDefaults: {}, unreadable: 'does not parse as JSON' });
  });
});

describe('readJiraConfig — skills', () => {
  it('keeps only a skill with a valid id, a name and a prompt, and reads a non-array as none', () => {
    put({
      skills: [
        { id: 's_0123abcd', name: 'ok', prompt: 'p' },
        { id: 's_0123abce', name: 'no prompt' },
        { id: 's_0123abcf', name: '', prompt: 'p' },
        { id: 'b_0123abcf', name: 'wrong kind', prompt: 'p' }
      ]
    });
    expect(readJiraConfig(file).skills).toEqual([{ id: 's_0123abcd', name: 'ok', prompt: 'p' }]);
    put({ skills: 'x' });
    expect(readJiraConfig(file).skills).toEqual([]);
  });
});

describe('jiraConfigFile', () => {
  it('is BM_JIRA_FILE when set, else the settings file under the home directory', () => {
    expect(jiraConfigFile({ BM_JIRA_FILE: '/x/y.json' })).toBe('/x/y.json');
    expect(jiraConfigFile({})).toMatch(/\/\.backlog-manager\/settings\/jira\.json$/);
  });
});

describe('ids and keys', () => {
  it('isJiraId checks the prefix against the kind, so a q_ or s_ id never passes as a board id', () => {
    expect(isJiraId('b', 'b_0123abcd')).toBe(true);
    expect(isJiraId('q', 'q_0123abcd')).toBe(true);
    expect(isJiraId('s', 's_0123abcd')).toBe(true);
    expect(isJiraId('b', 'q_0123abcd')).toBe(false);
    expect(isJiraId('b', 's_0123abcd')).toBe(false);
    expect(isJiraId('q', 'b_0123abcd')).toBe(false);
    expect(isJiraId('s', 'b_0123abcd')).toBe(false);
  });

  it('isJiraId rejects the wrong shape and any non-string', () => {
    for (const bad of ['b_0123ABCD', 'b_0123abc', 'b_0123abcde', 'b_0123abcg', 'b0123abcd', ' b_0123abcd', 'b_0123abcd\n', '', 7, null, undefined, {}]) {
      expect(isJiraId('b', bad)).toBe(false);
    }
    expect(JIRA_ID_RE.test('x_0123abcd')).toBe(false);
  });

  it('JIRA_PROJECT_KEY_RE is an upper-case key of two characters or more', () => {
    for (const ok of ['PAY', 'AM', 'A1', 'P_1']) expect(JIRA_PROJECT_KEY_RE.test(ok)).toBe(true);
    for (const bad of ['A', 'pay', '1AB', 'PAY-1', 'bad key', '']) expect(JIRA_PROJECT_KEY_RE.test(bad)).toBe(false);
  });

  it('JIRA_JQL_MAX_CHARS is the one home of the JQL length cap', () => {
    expect(JIRA_JQL_MAX_CHARS).toBe(2000);
  });
});
