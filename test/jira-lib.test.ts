/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { setJiraPage, useJiraPage } from '../client/src/hooks/useJiraPage';
import {
  JIRA_429_RED_MS,
  JIRA_BOARD_FILTER_FROM,
  JIRA_COLUMNS,
  JIRA_CUSTOM_QUERY,
  JIRA_QUERY_PRESETS,
  JIRA_SWEEP_CALL_CEILING,
  bandSub,
  cardFold,
  childrenLine,
  foldBoard,
  foldMatches,
  foldProgress,
  matchMarker,
  modalTree,
  progressLine,
  sortTops,
  boardRowLine,
  boardsForSetup,
  callsReading,
  sweepLine,
  cardAgeStamp,
  columnOf,
  crumbOf,
  crumbText,
  failurePhrase,
  displayPath,
  initialsOf,
  issueDatesLine,
  isJiraStatusPayload,
  defaultModeFor,
  jiraSettingOf,
  resolveJiraAction,
  runChipState,
  pickBoard,
  soonestBoard,
  sortForBoard,
  unmappedProjects
} from '../client/src/lib/jira';
import type { JiraFold } from '../client/src/lib/jira';
import { isJiraPage, JIRA_PAGE_KEY, JIRA_PAGES } from '../client/src/lib/jira-page';
import { elapsedSince, formatCreated } from '../client/src/lib/item-age';
import type { JiraBoard, JiraBoardStatus, JiraIssue, JiraSkill, JiraStatusPayload } from '../shared/types';
import { daysAgoStamp } from './helpers/dates';

/**
 * The client's Jira derivations (Jira phase 2). Every case builds its stamps from the clock the assertion runs under (`test/helpers/dates.ts`, and
 * `now` below), never from an absolute literal: a fixture dated the day it was written is an expiry date, not a constant.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** An ISO instant `ms` before `now`. */
const ago = (now: number, ms: number): string => new Date(now - ms).toISOString();

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: 'PAY-1',
    id: '10001',
    url: 'https://acme.atlassian.net/browse/PAY-1',
    summary: 'Refund flow',
    project: { key: 'PAY', name: 'Payments' },
    type: { name: 'Task', level: 0, subtask: false },
    status: { name: 'To Do', category: 'new' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(10),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}

function board(over: Partial<JiraBoardStatus> = {}): JiraBoardStatus {
  return {
    id: 'b_00000001',
    name: 'Payments',
    roots: ['PAY-1', 'PAY-9'],
    queries: [{ id: 'q_00000001', label: 'Mine', jql: 'assignee = currentUser()' }],
    interval: '1m',
    polledAt: null,
    count: 14,
    truncated: false,
    failures: [],
    ...over
  };
}

function payload(over: Partial<JiraStatusPayload> = {}): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: { accountId: 'acc-1', name: 'Ada Lovelace' },
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [board()],
    repos: {},
    projects: [],
    skills: [],
    calls: { sweep: 3, last429At: null },
    live: {},
    armed: true,
    home: '/Users/ada',
    ...over
  };
}

describe('columns', () => {
  it('maps a status category to its column', () => {
    expect(columnOf(issue({ status: { name: 'x', category: 'new' } }))).toBe('todo');
    expect(columnOf(issue({ status: { name: 'x', category: 'indeterminate' } }))).toBe('doing');
    expect(columnOf(issue({ status: { name: 'x', category: 'done' } }))).toBe('done');
  });

  it('declares the three columns in board order', () => {
    expect(JIRA_COLUMNS).toEqual([
      { slug: 'todo', label: 'To Do', category: 'new' },
      { slug: 'doing', label: 'In Progress', category: 'indeterminate' },
      { slug: 'done', label: 'Done', category: 'done' }
    ]);
  });
});

describe('sortForBoard', () => {
  it('puts the most recently updated first', () => {
    const now = Date.now();
    const a = issue({ key: 'PAY-1', updated: ago(now, 3 * 24 * HOUR) });
    const b = issue({ key: 'PAY-2', updated: ago(now, HOUR) });
    const c = issue({ key: 'PAY-3', updated: ago(now, 2 * 24 * HOUR) });
    expect(sortForBoard([a, b, c]).map((i) => i.key)).toEqual(['PAY-2', 'PAY-3', 'PAY-1']);
  });

  it('breaks a tie by key in string order, and never mutates its input', () => {
    const stamp = daysAgoStamp(1);
    const input = [issue({ key: 'PAY-2', updated: stamp }), issue({ key: 'PAY-10', updated: stamp })];
    const before = input.map((i) => i.key);
    expect(sortForBoard(input).map((i) => i.key)).toEqual(['PAY-10', 'PAY-2']);
    expect(input.map((i) => i.key)).toEqual(before);
  });
});

