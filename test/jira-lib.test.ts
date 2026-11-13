/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';

import { setJiraPage, useJiraPage } from '../client/src/hooks/useJiraPage';
import {
  JIRA_429_RED_MS,
  failureOf,
  jiraPollReading,
  boardPollReading,
  JIRA_BOARD_FILTER_FROM,
  JIRA_COLUMNS,
  JIRA_CUSTOM_QUERY,
  JIRA_QUERY_PRESETS,
  dispatchJira,
  fetchJiraPrompt,
  fetchJiraRefs,
  fetchJiraWorktrees,
  saveRepoDefaults,
  fetchAgeLine,
  branchPickerOptions,
  branchSheetDefaults,
  branchRefusal,
  branchDraft,
  branchChoiceOf,
  branchDispatchFields,
  draftRefusal,
  ticketWorktrees,
  removeCommand,
  repoWorktrees,
  treeLiveKey,
  continueOffTicket,
  stopJira,
  transitionOptions,
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
  rolledUpdated,
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
  parseJiraBoardIssues,
  defaultModeFor,
  jiraSettingOf,
  jiraWritesStand,
  resolveJiraAction,
  runChipState,
  pickBoard,
  soonestBoard,
  sortForBoard,
  unmappedProjects,
  priorityTone,
  typeTone,
  statusTone
} from '../client/src/lib/jira';
import type { JiraFold } from '../client/src/lib/jira';
import { DELIVERY_FILTER_LABELS, effectiveDeliveryFilter } from '../client/src/lib/delivery';
import { NO_JIRA_FILTERS, NO_JIRA_PANEL_FILTERS, boardFilterCount, boardFilterOptions, clampJiraPanelFilters, effectiveBoardFilters, launchFootLine, matchesBoardFilters } from '../client/src/lib/jira';
import { modelEffortFlags } from '../client/src/lib/agents';
import { isJiraPage, JIRA_PAGE_KEY, JIRA_PAGES } from '../client/src/lib/jira-page';
import { SHELF_LIMIT, boardAgents, boardShelves, childSessions, deckCrumb, deckGroup, deckTally, endedLine, topSessionCell } from '../client/src/lib/jira-deck';
import { elapsedSince, formatCreated } from '../client/src/lib/item-age';
import type { JiraBoard, JiraBoardStatus, JiraIssue, JiraLiveSession, JiraRepoRefs, JiraSessionsPayload, JiraSkill, JiraStatusPayload } from '../shared/types';
import { daysAgoStamp } from './helpers/dates';

/**
 * The zone every reading below is taken in (#241) — the global `TZ` pin (`test/helpers/global-setup.ts`), so the expected values written before the zone
 * became an argument still hold, and so a component mounted without `TimeZoneProvider` (whose default is the browser's zone) reads the same one.
 */
