import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JIRA_JQL_MAX_CHARS,
  JiraConfigUnreadableError,
  JiraUnknownIdError,
  deleteBoard,
  deleteSkill,
  isJiraId,
  mintJiraId,
  normaliseRepoPath,
  parseBoardWrite,
  parseReposWrite,
  parseSkillWrite,
  readJiraConfig,
  writeBoard,
  writeRepos,
  writeSkill,
  type JiraBoardWrite
} from '../server/src/jira/config.util';

// jira.json's writers (phase 2, task 1), on `writeSyncInterval`'s contract: read the RAW file, merge ONE entry, keep everything else byte-for-byte in meaning,
// temp file plus rename — and refuse, leaving the file exactly as it was, when it exists and cannot be read. Every case works on its own temp file and hands the
// path to the writer, so nothing here can touch the real ~/.backlog-manager/settings/jira.json. The reader warns once per entry it drops; the suite silences that.

let dir: string;
let file: string;
let warn: jest.SpyInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-jira-write-'));
  file = join(dir, 'jira.json');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function put(value: unknown): void {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function parsed(): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const b1 = { id: 'b_11111111', name: 'One', roots: ['AAA-1'], queries: [], interval: '1m' };
const b2 = {
  id: 'b_22222222',
  name: 'Two',
  roots: ['BBB-2'],
  queries: [
    { id: 'q_aaaaaaaa', label: 'A', jql: 'a = 1' },
    { id: 'q_bbbbbbbb', label: 'B', jql: 'b = 2' }
  ],
  interval: '5m'
};

function input(over: Partial<JiraBoardWrite> = {}): JiraBoardWrite {
  return { id: null, name: 'Payments', roots: ['PAY-1'], queries: [], interval: '1m', ...over };
}

describe('parseBoardWrite', () => {
  const valid = { name: 'Payments', roots: ['PAY-1'], queries: [{ label: 'mine', jql: 'assignee = currentUser()' }], interval: '15s' };

  function bad(over: Record<string, unknown>, field: string): void {
    const r = parseBoardWrite({ ...valid, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  }

  it('round-trips a valid body, trimmed', () => {
    const r = parseBoardWrite({
      ...valid,
      name: '  Payments  ',
      roots: ['  PAY-1 '],
      queries: [{ id: 'q_deadbeef', label: ' mine ', jql: ' project = PAY ' }]
    });
    expect(r).toEqual({
      ok: true,
      value: { id: null, name: 'Payments', roots: ['PAY-1'], queries: [{ id: 'q_deadbeef', label: 'mine', jql: 'project = PAY' }], interval: '15s' }
    });
  });

  it('refuses a bad name, naming the field', () => {
    bad({ name: '' }, 'name');
    bad({ name: '   ' }, 'name');
    bad({ name: 'x'.repeat(81) }, 'name');
    expect(parseBoardWrite({ ...valid, name: 'x'.repeat(80) }).ok).toBe(true);
    expect(parseBoardWrite({ ...valid, name: undefined }).ok).toBe(false);
  });

  it('refuses an interval that is not a token', () => {
    bad({ interval: '2m' }, 'interval');
    bad({ interval: undefined }, 'interval');
  });

  it('refuses more than 20 roots and a root that is not an issue key', () => {
    bad({ roots: Array.from({ length: 21 }, (_, i) => `PAY-${i + 1}`) }, 'roots');
    expect(parseBoardWrite({ ...valid, roots: Array.from({ length: 20 }, (_, i) => `PAY-${i + 1}`) }).ok).toBe(true);
    bad({ roots: ['pay-1'] }, 'roots');
    bad({ roots: [7] }, 'roots');
    bad({ roots: 'PAY-1' }, 'roots');
  });

  it('reads a repeated root as one', () => {
    const r = parseBoardWrite({ ...valid, roots: ['PAY-1', 'PAY-1'] });
    expect(r.ok && r.value.roots).toEqual(['PAY-1']);
  });

  it('refuses more than 10 queries, an empty or long label, an empty or long jql', () => {
    const q = { label: 'l', jql: 'j' };
    bad({ queries: Array.from({ length: 11 }, () => q) }, 'queries');
    expect(parseBoardWrite({ ...valid, queries: Array.from({ length: 10 }, () => q) }).ok).toBe(true);
    bad({ queries: [{ label: '', jql: 'j' }] }, 'label');
    bad({ queries: [{ label: 'x'.repeat(81), jql: 'j' }] }, 'label');
    bad({ queries: [{ label: 'l', jql: '' }] }, 'jql');
    bad({ queries: [{ label: 'l', jql: 'j'.repeat(JIRA_JQL_MAX_CHARS + 1) }] }, 'jql');
    expect(parseBoardWrite({ ...valid, queries: [{ label: 'l', jql: 'j'.repeat(JIRA_JQL_MAX_CHARS) }] }).ok).toBe(true);
    bad({ queries: [null] }, 'queries');
  });

  it('refuses a board with no root and no query', () => {
    bad({ roots: [], queries: [] }, 'roots');
    expect(parseBoardWrite({ name: 'x', interval: '1m' }).ok).toBe(false);
    expect(parseBoardWrite({ name: 'x', interval: '1m', roots: ['PAY-1'] }).ok).toBe(true);
    expect(parseBoardWrite({ name: 'x', interval: '1m', queries: [{ label: 'l', jql: 'j' }] }).ok).toBe(true);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'x', 7, undefined]) expect(parseBoardWrite(body).ok).toBe(false);
  });

  it('keeps an id as given, and refuses one that is not a string or null', () => {
    const r = parseBoardWrite({ ...valid, id: 'b_0000000z' });
    expect(r.ok && r.value.id).toBe('b_0000000z');
    const n = parseBoardWrite({ ...valid, id: null });
    expect(n.ok && n.value.id).toBeNull();
    bad({ id: 7 }, 'id');
    bad({ id: {} }, 'id');
    bad({ id: true }, 'id');
  });
});

describe('writeBoard', () => {
  it('creates the file with one board and fresh ids, and returns what the reader reads', () => {
    const board = writeBoard(input({ queries: [{ id: 'q_deadbeef', label: 'mine', jql: 'x = 1' }] }), file);
    expect(board.id).toMatch(/^b_[0-9a-f]{8}$/);
    expect(board.queries[0].id).toMatch(/^q_[0-9a-f]{8}$/);
    expect(board.queries[0].id).not.toBe('q_deadbeef');
    expect(parsed().boards).toHaveLength(1);
    expect(readJiraConfig(file).boards[0]).toEqual(board);
  });

  it('ignores a client id on create', () => {
    const board = writeBoard(input({ id: null }), file);
    expect(readJiraConfig(file).boards.map((b) => b.id)).toEqual([board.id]);
  });

  it('updates in place: keeps a held query id, mints for the rest, drops the unsent one, and keeps the position', () => {
    put({ boards: [b1, b2] });
    const board = writeBoard(
      input({
        id: 'b_22222222',
        name: 'Two!',
        queries: [
          { id: 'q_bbbbbbbb', label: 'B2', jql: 'b = 2' },
          { id: null, label: 'C', jql: 'c = 3' },
          { id: 'q_cccccccc', label: 'D', jql: 'd = 4' }
        ]
      }),
      file
    );
    expect(board.id).toBe('b_22222222');
    expect(board.queries.map((q) => q.label)).toEqual(['B2', 'C', 'D']);
    expect(board.queries[0].id).toBe('q_bbbbbbbb');
    expect(isJiraId('q', board.queries[1].id)).toBe(true);
    expect(isJiraId('q', board.queries[2].id)).toBe(true);
    expect(board.queries[2].id).not.toBe('q_cccccccc');
    expect(board.queries.map((q) => q.id)).not.toContain('q_aaaaaaaa');
    expect(new Set(board.queries.map((q) => q.id)).size).toBe(3);
    const boards = parsed().boards as { id: string; name: string }[];
    expect(boards.map((b) => b.id)).toEqual(['b_11111111', 'b_22222222']);
    expect(boards[0]).toEqual(b1);
    expect(boards[1].name).toBe('Two!');
  });

  it('gives a second query that repeats a held id a new one', () => {
    put({ boards: [b2] });
    const board = writeBoard(
      input({
        id: 'b_22222222',
        queries: [
          { id: 'q_aaaaaaaa', label: 'A', jql: 'a' },
          { id: 'q_aaaaaaaa', label: 'A again', jql: 'a' }
        ]
      }),
      file
    );
    expect(board.queries[0].id).toBe('q_aaaaaaaa');
    expect(board.queries[1].id).not.toBe('q_aaaaaaaa');
  });

  it('preserves malformed entries, repos, skills and unknown keys, in order', () => {
    const extra = { repos: { PAY: ['/a'] }, skills: [{ id: 's_00000001', name: 'n', prompt: 'p' }], note: 'mine' };
    put({ boards: [b1, { id: 7 }, b2], ...extra });
    writeBoard(input({ id: 'b_22222222', name: 'Renamed' }), file);
    const after = parsed();
    const boards = after.boards as Record<string, unknown>[];
    expect(boards[0]).toEqual(b1);
    expect(boards[1]).toEqual({ id: 7 });
    expect(boards[2].id).toBe('b_22222222');
    expect(boards[2].name).toBe('Renamed');
    expect(after.repos).toEqual(extra.repos);
    expect(after.skills).toEqual(extra.skills);
    expect(after.note).toBe('mine');
  });

  it('replaces a boards key that is an object on create and keeps the other keys', () => {
    put({ boards: {}, repos: { PAY: ['/a'] } });
    const board = writeBoard(input(), file);
    const after = parsed();
    expect(after.boards).toEqual([board]);
    expect(after.repos).toEqual({ PAY: ['/a'] });
  });

  it('refuses an update naming an id the file does not hold, leaving the file byte-identical', () => {
    put({ boards: [b1] });
    const before = readFileSync(file, 'utf8');
    expect(() => writeBoard(input({ id: 'b_12345678' }), file)).toThrow(JiraUnknownIdError);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes nothing for an update against a missing file', () => {
    expect(() => writeBoard(input({ id: 'b_12345678' }), file)).toThrow(JiraUnknownIdError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a file that does not parse, byte-identical, and a path that is a directory', () => {
    put('{ "boards": [');
    const before = readFileSync(file, 'utf8');
    expect(() => writeBoard(input(), file)).toThrow(JiraConfigUnreadableError);
    expect(() => writeBoard(input({ id: 'b_11111111' }), file)).toThrow(JiraConfigUnreadableError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const asDir = join(dir, 'a-directory');
    mkdirSync(asDir);
    expect(() => writeBoard(input(), asDir)).toThrow(JiraConfigUnreadableError);
    expect(() => writeBoard(input(), asDir)).toThrow(/fix or delete it by hand; nothing was written/);
  });

  it('replaces a parsed non-object with a file holding only the entry', () => {
    put([1, 2]);
    const board = writeBoard(input(), file);
    expect(parsed()).toEqual({ boards: [board] });
  });

  it('leaves no temp file behind, and creates a missing directory', () => {
    const nested = join(dir, 'settings', 'jira.json');
    writeBoard(input(), nested);
    expect(readdirSync(join(dir, 'settings'))).toEqual(['jira.json']);
    writeBoard(input({ name: 'Again' }), nested);
    expect(readdirSync(join(dir, 'settings')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('deleteBoard', () => {
  it('removes every entry holding the id, keeping the rest in order', () => {
    put({ boards: [b1, { id: 7 }, b2, { ...b2, name: 'dup' }], repos: { PAY: ['/a'] } });
    deleteBoard('b_22222222', file);
    const after = parsed();
    expect(after.boards).toEqual([b1, { id: 7 }]);
    expect(after.repos).toEqual({ PAY: ['/a'] });
  });

  it('refuses an unknown id and an unreadable file, byte-identical', () => {
    put({ boards: [b1] });
    const before = readFileSync(file, 'utf8');
    expect(() => deleteBoard('b_12345678', file)).toThrow(JiraUnknownIdError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    put('{ "boards": [');
    const bad = readFileSync(file, 'utf8');
    expect(() => deleteBoard('b_11111111', file)).toThrow(JiraConfigUnreadableError);
    expect(readFileSync(file, 'utf8')).toBe(bad);
  });
});

const sk1 = { id: 's_00000001', name: 'Review', prompt: 'Review {key}' };
const sk2 = { id: 's_00000002', name: 'Ship', prompt: 'Ship {key}: {summary}' };

describe('parseSkillWrite', () => {
  it('round-trips a valid body, trimmed, and keeps an id as given', () => {
    expect(parseSkillWrite({ name: '  Review  ', prompt: '  Review {key}\n' })).toEqual({ ok: true, value: { name: 'Review', prompt: 'Review {key}' } });
    expect(parseSkillWrite({ id: 's_00000001', name: 'n', prompt: 'p' })).toEqual({ ok: true, value: { id: 's_00000001', name: 'n', prompt: 'p' } });
    expect(parseSkillWrite({ id: null, name: 'n', prompt: 'p' })).toEqual({ ok: true, value: { name: 'n', prompt: 'p' } });
  });

  it('refuses a name that is empty, blank or over 60 trimmed characters, naming name, and takes exactly 60', () => {
    for (const name of ['', '   ', 'x'.repeat(61), 7, undefined]) {
      const r = parseSkillWrite({ name, prompt: 'p' });
      expect(r).toEqual({ ok: false, error: expect.stringContaining('name') });
    }
    expect(parseSkillWrite({ name: 'x'.repeat(60), prompt: 'p' }).ok).toBe(true);
    expect(parseSkillWrite({ name: `  ${'x'.repeat(60)}  `, prompt: 'p' }).ok).toBe(true);
  });

  it('refuses a prompt that is empty, blank or over 2 000 trimmed characters, naming prompt, and takes exactly 2 000', () => {
    for (const prompt of ['', '   ', 'x'.repeat(2001), 7, undefined]) {
      const r = parseSkillWrite({ name: 'n', prompt });
      expect(r).toEqual({ ok: false, error: expect.stringContaining('prompt') });
    }
    expect(parseSkillWrite({ name: 'n', prompt: 'x'.repeat(2000) }).ok).toBe(true);
  });

  it('refuses a body that is not an object, and an id that is not a string or null, naming id', () => {
    expect(parseSkillWrite([])).toEqual({ ok: false, error: expect.stringContaining('object') });
    expect(parseSkillWrite(null).ok).toBe(false);
    expect(parseSkillWrite({ id: 7, name: 'n', prompt: 'p' })).toEqual({ ok: false, error: expect.stringContaining('id') });
  });
});

describe('writeSkill', () => {
  it('creates the file with one skill and a minted s_ id, trimmed, and returns what the reader reads', () => {
    const skill = writeSkill({ name: 'Review', prompt: 'Review {key}' }, file);
    expect(skill).toEqual({ id: expect.stringMatching(/^s_[0-9a-f]{8}$/), name: 'Review', prompt: 'Review {key}' });
    expect(parsed()).toEqual({ skills: [skill] });
    expect(readJiraConfig(file).skills).toEqual([skill]);
  });

  it('appends a create after the skills already there', () => {
    put({ skills: [sk1] });
    const skill = writeSkill({ name: 'Ship', prompt: 'p' }, file);
    expect((parsed().skills as unknown[]).length).toBe(2);
    expect((parsed().skills as unknown[])[0]).toEqual(sk1);
    expect(skill.id).not.toBe(sk1.id);
  });

  it('mints an id the file does not already hold, whatever kind of entry holds it', () => {
    put({ boards: [b1], skills: [sk1] });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(writeSkill({ name: `n${i}`, prompt: 'p' }, file).id);
    expect(ids.size).toBe(20);
    expect(ids.has('s_00000001')).toBe(false);
  });

  it('updates in place: keeps the id and the position, replaces name and prompt, and stores them trimmed', () => {
    put({ skills: [sk1, sk2] });
    const skill = writeSkill({ id: 's_00000001', name: ' Renamed ', prompt: ' New {url} ' }, file);
    expect(skill).toEqual({ id: 's_00000001', name: 'Renamed', prompt: 'New {url}' });
    expect(parsed().skills).toEqual([skill, sk2]);
  });

  it('refuses an update naming an id the file does not hold, with the skill kind, leaving the file byte-identical', () => {
    put({ skills: [sk1] });
    const before = readFileSync(file, 'utf8');
    let thrown: unknown;
    try {
      writeSkill({ id: 's_12345678', name: 'n', prompt: 'p' }, file);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JiraUnknownIdError);
    expect((thrown as JiraUnknownIdError).kind).toBe('skill');
    expect((thrown as Error).message).toBe('no skill with id s_12345678');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a skill id that only a board holds, and an update against a missing file, writing nothing', () => {
    put({ boards: [b1] });
    expect(() => writeSkill({ id: 'b_11111111', name: 'n', prompt: 'p' }, file)).toThrow(JiraUnknownIdError);
    rmSync(file);
    expect(() => writeSkill({ id: 's_12345678', name: 'n', prompt: 'p' }, file)).toThrow(JiraUnknownIdError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('preserves a malformed skill entry, boards, repos and an unknown top-level key, in order', () => {
    const extra = { boards: [b1, { id: 7 }], repos: { PAY: ['/a'] }, note: 'mine' };
    put({ skills: [sk1, { id: 's_0000000a', name: '' }, 'junk', sk2], ...extra });
    writeSkill({ id: 's_00000002', name: 'Renamed', prompt: 'p' }, file);
    const after = parsed();
    const skills = after.skills as unknown[];
    expect(skills[0]).toEqual(sk1);
    expect(skills[1]).toEqual({ id: 's_0000000a', name: '' });
    expect(skills[2]).toBe('junk');
    expect(skills[3]).toEqual({ id: 's_00000002', name: 'Renamed', prompt: 'p' });
    expect(after.boards).toEqual(extra.boards);
    expect(after.repos).toEqual(extra.repos);
    expect(after.note).toBe('mine');
    writeSkill({ name: 'New', prompt: 'p' }, file);
    expect((parsed().skills as unknown[]).slice(0, 3)).toEqual([sk1, { id: 's_0000000a', name: '' }, 'junk']);
  });

  it('does not update a malformed entry the reader would drop, even by its id', () => {
    put({ skills: [{ id: 's_0000000a', name: '' }] });
    expect(() => writeSkill({ id: 's_0000000a', name: 'n', prompt: 'p' }, file)).toThrow(JiraUnknownIdError);
  });

  it('replaces a skills key that is an object on create and keeps the other keys', () => {
    put({ skills: {}, repos: { PAY: ['/a'] } });
    const skill = writeSkill({ name: 'n', prompt: 'p' }, file);
    expect(parsed()).toEqual({ skills: [skill], repos: { PAY: ['/a'] } });
  });

  it('refuses a file that does not parse, byte-identical, create or update', () => {
    put('{ "skills": [');
    const before = readFileSync(file, 'utf8');
    expect(() => writeSkill({ name: 'n', prompt: 'p' }, file)).toThrow(JiraConfigUnreadableError);
    expect(() => writeSkill({ id: 's_00000001', name: 'n', prompt: 'p' }, file)).toThrow(JiraConfigUnreadableError);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('leaves no temp file behind', () => {
    writeSkill({ name: 'n', prompt: 'p' }, file);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('deleteSkill', () => {
  it('removes every entry holding the id, keeping the rest in order and every other key', () => {
    put({ skills: [sk1, 'junk', sk2, { ...sk2, name: 'dup' }], boards: [b1], note: 'mine' });
    deleteSkill('s_00000002', file);
    expect(parsed()).toEqual({ skills: [sk1, 'junk'], boards: [b1], note: 'mine' });
  });

  it('refuses an unknown id with the skill kind, and an unreadable file, byte-identical', () => {
    put({ skills: [sk1] });
    const before = readFileSync(file, 'utf8');
    let thrown: unknown;
    try {
      deleteSkill('s_12345678', file);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JiraUnknownIdError);
    expect((thrown as JiraUnknownIdError).kind).toBe('skill');
    expect(readFileSync(file, 'utf8')).toBe(before);
    put('{ "skills": [');
    const bad = readFileSync(file, 'utf8');
    expect(() => deleteSkill('s_00000001', file)).toThrow(JiraConfigUnreadableError);
    expect(readFileSync(file, 'utf8')).toBe(bad);
  });

  it('refuses an id a board holds, and a missing file', () => {
    put({ boards: [b1] });
    expect(() => deleteSkill('b_11111111', file)).toThrow(JiraUnknownIdError);
    rmSync(file);
    expect(() => deleteSkill('s_00000001', file)).toThrow(JiraUnknownIdError);
  });

  it('a board error keeps its board kind', () => {
    put({ boards: [b1] });
    let thrown: unknown;
    try {
      deleteBoard('b_12345678', file);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as JiraUnknownIdError).kind).toBe('board');
    expect((thrown as Error).message).toBe('no board with id b_12345678');
  });
});

describe('normaliseRepoPath', () => {
  const home = '/Users/ada';

  it('expands ~, trims, and drops one trailing slash', () => {
    expect(normaliseRepoPath('~', home)).toBe('/Users/ada');
    expect(normaliseRepoPath('~/x/', home)).toBe('/Users/ada/x');
    expect(normaliseRepoPath('  /a/b/  ', home)).toBe('/a/b');
    expect(normaliseRepoPath('/', home)).toBe('/');
  });

  it('refuses everything that is not exactly one spelling', () => {
    for (const raw of ['/a//b', '/a/./b', '/a/../b', 'x/y', '~bob/x', '', '   ', '/a//', '//']) expect(normaliseRepoPath(raw, home)).toBeNull();
  });
});

describe('parseReposWrite', () => {
  const home = '/Users/ada';

  it('normalises and deduplicates after normalisation', () => {
    expect(parseReposWrite({ project: 'PAY', paths: ['/a/b', '/a/b/', '~/c'] }, home)).toEqual({
      ok: true,
      value: { project: 'PAY', paths: ['/a/b', '/Users/ada/c'] }
    });
  });

  it('refuses a project that is not a key, naming project', () => {
    for (const project of ['pay', 'P', 'PAY-1', 7, undefined]) {
      const r = parseReposWrite({ project, paths: [] }, home);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('project');
    }
  });

  it('refuses more than 10 distinct paths, naming paths', () => {
    const r = parseReposWrite({ project: 'PAY', paths: Array.from({ length: 11 }, (_, i) => `/p${i}`) }, home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('paths');
    expect(parseReposWrite({ project: 'PAY', paths: Array.from({ length: 10 }, (_, i) => `/p${i}`) }, home).ok).toBe(true);
    const notArray = parseReposWrite({ project: 'PAY', paths: '/a' }, home);
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain('paths');
  });

  it('names a refused path as given', () => {
    expect(parseReposWrite({ project: 'PAY', paths: ['/a//b'] }, home)).toEqual({ ok: false, error: 'path must be absolute and normalised: /a//b' });
  });

  it('takes an empty list, and refuses a body that is not an object', () => {
    expect(parseReposWrite({ project: 'PAY', paths: [] }, home)).toEqual({ ok: true, value: { project: 'PAY', paths: [] } });
    for (const body of [null, [], 'x']) expect(parseReposWrite(body, home).ok).toBe(false);
  });
});

describe('writeRepos', () => {
  it('sets one key and leaves every other, invalid ones included', () => {
    put({ repos: { OTH: ['/o'], pay: ['/hand-written'] }, boards: [b1] });
    writeRepos('PAY', ['/a', '/b'], file);
    const after = parsed();
    expect(after.repos).toEqual({ OTH: ['/o'], pay: ['/hand-written'], PAY: ['/a', '/b'] });
    expect(after.boards).toEqual([b1]);
  });

  it('removes the key for an empty list', () => {
    put({ repos: { PAY: ['/a'], OTH: ['/o'] } });
    writeRepos('PAY', [], file);
    expect(parsed().repos).toEqual({ OTH: ['/o'] });
  });

  it('turns a repos that is an array into an object, and creates a missing file', () => {
    put({ repos: [] });
    writeRepos('PAY', ['/a'], file);
    expect(parsed().repos).toEqual({ PAY: ['/a'] });
    const fresh = join(dir, 'new', 'jira.json');
    writeRepos('PAY', ['/a'], fresh);
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ repos: { PAY: ['/a'] } });
  });

  it('refuses an unreadable file, byte-identical', () => {
    put('nope {');
    expect(() => writeRepos('PAY', ['/a'], file)).toThrow(JiraConfigUnreadableError);
    expect(readFileSync(file, 'utf8')).toBe('nope {');
  });
});

describe('mintJiraId', () => {
  it('mints ids of its own kind, all distinct', () => {
    expect(isJiraId('q', mintJiraId('q'))).toBe(true);
    expect(isJiraId('b', mintJiraId('b'))).toBe(true);
    expect(isJiraId('s', mintJiraId('s'))).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => mintJiraId('q'))).size).toBe(1000);
  });
});