describe('cardAgeStamp', () => {
  // Relative to the clock the assertion runs under; `now` is passed, not read, so the reading is the test's own. A card's age is `elapsedSince`'s board
  // vocabulary (`now` / `4m` / `2h` / `6d`), not a date — the spec's "the age of `updated`" and the mocks' `2 days ago`.
  const now = Date.now();
  const updated = daysAgoStamp(3);
  const resolved = daysAgoStamp(40);

  it('reads the age of resolved for a done issue that has one, with no prefix', () => {
    const i = issue({ status: { name: 'Done', category: 'done' }, updated, resolved });
    expect(cardAgeStamp(i, now)).toBe('40d');
  });

  it('falls back to the age of updated for a done issue with no resolution', () => {
    const i = issue({ status: { name: 'Done', category: 'done' }, updated, resolved: null });
    expect(cardAgeStamp(i, now)).toBe('3d');
  });

  it('ignores a stale resolved on an issue that is not done', () => {
    const i = issue({ status: { name: 'Doing', category: 'indeterminate' }, updated, resolved });
    expect(cardAgeStamp(i, now)).toBe('3d');
  });

  it('climbs the ladder from the now it is given: now, minutes, hours, days', () => {
    const at = Date.parse('2026-06-15T12:00:00Z');
    const aged = (ms: number): string => cardAgeStamp(issue({ updated: new Date(at - ms).toISOString() }), at);
    expect(aged(20 * SECOND)).toBe('now');
    expect(aged(4 * MINUTE)).toBe('4m');
    expect(aged(2 * HOUR)).toBe('2h');
    expect(aged(6 * 24 * HOUR)).toBe('6d');
  });

  it('prints the raw stamp rather than NaN when it cannot be aged', () => {
    expect(cardAgeStamp(issue({ updated: 'garbage' }), now)).toBe('garbage');
  });
});

describe('issueDatesLine', () => {
  it('is the created date and the relative age of updated, the modal\'s `created · updated` value', () => {
    const at = Date.parse('2026-10-16T12:00:00Z');
    const i = issue({ created: '2026-10-02T09:00:00Z', updated: new Date(at - 4 * MINUTE).toISOString() });
    expect(issueDatesLine(i, at)).toBe(`${formatCreated(i.created, at)} · 4m`);
  });

  it('takes the year suffix of created from the now it is given', () => {
    const i = issue({ created: '2020-06-15T10:00:00.000Z', updated: '2020-06-16T10:00:00.000Z' });
    expect(issueDatesLine(i, Date.parse('2026-12-01T00:00:00Z'))).toBe("jun 15 '20 · " + elapsedSince(i.updated, Date.parse('2026-12-01T00:00:00Z')));
  });
});

describe('crumbOf', () => {
  const b: JiraBoard = { id: 'b_1', name: 'P', roots: ['PAY-1'], queries: [], interval: '1m' };
  const me = { accountId: 'acc-1', name: 'Ada' };
  const mine = { accountId: 'acc-1', name: 'Ada' };

  it('reads root before parent, even when the root has a parent', () => {
    expect(crumbOf(issue({ key: 'PAY-1', parent: { key: 'PAY-0', summary: 'Epic' } }), b, me)).toEqual({ kind: 'root' });
  });

  it('reads parent before mine', () => {
    expect(crumbOf(issue({ key: 'PAY-2', parent: { key: 'PAY-1', summary: 'Checkout' }, assignee: mine }), b, me)).toEqual({
      kind: 'parent',
      key: 'PAY-1',
      summary: 'Checkout'
    });
  });

  it('reads mine for a parentless issue assigned to me', () => {
    expect(crumbOf(issue({ key: 'PAY-3', assignee: mine }), b, me)).toEqual({ kind: 'mine' });
  });

  it('reads nothing for an issue that is none of those', () => {
    expect(crumbOf(issue({ key: 'PAY-4' }), b, me)).toBeNull();
  });

  it('never reads mine while me is unknown', () => {
    expect(crumbOf(issue({ key: 'PAY-3', assignee: mine }), b, null)).toBeNull();
  });
});

describe('crumbText', () => {
  it('prints the three crumbs the card draws, verbatim', () => {
    expect(crumbText({ kind: 'root' })).toBe('root');
    expect(crumbText({ kind: 'parent', key: 'PAY-120', summary: 'Refund flows' })).toBe('↳ PAY-120 Refund flows');
    expect(crumbText({ kind: 'mine' })).toBe('Assigned to me');
  });

  it('prints nothing for no crumb', () => {
    expect(crumbText(null)).toBeNull();
  });
});

describe('failurePhrase', () => {
  it('is null with no failures', () => {
    expect(failurePhrase([])).toBeNull();
  });

  it("is Jira's message for one, and the first message plus a count for several", () => {
    const f = (message: string) => ({ kind: 'root' as const, id: 'PAY-9', message });
    expect(failurePhrase([f('Issue does not exist')])).toBe('Issue does not exist');
    expect(failurePhrase([f('Issue does not exist'), f('Bad JQL'), f('Worse JQL')])).toBe('Issue does not exist +2 more');
  });
});