const ZONE = 'America/New_York';

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
    repoDefaults: {},
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
    expect(issueDatesLine(i, at, ZONE)).toBe(`${formatCreated(i.created, at, ZONE)} · 4m`);
  });

  it('takes the year suffix of created from the now it is given', () => {
    const i = issue({ created: '2020-06-15T10:00:00.000Z', updated: '2020-06-16T10:00:00.000Z' });
    expect(issueDatesLine(i, Date.parse('2026-12-01T00:00:00Z'), ZONE)).toBe("jun 15 '20 · " + elapsedSince(i.updated, Date.parse('2026-12-01T00:00:00Z')));
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
      facts: ['2 roots', '1 query', '14 issues', 'every 1m'],
      age: 'polled 12 s ago',
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

  it('splits the line into facts and an age: an off board says sync off and last polled', () => {
    const now = Date.now();
    const row = boardRowLine(board({ interval: 'off', polledAt: ago(now, 12 * SECOND) }), now);
    expect(row.facts).toEqual(['2 roots', '1 query', '14 issues', 'sync off']);
    expect(row.age).toBe('last polled 12 s ago');
  });

  it('has no age for a never-polled board, and its facts still end on the interval', () => {
    const row = boardRowLine(board({ polledAt: null }), Date.now());
    expect(row.facts).toEqual(['2 roots', '1 query', '14 issues', 'every 1m']);
    expect(row.age).toBeNull();
  });

  it('counts a three-root board in its facts and leaves the zero counts out', () => {
    const now = Date.now();
    const row = boardRowLine(board({ roots: ['A-1', 'A-2', 'A-3'], queries: [], count: 0, polledAt: ago(now, 12 * SECOND) }), now);
    expect(row.facts).toEqual(['3 roots', 'every 1m']);
    expect(row.age).toBe('polled 12 s ago');
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

// #376: the Jira chip's POLL reading, moved here out of JiraChip.tsx; its last three rungs are `countdownReading` (lib/tracker.ts).
describe('boardPollReading', () => {
  const NOW = Date.parse('2026-09-18T12:00:00Z');
  const one = (over: Partial<JiraBoardStatus>): JiraBoardStatus =>
    ({ id: 'b_00000001', name: 'Platform', roots: [], queries: [], interval: '1m', polledAt: null, count: 0, truncated: false, failures: [], ...over }) as JiraBoardStatus;

  it('reads syncing… on a full green bar while its `now` is out, whatever the interval', () => {
    expect(boardPollReading(one({ interval: 'off' }), NOW, true)).toEqual({ value: 'syncing…', fraction: 1, tone: 'green' });
    expect(boardPollReading(one({ polledAt: new Date(NOW).toISOString() }), NOW, true)).toEqual({ value: 'syncing…', fraction: 1, tone: 'green' });
  });

  it('reads sync off, amber and empty, for an off board', () => {
    expect(boardPollReading(one({ interval: 'off', polledAt: new Date(NOW - 5_000).toISOString() }), NOW, false)).toEqual({ value: 'sync off', fraction: null, tone: 'amber' });
  });

  it('counts down on the board’s own interval, … before its first poll, overdue after two silent intervals', () => {
    expect(boardPollReading(one({ polledAt: new Date(NOW - 15_000).toISOString() }), NOW, false)).toEqual({ value: '45s', fraction: 0.25, tone: 'green' });
    expect(boardPollReading(one({ polledAt: null }), NOW, false)).toEqual({ value: '…', fraction: null, tone: 'green' });
    expect(boardPollReading(one({ polledAt: new Date(NOW - 121_000).toISOString() }), NOW, false)).toEqual({ value: 'overdue', fraction: 1, tone: 'amber' });
  });

  it('is what the chip’s POLL meter reads for the soonest board', () => {
    const a = one({ id: 'b_a', polledAt: new Date(NOW - 50_000).toISOString() });
    const b = one({ id: 'b_b', polledAt: new Date(NOW - 10_000).toISOString() });
    expect(jiraPollReading([b, a], NOW)).toEqual(boardPollReading(a, NOW, false));
  });
});

describe('jiraPollReading', () => {
  it('reads — on an empty green bar with no boards', () => {
    expect(jiraPollReading([], Date.now())).toEqual({ value: '—', fraction: null, tone: 'green' });
  });

  it('reads sync off, amber, when every board is off', () => {
    expect(jiraPollReading([board({ interval: 'off' }), board({ id: 'b_2', interval: 'off' })], Date.now())).toEqual({
      value: 'sync off',
      fraction: null,
      tone: 'amber'
    });
  });

  it('reads … for a syncing board that has never polled', () => {
    expect(jiraPollReading([board({ interval: '1m', polledAt: null })], Date.now())).toEqual({ value: '…', fraction: null, tone: 'green' });
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

describe('clampJiraPanelFilters', () => {
  it('keeps every well-shaped field, `no sprint` (null) included', () => {
    expect(clampJiraPanelFilters({ type: 'Bug', assignee: 'unassigned', sprint: null, statuses: ['To Do'], delivery: 'failing' })).toEqual({
      type: 'Bug',
      assignee: 'unassigned',
      sprint: null,
      statuses: ['To Do'],
      delivery: 'failing'
    });
  });

  it('reads a bogus or missing delivery as all, and keeps each real value', () => {
    expect(clampJiraPanelFilters({ delivery: 'bogus' }).delivery).toBe('all');
    expect(clampJiraPanelFilters({ type: 'Bug' }).delivery).toBe('all');
    expect(clampJiraPanelFilters({ delivery: 7 }).delivery).toBe('all');
    for (const d of ['all', 'has-mr', 'failing', 'done-not-merged'] as const) expect(clampJiraPanelFilters({ delivery: d }).delivery).toBe(d);
  });

  it('reads each wrong-shaped field as its any, without costing the others', () => {
    expect(clampJiraPanelFilters({ type: 7, assignee: 'boss', sprint: 3, statuses: ['To Do', 5, null] })).toEqual({
      ...NO_JIRA_PANEL_FILTERS,
      statuses: ['To Do']
    });
    expect(clampJiraPanelFilters({ statuses: 'To Do', sprint: 'Sprint 9' })).toEqual({ ...NO_JIRA_PANEL_FILTERS, sprint: 'Sprint 9' });
  });

  it.each([[null], [undefined], ['banana'], [42], [['To Do']]])('reads %p as no filter at all', (v) => {
    expect(clampJiraPanelFilters(v)).toEqual(NO_JIRA_PANEL_FILTERS);
  });
});

describe('boardFilterCount and the delivery filter', () => {
  it('counts a delivery pick as one, on top of the other four', () => {
    expect(boardFilterCount(NO_JIRA_FILTERS)).toBe(0);
    expect(boardFilterCount({ ...NO_JIRA_FILTERS, delivery: 'failing' })).toBe(1);
    expect(boardFilterCount({ ...NO_JIRA_FILTERS, type: 'Bug', statuses: ['To Do'], delivery: 'has-mr' })).toBe(3);
  });

  it('counts the effective value: a stored pick is not counted while delivery is not shown', () => {
    const stored = { ...NO_JIRA_FILTERS, delivery: 'failing' as const };
    expect(boardFilterCount({ ...stored, delivery: effectiveDeliveryFilter(stored.delivery, false) })).toBe(0);
    expect(boardFilterCount({ ...stored, delivery: effectiveDeliveryFilter(stored.delivery, true) })).toBe(1);
  });
});

describe('the status filter', () => {
  const todo = issue({ key: 'PAY-1', status: { name: 'To Do', category: 'new' } });
  const doing = issue({ key: 'PAY-2', status: { name: 'In Progress', category: 'indeterminate' } });
  const done = issue({ key: 'PAY-3', status: { name: 'Done', category: 'done' } });
  const review = issue({ key: 'PAY-4', status: { name: 'Code Review', category: 'indeterminate' } });

  it('offers statuses in workflow order — category first, then name — whatever order the list came in', () => {
    expect(boardFilterOptions([done, review, todo, doing]).statuses).toEqual(['To Do', 'Code Review', 'In Progress', 'Done']);
  });

  it('keeps an issue whose status is in the set; an empty set keeps everything', () => {
    const f = { ...NO_JIRA_FILTERS, statuses: ['To Do', 'In Progress'] };
    expect([todo, doing, done, review].filter((i) => matchesBoardFilters(i, f, null)).map((i) => i.key)).toEqual(['PAY-1', 'PAY-2']);
    expect([todo, doing, done].every((i) => matchesBoardFilters(i, NO_JIRA_FILTERS, null))).toBe(true);
  });

  // Per name, not all-or-nothing: a board switch that loses `In Progress` must keep the `To Do` half rather than drop the whole pick or empty the board.
  it('drops only the picked statuses the loaded list no longer offers', () => {
    const f = { ...NO_JIRA_FILTERS, statuses: ['To Do', 'In Progress'] };
    expect(effectiveBoardFilters(f, boardFilterOptions([todo, done]), null).statuses).toEqual(['To Do']);
    expect(effectiveBoardFilters(f, boardFilterOptions([done]), null).statuses).toEqual([]);
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

  it('rejects a payload without skills (the Dispatch row maps it) and one whose live is not a plain object (runChipState reads it)', () => {
    const { skills: _skills, ...noSkills } = payload();
    const { live: _live, ...noLive } = payload();
    expect(isJiraStatusPayload(noSkills)).toBe(false);
    expect(isJiraStatusPayload({ ...payload(), skills: null })).toBe(false);
    expect(isJiraStatusPayload({ ...payload(), skills: {} })).toBe(false);
    expect(isJiraStatusPayload(noLive)).toBe(false);
    expect(isJiraStatusPayload({ ...payload(), live: null })).toBe(false);
    expect(isJiraStatusPayload({ ...payload(), live: [] })).toBe(false);
    expect(isJiraStatusPayload(payload({ skills: [{ id: 's_0123abcd', name: 'Groom', prompt: '/g' }] }))).toBe(true);
  });

  it('rejects what is not an object', () => {
    expect(isJiraStatusPayload(null)).toBe(false);
    expect(isJiraStatusPayload('x')).toBe(false);
    expect(isJiraStatusPayload([])).toBe(false);
  });
});

describe('parseJiraBoardIssues', () => {
  const row = { key: 'A-1', summary: 's' };

  it('returns the rows and the stamp of a good answer unchanged', () => {
    expect(parseJiraBoardIssues({ issues: [row], polledAt: '2026-11-04T00:00:00Z' })).toEqual({ issues: [row], polledAt: '2026-11-04T00:00:00Z' });
  });

  it('reads an absent or non-string polledAt as null', () => {
    expect(parseJiraBoardIssues({ issues: [row] })?.polledAt).toBeNull();
    expect(parseJiraBoardIssues({ issues: [row], polledAt: 3 })?.polledAt).toBeNull();
  });

  it('answers null for what has no issues array', () => {
    for (const bad of [null, 'x', [], {}, { issues: 'x' }]) expect(parseJiraBoardIssues(bad)).toBeNull();
  });

  it('filters a bad row rather than refusing the payload, because one bad row must not blank a board', () => {
    expect(parseJiraBoardIssues({ issues: [null, 3, {}, { key: 'A-1' }, { summary: 's' }, row] })?.issues).toEqual([row]);
  });

  it('reads an empty board as an empty answer, not as no answer', () => {
    expect(parseJiraBoardIssues({ issues: [] })).toEqual({ issues: [], polledAt: null });
  });
});

describe('jira page key', () => {
  it('names the three pages and the stored key', () => {
    expect(JIRA_PAGES).toEqual(['board', 'sessions', 'setup']);
    expect(isJiraPage('sessions')).toBe(true);
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

  describe('rolledUpdated', () => {
    it('is the newest folded issue\u2019s stamp, as given, when a child is newer than the top', () => {
      const p = n('P', null, 5 * 24);
      const c = n('P1', 'P', 24);
      const f = fold([p, c]);
      expect(rolledUpdated(f.tops[0], f.under)).toBe(c.updated);
    });

    it('is the top\u2019s own stamp with nothing folded under it', () => {
      const p = n('P', null, 3);
      expect(rolledUpdated(p, new Map())).toBe(p.updated);
    });

    it('skips an unparseable top stamp for a parseable child, and is null when nothing parses', () => {
      const bad = n('P', null, 0, { updated: 'not a date' });
      const c = n('P1', 'P', 2);
      expect(rolledUpdated(bad, new Map([['P', [c]]]))).toBe(c.updated);
      expect(rolledUpdated(bad, new Map([['P', [n('P2', 'P', 0, { updated: '' })]]]))).toBeNull();
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
    // A stored review is not a setting: it never resolves, so the default reads execute (the review action is a button's, never a default).
    expect(resolveJiraAction('review', skills)).toBe('execute');
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
  const session = { sessionId: 's1', name: 'jira PAY-1', startedAt: '2026-10-19T10:00:00.000Z', repo: '/home/ada/pay', starting: false };

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

  // Jira sessions Task 10: once the sessions payload has landed the gate is a live `run` LINK (spec §5's one-run rule) or a reservation — the one live entry
  // that has no link yet. `status.live` is the same links plus those reservations, so the two never contradict; a branch or manual link never holds it.
  describe('with the sessions payload', () => {
    const link = (over: Partial<JiraSessionsPayload['links'][number]> = {}): JiraSessionsPayload['links'][number] =>
      ({
        key: 'PAY-1', sessionId: 's1', how: 'run', action: 'context', name: 'jira PAY-1', repo: '/home/ada/pay', branch: null, surface: 'dashboard', model: null,
        effort: null, snapshot: { summary: 'x', type: 'Story', parentKey: null }, startedAt: '2026-10-19T10:00:00.000Z', endedAt: null, endReason: null,
        quietSince: null, reattachedAt: null, state: 'working', row: null, stateSince: '2026-10-19T10:00:00.000Z', ...over
      }) as JiraSessionsPayload['links'][number];
    const sessions = (...links: JiraSessionsPayload['links']): JiraSessionsPayload => ({ links, reachable: true, rowsAt: null });

    it('is live for a live run link on the key, and for nothing else the payload holds', () => {
      expect(runChipState(issue(), payload({ repos: mapped }), sessions(link()))).toBe('live');
      expect(runChipState(issue(), payload({ repos: mapped }), sessions(link({ how: 'branch' })))).toBe('ready');
      expect(runChipState(issue(), payload({ repos: mapped }), sessions(link({ how: 'manual' })))).toBe('ready');
      expect(runChipState(issue(), payload({ repos: mapped }), sessions(link({ endedAt: '2026-10-19T11:00:00.000Z', state: 'ended' })))).toBe('ready');
      expect(runChipState(issue(), payload({ repos: mapped }), sessions(link({ key: 'PAY-2' })))).toBe('ready');
      expect(runChipState(issue(), payload({ repos: mapped }), sessions())).toBe('ready');
    });

    it('is live for a starting reservation, which the sessions payload cannot carry', () => {
      expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': { ...session, starting: true } } }), sessions())).toBe('live');
    });

    it('is live for a confirmed non-starting status entry the landed sessions payload has no link for yet (ruling 95: the union, not payload-then-fallback)', () => {
      // A Start landed and the server confirmed it; the sessions poll has not seen the run link. Reading `ready` here re-offered Start for up to a poll.
      expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': session } }), sessions())).toBe('live');
      expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': session } }), sessions(link({ key: 'PAY-2' })))).toBe('live');
      // Neither source holds the key: a branch-only link and an empty status entry map stay `ready`.
      expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-2': session } }), sessions(link({ how: 'branch' })))).toBe('ready');
    });

    it('still answers no-repo first, and reads the old live entry while the payload is null', () => {
      expect(runChipState(issue(), payload({ repos: {} }), sessions(link()))).toBe('no-repo');
      expect(runChipState(issue(), payload({ repos: mapped, live: { 'PAY-1': session } }), null)).toBe('live');
    });
  });
});

describe('defaultModeFor', () => {
  it('per action (the setting is empty): plan for context and acceptEdits for execute and for a skill', () => {
    expect(defaultModeFor('context', '')).toBe('plan');
    expect(defaultModeFor('execute', '')).toBe('acceptEdits');
    expect(defaultModeFor({ skill: 's_0123abcd' }, '')).toBe('acceptEdits');
  });

  it('a fixed setting wins for every action, context included', () => {
    expect(defaultModeFor('context', 'auto')).toBe('auto');
    expect(defaultModeFor('execute', 'auto')).toBe('auto');
    expect(defaultModeFor({ skill: 's_0123abcd' }, 'bypassPermissions')).toBe('bypassPermissions');
    expect(defaultModeFor('execute', 'plan')).toBe('plan');
  });
});

describe('the launch sheet wire', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const answer = (status: number, body: unknown, text?: string): jest.Mock =>
    (global.fetch = jest.fn().mockResolvedValue({
      ok: status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(text ?? '')
    })) as jest.Mock;

  it('transitionOptions names by landing status, and falls back to the transition name only where two land in one', () => {
    const t = (id: string, name: string, to: string) => ({ id, name, to: { name: to, category: 'indeterminate' as const } });
    expect(transitionOptions([t('1', 'Start', 'In Progress'), t('2', 'Finish', 'Done')])).toEqual([
      { value: '1', label: 'In Progress' },
      { value: '2', label: 'Done' }
    ]);
    expect(transitionOptions([t('1', 'Review', 'Done'), t('2', 'Close', 'Done')]).map((o) => o.label)).toEqual(['Review', 'Close']);
  });

  it('fetchJiraPrompt escapes the skill colon and the repo path once, and reads text', async () => {
    const f = answer(200, null, 'the prompt');
    await expect(fetchJiraPrompt('PAY-1', { skill: 's_0a1b2c3d' }, '/Users/a/b', { mode: 'none' })).resolves.toBe('the prompt');
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=skill%3As_0a1b2c3d&repo=%2FUsers%2Fa%2Fb&mode=none');
  });

  it('fetchJiraPrompt rejects with the server sentence, else HTTP <status>', async () => {
    answer(400, { error: 'unknown skill s_deadbeef' });
    await expect(fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'none' })).rejects.toThrow('unknown skill s_deadbeef');
    answer(502, 'not json');
    await expect(fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'none' })).rejects.toThrow('HTTP 502');
  });

  it('dispatchJira posts the request as JSON and rejects with the 409 sentence', async () => {
    const req = { key: 'PAY-1', repo: '/r', action: 'execute' as const, assign: false, transitionId: null, mode: 'none' as const, permissionMode: 'plan' as const, remoteControl: true };
    const f = answer(200, { sessionId: 's1' });
    await expect(dispatchJira(req)).resolves.toEqual({ sessionId: 's1' });
    expect(f.mock.calls[0][0]).toBe('/api/agents/dispatch-jira');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual(req);
    answer(409, { error: 'PAY-1 already has a live Run session' });
    await expect(dispatchJira(req)).rejects.toThrow('PAY-1 already has a live Run session');
  });

  it('stopJira posts the key and the session it names, and rejects with the server sentence', async () => {
    const f = answer(200, { ok: true });
    await expect(stopJira('PAY-1', 's1')).resolves.toBeUndefined();
    expect(f.mock.calls[0][0]).toBe('/api/agents/jira-stop');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ key: 'PAY-1', sessionId: 's1' });
    answer(409, { error: 'PAY-1 has no live session s9' });
    await expect(stopJira('PAY-1', 's9')).rejects.toThrow('PAY-1 has no live session s9');
  });

  it('modelEffortFlags leaves the key out for the default option', () => {
    expect(modelEffortFlags('', '')).toEqual({});
    expect(Object.keys(modelEffortFlags('opus', ''))).toEqual(['model']);
    expect(modelEffortFlags('opus', 'high')).toEqual({ model: 'opus', effort: 'high' });
  });
});

describe('failureOf', () => {
  const res = (status: number, json: () => Promise<unknown>): Response => ({ ok: false, status, json }) as unknown as Response;

  it('reads the server sentence', async () => {
    await expect(failureOf(res(409, () => Promise.resolve({ error: 'nope' })))).resolves.toBe('nope');
  });

  it('falls back to the status on an empty sentence', async () => {
    await expect(failureOf(res(409, () => Promise.resolve({ error: '' })))).resolves.toBe('HTTP 409');
  });

  it('falls back to the status on a body that is not JSON', async () => {
    await expect(failureOf(res(502, () => Promise.reject(new SyntaxError('Unexpected token <'))))).resolves.toBe('HTTP 502');
  });
});

describe('jiraWritesStand', () => {
  it('is true for the two sentences the server ends a post-write failure with', () => {
    expect(jiraWritesStand('dashboard unreachable — the Jira writes stand')).toBe(true);
    expect(jiraWritesStand('transition: Jira refused it — the assign stands')).toBe(true);
  });

  it('is false for a refusal before any write, however it is worded', () => {
    expect(jiraWritesStand('transition not offered')).toBe(false);
    expect(jiraWritesStand('PAY-131 already has a live Run session')).toBe(false);
    expect(jiraWritesStand('the assign stands, they said, but this is not that sentence')).toBe(false);
  });
});

describe('the branch choice wire', () => {
  const answer = (status: number, body: unknown): jest.Mock =>
    (global.fetch = jest.fn().mockResolvedValue({
      ok: status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve('p')
    })) as jest.Mock;

  it('fetchJiraPrompt adds mode, and branch/base/openMr/target only for the modes that carry them', async () => {
    let f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'new', branch: 'feature/pay-1-x', base: 'develop', openMr: false });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=new&branch=feature%2Fpay-1-x&base=develop');
    f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'continue', branch: 'pay-1-x', openMr: true, target: 'main' });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=continue&branch=pay-1-x&openMr=true&target=main');
    f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'continue', branch: 'pay-1-x', openMr: false, target: null });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=continue&branch=pay-1-x');
  });

  it('fetchJiraRefs sends key only when there is one, and rejects with the sentence', async () => {
    const refs = { repo: '/r', available: false, reason: 'does not exist' };
    let f = answer(200, refs);
    await expect(fetchJiraRefs('/my r', 'PAY-1')).resolves.toEqual(refs);
    expect(f.mock.calls[0][0]).toBe('/api/jira/refs?repo=%2Fmy+r&key=PAY-1');
    f = answer(200, refs);
    await fetchJiraRefs('/r', null);
    expect(f.mock.calls[0][0]).toBe('/api/jira/refs?repo=%2Fr');
    answer(400, { error: '/x is not mapped' });
    await expect(fetchJiraRefs('/x', null)).rejects.toThrow('/x is not mapped');
    answer(200, { nope: 1 });
    await expect(fetchJiraRefs('/x', null)).rejects.toThrow('malformed response');
  });

  it('fetchJiraWorktrees reads the payload and rejects on a refusal or a malformed body', async () => {
    const payload = { worktrees: [], unavailable: [] };
    const f = answer(200, payload);
    await expect(fetchJiraWorktrees()).resolves.toEqual(payload);
    expect(f.mock.calls[0][0]).toBe('/api/jira/worktrees');
    answer(503, { error: 'Jira is not configured' });
    await expect(fetchJiraWorktrees()).rejects.toThrow('Jira is not configured');
    answer(200, {});
    await expect(fetchJiraWorktrees()).rejects.toThrow('malformed response');
  });

  it('saveRepoDefaults always sends both keys, null when unset', async () => {
    const f = answer(200, { path: '/r', base: null, namePattern: 'x{key}' });
    await expect(saveRepoDefaults('/r', null, 'x{key}')).resolves.toEqual({ path: '/r', base: null, namePattern: 'x{key}' });
    expect(f.mock.calls[0][0]).toBe('/api/jira/repo-defaults');
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(f.mock.calls[0][1].headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ path: '/r', base: null, namePattern: 'x{key}' });
    answer(400, { error: 'namePattern renders as x' });
    await expect(saveRepoDefaults('/r', null, 'x')).rejects.toThrow('namePattern renders as x');
  });
});

describe('fetchAgeLine', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('buckets the age of the last fetch', () => {
    expect(fetchAgeLine(null, now)).toBe('never fetched');
    expect(fetchAgeLine('garbage', now)).toBe('never fetched');
    expect(fetchAgeLine(ago(59_000), now)).toBe('as of last fetch, just now');
    expect(fetchAgeLine(ago(60_000), now)).toBe('as of last fetch, 1 min ago');
    expect(fetchAgeLine(ago(7 * 60_000), now)).toBe('as of last fetch, 7 min ago');
    expect(fetchAgeLine(ago(59 * 60_000), now)).toBe('as of last fetch, 59 min ago');
    expect(fetchAgeLine(ago(60 * 60_000), now)).toBe('as of last fetch, 1 h ago');
    expect(fetchAgeLine(ago(3 * 3_600_000), now)).toBe('as of last fetch, 3 h ago');
    expect(fetchAgeLine(ago(47 * 3_600_000), now)).toBe('as of last fetch, 47 h ago');
    expect(fetchAgeLine(ago(48 * 3_600_000), now)).toBe('as of last fetch, 2 d ago');
    expect(fetchAgeLine(ago(4 * 86_400_000 + 5_000), now)).toBe('as of last fetch, 4 d ago');
  });
  it('a stamp in the future reads just now, never negative', () => {
    expect(fetchAgeLine(ago(-5 * 60_000), now)).toBe('as of last fetch, just now');
  });
});

describe('branchPickerOptions', () => {
  const b = (name: string, over: Partial<{ local: boolean; remote: boolean; worktree: string | null; ticket: boolean }> = {}) => ({
    name,
    local: true,
    remote: true,
    sync: null,
    committedAt: '2026-10-20T12:00:00.000Z',
    worktree: null,
    ticket: false,
    ...over
  });
  // The server's order: ticket branches first, then the rest by name — a remote-only branch sorts among the locals there.
  const branches = [
    b('feature/pay-131-x', { ticket: true }),
    b('develop', { worktree: '/r' }),
    b('feature/aaa-remote', { local: false }),
    b('feature/investigation', { worktree: '/r/.claude/worktrees/inv' }),
    b('hotfix/zzz'),
    b('next-release', { local: false })
  ];
  const groups = (options: { value: string; group?: string }[]) => options.map((o) => [o.group, o.value]);

  it('groups the ticket, then other trees, then local, then remote-only, keeping the server order inside each', () => {
    expect(groups(branchPickerOptions(branches, '/r', ''))).toEqual([
      ['this ticket', 'feature/pay-131-x'],
      ['worktrees', 'feature/investigation'],
      ['local', 'develop'],
      ['local', 'hotfix/zzz'],
      ['remote', 'feature/aaa-remote'],
      ['remote', 'next-release']
    ]);
  });

  it('the mapped checkout itself is local, not a worktree', () => {
    expect(branchPickerOptions([b('develop', { worktree: '/r' })], '/r', '')[0].group).toBe('local');
  });

  it('filters by every whitespace-separated term, case-insensitively, and keeps the groups of what is left', () => {
    expect(groups(branchPickerOptions(branches, '/r', 'FEATURE'))).toEqual([
      ['this ticket', 'feature/pay-131-x'],
      ['worktrees', 'feature/investigation'],
      ['remote', 'feature/aaa-remote']
    ]);
    expect(groups(branchPickerOptions(branches, '/r', '  feat  inv '))).toEqual([['worktrees', 'feature/investigation']]);
    expect(branchPickerOptions(branches, '/r', 'nothing-like-it')).toEqual([]);
  });

  it('labels each option by its name', () => {
    expect(branchPickerOptions(branches, '/r', 'hotfix')).toEqual([{ value: 'hotfix/zzz', label: 'hotfix/zzz', group: 'local' }]);
  });
});

describe('branch choice derivations', () => {
  const branch = (name: string, ticket: boolean, extra: Partial<{ worktree: string | null }> = {}) => ({
    name,
    local: true,
    remote: false,
    sync: null,
    committedAt: '2026-10-01T00:00:00Z',
    worktree: null,
    ticket,
    ...extra
  });
  const refsOf = (branches: ReturnType<typeof branch>[], over: Partial<{ defaultBase: string | null; mainBranch: string | null }> = {}): JiraRepoRefs => ({
    repo: '/repos/app',
    available: true,
    fetchedAt: null,
    mainBranch: 'develop',
    defaultBase: 'develop',
    branches,
    ...over
  });

  describe('branchSheetDefaults', () => {
    it('context never needs a branch', () => {
      const refs = refsOf([branch('timify-123-x', true)]);
      expect(branchSheetDefaults('context', refs, 'TIMIFY-123', 'Export', undefined)).toEqual({ mode: 'none', branch: '', base: '' });
    });
    it('continues on the first ticket branch', () => {
      const refs = refsOf([branch('feature/timify-123-newest', true), branch('timify-123-older', true), branch('develop', false)]);
      expect(branchSheetDefaults('execute', refs, 'TIMIFY-123', 'Export contacts', undefined)).toEqual({
        mode: 'continue',
        branch: 'feature/timify-123-newest',
        base: ''
      });
    });
    it('without one, a new branch from the pattern and the repo default base', () => {
      expect(
        branchSheetDefaults('execute', refsOf([branch('develop', false)]), 'TIMIFY-123', 'Export contacts', { namePattern: 'feature/{key}-{slug}' })
      ).toEqual({ mode: 'new', branch: 'feature/timify-123-export-contacts', base: 'develop' });
      expect(branchSheetDefaults('execute', refsOf([]), 'TIMIFY-123', 'Export contacts', undefined).branch).toBe('timify-123-export-contacts');
    });
    it('a summary with no slug leaves the bare key', () => {
      expect(branchSheetDefaults('execute', refsOf([]), 'TIMIFY-123', '🙂🙂', undefined).branch).toBe('timify-123');
    });
    it('a null defaultBase is an empty base', () => {
      expect(branchSheetDefaults('execute', refsOf([], { defaultBase: null }), 'TIMIFY-123', 'x', undefined).base).toBe('');
    });
    it('unavailable or unread refs fall back to the stored base', () => {
      const down: JiraRepoRefs = { repo: '/r', available: false, reason: 'does not exist' };
      expect(branchSheetDefaults('execute', down, 'TIMIFY-123', 'Export', { base: 'main' })).toEqual({
        mode: 'new',
        branch: 'timify-123-export',
        base: 'main'
      });
      expect(branchSheetDefaults('execute', null, 'TIMIFY-123', 'Export', undefined)).toEqual({ mode: 'new', branch: 'timify-123-export', base: '' });
    });
    it('a skill action is treated as execute', () => {
      expect(branchSheetDefaults({ skill: 's_0a1b2c3d' }, refsOf([]), 'TIMIFY-123', 'x', undefined).mode).toBe('new');
    });
    // Ruling 15: the sheet refuses Continue on the mapped checkout's own branch, so opening on it would be a dead end.
    it('skips a ticket branch the mapped checkout holds, taking the next one, else New', () => {
      const held = { mainBranch: 'timify-123-main' };
      expect(
        branchSheetDefaults('execute', refsOf([branch('timify-123-main', true), branch('timify-123-y', true)], held), 'TIMIFY-123', 'x', undefined)
      ).toEqual({ mode: 'continue', branch: 'timify-123-y', base: '' });
      expect(branchSheetDefaults('execute', refsOf([branch('timify-123-main', true)], held), 'TIMIFY-123', 'Export', undefined)).toEqual({
        mode: 'new',
        branch: 'timify-123-export',
        base: 'develop'
      });
    });
  });

  describe('branchRefusal', () => {
    const refs = refsOf([branch('timify-123-x', true)]);
    it('none and a clean choice refuse nothing', () => {
      expect(branchRefusal('none', '', 'TIMIFY-123', refs)).toBeNull();
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', refs)).toBeNull();
      expect(branchRefusal('continue', 'timify-123-x', 'TIMIFY-123', refs)).toBeNull();
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', null)).toBeNull();
    });
    it('a Table A problem comes first, as branch <problem>', () => {
      expect(branchRefusal('new', 'a..b', 'TIMIFY-123', refs)).toEqual({ text: 'branch may not contain ..', offerContinue: false });
      expect(branchRefusal('continue', '', 'TIMIFY-123', refs)).toEqual({ text: 'branch is empty', offerContinue: false });
    });
    it('a new branch must carry the key', () => {
      expect(branchRefusal('new', 'timify-1234-x', 'TIMIFY-123', refs)).toEqual({ text: 'branch must carry TIMIFY-123', offerContinue: false });
    });
    it('a new branch that is listed offers Continue', () => {
      expect(branchRefusal('new', 'timify-123-x', 'TIMIFY-123', refs)).toEqual({ text: 'timify-123-x exists', offerContinue: true });
    });
    it('continuing on the mapped checkout branch is refused', () => {
      expect(branchRefusal('continue', 'develop', 'TIMIFY-123', refs)).toEqual({
        text: 'develop is checked out in the mapped checkout /repos/app',
        offerContinue: false
      });
    });
    it('continue does not require the key, and unavailable refs add no state checks', () => {
      expect(branchRefusal('continue', 'whatever', 'TIMIFY-123', refs)).toBeNull();
      expect(branchRefusal('continue', 'develop', 'TIMIFY-123', { repo: '/r', available: false, reason: 'does not exist' })).toBeNull();
    });
    // Ruling 16: the server refuses a new branch with no base, or a malformed one, so the sheet says it before Start rather than sending a sure 400.
    it('a new branch needs a well-formed base, checked after the branch and before the key, refs or not', () => {
      const down: JiraRepoRefs = { repo: '/r', available: false, reason: 'does not exist' };
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', refs, '')).toEqual({ text: 'base is required for a new branch', offerContinue: false });
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', down, '')).toEqual({ text: 'base is required for a new branch', offerContinue: false });
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', refs, 'a..b')).toEqual({ text: 'base may not contain ..', offerContinue: false });
      expect(branchRefusal('new', 'x y', 'TIMIFY-123', refs, '')).toEqual({ text: 'branch may hold only A-Z a-z 0-9 . _ / -', offerContinue: false });
      expect(branchRefusal('new', 'nokey', 'TIMIFY-123', refs, '')).toEqual({ text: 'base is required for a new branch', offerContinue: false });
      expect(branchRefusal('new', 'timify-123-fresh', 'TIMIFY-123', refs, 'origin/develop')).toBeNull();
      expect(branchRefusal('continue', 'timify-123-x', 'TIMIFY-123', refs, '')).toBeNull();
    });
  });

  describe('the sheet draft', () => {
    const tickets = refsOf([branch('timify-123-x', true), branch('develop', false)]);
    it('execute with a ticket branch: Continue on it, and New and the MR target still filled for a switch', () => {
      expect(branchDraft('execute', tickets, 'TIMIFY-123', 'Export contacts', undefined)).toEqual({
        mode: 'continue',
        continueBranch: 'timify-123-x',
        newBranch: 'timify-123-export-contacts',
        base: 'develop',
        openMr: false,
        target: 'develop'
      });
    });
    it('context: No branch, with the other two modes pre-filled', () => {
      expect(branchDraft('context', tickets, 'TIMIFY-123', 'Export', { namePattern: 'feature/{key}-{slug}' })).toEqual({
        mode: 'none',
        continueBranch: 'timify-123-x',
        newBranch: 'feature/timify-123-export',
        base: 'develop',
        openMr: false,
        target: 'develop'
      });
    });
    it('unread refs: the stored base fills base and target, and Continue has nothing to offer', () => {
      expect(branchDraft('execute', null, 'TIMIFY-123', 'Export', { base: 'main' })).toEqual({
        mode: 'new',
        continueBranch: '',
        newBranch: 'timify-123-export',
        base: 'main',
        openMr: false,
        target: 'main'
      });
    });
    it('the choice keeps only the fields its mode and action own', () => {
      const draft = { mode: 'continue' as const, continueBranch: 'b', newBranch: 'n', base: 'develop', openMr: true, target: 'main' };
      expect(branchChoiceOf(draft, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: true, target: 'main' });
      expect(branchChoiceOf({ ...draft, target: '' }, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: true, target: null });
      expect(branchChoiceOf({ ...draft, openMr: false }, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: false, target: null });
      expect(branchChoiceOf(draft, 'context')).toEqual({ mode: 'continue', branch: 'b', openMr: false, target: null });
      expect(branchChoiceOf({ ...draft, mode: 'new' }, 'execute')).toEqual({ mode: 'new', branch: 'n', base: 'develop', openMr: true });
      expect(branchChoiceOf({ ...draft, mode: 'new' }, { skill: 's_0a1b2c3d' })).toEqual({ mode: 'new', branch: 'n', base: 'develop', openMr: false });
      expect(branchChoiceOf({ ...draft, mode: 'none' }, 'context')).toEqual({ mode: 'none' });
    });
    it('the dispatch fields are the five flat ones, each only with its mode', () => {
      expect(branchDispatchFields({ mode: 'none' })).toEqual({ mode: 'none' });
      expect(branchDispatchFields({ mode: 'new', branch: 'n', base: 'develop', openMr: false })).toEqual({
        mode: 'new',
        branch: 'n',
        base: 'develop',
        openMr: false
      });
      expect(branchDispatchFields({ mode: 'continue', branch: 'b', openMr: true, target: 'main' })).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: true,
        target: 'main'
      });
      expect(branchDispatchFields({ mode: 'continue', branch: 'b', openMr: false, target: null })).toEqual({ mode: 'continue', branch: 'b', openMr: false });
    });
    it('the draft refusal reads the mode\'s own fields, then a typed MR target', () => {
      const draft = { mode: 'new' as const, continueBranch: 'develop', newBranch: 'timify-123-n', base: '', openMr: false, target: '' };
      expect(draftRefusal(draft, 'execute', 'TIMIFY-123', tickets)?.text).toBe('base is required for a new branch');
      expect(draftRefusal({ ...draft, mode: 'continue' }, 'execute', 'TIMIFY-123', tickets)?.text).toBe(
        'develop is checked out in the mapped checkout /repos/app'
      );
      const cont = { ...draft, mode: 'continue' as const, continueBranch: 'timify-123-x', openMr: true };
      expect(draftRefusal({ ...cont, target: 'a..b' }, 'execute', 'TIMIFY-123', null)?.text).toBe('target may not contain ..');
      expect(draftRefusal(cont, 'execute', 'TIMIFY-123', null)).toBeNull();
      expect(draftRefusal({ ...cont, target: 'a..b', openMr: false }, 'execute', 'TIMIFY-123', null)).toBeNull();
      expect(draftRefusal({ ...draft, mode: 'none' }, 'context', 'TIMIFY-123', tickets)).toBeNull();
      expect(draftRefusal({ ...draft, mode: 'continue', continueBranch: '' }, 'execute', 'TIMIFY-123', tickets)?.text).toBe('choose a branch to continue');
    });
  });

  describe('ticketWorktrees and removeCommand', () => {
    const t = (repo: string, path: string, br: string | null, main = false) => ({ repo, path, branch: br, main });
    it('drops the main tree, other tickets and detached trees; sorts by repo then path', () => {
      const payload = {
        worktrees: [
          t('/b', '/b/.worktrees/timify-123-z', 'timify-123-z'),
          t('/a', '/a', 'timify-123-main', true),
          t('/a', '/a/.worktrees/timify-1234-x', 'timify-1234-x'),
          t('/a', '/a/.worktrees/feature-timify-123-y', 'feature/timify-123-y'),
          t('/a', '/a/.worktrees/detached', null),
          t('/a', '/a/.worktrees/a-timify-123', 'a/timify-123')
        ],
        unavailable: []
      };
      expect(ticketWorktrees('TIMIFY-123', payload).map((w) => w.path)).toEqual([
        '/a/.worktrees/a-timify-123',
        '/a/.worktrees/feature-timify-123-y',
        '/b/.worktrees/timify-123-z'
      ]);
    });
    it('removeCommand quotes both paths and never forces', () => {
      const cmd = removeCommand(t("/my repos/it's", "/my repos/it's/.worktrees/x", 'x'));
      expect(cmd).toBe(`git -C '/my repos/it'\\''s' worktree remove '/my repos/it'\\''s/.worktrees/x'`);
      expect(cmd).not.toContain('--force');
    });
  });

  // M7 (final review): a Continue on a key-less branch makes a tree no card finds, so Setup lists every tree of a path, ticket or not.
  describe('repoWorktrees, treeLiveKey and continueOffTicket', () => {
    const t = (repo: string, path: string, br: string | null, main = false) => ({ repo, path, branch: br, main });
    it('repoWorktrees keeps every non-main tree of exactly that path — key-less and detached included — sorted by path', () => {
      const payload = {
        worktrees: [
          t('/a', '/a/.worktrees/timify-123-x', 'timify-123-x'),
          t('/a', '/a', 'main', true),
          t('/a', '/a/.worktrees/develop', 'develop'),
          t('/ab', '/ab/.worktrees/other', 'other'),
          t('/a', '/a/.worktrees/detached', null)
        ],
        unavailable: []
      };
      expect(repoWorktrees('/a', payload).map((w) => w.path)).toEqual(['/a/.worktrees/detached', '/a/.worktrees/develop', '/a/.worktrees/timify-123-x']);
      expect(repoWorktrees('/missing', payload)).toEqual([]);
    });
    it('treeLiveKey names the first live key, in key order, whose branch carries it — never one for a key-less or detached tree', () => {
      expect(treeLiveKey(t('/a', '/a/w', 'feature/timify-123-x'), ['PAY-1', 'TIMIFY-123'])).toBe('TIMIFY-123');
      expect(treeLiveKey(t('/a', '/a/w', 'timify-1234-x'), ['TIMIFY-123'])).toBeNull();
      expect(treeLiveKey(t('/a', '/a/w', 'develop'), ['TIMIFY-123'])).toBeNull();
      expect(treeLiveKey(t('/a', '/a/w', null), ['TIMIFY-123'])).toBeNull();
      expect(treeLiveKey(t('/a', '/a/w', 'pay-2-timify-123'), ['TIMIFY-123', 'PAY-2'])).toBe('PAY-2');
    });
    it('continueOffTicket is true only for a non-empty Continue branch without the key', () => {
      expect(continueOffTicket({ mode: 'continue', branch: 'develop', openMr: false, target: null }, 'TIMIFY-123')).toBe(true);
      expect(continueOffTicket({ mode: 'continue', branch: 'feature/timify-123-x', openMr: false, target: null }, 'TIMIFY-123')).toBe(false);
      expect(continueOffTicket({ mode: 'continue', branch: 'timify-1234', openMr: false, target: null }, 'TIMIFY-123')).toBe(true);
      expect(continueOffTicket({ mode: 'continue', branch: '  ', openMr: false, target: null }, 'TIMIFY-123')).toBe(false);
      expect(continueOffTicket({ mode: 'new', branch: 'develop', base: 'main', openMr: false }, 'TIMIFY-123')).toBe(false);
      expect(continueOffTicket({ mode: 'none' }, 'TIMIFY-123')).toBe(false);
    });
  });
});

