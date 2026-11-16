import { JIRA_MENTIONS_EXCERPT_CHARS } from '../../shared/types';
import { excerptOf, judgeComments, mentionsJql, mentionsUser, MENTION_SEARCH_FIELDS, type RawComment } from '../../server/src/jira/mentions.util';

/* `now` is a pure-function input here, not a jsdom fixture, so absolute instants are the clearer fixture (the clock guard scopes to .tsx). */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const ME = 'acc-me';
const MARA = { accountId: 'acc-m', displayName: 'Mara Ilić', avatarUrls: { '16x16': 'https://a/16', '48x48': 'https://a/48' } };
const IVO = { accountId: 'acc-i', displayName: 'Ivo' };
const ME_AUTHOR = { accountId: ME, displayName: 'Me' };

const mention = (id: string) => ({ type: 'mention', attrs: { id, text: '@x' } });
const doc = (...inline: unknown[]) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: inline }] });
const text = (t: string) => ({ type: 'text', text: t });
const c = (id: string, author: RawComment['author'], created: string, body: unknown): RawComment => ({ id, author, created, body });
const judge = (comments: RawComment[], extra: { answeredAfter?: string | null } = {}) =>
  judgeComments({ comments, me: ME, site: 'acme.atlassian.net', key: 'SUP-208', now: NOW, windowDays: 30, ...extra });
const atMe = doc(mention(ME), text(' please look'));

describe('judgeComments', () => {
  it('finds a mention', () => {
    const r = judge([c('11', MARA, '2026-11-16T10:00:00Z', atMe)]);
    expect(r).toHaveLength(1);
    expect(r[0].commentId).toBe('11');
    expect(r[0].author).toEqual({ accountId: 'acc-m', name: 'Mara Ilić', avatarUrl: 'https://a/48' });
    expect(r[0].url).toBe('https://acme.atlassian.net/browse/SUP-208?focusedCommentId=11');
  });
  it('drops a mention answered by a later own comment', () => {
    expect(judge([c('1', MARA, '2026-11-16T10:00:00Z', atMe), c('2', ME_AUTHOR, '2026-11-16T10:04:00Z', doc(text('on it')))])).toEqual([]);
  });
  it('keeps only mentions after the latest own comment, newest first', () => {
    const r = judge([
      c('0', ME_AUTHOR, '2026-11-16T07:00:00Z', doc(text('early'))),
      c('1', MARA, '2026-11-16T08:00:00Z', atMe),
      c('2', ME_AUTHOR, '2026-11-16T09:00:00Z', doc(text('ok'))),
      c('3', IVO, '2026-11-16T11:00:00Z', atMe),
      c('4', MARA, '2026-11-16T11:30:00Z', atMe)
    ]);
    expect(r.map((m) => m.commentId)).toEqual(['4', '3']);
  });
  it('ignores a self-mention, which still counts as my latest comment', () => {
    expect(judge([c('1', ME_AUTHOR, '2026-11-16T10:00:00Z', atMe)])).toEqual([]);
    expect(judge([c('1', MARA, '2026-11-16T08:00:00Z', atMe), c('2', ME_AUTHOR, '2026-11-16T10:00:00Z', atMe)])).toEqual([]);
  });
  it('keeps the window edge and drops one second past it', () => {
    const edge = new Date(NOW - 30 * 86_400_000).toISOString();
    const past = new Date(NOW - 30 * 86_400_000 - 1000).toISOString();
    expect(judge([c('1', MARA, edge, atMe)])).toHaveLength(1);
    expect(judge([c('1', MARA, past, atMe)])).toEqual([]);
  });
  it('does not resurface an edited comment', () => {
    const edited = { ...c('1', MARA, '2026-11-16T08:00:00Z', atMe), updated: '2026-11-16T11:00:00Z' };
    expect(judge([edited, c('2', ME_AUTHOR, '2026-11-16T09:00:00Z', doc(text('ok')))])).toEqual([]);
  });
  it('lets answeredAfter win over an older own comment', () => {
    const comments = [c('1', ME_AUTHOR, '2026-11-16T09:00:00Z', doc(text('a'))), c('2', MARA, '2026-11-16T10:00:00Z', atMe)];
    expect(judge(comments)).toHaveLength(1);
    expect(judge(comments, { answeredAfter: '2026-11-16T10:30:00Z' })).toEqual([]);
  });
  it('ignores a mention of someone else', () => {
    expect(judge([c('1', MARA, '2026-11-16T10:00:00Z', doc(mention('acc-i')))])).toEqual([]);
  });
  it('names a missing author Someone and omits a missing avatar', () => {
    const r = judge([c('1', { accountId: 'acc-i' }, '2026-11-16T10:00:00Z', atMe), c('2', undefined, '2026-11-16T10:01:00Z', atMe)]);
    expect(r.map((m) => m.author.name)).toEqual(['Someone', 'Someone']);
    expect('avatarUrl' in r[1].author).toBe(false);
  });
  it('falls back to the largest avatar when 48x48 is absent', () => {
    const a = { accountId: 'acc-m', displayName: 'M', avatarUrls: { '16x16': 'https://a/16', '32x32': 'https://a/32' } };
    expect(judge([c('1', a, '2026-11-16T10:00:00Z', atMe)])[0].author.avatarUrl).toBe('https://a/32');
  });
});

describe('mentionsUser', () => {
  it('finds a mention at depth and rejects others', () => {
    const deep = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [mention(ME)] }] }] }] };
    expect(mentionsUser(deep, ME)).toBe(true);
    expect(mentionsUser(deep, 'x')).toBe(false);
    expect(mentionsUser(null, ME)).toBe(false);
    expect(mentionsUser('str', ME)).toBe(false);
  });
});

describe('mentionsJql / excerptOf', () => {
  it('quotes the account id through jqlString', () => {
    expect(mentionsJql('acc-"x', 30)).toBe('comment ~ "acc-\\"x" AND updated >= -30d ORDER BY updated DESC');
    expect(MENTION_SEARCH_FIELDS).toEqual(['summary', 'status', 'issuetype', 'comment', 'updated']);
  });
  it('cuts a long excerpt on a word boundary with an ellipsis', () => {
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const out = excerptOf(doc(text(long)));
    expect(out.length).toBeLessThanOrEqual(281);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(long[out.length - 1]).toBe(' ');
  });
  it('does not cut a short one', () => {
    expect(excerptOf(doc(text('hello  world')))).toBe('hello world');
  });
  it('keeps text of exactly JIRA_MENTIONS_EXCERPT_CHARS whole, and cuts one character more', () => {
    const exact = `${'a'.repeat(JIRA_MENTIONS_EXCERPT_CHARS - 2)} b`;
    expect(exact).toHaveLength(JIRA_MENTIONS_EXCERPT_CHARS);
    expect(excerptOf(doc(text(exact)))).toBe(exact);
    const over = `${'a'.repeat(JIRA_MENTIONS_EXCERPT_CHARS - 1)} b`;
    expect(over).toHaveLength(JIRA_MENTIONS_EXCERPT_CHARS + 1);
    expect(excerptOf(doc(text(over)))).toBe(`${'a'.repeat(JIRA_MENTIONS_EXCERPT_CHARS - 1)}…`);
  });
});