describe('bandSub', () => {
  const site = 'acme.atlassian.net';

  it('names the count, the sources and the age of the poll', () => {
    const now = Date.now();
    const b = board({ count: 14, polledAt: ago(now, 12 * SECOND) });
    expect(bandSub(b, site, now, null)).toEqual({ text: 'acme.atlassian.net · 14 issues from 2 roots and 1 query · polled 12 s ago', failing: false });
  });

  it('omits a zero source and pluralises the other', () => {
    const now = Date.now();
    const b = board({
      roots: [],
      queries: [
        { id: 'q_1', label: 'a', jql: 'x' },
        { id: 'q_2', label: 'b', jql: 'y' }
      ],
      polledAt: ago(now, 12 * SECOND)
    });
    expect(bandSub(b, site, now, null).text).toBe('acme.atlassian.net · 14 issues from 2 queries · polled 12 s ago');
  });

  it('says 1 issue in the singular', () => {
    const now = Date.now();
    expect(bandSub(board({ count: 1, polledAt: ago(now, 12 * SECOND) }), site, now, null).text).toContain(' · 1 issue from ');
  });

  it('reads not polled yet where an age would be', () => {
    expect(bandSub(board({ polledAt: null }), site, Date.now(), null).text).toBe('acme.atlassian.net · 14 issues from 2 roots and 1 query · not polled yet');
  });

  it('ends on the cap when the list is truncated', () => {
    const now = Date.now();
    const text = bandSub(board({ truncated: true, polledAt: ago(now, 12 * SECOND) }), site, now, null).text;
    expect(text.endsWith(' · first 500 shown')).toBe(true);
  });

  it("is failing and names Jira's message for the first failure, with the rest counted", () => {
    const now = Date.now();
    const one = bandSub(board({ polledAt: ago(now, 12 * SECOND), failures: [{ kind: 'root', id: 'PAY-9', message: 'Issue does not exist' }] }), site, now, null);
    expect(one.failing).toBe(true);
    expect(one.text).toContain('Issue does not exist');
    expect(one.text).not.toContain('more');

    const three = bandSub(
      board({
        polledAt: ago(now, 12 * SECOND),
        failures: [
          { kind: 'root', id: 'PAY-9', message: 'Issue does not exist' },
          { kind: 'query', id: 'q_1', message: 'Field foo does not exist' },
          { kind: 'query', id: 'q_2', message: 'Bad JQL' }
        ]
      }),
      site,
      now,
      null
    );
    expect(three.failing).toBe(true);
    expect(three.text).toContain('Issue does not exist');
    expect(three.text).toContain('+2 more');
    expect(three.text).not.toContain('Bad JQL');
  });
});

describe('boardRowLine', () => {
  it('reads the sources, the count, the interval and the age', () => {
    const now = Date.now();
    expect(boardRowLine(board({ polledAt: ago(now, 12 * SECOND) }), now)).toEqual({
      text: '2 roots · 1 query · 14 issues · every 1m · polled 12 s ago',
      failing: false,
      failure: null
    });
  });

  it('says sync off and last polled for an off board', () => {
    const now = Date.now();
    expect(boardRowLine(board({ interval: 'off', polledAt: ago(now, 12 * SECOND) }), now).text).toBe(
      '2 roots · 1 query · 14 issues · sync off · last polled 12 s ago'
    );
  });

  it('omits zero counts', () => {
    const now = Date.now();
    expect(boardRowLine(board({ roots: [], count: 0, polledAt: ago(now, 12 * SECOND) }), now).text).toBe('1 query · every 1m · polled 12 s ago');
  });

  it('reads not polled yet for a board never swept', () => {
    expect(boardRowLine(board({ polledAt: null }), Date.now()).text).toBe('2 roots · 1 query · 14 issues · every 1m · not polled yet');
    expect(boardRowLine(board({ interval: 'off', polledAt: null }), Date.now()).text).toBe('2 roots · 1 query · 14 issues · sync off · not polled yet');
  });

  it('is failing when the last sweep left a failure', () => {
    const now = Date.now();
    const row = boardRowLine(
      board({
        polledAt: ago(now, SECOND),
        failures: [
          { kind: 'root', id: 'PAY-9', message: 'Issue does not exist' },
          { kind: 'query', id: 'q_1', message: 'Bad JQL' }
        ]
      }),
      now
    );
    expect(row.failing).toBe(true);
    // The message travels beside the text, not inside it, so Setup can draw it red without re-deriving it.
    expect(row.failure).toBe('Issue does not exist +1 more');
    expect(row.text).not.toContain('Issue does not exist');
  });

  it('carries no failure for a clean board', () => {
    expect(boardRowLine(board({ polledAt: ago(Date.now(), SECOND) }), Date.now()).failure).toBeNull();
  });
});

