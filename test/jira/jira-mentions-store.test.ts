import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

describe('JiraMentionsStore drafts (plan ruling R5)', () => {
  const draft = (text = 'Thanks, done.', ageDays = 0, sessionId = 'sess-1') => ({ text, sessionId, at: iso(ageDays) });
  const diskDrafts = (): Array<{ key: string; text: string }> => JSON.parse(readFileSync(file, 'utf8')).drafts;

  it('a v1 file with no drafts loads with no drafts and its dismissals intact', () => {
    writeFileSync(file, JSON.stringify({ version: 1, dismissed: [entry('1')] }));
    const s = new JiraMentionsStore();
    expect(s.draftFor('ABC-1')).toBeNull();
    expect(s.dismissed().map((d) => d.commentId)).toEqual(['1']);
  });

  it('setDraft then a reload returns it, and a second setDraft replaces it', () => {
    const s = new JiraMentionsStore();
    const d = draft();
    s.setDraft('PAY-1', d);
    expect(new JiraMentionsStore().draftFor('PAY-1')).toEqual(d);
    s.setDraft('PAY-1', draft('Second.'));
    expect(s.draftFor('PAY-1')?.text).toBe('Second.');
    expect(diskDrafts()).toHaveLength(1);
  });

  it('a dismiss keeps the drafts and a draft keeps the dismissals', () => {
    const s = new JiraMentionsStore();
    s.setDraft('PAY-1', draft());
    s.dismiss([entry('1')]);
    expect(new JiraMentionsStore().draftFor('PAY-1')).not.toBeNull();
    s.setDraft('PAY-2', draft());
    expect(new JiraMentionsStore().dismissed().map((d) => d.commentId)).toEqual(['1']);
  });

  it('drops a malformed draft alone and keeps the rest', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = { key: 'PAY-1', text: 'fine', sessionId: 'a', at: iso(0) };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        dismissed: [entry('1')],
        drafts: [
          { ...ok, key: 'PAY-2', text: '' },
          { ...ok, key: 'PAY-3', at: 'not a date' },
          { ...ok, key: 'PAY-4', sessionId: 7 },
          { ...ok, key: 'PAY-5', sessionId: 'a b' },
          'junk',
          ok
        ]
      })
    );
    const s = new JiraMentionsStore();
    expect(['PAY-2', 'PAY-3', 'PAY-4', 'PAY-5'].map((k) => s.draftFor(k))).toEqual([null, null, null, null]);
    expect(s.draftFor('PAY-1')).toEqual({ text: 'fine', sessionId: 'a', at: ok.at });
    expect(s.dismissed()).toHaveLength(1);
  });

  it('prunes a draft older than the window plus the grace on save, and keeps one exactly the window old', () => {
    const s = new JiraMentionsStore();
    s.setDraft('PAY-1', draft('old', JIRA_MENTIONS_WINDOW_DAYS + 1 + 0.01));
    expect(s.draftFor('PAY-1')).toBeNull();
    s.setDraft('PAY-2', draft('edge', JIRA_MENTIONS_WINDOW_DAYS));
    expect(s.draftFor('PAY-2')?.text).toBe('edge');
    expect(PRUNE_GRACE_MS).toBe(DAY);
  });

  it('dropDraft of a missing key writes nothing; of a present one, leaves another key as it was', () => {
    const s = new JiraMentionsStore();
    s.setDraft('PAY-1', draft());
    const before = statSync(file).mtimeMs;
    const spy = jest.spyOn(atomic, 'writeJsonAtomic');
    expect(s.dropDraft('PAY-9')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(statSync(file).mtimeMs).toBe(before);
    spy.mockRestore();
    s.setDraft('PAY-2', draft('two'));
    expect(s.dropDraft('PAY-1')).toBe(true);
    expect(s.draftFor('PAY-1')).toBeNull();
    expect(s.draftFor('PAY-2')?.text).toBe('two');
  });

  it('a failed write throws and leaves the drafts unchanged', () => {
    const s = new JiraMentionsStore();
    s.setDraft('PAY-1', draft('kept'));
    jest.spyOn(atomic, 'writeJsonAtomic').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => s.setDraft('PAY-1', draft('lost'))).toThrow('disk full');
    expect(() => s.dropDraft('PAY-1')).toThrow('disk full');
    expect(s.draftFor('PAY-1')?.text).toBe('kept');
  });
});
