import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { JIRA_MENTIONS_WINDOW_DAYS } from '../../shared/types';
import { JiraMentionsStore, PRUNE_GRACE_MS, jiraMentionsFile } from '../../server/src/jira/mentions.store';
import * as atomic from '../../server/src/atomic-write.util';

const DAY = 86_400_000;
let dir: string;
let file: string;

const iso = (ageDays: number): string => new Date(Date.now() - ageDays * DAY).toISOString();
const entry = (commentId: string, key = 'ABC-1', ageDays = 1) => ({ commentId, key, created: iso(ageDays), dismissedAt: iso(0) });
const onDisk = (): { version: number; dismissed: Array<{ commentId: string }> } => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-mentions-'));
  file = join(dir, 'jira-mentions.json');
  process.env.BM_JIRA_MENTIONS_FILE = file;
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('jiraMentionsFile', () => {
  it('defaults under ~/.backlog-manager/settings', () => {
    expect(jiraMentionsFile({})).toBe(join(homedir(), '.backlog-manager', 'settings', 'jira-mentions.json'));
    expect(jiraMentionsFile({}).endsWith('/.backlog-manager/settings/jira-mentions.json')).toBe(true);
  });
  it('lets BM_JIRA_MENTIONS_FILE win', () => {
    expect(jiraMentionsFile({ BM_JIRA_MENTIONS_FILE: '/x/y.json' })).toBe('/x/y.json');
  });
});

describe('JiraMentionsStore', () => {
  it('loads empty from a missing file and writes nothing', () => {
    const s = new JiraMentionsStore();
    expect(s.dismissed()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('dismisses, persists as version 1, and answers isDismissed', () => {
    const s = new JiraMentionsStore();
    s.dismiss([entry('1'), entry('2')]);
    expect(onDisk().version).toBe(1);
    expect(s.isDismissed('1')).toBe(true);
    expect(s.isDismissed('9')).toBe(false);
    expect(new JiraMentionsStore().dismissed().map((d) => d.commentId)).toEqual(['1', '2']);
  });

  it('replaces an entry with the same commentId rather than duplicating it', () => {
    const s = new JiraMentionsStore();
    s.dismiss([entry('1', 'ABC-1')]);
    s.dismiss([entry('1', 'ABC-2')]);
    expect(s.dismissed()).toHaveLength(1);
    expect(s.dismissed()[0].key).toBe('ABC-2');
  });

  it('treats an unreadable file as empty, then sets it aside at the first dismiss', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(file, '{not json');
    const s = new JiraMentionsStore();
    expect(s.dismissed()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
    s.dismiss([entry('1')]);
    const bad = readdirSync(dir).filter((f) => f.startsWith('jira-mentions.json.bad-'));
    expect(bad).toHaveLength(1);
    expect(readFileSync(join(dir, bad[0]), 'utf8')).toBe('{not json');
    expect(onDisk().version).toBe(1);
  });

  it('drops an entry missing its commentId and keeps its siblings', () => {
    writeFileSync(file, JSON.stringify({ version: 1, dismissed: [{ key: 'ABC-1', created: iso(1), dismissedAt: iso(0) }, entry('7')] }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = new JiraMentionsStore();
    expect(s.dismissed().map((d) => d.commentId)).toEqual(['7']);
    expect(warn).toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['jira-mentions.json']);
  });

  it('prunes a dismissal whose comment is older than the window plus the grace on save', () => {
    writeFileSync(file, JSON.stringify({ version: 1, dismissed: [entry('old', 'ABC-1', 32), entry('new', 'ABC-1', 29)] }));
    const s = new JiraMentionsStore();
    expect(s.dismissed()).toHaveLength(2); // a load does not prune
    s.dismiss([entry('x')]);
    expect(s.dismissed().map((d) => d.commentId).sort()).toEqual(['new', 'x']);
    expect(onDisk().dismissed.map((d) => d.commentId).sort()).toEqual(['new', 'x']);
  });

  it('keeps a dismissal whose comment just crossed the window: the route proved it against a check judged before the crossing', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const window = JIRA_MENTIONS_WINDOW_DAYS * DAY;
    const at = (ms: number) => ({ commentId: '', key: 'ABC-1', created: new Date(now - ms).toISOString(), dismissedAt: new Date(now).toISOString() });
    const s = new JiraMentionsStore();
    s.dismiss([
      { ...at(window + 60_000), commentId: 'crossed' }, // a minute past the window: still in the check's candidates, the case the grace exists for
      { ...at(window + PRUNE_GRACE_MS), commentId: 'edge' }, // exactly at the grace's end: kept
      { ...at(window + PRUNE_GRACE_MS + 1), commentId: 'gone' } // one ms past it: pruned by the save that wrote it
    ]);
    expect(s.isDismissed('crossed')).toBe(true);
    expect(s.dismissed().map((d) => d.commentId)).toEqual(['crossed', 'edge']);
    expect(onDisk().dismissed.map((d) => d.commentId)).toEqual(['crossed', 'edge']);
  });

  it('restore drops every entry of a key and returns the count; none means 0 and no write', () => {
    const s = new JiraMentionsStore();
    expect(s.restore('ABC-1')).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    s.dismiss([entry('1', 'ABC-1'), entry('2', 'ABC-1'), entry('3', 'ABC-2')]);
    expect(s.restore('ABC-1')).toBe(2);
    expect(s.dismissed().map((d) => d.commentId)).toEqual(['3']);
    expect(onDisk().dismissed.map((d) => d.commentId)).toEqual(['3']);
  });

  it('a failed write throws and leaves memory unchanged', () => {
    const s = new JiraMentionsStore();
    s.dismiss([entry('1', 'ABC-1')]);
    jest.spyOn(atomic, 'writeJsonAtomic').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => s.dismiss([entry('2')])).toThrow('disk full');
    expect(s.dismissed().map((d) => d.commentId)).toEqual(['1']);
    expect(() => s.restore('ABC-1')).toThrow('disk full');
    expect(s.isDismissed('1')).toBe(true);
  });
});