/*
  The Board's deck and shelves (Jira sessions, Task 11; spec §7.1, C8) — `lib/jira-deck.ts`, pure. A session is a payload link; a Starting one is a status `live`
  reservation with no link, because the sessions endpoint never carries one.
*/
describe('lib/jira-deck', () => {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const hoursAgo = (h: number): string => ago(NOW, h * 3_600_000);
  type Link = JiraSessionsPayload['links'][number];
  const link = (key: string, id: string | null, state: Link['state'], startedH: number, over: Partial<Link> = {}): Link =>
    ({
      key, sessionId: id, how: 'run', action: 'context', name: 'jira run', repo: '/Users/ada/pay', branch: null, surface: 'dashboard', model: 'opus', effort: null,
      snapshot: { summary: 'x', type: 'Story', parentKey: null }, startedAt: hoursAgo(startedH), endedAt: null, endReason: null, quietSince: null, reattachedAt: null,
      state, row: null, stateSince: hoursAgo(startedH), ...over
    }) as Link;
  const answer = (links: Link[]): JiraSessionsPayload => ({ links, reachable: true, rowsAt: null }) as JiraSessionsPayload;
  const reservation = (h: number): JiraLiveSession => ({ sessionId: null, name: 'jira PAY-5', startedAt: hoursAgo(h), repo: '/Users/ada/pay', starting: true });

  const top = issue({ key: 'PAY-1', summary: 'Top' });
  const child = issue({ key: 'PAY-2', summary: 'Child', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-1', summary: 'Top' } });
  const other = issue({ key: 'PAY-3', summary: 'Other' });
  const fold = foldBoard([top, child, other]);

  it('boardAgents gives one session linked to two on-board tickets two entries with distinct ids', () => {
    const entries = boardAgents(fold, answer([link('PAY-1', 's1', 'working', 3), link('PAY-3', 's1', 'working', 3)]), {});
    expect(entries.map((e) => e.top.key).sort()).toEqual(['PAY-1', 'PAY-3']);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });

  it('deckGroup puts the four wait states in Needs you, and the rest where §7.1 says', () => {
    expect(['plan', 'permission', 'reply', 'answer'].map((s) => deckGroup(s as Link['state']))).toEqual(['needs', 'needs', 'needs', 'needs']);
    expect(deckGroup('working')).toBe('working');
    expect(deckGroup('quiet')).toBe('quiet');
    expect([deckGroup('starting'), deckGroup('lost')]).toEqual(['other', 'other']);
  });

  it('boardAgents orders by group, then newest start, and draws a reservation from `live` and never an ended link', () => {
    const entries = boardAgents(
      fold,
      answer([
        link('PAY-1', 'a', 'quiet', 5),
        link('PAY-3', 'b', 'working', 4),
        link('PAY-2', 'c', 'plan', 3),
        link('PAY-3', 'd', 'ended', 9, { endedAt: hoursAgo(8) }),
        link('PAY-99', 'e', 'working', 1)
      ]),
      { 'PAY-3': reservation(1) }
    );
    expect(entries.map((e) => `${e.issue.key}:${e.state}`)).toEqual(['PAY-2:plan', 'PAY-3:working', 'PAY-1:quiet', 'PAY-3:starting']);
    expect(deckTally(entries)).toEqual({ needs: 1, working: 1 });
  });

  it('boardAgents ignores a live entry that is not starting, and every payload when none has loaded', () => {
    expect(boardAgents(fold, null, { 'PAY-1': { ...reservation(1), starting: false, sessionId: 's' } })).toEqual([]);
  });

  it('a session on a folded child belongs to the top, and its crumb names the top', () => {
    const [entry] = boardAgents(fold, answer([link('PAY-2', 'c', 'working', 2)]), {});
    expect(entry.issue.key).toBe('PAY-2');
    expect(entry.top.key).toBe('PAY-1');
    expect(deckCrumb(entry, [])).toMatch(/^↳ PAY-1 · /);
    expect(deckCrumb(entry, [])).toContain('pay');
    const [own] = boardAgents(fold, answer([link('PAY-1', 'a', 'working', 2)]), {});
    expect(deckCrumb(own, [])).not.toContain('↳');
  });

  describe('topSessionCell (the List\u2019s Session cell)', () => {
    const tree = foldBoard([top, child, other]);
    const cellOf = (links: Link[], live: Record<string, JiraLiveSession> = {}) => topSessionCell(boardAgents(tree, answer(links), live), links, tree);

    it('names the deck\u2019s lead session per top with its own `since`: needs you on a child beats working on the top', () => {
      expect(cellOf([link('PAY-1', 'a', 'working', 3), link('PAY-2', 'b', 'plan', 2)]).get('PAY-1')).toEqual({ state: 'plan', since: hoursAgo(2), on: 'PAY-2', more: 1 });
    });

    it('a live plan on the top gives { plan, since }', () => {
      const links = [link('PAY-1', 'a', 'plan', 4)];
      expect(cellOf(links).get('PAY-1')).toEqual({ state: 'plan', since: links[0].stateSince, on: null, more: 0 });
    });

    it('lets the newest start lead inside one group: a reservation on a child outranks an older lost session on the top', () => {
      expect(cellOf([link('PAY-1', 'a', 'lost', 2)], { 'PAY-2': { ...reservation(1), starting: true } }).get('PAY-1')?.state).toBe('starting');
    });

    it('prefers a live child over an older ended top', () => {
      const cell = cellOf([link('PAY-2', 'b', 'working', 2), link('PAY-1', 'a', 'ended', 9, { endedAt: hoursAgo(8) })]);
      expect(cell.get('PAY-1')?.state).toBe('working');
    });

    it('reads an ended session on a folded child as { ended, since: endedAt }', () => {
      const cell = cellOf([link('PAY-2', 'b', 'ended', 5, { endedAt: hoursAgo(2) })]);
      expect(cell.get('PAY-1')).toEqual({ state: 'ended', since: hoursAgo(2), on: 'PAY-2', more: 0 });
    });

    it('takes the newer of two ended links', () => {
      const cell = cellOf([link('PAY-1', 'a', 'ended', 9, { endedAt: hoursAgo(8) }), link('PAY-2', 'b', 'ended', 6, { endedAt: hoursAgo(3) })]);
      expect(cell.get('PAY-1')?.since).toBe(hoursAgo(3));
    });

    it('names the child the lead runs on (`on`), and `null` when the lead runs on the top itself', () => {
      expect(cellOf([link('PAY-2', 'b', 'working', 1)]).get('PAY-1')).toMatchObject({ on: 'PAY-2', more: 0 });
      // The top's own session leads (newer start in the same group), so the cell is the top's and the child's is only counted.
      expect(cellOf([link('PAY-1', 'a', 'working', 1), link('PAY-2', 'b', 'working', 4)]).get('PAY-1')).toMatchObject({ on: null, more: 1 });
    });

    it('names the top for an ended session on the top itself, so an ended cell says where it ran too', () => {
      const cell = cellOf([link('PAY-1', 'a', 'ended', 9, { endedAt: hoursAgo(8) }), link('PAY-2', 'b', 'ended', 9, { endedAt: hoursAgo(9) })]);
      expect(cell.get('PAY-1')).toMatchObject({ state: 'ended', on: null, more: 0 });
    });

    it('has no key with nothing live or ended, and keeps two tops apart', () => {
      expect(cellOf([]).size).toBe(0);
      const both = cellOf([link('PAY-1', 'a', 'working', 3), link('PAY-3', 'b', 'quiet', 2)]);
      expect([...both].map(([k, v]) => [k, v.state])).toEqual([['PAY-1', 'working'], ['PAY-3', 'quiet']]);
    });
  });

  describe('childSessions (Detail\u2019s Children rows and the Agent pane\u2019s on-a-child line)', () => {
    const grand = issue({ key: 'PAY-4', summary: 'Grandchild', parent: { key: 'PAY-2', summary: 'Child' } });
    const keys = (entries: ReturnType<typeof childSessions>): [string, string][] => entries.map((e) => [e.issue.key, e.state]);

    it('is empty with no live session on any of the issues', () => {
      expect(childSessions([child, grand], answer([link('PAY-1', 'a', 'working', 1)]), {})).toEqual([]);
      expect(childSessions([child], null, {})).toEqual([]);
    });

    it('draws one entry per issue \u2014 the deck\u2019s lead \u2014 and orders the issues the way the deck does', () => {
      const payload = answer([
        link('PAY-2', 'a', 'working', 3),
        link('PAY-2', 'b', 'plan', 5),
        link('PAY-4', 'c', 'working', 1),
        link('PAY-4', 'd', 'ended', 9, { endedAt: hoursAgo(1) })
      ]);
      // PAY-2's plan (needs you) leads it and outranks PAY-4's working; an ended link is never a child's session.
      expect(keys(childSessions([child, grand], payload, {}))).toEqual([['PAY-2', 'plan'], ['PAY-4', 'working']]);
      const [first] = childSessions([child, grand], payload, {});
      expect(first.issue).toBe(child);
      expect(first.top).toBe(child);
      expect(first.since).toBe(payload.links[1].stateSince);
    });

    it('counts a reservation from the status as `starting`, which the sessions payload never carries', () => {
      expect(keys(childSessions([child, grand], answer([]), { 'PAY-4': { ...reservation(1), starting: true } }))).toEqual([['PAY-4', 'starting']]);
    });

    it('ignores a session on an issue that is not in the list it was handed', () => {
      expect(childSessions([grand], answer([link('PAY-2', 'a', 'working', 1)]), {})).toEqual([]);
    });
  });

  it('boardShelves takes a top with a live session on itself or a folded child off its shelf, and leaves the others', () => {
    const agents = boardAgents(fold, answer([link('PAY-2', 'c', 'working', 2)]), {});
    const shown = foldMatches(fold, () => true);
    const shelves = boardShelves(fold, shown, agents, null);
    expect(shelves.map((s) => s.slug)).toEqual(['todo', 'doing', 'done']);
    expect(shelves[0].cards.map((c) => c.issue.key)).toEqual(['PAY-3']);
  });

  it('boardShelves applies the filter to the shelves while the deck exclusion stays independent of it', () => {
    const agents = boardAgents(fold, answer([link('PAY-3', 'x', 'working', 1)]), {});
    // A filter that keeps nothing: the live top is not resurrected, and the others are gone by the filter.
    const none = boardShelves(fold, foldMatches(fold, () => false), agents, null);
    expect(none.every((s) => s.cards.length === 0)).toBe(true);
    // A filter that keeps only the live top: it stays off the shelves.
    const onlyLive = boardShelves(fold, foldMatches(fold, (i) => i.key === 'PAY-3'), agents, null);
    expect(onlyLive.every((s) => s.cards.length === 0)).toBe(true);
  });

  it('boardShelves hangs each top’s own ended sessions on its row, newest end first', () => {
    const payload = answer([
      link('PAY-3', 'o', 'ended', 9, { endedAt: hoursAgo(8) }),
      link('PAY-3', 'n', 'ended', 5, { endedAt: hoursAgo(2) }),
      link('PAY-2', 'f', 'ended', 5, { endedAt: hoursAgo(1) })
    ]);
    const shelves = boardShelves(fold, foldMatches(fold, () => true), [], payload);
    const rows = Object.fromEntries(shelves[0].cards.map((c) => [c.issue.key, c.ended.map((l) => l.sessionId)]));
    expect(rows).toEqual({ 'PAY-3': ['n', 'o'], 'PAY-1': [] });
  });

  it('SHELF_LIMIT is 8, 8 and 3', () => {
    expect(SHELF_LIMIT).toEqual({ todo: 8, doing: 8, done: 3 });
  });

  it('endedLine: nothing for none, a Reopen for one, `N sessions` for several', () => {
    expect(endedLine([], NOW)).toBeNull();
    const one = link('PAY-3', 'o', 'ended', 5, { endedAt: hoursAgo(2) });
    expect(endedLine([one], NOW)).toEqual({ text: 'run ended 2h ago', reopen: one });
    expect(endedLine([one, one], NOW)).toEqual({ text: '2 sessions', reopen: null });
    // A detected or hand-made link reads `run` too: §7.1 words the row, and `branch ended` would read as a branch that ended.
    const branch = link('PAY-3', 'b', 'ended', 5, { endedAt: hoursAgo(2), how: 'branch' });
    expect(endedLine([branch], NOW)?.text).toBe('run ended 2h ago');
  });
});

describe('card tone helpers', () => {
  it('priorityTone reads Jira names case-insensitively and sends any other string to `other`', () => {
    expect(['Highest', 'high', 'MEDIUM', 'Low', 'lowest', 'P1', '', null].map(priorityTone)).toEqual(['high', 'high', 'med', 'low', 'low', 'other', 'other', null]);
  });

  it('typeTone: a sub-task or a level >= 1 type is neutral whatever its name, then bug, story, and the rest neutral', () => {
    expect(typeTone({ name: 'Bug', level: 0, subtask: false })).toBe('bug');
    expect(typeTone({ name: 'Story', level: 0, subtask: false })).toBe('story');
    expect(typeTone({ name: 'Task', level: 0, subtask: false })).toBe('neutral');
    expect(typeTone({ name: 'Bug', level: -1, subtask: true })).toBe('neutral');
    expect(typeTone({ name: 'Story', level: 1, subtask: false })).toBe('neutral');
  });

  it('statusTone maps the three categories to the three column slugs', () => {
    expect([statusTone('new'), statusTone('indeterminate'), statusTone('done')]).toEqual(['todo', 'doing', 'done']);
  });
});

describe('launchFootLine', () => {
  it('names the checkout itself for none, a new worktree for new, and the branch for continue', () => {
    expect(launchFootLine('/Users/ada/microservice', { mode: 'none' })).toBe('Starts in microservice on the checkout itself');
    expect(launchFootLine('/Users/ada/microservice', { mode: 'new', branch: 'b', base: 'main', openMr: false })).toBe('Starts in microservice on a new worktree');
    expect(launchFootLine('/Users/ada/microservice', { mode: 'continue', branch: 'pay-131-a', openMr: false, target: null })).toBe(
      'Starts in microservice on pay-131-a'
    );
  });
  it('is null without a repository and ends after the basename without a choice', () => {
    expect(launchFootLine(null, { mode: 'none' })).toBeNull();
    expect(launchFootLine('/Users/ada/microservice', null)).toBe('Starts in microservice');
  });
});

// `lib/jira.ts` keeps its own copy of the Delivery filter values (DELIVERY_VALUES) because importing them from `lib/delivery.ts` would close an import
// cycle. This pins the copy to the labels table, the list the UI draws: a value added there and not here would be clamped to `all` on every read.
describe('clampJiraPanelFilters keeps every Delivery filter value the UI offers', () => {
  it.each(Object.keys(DELIVERY_FILTER_LABELS))('keeps `%s`', (value) => {
    expect(clampJiraPanelFilters({ ...NO_JIRA_PANEL_FILTERS, delivery: value }).delivery).toBe(value);
  });
});
