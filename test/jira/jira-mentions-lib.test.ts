/**
 * @jest-environment jsdom
 */
import { accessPhrase } from '../../client/src/lib/jira';
import {
  askedAge,
  checkedAge,
  excerptParts,
  failureOfMentions,
  isJiraMentionsPayload,
  mentionCards,
  mentionRows,
  mentionsBand,
  mentionsCheckGate,
  type JiraMentionsFailure
} from '../../client/src/lib/jira-mentions';
import { JIRA_MENTIONS_ISSUE_CAP, type JiraMention, type JiraMentionIssue, type JiraMentionsConfigured } from '../../shared/types';

/*
  `lib/jira-mentions.ts` read directly (spec "The page", "Sync now, two ways"; DESIGN.md §8.9.7). The page, hook and chip suites reach these functions
  through a render and cover their main states; this suite holds the branches a render does not reach — the malformed-200 guard, the red text for a refused
  write beside rows, `checked at an unknown time`, the `@` boundary in an excerpt, the age spellings and the check-now gate the page chip and the pill's
  Mentions icon share. A `.ts` suite, so every instant is built from a `NOW` passed in explicitly (tests.md: the fixture-clock rule is the jsdom suites').
*/

const NOW = Date.parse('2026-11-16T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function mention(commentId: string, agoMs: number, excerpt = '@Ana can you check?'): JiraMention {
  return {
    commentId,
    author: { accountId: `acc-${commentId}`, name: `Author ${commentId}` },
    created: ago(agoMs),
    excerpt,
    url: `https://acme.atlassian.net/browse/SUP-1?focusedCommentId=${commentId}`
  };
}

function issue(key: string, mentions: JiraMention[]): JiraMentionIssue {
  return { key, summary: `Summary ${key}`, type: 'Bug', status: { name: 'To Do', category: 'new' }, boards: [], mentions };
}

function data(over: Partial<JiraMentionsConfigured> = {}): JiraMentionsConfigured {
  return {
    configured: true,
    polledAt: ago(MIN),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: 'Ana',
    issues: [issue('SUP-1', [mention('1', HOUR), mention('2', 2 * HOUR)]), issue('PAY-2', [mention('3', 3 * HOUR)])],
    dismissed: [],
    ...over
  };
}

const band = (over: Partial<Parameters<typeof mentionsBand>[0]> = {}) =>
  mentionsBand({ data: data(), checking: false, access: 'ok', error: null, now: NOW, zone: 'UTC', ...over });

describe('isJiraMentionsPayload', () => {
  it('takes an unconfigured answer and a configured one that can be drawn', () => {
    expect(isJiraMentionsPayload({ configured: false, detail: null })).toBe(true);
    expect(isJiraMentionsPayload(data())).toBe(true);
    expect(isJiraMentionsPayload(data({ issues: [], dismissed: [issue('OPS-9', [mention('9', DAY)])] }))).toBe(true);
  });

  it('refuses a non-object, a missing discriminator, or a configured body without its two arrays', () => {
    for (const bad of [null, 'x', [], {}, { configured: 'yes' }, { ...data(), issues: undefined }, { ...data(), dismissed: {} }]) {
      expect(isJiraMentionsPayload(bad)).toBe(false);
    }
  });

  // The rows are what a render maps over without a null-safe expression: `mentionRows` flat-maps `mentions`, the search lowercases the strings.
  it('refuses a body whose ticket or mention a render would throw on', () => {
    const { mentions: _dropped, ...noMentions } = issue('SUP-1', []);
    expect(isJiraMentionsPayload(data({ issues: [noMentions as JiraMentionIssue] }))).toBe(false);
    expect(isJiraMentionsPayload(data({ issues: [{ ...issue('SUP-1', []), summary: 7 as unknown as string }] }))).toBe(false);
    expect(isJiraMentionsPayload(data({ issues: [{ ...issue('SUP-1', []), boards: null as unknown as string[] }] }))).toBe(false);
    expect(isJiraMentionsPayload(data({ issues: [issue('SUP-1', [{ ...mention('1', HOUR), author: {} as JiraMention['author'] }])] }))).toBe(false);
    expect(isJiraMentionsPayload(data({ issues: [issue('SUP-1', [{ ...mention('1', HOUR), excerpt: null as unknown as string }])] }))).toBe(false);
    expect(isJiraMentionsPayload(data({ dismissed: [noMentions as JiraMentionIssue] }))).toBe(false);
  });
});