describe('initialsOf', () => {
  it('takes the first letter of the first two words, upper-cased', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada')).toBe('A');
    expect(initialsOf('Jean-Luc Picard Jr')).toBe('JP');
  });

  it('reads ? for nothing', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('callsReading', () => {
  it('is the sweep over the ceiling, capped at 1', () => {
    expect(callsReading({ sweep: 40, last429At: null }, Date.now()).fraction).toBeCloseTo(0.4);
    expect(callsReading({ sweep: 140, last429At: null }, Date.now()).fraction).toBe(1);
    expect(JIRA_SWEEP_CALL_CEILING).toBe(100);
  });

  it('is red for a 429 inside the window and not past it', () => {
    const now = Date.now();
    expect(JIRA_429_RED_MS).toBe(15 * MINUTE);
    expect(callsReading({ sweep: 1, last429At: ago(now, 10 * MINUTE) }, now).red).toBe(true);
    expect(callsReading({ sweep: 1, last429At: ago(now, 16 * MINUTE) }, now).red).toBe(false);
    expect(callsReading({ sweep: 1, last429At: null }, now).red).toBe(false);
  });
});

describe('soonestBoard', () => {
  it('picks the syncing board whose next poll is soonest', () => {
    const now = Date.now();
    const slow = board({ id: 'b_slow', interval: '5m', polledAt: ago(now, MINUTE) });
    const fast = board({ id: 'b_fast', interval: '1m', polledAt: ago(now, 30 * SECOND) });
    expect(soonestBoard([slow, fast], now)?.id).toBe('b_fast');
  });

  it('is null when nothing syncs', () => {
    const now = Date.now();
    expect(soonestBoard([board({ interval: 'off', polledAt: ago(now, SECOND) })], now)).toBeNull();
    expect(soonestBoard([], now)).toBeNull();
  });

  it('puts a syncing board that has never polled ahead of every other', () => {
    const now = Date.now();
    const polled = board({ id: 'b_polled', interval: '15s', polledAt: ago(now, 14 * SECOND) });
    const fresh = board({ id: 'b_fresh', interval: '5m', polledAt: null });
    expect(soonestBoard([polled, fresh], now)?.id).toBe('b_fresh');
  });
});

describe('pickBoard', () => {
  const alpha = board({ id: 'b_a', name: 'Alpha' });
  const beta = board({ id: 'b_b', name: 'beta' });

  it('returns the stored board when it is still there', () => {
    expect(pickBoard('b_b', [beta, alpha])?.id).toBe('b_b');
  });

  it('falls to the first by name, case-insensitively, when the stored id is gone', () => {
    expect(pickBoard('b_deleted', [beta, alpha])?.id).toBe('b_a');
  });

  it('falls to the first by name for a stored value that is not a string', () => {
    expect(pickBoard(42, [beta, alpha])?.id).toBe('b_a');
    expect(pickBoard(null, [beta, alpha])?.id).toBe('b_a');
  });

  it('is null with no boards', () => {
    expect(pickBoard('b_a', [])).toBeNull();
  });

  it('does not mutate the list it is handed', () => {
    const boards = [beta, alpha];
    pickBoard(null, boards);
    expect(boards.map((b) => b.id)).toEqual(['b_b', 'b_a']);
  });
});

describe('boardsForSetup', () => {
  it('orders by name with off boards last', () => {
    const zed = board({ id: 'z', name: 'Zed', interval: '1m' });
    const alpha = board({ id: 'a', name: 'alpha', interval: 'off' });
    const beta = board({ id: 'b', name: 'Beta', interval: '5m' });
    expect(boardsForSetup([zed, alpha, beta]).map((b) => b.name)).toEqual(['Beta', 'Zed', 'alpha']);
  });
});

describe('unmappedProjects', () => {
  it('lists the projects with no repos entry', () => {
    const status = payload({
      projects: [
        { key: 'PAY', name: 'Payments' },
        { key: 'OPS', name: 'Operations' }
      ],
      repos: { PAY: ['/Users/ada/pay'] }
    });
    expect(unmappedProjects(status)).toEqual([{ key: 'OPS', name: 'Operations' }]);
  });
});

describe('displayPath', () => {
  it('writes the home prefix as ~ at a segment boundary', () => {
    expect(displayPath('/Users/ada/x', '/Users/ada')).toBe('~/x');
    expect(displayPath('/Users/ada', '/Users/ada')).toBe('~');
  });

  it('leaves a path that only shares a spelling prefix alone', () => {
    expect(displayPath('/Users/adam/x', '/Users/ada')).toBe('/Users/adam/x');
  });

  it('leaves the path alone while home is unknown', () => {
    expect(displayPath('/Users/ada/x', null)).toBe('/Users/ada/x');
  });
});

describe('constants', () => {
  it('pins the filter threshold', () => {
    expect(JIRA_BOARD_FILTER_FROM).toBe(6);
  });

  it('pins the three presets: the chip text, the row label and the JQL each', () => {
    expect(JIRA_QUERY_PRESETS).toEqual([
      { chip: 'Assigned to me', label: 'Assigned to me', jql: 'assignee = currentUser() AND statusCategory != Done' },
      { chip: 'Open in current sprint', label: 'Open in current sprint', jql: 'sprint in openSprints() AND statusCategory != Done' },
      { chip: 'Unresolved in a project…', label: 'Unresolved in <KEY>', jql: 'project = "<KEY>" AND resolution = Unresolved' }
    ]);
  });

  it('pins the custom chip beside them: an empty row labelled Custom query', () => {
    expect(JIRA_CUSTOM_QUERY).toEqual({ chip: 'Custom JQL', label: 'Custom query', jql: '' });
  });
});

describe('isJiraStatusPayload', () => {
  it('accepts a full phase-2 payload, and the unconfigured one the server sends', () => {
    expect(isJiraStatusPayload(payload())).toBe(true);
    expect(
      isJiraStatusPayload(
        payload({ configured: false, site: null, me: null, tokenKind: null, access: 'unconfigured', boards: [], armed: false, home: null })
      )
    ).toBe(true);
  });

  it('rejects a payload missing the arrays or fields a render maps or reads', () => {
    const { boards: _boards, ...noBoards } = payload();
    const { armed: _armed, ...noArmed } = payload();
    expect(isJiraStatusPayload(noBoards)).toBe(false);
    expect(isJiraStatusPayload(noArmed)).toBe(false);
  });

  it('rejects what is not an object', () => {
    expect(isJiraStatusPayload(null)).toBe(false);
    expect(isJiraStatusPayload('x')).toBe(false);
    expect(isJiraStatusPayload([])).toBe(false);
  });
});

describe('jira page key', () => {
  it('names the two pages and the stored key', () => {
    expect(JIRA_PAGES).toEqual(['board', 'setup']);
    expect(JIRA_PAGE_KEY).toBe('backlog-manager.jira-page');
    expect(isJiraPage('setup')).toBe(true);
    expect(isJiraPage('banana')).toBe(false);
    expect(isJiraPage(null)).toBe(false);
    expect(isJiraPage(42)).toBe(false);
  });
});

describe('useJiraPage', () => {
  beforeEach(() => localStorage.clear());

  it('reaches every mounted reader, and stores the value as JSON', () => {
    const a = renderHook(() => useJiraPage());
    const b = renderHook(() => useJiraPage());
    expect(a.result.current[0]).toBe('board');
    act(() => a.result.current[1]('setup'));
    expect(a.result.current[0]).toBe('setup');
    expect(b.result.current[0]).toBe('setup');
    expect(localStorage.getItem(JIRA_PAGE_KEY)).toBe('"setup"');
  });

  it('reads a stored value that is not a page as board', () => {
    localStorage.setItem(JIRA_PAGE_KEY, JSON.stringify('banana'));
    expect(renderHook(() => useJiraPage()).result.current[0]).toBe('board');
  });

  it('reads a stored value that is not JSON as board', () => {
    localStorage.setItem(JIRA_PAGE_KEY, 'setup-without-quotes');
    expect(renderHook(() => useJiraPage()).result.current[0]).toBe('board');
  });

  it('exports a setter that works without a mounted component', () => {
    const a = renderHook(() => useJiraPage());
    act(() => setJiraPage('setup'));
    expect(a.result.current[0]).toBe('setup');
  });
});

describe('sweepLine', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it('reads every 15 s while armed and idle otherwise, with the call count', () => {
    expect(sweepLine(true, { sweep: 12, last429At: null }, now)).toEqual({ lead: 'every 15 s · 12 calls', rate: 'no 429 since start', red: false });
    expect(sweepLine(false, { sweep: 0, last429At: null }, now).lead).toBe('idle · 0 calls');
    expect(sweepLine(true, { sweep: 1, last429At: null }, now).lead).toBe('every 15 s · 1 call');
  });

  it('ages a 429 through pollAge and reddens it only inside JIRA_429_RED_MS', () => {
    expect(sweepLine(true, { sweep: 3, last429At: ago(40_000) }, now)).toMatchObject({ rate: 'last 429 40 s ago', red: true });
    expect(sweepLine(true, { sweep: 3, last429At: ago(JIRA_429_RED_MS - 1) }, now).red).toBe(true);
    expect(sweepLine(true, { sweep: 3, last429At: ago(JIRA_429_RED_MS) }, now).red).toBe(false);
  });

  it('says a 429 happened, but not when, for a stamp it cannot parse — and does not redden it', () => {
    expect(sweepLine(true, { sweep: 3, last429At: 'garbage' }, now)).toMatchObject({ rate: 'last 429 at an unknown time', red: false });
  });
});

// ── The fold (grouped-board spec §3–§6) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the fold', () => {
  const now = Date.now();

  /**
   * An issue keyed `key` under `parent` (`null` for none), updated `h` hours before `now`. Every case gives each issue a distinct `h`, so the
   * `sortForBoard` order every `under` and `childrenOf` list is held in is a fact of the case rather than an accident of insertion order.
   */
  const n = (key: string, parent: string | null, h: number, over: Partial<JiraIssue> = {}): JiraIssue =>
    issue({
      key,
      summary: `${key} summary`,
      parent: parent === null ? null : { key: parent, summary: `${parent} summary` },
      updated: ago(now, h * HOUR),
      ...over
    });
  const keys = (list: readonly JiraIssue[] | undefined): string[] => (list ?? []).map((i) => i.key);
  const asObject = (m: ReadonlyMap<string, readonly JiraIssue[]>): Record<string, string[]> => Object.fromEntries([...m].map(([k, v]) => [k, keys(v)]));
  const todo = { status: { name: 'To Do', category: 'new' as const } };
  const doing = { status: { name: 'In Progress', category: 'indeterminate' as const } };
  const done = { status: { name: 'Done', category: 'done' as const } };

  /** `foldBoard`, plus the one property every case owes: each input key lands exactly once, as a top or in exactly one `under` list. */
  function fold(input: JiraIssue[]): JiraFold {
    const f = foldBoard(input);
    const landed = [...keys(f.tops), ...[...f.under.values()].flatMap((l) => keys(l))].sort();
    expect(landed).toEqual(keys(input).sort());
    return f;
  }

  describe('foldBoard', () => {
    it('folds a depth-1 child under its parent', () => {
      const f = fold([n('E1', null, 5), n('S1', 'E1', 3)]);
      expect(keys(f.tops)).toEqual(['E1']);
      expect(asObject(f.under)).toEqual({ E1: ['S1'] });
      expect(asObject(f.childrenOf)).toEqual({ E1: ['S1'] });
      expect(f.childrenOf.has('S1')).toBe(false);
    });

    it('folds depth 2 and 3 into the topmost ancestor, in sortForBoard order, with one childrenOf edge per level', () => {
      const f = fold([n('E1', null, 5), n('S1', 'E1', 3), n('T1', 'S1', 4), n('U1', 'T1', 1)]);
      expect(keys(f.tops)).toEqual(['E1']);
      expect(asObject(f.under)).toEqual({ E1: ['U1', 'S1', 'T1'] });
      expect(asObject(f.childrenOf)).toEqual({ E1: ['S1'], S1: ['T1'], T1: ['U1'] });
    });

    it('makes an issue whose parent is off the board a top, and its crumb still names that parent', () => {
      const s2 = n('S2', 'X-9', 2);
      const f = fold([n('E1', null, 5), s2]);
      expect(keys(f.tops)).toEqual(['E1', 'S2']);
      expect(f.under.size).toBe(0);
      expect(crumbText(crumbOf(s2, board({ roots: [] }), null))).toBe('↳ X-9 X-9 summary');
    });

    it('lifts the open children of a parent dropped by the Done window (absent from the list)', () => {
      const f = fold([n('S1', 'E1', 3), n('T1', 'S1', 4)]);
      expect(keys(f.tops)).toEqual(['S1']);
      expect(asObject(f.under)).toEqual({ S1: ['T1'] });
    });

    it('folds a query hit that is also a descendant of a root like any other descendant', () => {
      const f = fold([n('E1', null, 5), n('S1', 'E1', 3), n('Q1', 'S1', 2)]);
      expect(keys(f.tops)).toEqual(['E1']);
      expect(keys(f.under.get('E1'))).toContain('Q1');
      expect(asObject(f.childrenOf)).toEqual({ E1: ['S1'], S1: ['Q1'] });
    });

    it('terminates on a self-parent, which is its own top', () => {
      const f = fold([n('A', 'A', 1)]);
      expect(keys(f.tops)).toEqual(['A']);
      expect(f.under.size).toBe(0);
      expect(f.childrenOf.size).toBe(0);
    });

    it('draws a two-cycle as both members side by side, in input order, with no edge between them', () => {
      const f = fold([n('A', 'B', 1), n('B', 'A', 2)]);
      expect(keys(f.tops)).toEqual(['A', 'B']);
      expect(f.under.size).toBe(0);
      expect(f.childrenOf.size).toBe(0);
    });

    it('folds a child of a cycle member under that member, and nothing between the members', () => {
      const f = fold([n('A', 'B', 1), n('B', 'A', 2), n('C', 'A', 3)]);
      expect(keys(f.tops)).toEqual(['A', 'B']);
      expect(asObject(f.under)).toEqual({ A: ['C'] });
      expect(asObject(f.childrenOf)).toEqual({ A: ['C'] });
    });

    it('never mutates the list it is given', () => {
      const input = [n('T1', 'S1', 4), n('E1', null, 5), n('U1', 'T1', 1), n('S1', 'E1', 3)];
      const before = [...input];
      fold(input);
      expect(input).toHaveLength(before.length);
      input.forEach((x, i) => expect(x).toBe(before[i]));
    });
  });

  describe('sortTops', () => {
    it('ranks a top by the newest updated across it and everything folded under it', () => {
      const p = n('P', null, 5 * 24);
      const q = n('Q', null, 24);
      const f = fold([q, p, n('P1', 'P', 0)]);
      expect(keys(sortTops(f.tops, f.under))).toEqual(['P', 'Q']);
    });

    it('breaks a tie on the newest stamp by key in plain string order', () => {
      const f = fold([n('B-2', null, 3), n('A-1', null, 3)]);
      expect(keys(sortTops(f.tops, f.under))).toEqual(['A-1', 'B-2']);
    });

    it('sorts an unparseable stamp last, and returns a new array', () => {
      const tops = [n('X', null, 0, { updated: 'not a date' }), n('Y', null, 30 * 24)];
      const sorted = sortTops(tops, new Map());
      expect(keys(sorted)).toEqual(['Y', 'X']);
      expect(sorted).not.toBe(tops);
      expect(keys(tops)).toEqual(['X', 'Y']);
    });
  });

  describe('foldProgress and progressLine', () => {
    const many = (count: number, over: Partial<JiraIssue>, tag: string): JiraIssue[] => Array.from({ length: count }, (_, i) => n(`${tag}${i}`, null, i, over));

    it('buckets by column and prints every non-zero part, done first', () => {
      const p = foldProgress([...many(3, todo, 'T'), ...many(2, done, 'D'), ...many(4, doing, 'G')]);
      expect(p).toEqual({ done: 2, doing: 4, todo: 3 });
      expect(progressLine(p)).toBe('2 done · 4 in progress · 3 to do');
    });

    it('omits each zero part', () => {
      expect(progressLine({ done: 0, doing: 1, todo: 0 })).toBe('1 in progress');
      expect(progressLine({ done: 1, doing: 0, todo: 2 })).toBe('1 done · 2 to do');
    });

    it('is null when there is nothing to count', () => {
      expect(foldProgress([])).toEqual({ done: 0, doing: 0, todo: 0 });
      expect(progressLine({ done: 0, doing: 0, todo: 0 })).toBeNull();
    });
  });

  describe('childrenLine', () => {
    it.each([
      [0, 0, null],
      [1, 0, '1 child'],
      [3, 0, '3 children'],
      [1, 1, '1 child · 1 below them'],
      [2, 7, '2 children · 7 below them']
    ])('(%i, %i) → %p', (direct, deeper, line) => {
      expect(childrenLine(direct, deeper)).toBe(line);
    });
  });

  describe('cardFold', () => {
    const f = foldBoard([n('E1', null, 5), n('S1', 'E1', 3, doing), n('T1', 'S1', 4, done), n('U1', 'T1', 1, todo), n('R', null, 6)]);

    it('reads the top’s direct children, everything deeper, and the spread', () => {
      expect(cardFold('E1', f)).toEqual({
        line: '1 child · 2 below them',
        progress: { done: 1, doing: 1, todo: 1 },
        caption: '1 done · 1 in progress · 1 to do'
      });
    });

    it('is null for a top with nothing folded', () => {
      expect(cardFold('R', f)).toBeNull();
    });
  });

  describe('foldMatches (F1)', () => {
    const f = foldBoard([n('E1', null, 5), n('S1', 'E1', 3), n('T1', 'S1', 4), n('R', null, 6)]);
    const only = (...ks: string[]) => (i: JiraIssue): boolean => ks.includes(i.key);

    it('keeps every top that matches on its own, with no ring keys', () => {
      expect(Object.fromEntries(foldMatches(f, () => true))).toEqual({ E1: [], R: [] });
    });

    it('keeps a top for a folded match alone, naming that match', () => {
      expect(Object.fromEntries(foldMatches(f, only('T1')))).toEqual({ E1: ['T1'] });
    });

    it('draws no ring keys on a top that matches itself, even when folded issues match too', () => {
      expect(Object.fromEntries(foldMatches(f, only('E1', 'T1')))).toEqual({ E1: [] });
    });

    it('hides everything when nothing matches', () => {
      expect(foldMatches(f, () => false).size).toBe(0);
    });

    it('keeps a matching cycle member on its own', () => {
      const cycle = foldBoard([n('A', 'B', 1), n('B', 'A', 2)]);
      expect(Object.fromEntries(foldMatches(cycle, only('B')))).toEqual({ B: [] });
    });
  });

  describe('matchMarker', () => {
    it('is null for no match', () => {
      expect(matchMarker([])).toBeNull();
    });

    it('names a single match in the word itself', () => {
      expect(matchMarker(['PAY-162'])).toEqual({ word: '1 match: PAY-162', title: undefined });
    });

    it('counts several and puts their keys in the title', () => {
      expect(matchMarker(['PAY-162', 'PAY-161'])).toEqual({ word: '2 matches', title: 'PAY-162, PAY-161' });
    });
  });

  describe('modalTree', () => {
    const rows = (t: ReturnType<typeof modalTree>): string[] => t.rows.map((r) => `${r.issue.key}/${r.depth}`);

    it('draws the direct children only, at depth 0, with no board context', () => {
      const t = modalTree('SELF', [n('A', 'SELF', 1), n('B', 'SELF', 2)], null);
      expect(rows(t)).toEqual(['A/0', 'B/0']);
    });

    it('nests each child’s on-board descendants depth-first under it', () => {
      const index = new Map([
        ['A', [n('A1', 'A', 3)]],
        ['A1', [n('A2', 'A1', 4)]]
      ]);
      expect(rows(modalTree('SELF', [n('A', 'SELF', 1), n('B', 'SELF', 2)], index))).toEqual(['A/0', 'A1/1', 'A2/2', 'B/0']);
    });

    it('lists a direct child the board does not hold, with nothing under it', () => {
      const index = new Map([['A', [n('A1', 'A', 3)]]]);
      expect(rows(modalTree('SELF', [n('A', 'SELF', 1), n('Z', 'SELF', 2)], index))).toEqual(['A/0', 'A1/1', 'Z/0']);
    });

    it('draws a reparented issue once, as the direct child', () => {
      const index = new Map([['A', [n('X', 'A', 3), n('Y', 'A', 4)]]]);
      expect(rows(modalTree('SELF', [n('A', 'SELF', 1), n('X', 'SELF', 2)], index))).toEqual(['A/0', 'Y/1', 'X/0']);
    });

    it('never draws the open issue inside its own tree, nor the branch under it', () => {
      const index = new Map([
        ['A', [n('SELF', 'A', 3), n('A1', 'A', 4)]],
        ['SELF', [n('K', 'SELF', 5)]]
      ]);
      expect(rows(modalTree('SELF', [n('A', 'SELF', 1)], index))).toEqual(['A/0', 'A1/1']);
    });

    it('counts the rows as drawn', () => {
      const index = new Map([['A', [n('A1', 'A', 3, done), n('A2', 'A', 4, doing)]]]);
      const t = modalTree('SELF', [n('A', 'SELF', 1, doing), n('Z', 'SELF', 2, todo)], index);
      expect(t.progress).toEqual({ done: 1, doing: 2, todo: 1 });
    });
  });

  describe('bandSub with a fold', () => {
    const site = 'acme.atlassian.net';
    const b = board({ count: 14, polledAt: ago(now, 12 * SECOND) });

    it('counts the loaded list and adds the cards part after the sources', () => {
      expect(bandSub(b, site, now, { issues: 17, cards: 5 }).text).toBe(
        'acme.atlassian.net · 17 issues from 2 roots and 1 query · 5 cards · polled 12 s ago'
      );
    });

    it('reads today’s line exactly when nothing folds', () => {
      expect(bandSub(b, site, now, { issues: 14, cards: 14 }).text).toBe(bandSub(b, site, now, null).text);
    });

    it('says 1 card in the singular', () => {
      expect(bandSub(b, site, now, { issues: 3, cards: 1 }).text).toContain(' · 1 card · ');
    });

    it('draws no cards part on an empty list', () => {
      const text = bandSub(b, site, now, { issues: 0, cards: 0 }).text;
      expect(text).toContain('0 issues');
      expect(text).not.toContain('card');
    });

    it('still ends on the cap', () => {
      const text = bandSub(board({ truncated: true, polledAt: ago(now, 12 * SECOND) }), site, now, { issues: 17, cards: 5 }).text;
      expect(text).toContain(' · 5 cards · ');
      expect(text.endsWith(' · first 500 shown')).toBe(true);
    });
  });
});