describe('failureOfMentions', () => {
  it('reads the sweep’s `{ message }` first, then `{ error }`, then the fallback, keeping a 429’s wait end', () => {
    const until = ago(-5 * MIN);
    expect(failureOfMentions(429, { message: 'rate limited', retryAt: until }, 'x')).toEqual({ message: 'rate limited', retryAt: until, status: 429 });
    expect(failureOfMentions(400, { error: '1 is not an open mention on SUP-1' }, 'x')).toEqual({ message: '1 is not an open mention on SUP-1', retryAt: null, status: 400 });
    expect(failureOfMentions(500, null, 'Jira answered 500')).toEqual({ message: 'Jira answered 500', retryAt: null, status: 500 });
    expect(failureOfMentions(409, { message: '' }, 'fallback').message).toBe('fallback');
  });
});

describe('mentionsBand', () => {
  const refused: JiraMentionsFailure = { message: '1 is not an open mention on SUP-1', retryAt: null, status: 400 };

  it('reads the count line, and a refused write in red beside the rows it left', () => {
    expect(band()).toEqual({ lead: '3 waiting · last 30 days · checked 1 min ago', fail: null, tail: null, disabled: false, title: 'Check mentions now' });
    expect(band({ error: refused })).toMatchObject({ lead: '3 waiting · last 30 days · checked 1 min ago', fail: refused.message, disabled: false });
  });

  it('puts a blocking access before the cache detail, and the detail before a refused write', () => {
    expect(band({ error: refused, data: data({ detail: 'Jira answered 503' }) }).fail).toBe('Jira answered 503');
    const blocked = band({ error: refused, access: 'unauthorized', data: data({ detail: 'Jira answered 503' }) });
    expect(blocked.fail).toBe(accessPhrase('unauthorized'));
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe(accessPhrase('unauthorized'));
  });

  it('says a 429 through its wait while it is ahead, never as a red refusal, and drops it once passed', () => {
    const waiting = band({ error: { message: 'rate limited', retryAt: ago(-150_000), status: 429 } });
    expect(waiting.lead).toBe('3 waiting · last 30 days · checked 1 min ago · Jira asked to wait until 12:02');
    expect(waiting.fail).toBeNull();
    expect(waiting.disabled).toBe(true);
    const passed = band({ error: { message: 'rate limited', retryAt: ago(1_000), status: 429 } });
    expect(passed.lead).toBe('3 waiting · last 30 days · checked 1 min ago');
    expect(passed.fail).toBeNull();
  });

  it('reads `checked at an unknown time` for a stamp that does not parse, `checking…` while a check is out', () => {
    expect(band({ data: data({ polledAt: 'not a date' }) }).lead).toBe('3 waiting · last 30 days · checked at an unknown time');
    expect(band({ checking: true })).toMatchObject({ lead: '3 waiting · last 30 days · checking…', disabled: true });
  });

  it('counts tickets in the Cards view, and ends on the cap tail when the search was truncated', () => {
    expect(band({ view: 'cards' }).lead).toBe('2 tickets waiting · last 30 days · checked 1 min ago');
    expect(band({ data: data({ truncated: true }) }).tail).toBe(`newest ${JIRA_MENTIONS_ISSUE_CAP} tickets checked`);
  });

  it('before the first stamp: checking, else the wait, else the reason, else `not checked yet` — never a count', () => {
    const first = data({ polledAt: null, issues: [] });
    expect(band({ data: first, checking: true }).lead).toBe('checking…');
    expect(band({ data: first, error: { message: 'rate limited', retryAt: ago(-150_000), status: 429 } }).lead).toBe('Jira asked to wait until 12:02');
    // `unreachable` does not block the chip (the next tick may clear it), but it is still the reason nothing has been checked.
    expect(band({ data: first, access: 'unreachable' })).toMatchObject({ lead: '', fail: accessPhrase('unreachable'), disabled: false });
    expect(band({ data: first, error: refused })).toMatchObject({ lead: '', fail: refused.message });
    expect(band({ data: first })).toMatchObject({ lead: 'not checked yet', fail: null });
  });
});

describe('mentionsCheckGate', () => {
  it('takes the first wait still ahead in the order given, then a blocking access, else the plain tooltip', () => {
    const gate = (over: Partial<Parameters<typeof mentionsCheckGate>[0]> = {}) =>
      mentionsCheckGate({ checking: false, access: 'ok', retryAts: [null, null], now: NOW, zone: 'UTC', ...over });
    expect(gate()).toEqual({ wait: null, blocking: null, disabled: false, title: 'Check mentions now' });
    expect(gate({ retryAts: [ago(-150_000), ago(-300_000)] }).title).toBe('Jira asked to wait until 12:02');
    expect(gate({ retryAts: [ago(1_000), ago(-300_000)] }).title).toBe('Jira asked to wait until 12:05');
    expect(gate({ access: 'forbidden' })).toMatchObject({ blocking: accessPhrase('forbidden'), disabled: true, title: accessPhrase('forbidden') });
    expect(gate({ access: 'unreachable' })).toMatchObject({ blocking: null, disabled: false });
    expect(gate({ checking: true })).toMatchObject({ disabled: true, title: 'Check mentions now' });
  });
});

describe('excerptParts', () => {
  it('chips the user’s own @ in place, and nothing without a name', () => {
    expect(excerptParts('ask @Ana about it', 'Ana')).toEqual([
      { text: 'ask ', me: false },
      { text: '@Ana', me: true },
      { text: ' about it', me: false }
    ]);
    expect(excerptParts('@Ana, @Ana.', 'Ana').filter((p) => p.me)).toHaveLength(2);
    expect(excerptParts('ask @Ana', null)).toEqual([{ text: 'ask @Ana', me: false }]);
    expect(excerptParts('ask @Ana', '')).toEqual([{ text: 'ask @Ana', me: false }]);
  });

  // `chipMentions`' boundary: a name that merely starts with the user's is someone else.
  it('does not chip the start of a longer name, and still finds the user after one', () => {
    expect(excerptParts('@Anastasia can you check', 'Ana')).toEqual([{ text: '@Anastasia can you check', me: false }]);
    expect(excerptParts('@Anastasia and @Ana', 'Ana')).toEqual([
      { text: '@Anastasia and ', me: false },
      { text: '@Ana', me: true }
    ]);
    expect(excerptParts('@Anaïs', 'Ana')).toEqual([{ text: '@Anaïs', me: false }]);
  });
});

describe('the ages', () => {
  it('checkedAge spells the band’s floored age, `0 s` for a stamp ahead, null for none or nonsense', () => {
    expect(checkedAge(null, NOW)).toBeNull();
    expect(checkedAge('nope', NOW)).toBeNull();
    expect(checkedAge(ago(-5_000), NOW)).toBe('0 s');
    expect(checkedAge(ago(59_999), NOW)).toBe('59 s');
    expect(checkedAge(ago(MIN), NOW)).toBe('1 min');
    expect(checkedAge(ago(2 * HOUR + 59 * MIN), NOW)).toBe('2 h');
    expect(checkedAge(ago(3 * DAY), NOW)).toBe('3 d');
  });

  it('askedAge spells the quote’s age the mock’s way', () => {
    expect(askedAge(ago(10_000), NOW)).toBe('just now');
    expect(askedAge(ago(2 * HOUR), NOW)).toBe('2 h ago');
    expect(askedAge(ago(6 * DAY), NOW)).toBe('6 d ago');
    expect(askedAge('nope', NOW)).toBeNull();
  });
});

describe('mentionCards', () => {
  it('quotes the newest mention by `created`, an unparseable stamp sorting oldest, and counts the rest as earlier', () => {
    const rows = mentionRows(data({ issues: [issue('SUP-1', [{ ...mention('1', HOUR), created: 'garbage' }, mention('2', 2 * HOUR)])] }), false);
    const [card] = mentionCards(rows);
    expect(card.mention.commentId).toBe('2');
    expect(card.earlier).toBe(1);
  });
});