describe('resolveJiraAction and jiraSettingOf', () => {
  const skills: JiraSkill[] = [{ id: 's_0123abcd', name: 'Groom ticket', prompt: '/jira-groom {key}' }];

  it('reads the two built-ins as themselves and a present skill id as { skill }', () => {
    expect(resolveJiraAction('execute', skills)).toBe('execute');
    expect(resolveJiraAction('context', skills)).toBe('context');
    expect(resolveJiraAction('s_0123abcd', skills)).toEqual({ skill: 's_0123abcd' });
  });

  it('falls back to execute for an id no skill holds, an empty list and anything that is not an id', () => {
    expect(resolveJiraAction('s_gone', [])).toBe('execute');
    expect(resolveJiraAction('s_ffffffff', skills)).toBe('execute');
    expect(resolveJiraAction('', skills)).toBe('execute');
    expect(resolveJiraAction('skill:s_0123abcd', skills)).toBe('execute');
  });

  it('jiraSettingOf is its inverse', () => {
    expect(jiraSettingOf('execute')).toBe('execute');
    expect(jiraSettingOf('context')).toBe('context');
    expect(jiraSettingOf({ skill: 's_0123abcd' })).toBe('s_0123abcd');
    for (const setting of ['execute', 'context', 's_0123abcd']) expect(jiraSettingOf(resolveJiraAction(setting, skills))).toBe(setting);
  });
});

describe('runChipState', () => {
  const mapped = { PAY: ['/home/ada/pay'] };
  const session = { name: 'jira PAY-1', startedAt: '2026-10-19T10:00:00.000Z', repo: '/home/ada/pay', starting: false };

  it('is no-repo while the issue’s project has no mapped path, an empty list included', () => {
    expect(runChipState(issue(), payload({ repos: {} }))).toBe('no-repo');
    expect(runChipState(issue(), payload({ repos: { PAY: [] } }))).toBe('no-repo');
    expect(runChipState(issue(), payload({ repos: { OPS: ['/home/ada/ops'] } }))).toBe('no-repo');
  });

  it('is live for a mapped project with a session on the key, starting or not', () => {
    expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': session } }))).toBe('live');
    expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': { ...session, starting: true } } }))).toBe('live');
  });

  it('is ready for a mapped project with no session on that key, whatever another key holds', () => {
    expect(runChipState(issue(), payload({ repos: mapped }))).toBe('ready');
    expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-2': session } }))).toBe('ready');
  });
});

describe('defaultModeFor', () => {
  it('is plan for context and acceptEdits for execute and for a skill', () => {
    expect(defaultModeFor('context')).toBe('plan');
    expect(defaultModeFor('execute')).toBe('acceptEdits');
    expect(defaultModeFor({ skill: 's_0123abcd' })).toBe('acceptEdits');
  });
});
