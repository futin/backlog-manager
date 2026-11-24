/**
 * @jest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, renderHook } from '@testing-library/react';

import { setJiraPage, useJiraPage } from '../../client/src/hooks/useJiraPage';
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
  fetchJiraDetail,
  fetchJiraProjects,
  fetchJiraPrompt,
  fetchJiraRefs,
  fetchJiraSessions,
  fetchJiraWorktrees,
  saveRepoDefaults,
  fetchAgeLine,
  branchPickerOptions,
  branchSheetDefaults,
  branchRefusal,
  branchDraft,
  preferredBranchApplies,
  lastJiraLink,
  prefilledLine,
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
  laneBoard,
  NO_PARENT_LANE,
  laneViews,
  laneParents,
  laneCell,
  LANE_CELL_LIMIT,
  clampLaneFolds,
  laneOverrides,
  laneOpen,
  setLaneFold,
  foldProgress,
  modalTree,
  progressLine,
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
  dispatchReply,
  replyRepos,
  jiraSettingOf,
  jiraWritesStand,
  isReviewSkill,
  resolveJiraAction,
  runChipState,
  runBlockTitle,
  pickBoard,
  soonestBoard,
  sortForBoard,
  unmappedProjects,
  priorityTone,
  typeTone,
  statusTone
} from '../../client/src/lib/jira';
import type { JiraLane, JiraLanes, JiraLaneFolds, JiraLaneView } from '../../client/src/lib/jira';
import { DELIVERY_FILTER_LABELS, effectiveDeliveryFilter } from '../../client/src/lib/delivery';
import { NO_JIRA_FILTERS, NO_JIRA_PANEL_FILTERS, boardFilterCount, boardFilterOptions, clampJiraPanelFilters, effectiveBoardFilters, launchFootLine, matchesBoardFilters } from '../../client/src/lib/jira';
import { modelEffortFlags } from '../../client/src/lib/agents';
import { isJiraPage, JIRA_PAGE_KEY, JIRA_PAGES } from '../../client/src/lib/jira-page';
import { boardAgents, childSessions, deckCrumb, deckGroup, deckTally, endedByKey, endedLine, sessionCells } from '../../client/src/lib/jira-deck';
import { elapsedSince, formatCreated } from '../../client/src/lib/item-age';
import type { JiraBoard, JiraBoardStatus, JiraIssue, JiraLiveSession, JiraRepoRefs, JiraSessionsPayload, JiraSkill, JiraStatusPayload } from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

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
    mentions: null,
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
    expect(crumbOf(issue({ key: 'PAY-1', parent: { key: 'PAY-0', summary: 'Epic', type: null, status: null } }), b, me)).toEqual({ kind: 'root' });
  });

  it('reads parent before mine', () => {
    expect(crumbOf(issue({ key: 'PAY-2', parent: { key: 'PAY-1', summary: 'Checkout', type: null, status: null }, assignee: mine }), b, me)).toEqual({
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

  // Parent-lanes spec §1.4: the crumb reads the parent the lane model KEPT. A cycle member's raw parent is ignored, so it reads `mine` when it is mine.
  it('reads mine when the kept parent handed in is null, whatever the raw field says', () => {
    const raw = issue({ key: 'PAY-5', parent: { key: 'PAY-6', summary: 'Cycle', type: null, status: null }, assignee: mine });
    expect(crumbOf(raw, b, me, null)).toEqual({ kind: 'mine' });
    expect(crumbOf(raw, b, me)).toEqual({ kind: 'parent', key: 'PAY-6', summary: 'Cycle' });
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
    expect(bandSub(b, site, now, null)).toMatchObject({ text: 'acme.atlassian.net · 14 issues from 2 roots and 1 query · polled 12 s ago', failing: false });
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
    expect(isJiraStatusPayload(payload({ skills: [{ id: 's_0123abcd', name: 'Groom', prompt: '/g', group: 'run' }] }))).toBe(true);
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

  it('reads a parent without a type or status as null for each, keeps both when present, and leaves a null parent null', () => {
    // The wire shape of an older server: the parent has no type or status key at all.
    const bare = { ...row, parent: { key: 'PAY-1', summary: 'Checkout' } };
    expect(parseJiraBoardIssues({ issues: [bare] })?.issues[0].parent).toEqual({ key: 'PAY-1', summary: 'Checkout', type: null, status: null });
    const full = {
      ...row,
      parent: {
        key: 'PAY-1',
        summary: 'Checkout',
        type: { name: 'Epic', level: 1, subtask: false },
        status: { name: 'In Progress', category: 'indeterminate' }
      }
    };
    expect(parseJiraBoardIssues({ issues: [full] })?.issues).toEqual([full]);
    expect(parseJiraBoardIssues({ issues: [{ ...row, parent: null }] })?.issues[0].parent).toBeNull();
  });

  it('reads an empty board as an empty answer, not as no answer', () => {
    expect(parseJiraBoardIssues({ issues: [] })).toEqual({ issues: [], polledAt: null });
  });
});

describe('jira page key', () => {
  it('names the five pages and the stored key', () => {
    expect(JIRA_PAGES).toEqual(['board', 'sessions', 'mentions', 'setup', 'ticket']);
    expect(isJiraPage('ticket')).toBe(true);
    expect(isJiraPage('mentions')).toBe(true);
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

// ── Fold progress, the modal tree and the band's lane counts (grouped-board spec §3–§6, kept by parent-lanes spec §1.5) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('foldProgress, modalTree and the band’s lane counts', () => {
  const now = Date.now();

  /**
   * An issue keyed `key` under `parent` (`null` for none), updated `h` hours before `now`. Every case gives each issue a distinct `h`, so the
   * `sortForBoard` order a `childrenOf` list is held in is a fact of the case rather than an accident of insertion order.
   */
  const n = (key: string, parent: string | null, h: number, over: Partial<JiraIssue> = {}): JiraIssue =>
    issue({
      key,
      summary: `${key} summary`,
      parent: parent === null ? null : { key: parent, summary: `${parent} summary`, type: null, status: null },
      updated: ago(now, h * HOUR),
      ...over
    });
  const todo = { status: { name: 'To Do', category: 'new' as const } };
  const doing = { status: { name: 'In Progress', category: 'indeterminate' as const } };
  const done = { status: { name: 'Done', category: 'done' as const } };

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

  describe('bandSub with the lane counts', () => {
    const site = 'acme.atlassian.net';
    const b = board({ count: 14, roots: [], polledAt: ago(now, 12 * SECOND) });

    it('counts the loaded list and adds the parents part after the sources', () => {
      expect(bandSub(b, site, now, { issues: 16, parents: 8 }).text).toBe('acme.atlassian.net · 16 issues from 1 query · 8 parents · polled 12 s ago');
    });

    it('says 1 parent in the singular', () => {
      expect(bandSub(b, site, now, { issues: 3, parents: 1 }).text).toContain(' · 3 issues from 1 query · 1 parent · ');
    });

    it('draws no parents part when no lane has a parent, and reads the loaded count rather than the status poll’s', () => {
      const text = bandSub(b, site, now, { issues: 4, parents: 0 }).text;
      expect(text).toBe('acme.atlassian.net · 4 issues from 1 query · polled 12 s ago');
      expect(text).not.toContain('parent');
    });

    it('reads today’s line from the status count while the list has not loaded', () => {
      expect(bandSub(b, site, now, null).text).toBe('acme.atlassian.net · 14 issues from 1 query · polled 12 s ago');
    });

    it('still ends on the cap', () => {
      const text = bandSub(board({ truncated: true, polledAt: ago(now, 12 * SECOND) }), site, now, { issues: 17, parents: 5 }).text;
      expect(text).toContain(' · 5 parents · ');
      expect(text.endsWith(' · first 500 shown')).toBe(true);
    });
  });
});

// The band draws `bandSub` as pills (mock A, 2026-11-18): the site, one pill per count, a red pill for the failure, then a toned dot and the age. `text`
// stays the whole sentence — the row's `title`, so hovering it still reads the line the pills replaced.
describe('bandSub parts', () => {
  const site = 'acme.atlassian.net';
  const now = Date.now();

  it('splits the line into the site, the count pills, the age and the full polled phrase', () => {
    const sub = bandSub(board({ count: 14, polledAt: ago(now, 12 * SECOND) }), site, now, { issues: 16, parents: 8 });
    expect(sub.site).toBe(site);
    expect(sub.facts).toEqual(['16 issues', '8 parents', '2 roots', '1 query']);
    expect(sub.failure).toBeNull();
    expect(sub.age).toBe('12 s ago');
    expect(sub.polled).toBe('polled 12 s ago');
  });

  it('omits zero sources and the parents pill before the list loads, and puts the cap last', () => {
    const sub = bandSub(board({ roots: [], truncated: true, polledAt: ago(now, 12 * SECOND) }), site, now, null);
    expect(sub.facts).toEqual(['14 issues', '1 query', 'first 500 shown']);
  });

  it('has no age before the first poll, and says so in the polled phrase', () => {
    const sub = bandSub(board({ polledAt: null }), site, now, null);
    expect(sub.age).toBeNull();
    expect(sub.polled).toBe('not polled yet');
  });

  it("carries Jira's failure apart from the facts", () => {
    const sub = bandSub(
      board({
        polledAt: ago(now, 12 * SECOND),
        failures: [
          { kind: 'query', id: 'q_1', message: "Field 'sprint' does not exist" },
          { kind: 'root', id: 'PAY-9', message: 'Issue does not exist' }
        ]
      }),
      site,
      now,
      null
    );
    expect(sub.failure).toBe("Field 'sprint' does not exist +1 more");
    expect(sub.facts.join(' ')).not.toContain('exist');
  });

  // The dot's tone is the shell's Jira chip's rule (`serviceTone`): late is twice the board's own interval, never polled is grey — and a failed sweep is red
  // whatever the age, because a fresh poll that could not read a query is not on time.
  it.each([
    ['green while within twice the interval', { interval: '1m' as const, polledAt: ago(now, 90 * SECOND) }, 'green'],
    ['amber past twice the interval', { interval: '1m' as const, polledAt: ago(now, 3 * MINUTE) }, 'amber'],
    ['grey before the first poll', { polledAt: null }, 'grey'],
    ['grey for a board whose sync is off', { interval: 'off' as const, polledAt: ago(now, 3 * MINUTE) }, 'grey'],
    ['red on a failed sweep, however fresh', { polledAt: ago(now, 5 * SECOND), failures: [{ kind: 'root' as const, id: 'PAY-9', message: 'gone' }] }, 'red']
  ])('the dot is %s', (_label, over, tone) => {
    expect(bandSub(board(over), site, now, null).tone).toBe(tone);
  });
});

describe('laneBoard', () => {
  const now = Date.now();
  const todo = { status: { name: 'To Do', category: 'new' as const } };
  const doing = { status: { name: 'In Progress', category: 'indeterminate' as const } };
  const done = { status: { name: 'Done', category: 'done' as const } };

  /**
   * An issue keyed `key` under `parent` (`null` for none), updated `ms` before `now`. The parent's summary is derived from its key, so two parents never
   * share one, and every case gives each issue its own `ms` unless the case is about a tie.
   */
  const n = (key: string, parent: string | null, ms: number, over: Partial<JiraIssue> = {}): JiraIssue =>
    issue({
      key,
      summary: `${key} summary`,
      parent: parent === null ? null : { key: parent, summary: `${parent} summary`, type: null, status: null },
      updated: ago(now, ms),
      ...todo,
      ...over
    });
  const keys = (list: readonly JiraIssue[] | undefined): string[] => (list ?? []).map((i) => i.key);
  const laneKeys = (list: readonly JiraLane[]): string[] => list.map((l) => l.key);
  const keySets = (m: ReadonlyMap<string, readonly JiraIssue[]>): Record<string, string[]> =>
    Object.fromEntries([...m].map(([k, v]) => [k, keys(v).sort()]));

  /**
   * `laneBoard`, plus the property every fixture owes: each input key is drawn exactly once across the whole tree, as an on-board header or as a card
   * (§1.4: never twice, never dropped). What `childrenOf` holds is pinned by its own cases below (§1.5).
   */
  function lanes(input: JiraIssue[]): JiraLanes {
    const l = laneBoard(input);
    const drawn: string[] = [];
    const visit = (lane: JiraLane): void => {
      if (lane.header !== null) drawn.push(lane.header.key);
      drawn.push(...keys(lane.cards));
      lane.lanes.forEach(visit);
    };
    l.lanes.forEach(visit);
    expect(drawn.sort()).toEqual(keys(input).sort());
    return l;
  }

  const epic = { name: 'Epic', level: 1, subtask: false };
  /** Case 1's fixture: three cards under off-board `PAY-1`, the freshest (`PAY-12`) carrying a richer parent payload than the other two. */
  const offBoardThree = (): JiraIssue[] => {
    const plain = { key: 'PAY-1', summary: 'Checkout', type: null, status: null };
    return [
      n('PAY-11', null, 3 * HOUR, { parent: plain }),
      n('PAY-12', null, 1 * HOUR, {
        parent: { key: 'PAY-1', summary: 'Checkout v2', type: epic, status: { name: 'In Progress', category: 'indeterminate' } }
      }),
      n('PAY-13', null, 2 * HOUR, { parent: { ...plain } })
    ];
  };

  it('draws one off-board lane whose stub is the freshest card’s parent', () => {
    const input = offBoardThree();
    const l = lanes(input);
    expect(l.lanes).toHaveLength(1);
    const [lane] = l.lanes;
    expect(lane.key).toBe('PAY-1');
    expect(lane.kind).toBe('off');
    expect(lane.header).toBeNull();
    expect(lane.stub).toEqual(input[1].parent);
    expect(keys(lane.cards)).toEqual(['PAY-12', 'PAY-13', 'PAY-11']);
    expect(lane.depth).toBe(0);
    expect(lane.lanes).toEqual([]);
  });

  it('reads a tied stub from whichever card sortForBoard puts first, whatever the input order', () => {
    const at = 2 * HOUR;
    const a = n('PAY-21', null, at, { parent: { key: 'PAY-1', summary: 'Checkout', type: null, status: null } });
    const b = n('PAY-22', null, at, { parent: { key: 'PAY-1', summary: 'Checkout v2', type: null, status: null } });
    const first = sortForBoard([a, b])[0];
    expect(lanes([a, b]).lanes[0].stub).toEqual(first.parent);
    expect(lanes([b, a]).lanes[0].stub).toEqual(first.parent);
    expect(lanes([b, a]).lanes[0].stub?.summary).toBe('Checkout');
  });

  it('adds a No parent lane, last, only when a card has no parent', () => {
    const l = lanes([...offBoardThree(), n('PAY-20', null, 4 * HOUR)]);
    expect(laneKeys(l.lanes)).toEqual(['PAY-1', NO_PARENT_LANE]);
    expect(NO_PARENT_LANE).toBe('none');
    expect(l.lanes[1].kind).toBe('none');
    expect(keys(l.lanes[1].cards)).toEqual(['PAY-20']);
    expect(lanes(offBoardThree()).lanes.some((x) => x.kind === 'none')).toBe(false);
  });

  it('makes an on-board parent the header of its lane and no card anywhere', () => {
    const l = lanes([n('PAY-30', null, 5 * HOUR), n('PAY-31', 'PAY-30', 1 * HOUR), n('PAY-32', 'PAY-30', 2 * HOUR)]);
    expect(l.lanes).toHaveLength(1);
    expect(l.lanes[0].kind).toBe('board');
    expect(l.lanes[0].header?.key).toBe('PAY-30');
    expect(keys(l.lanes[0].cards)).toEqual(['PAY-31', 'PAY-32']);
    expect(l.lanes.some((x) => x.kind === 'none')).toBe(false);
  });

  const nesting = (): JiraIssue[] => [
    n('PAY-40', null, 6 * HOUR, { type: epic }),
    n('PAY-41', 'PAY-40', 5 * HOUR),
    n('PAY-42', 'PAY-41', 1 * HOUR),
    n('PAY-43', 'PAY-41', 2 * HOUR),
    n('PAY-44', 'PAY-40', 3 * HOUR)
  ];

  it('nests a header issue’s lane under its parent’s lane, one step in, with the subtree counting the nested header', () => {
    const l = lanes(nesting());
    expect(laneKeys(l.lanes)).toEqual(['PAY-40']);
    const [root] = l.lanes;
    expect(keys(root.cards)).toEqual(['PAY-44']);
    expect(laneKeys(root.lanes)).toEqual(['PAY-41']);
    expect(root.lanes[0].depth).toBe(1);
    expect(root.lanes[0].cards).toHaveLength(2);
    expect(keys(root.subtree).sort()).toEqual(['PAY-41', 'PAY-42', 'PAY-43', 'PAY-44']);
    expect(keys(root.lanes[0].subtree).sort()).toEqual(['PAY-42', 'PAY-43']);
  });

  it('draws no lane for an off-board parent with no card under it, and the header names it through parentOf', () => {
    const l = lanes([n('PAY-51', 'PAY-50', 2 * HOUR), n('PAY-52', 'PAY-51', 1 * HOUR)]);
    expect(laneKeys(l.lanes)).toEqual(['PAY-51']);
    expect(l.lanes[0].kind).toBe('board');
    expect(l.lanes[0].depth).toBe(0);
    expect(l.parentOf.get('PAY-51')?.key).toBe('PAY-50');
  });

  const offWithHeader = (s61: Partial<JiraIssue> = todo, s62: Partial<JiraIssue> = todo, s63: Partial<JiraIssue> = todo): JiraIssue[] => [
    n('PAY-61', 'PAY-60', 3 * HOUR, s61),
    n('PAY-62', 'PAY-60', 2 * HOUR, s62),
    n('PAY-63', 'PAY-62', 1 * HOUR, s63)
  ];

  it('nests an on-board header under an off-board lane that has a card of its own', () => {
    const l = lanes(offWithHeader());
    expect(laneKeys(l.lanes)).toEqual(['PAY-60']);
    expect(l.lanes[0].kind).toBe('off');
    expect(keys(l.lanes[0].cards)).toEqual(['PAY-61']);
    expect(laneKeys(l.lanes[0].lanes)).toEqual(['PAY-62']);
    expect(l.lanes[0].lanes[0].depth).toBe(1);
    expect(keys(l.lanes[0].lanes[0].cards)).toEqual(['PAY-63']);
  });

  describe('cycles (§1.4)', () => {
    const twoCycle = (): JiraIssue[] => [n('PAY-71', 'PAY-72', 1 * HOUR), n('PAY-72', 'PAY-71', 2 * HOUR)];

    it('draws a two-cycle as two parentless cards in one No parent lane', () => {
      const l = lanes(twoCycle());
      expect(l.lanes).toHaveLength(1);
      expect(l.lanes[0].kind).toBe('none');
      expect(keys(l.lanes[0].cards).sort()).toEqual(['PAY-71', 'PAY-72']);
      expect(l.parentOf.get('PAY-71')).toBeNull();
      expect(l.parentOf.get('PAY-72')).toBeNull();
    });

    it('draws a self-parent as one card in the No parent lane', () => {
      const l = lanes([n('PAY-73', 'PAY-73', 1 * HOUR)]);
      expect(l.lanes).toHaveLength(1);
      expect(l.lanes[0].kind).toBe('none');
      expect(keys(l.lanes[0].cards)).toEqual(['PAY-73']);
      expect(l.parentOf.get('PAY-73')).toBeNull();
    });

    it('lets an issue hanging off a cycle keep its parent, which becomes a root lane', () => {
      const l = lanes([...twoCycle(), n('PAY-74', 'PAY-71', 3 * HOUR)]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-71', NO_PARENT_LANE]);
      expect(l.lanes[0].kind).toBe('board');
      expect(keys(l.lanes[0].cards)).toEqual(['PAY-74']);
      expect(keys(l.lanes[1].cards)).toEqual(['PAY-72']);
      expect(l.parentOf.get('PAY-74')?.key).toBe('PAY-71');
    });
  });

  describe('order (§3.5)', () => {
    it('puts an open lane a week old before a settled lane updated a minute ago', () => {
      const l = lanes([n('PAY-201', 'PAY-200', 7 * 24 * HOUR), n('PAY-211', 'PAY-210', MINUTE, done)]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-200', 'PAY-210']);
    });

    it('ranks open lanes by the newest updated across header and subtree, not the header’s own', () => {
      const l = lanes([
        n('PAY-81', null, 5 * 24 * HOUR),
        n('PAY-82', 'PAY-81', 1 * HOUR),
        n('PAY-85', null, 2 * HOUR),
        n('PAY-86', 'PAY-85', 3 * HOUR)
      ]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-81', 'PAY-85']);
      expect(l.lanes[0].stamp).toBe(Date.parse(ago(now, 1 * HOUR)));
      expect(l.lanes[1].stamp).toBe(Date.parse(ago(now, 2 * HOUR)));
    });

    it('breaks a stamp tie by lane key, whatever the input order', () => {
      const a = n('PAY-94', 'PAY-91', 1 * HOUR);
      const b = n('PAY-93', 'PAY-92', 1 * HOUR);
      expect(laneKeys(lanes([b, a]).lanes)).toEqual(['PAY-91', 'PAY-92']);
      expect(laneKeys(lanes([a, b]).lanes)).toEqual(['PAY-91', 'PAY-92']);
    });

    const openLane = (): JiraIssue => n('PAY-301', 'PAY-300', 5 * HOUR);
    const settledLane = (): JiraIssue => n('PAY-311', 'PAY-310', 3 * HOUR, done);

    it('keeps an open No parent lane last among the open lanes, before every settled lane, even holding the newest card', () => {
      const l = lanes([openLane(), settledLane(), n('PAY-320', null, MINUTE)]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-300', NO_PARENT_LANE, 'PAY-310']);
    });

    it('puts a settled No parent lane last of all, even when it is the newest', () => {
      const l = lanes([openLane(), settledLane(), n('PAY-321', null, MINUTE, done)]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-300', 'PAY-310', NO_PARENT_LANE]);
      expect(l.lanes[2].settled).toBe(true);
    });

    it('sorts nested lanes among their siblings by the same rule, inside their parent', () => {
      const l = lanes([
        n('PAY-400', null, 9 * 24 * HOUR),
        n('PAY-401', 'PAY-400', 6 * 24 * HOUR),
        n('PAY-410', 'PAY-400', 7 * 24 * HOUR),
        n('PAY-411', 'PAY-410', 8 * 24 * HOUR),
        n('PAY-420', 'PAY-400', MINUTE, done),
        n('PAY-421', 'PAY-420', 2 * MINUTE, done)
      ]);
      expect(laneKeys(l.lanes)).toEqual(['PAY-400']);
      expect(laneKeys(l.lanes[0].lanes)).toEqual(['PAY-410', 'PAY-420']);
      expect(l.lanes[0].lanes[1].settled).toBe(true);
      expect(l.lanes[0].settled).toBe(false);
    });
  });

  describe('settled (§3.5)', () => {
    it('is false for an on-board header still in progress over Done cards', () => {
      const l = lanes([n('PAY-500', null, 3 * HOUR, doing), n('PAY-501', 'PAY-500', 1 * HOUR, done), n('PAY-502', 'PAY-500', 2 * HOUR, done)]);
      expect(l.lanes[0].settled).toBe(false);
    });

    it('is true for an off-board stub in progress over Done cards — its status is not this board’s', () => {
      const p = { key: 'PAY-510', summary: 'PAY-510 summary', type: null, status: { name: 'In Progress', category: 'indeterminate' as const } };
      const l = lanes([n('PAY-511', null, 1 * HOUR, { ...done, parent: p }), n('PAY-512', null, 2 * HOUR, { ...done, parent: { ...p } })]);
      expect(l.lanes[0].kind).toBe('off');
      expect(l.lanes[0].settled).toBe(true);
    });

    it('counts a nested header in its parent lane’s subtree', () => {
      expect(lanes(offWithHeader(done, doing, done)).lanes[0].settled).toBe(false);
      expect(lanes(offWithHeader(done, done, done)).lanes[0].settled).toBe(true);
    });
  });

  it('nests six deep with no cap, each key drawn once', () => {
    const chain = [n('PAY-101', null, 7 * HOUR)];
    for (let k = 102; k <= 106; k += 1) chain.push(n(`PAY-${k}`, `PAY-${k - 1}`, (108 - k) * HOUR));
    chain.push(n('PAY-107', 'PAY-106', 1 * HOUR));
    const l = lanes(chain);
    const depths: number[] = [];
    let at: readonly JiraLane[] = l.lanes;
    while (at.length > 0) {
      depths.push(at[0].depth);
      at = at[0].lanes;
    }
    expect(depths).toEqual([0, 1, 2, 3, 4, 5]);
    // `lanes()` already holds every header and card to exactly once; this is the count the brief names.
    let count = 0;
    const visit = (lane: JiraLane): void => {
      count += (lane.header === null ? 0 : 1) + lane.cards.length;
      lane.lanes.forEach(visit);
    };
    l.lanes.forEach(visit);
    expect(count).toBe(7);
  });

  describe('childrenOf (§1.5)', () => {
    it('holds each on-board parent’s direct children', () => {
      expect(keySets(lanes(nesting()).childrenOf)).toEqual({ 'PAY-40': ['PAY-41', 'PAY-44'], 'PAY-41': ['PAY-42', 'PAY-43'] });
    });

    it('holds no edge between cycle members, and keeps the edge off a cycle', () => {
      expect(lanes([n('PAY-71', 'PAY-72', 1 * HOUR), n('PAY-72', 'PAY-71', 2 * HOUR)]).childrenOf.size).toBe(0);
      expect(lanes([n('PAY-73', 'PAY-73', 1 * HOUR)]).childrenOf.size).toBe(0);
      const c = lanes([n('PAY-71', 'PAY-72', 1 * HOUR), n('PAY-72', 'PAY-71', 2 * HOUR), n('PAY-74', 'PAY-71', 3 * HOUR)]);
      expect(keySets(c.childrenOf)).toEqual({ 'PAY-71': ['PAY-74'] });
    });
  });

  /*
    Two properties the deleted fold suite pinned (`foldBoard` never mutating its list; `sortTops` ranking an unparseable stamp) that the lane walk keeps —
    `sortForBoard` copies its input and `updatedMs` reads NaN as 0 — and the `laneBoard` comment promises.
  */
  describe('input and stamps', () => {
    const shape = (list: readonly JiraLane[]): unknown => list.map((l) => ({ key: l.key, cards: keys(l.cards), lanes: shape(l.lanes) }));

    it('never mutates the list it is given, and a shuffled list draws the same lanes', () => {
      const input = nesting();
      const before = keys(input);
      const out = lanes(input);
      expect(keys(input)).toEqual(before);
      expect(shape(lanes([...input].reverse()).lanes)).toEqual(shape(out.lanes));
    });

    it('ranks a lane whose only stamp is unparseable last among the open lanes', () => {
      const under = (key: string, parent: string, ms: number, over: Partial<JiraIssue> = {}): JiraIssue =>
        n(key, null, ms, { parent: { key: parent, summary: `${parent} summary`, type: null, status: null }, ...over });
      const l = lanes([under('PAY-81', 'PAY-8', 1 * HOUR), under('PAY-61', 'PAY-6', 1 * HOUR, { updated: 'not a date' }), under('PAY-71', 'PAY-7', 2 * HOUR)]);
      // PAY-6 holds the LOWEST key, so a NaN stamp falling through to key order would put it first and fail the case.
      expect(laneKeys(l.lanes)).toEqual(['PAY-8', 'PAY-7', 'PAY-6']);
    });
  });
});

describe('resolveJiraAction and jiraSettingOf', () => {
  const skills: JiraSkill[] = [{ id: 's_0123abcd', name: 'Groom ticket', prompt: '/jira-groom {key}', group: 'run' }];

  it('reads the two built-ins as themselves and a present skill id as { skill }', () => {
    expect(resolveJiraAction('execute', skills)).toBe('execute');
    expect(resolveJiraAction('context', skills)).toBe('context');
    expect(resolveJiraAction('s_0123abcd', skills)).toEqual({ skill: 's_0123abcd' });
  });

  it('a stored id that names a review skill resolves to execute, and isReviewSkill reads the group off the list', () => {
    const list: JiraSkill[] = [...skills, { id: 's_feedbeef', name: 'Check MR', prompt: '/check {mr.url}', group: 'review' }];
    expect(resolveJiraAction('s_feedbeef', list)).toBe('execute');
    expect(resolveJiraAction('s_0123abcd', list)).toEqual({ skill: 's_0123abcd' });
    expect(isReviewSkill({ skill: 's_feedbeef' }, list)).toBe(true);
    expect(isReviewSkill({ skill: 's_0123abcd' }, list)).toBe(false);
    expect(isReviewSkill({ skill: 's_gone' }, list)).toBe(false);
    expect(isReviewSkill('execute', list)).toBe(false);
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

  // The quiet-only Run gate (spec 2026-11-17-jira-quiet-run-gate-design.md, Design → Client): a live Run on the key holds the chip only while it does not
  // yield — quiet AND seen in the dashboard's latest good read. The title names why, in the words the server's 409 ends with.
  describe('the quiet gate', () => {
    const at = (min: number): string => new Date(Date.UTC(2026, 9, 19, 10, min)).toISOString();
    const link = (over: Partial<JiraSessionsPayload['links'][number]> = {}): JiraSessionsPayload['links'][number] =>
      ({
        key: 'PAY-1', sessionId: 's1', how: 'run', action: 'context', name: 'jira PAY-1', repo: '/home/ada/pay', branch: null, surface: 'dashboard', model: null,
        effort: null, snapshot: { summary: 'x', type: 'Story', parentKey: null }, startedAt: at(0), endedAt: null, endReason: null,
        quietSince: at(3), reattachedAt: null, state: 'quiet', row: { status: 'idle' }, stateSince: at(3), ...over
      }) as JiraSessionsPayload['links'][number];
    const working = { quietSince: null, state: 'working', row: { status: 'working' } } as Partial<JiraSessionsPayload['links'][number]>;
    const asking = { quietSince: null, state: 'answer', row: { status: 'question' } } as Partial<JiraSessionsPayload['links'][number]>;
    const sessions = (links: JiraSessionsPayload['links'], reachable = true): JiraSessionsPayload => ({ links, reachable, rowsAt: at(4) });
    const live = (sessionId: string, starting = false) => ({ 'PAY-1': { ...session, sessionId, starting } });
    const both = (st: ReturnType<typeof payload>, ss: JiraSessionsPayload | null) => [runChipState(issue(), st, ss), runBlockTitle(issue(), st, ss)];

    it('a quiet Run the dashboard sees leaves the chip ready, with no title', () => {
      expect(both(payload({ repos: mapped, live: live('s1') }), sessions([link()]))).toEqual(['ready', null]);
    });

    it('a working Run holds it: still working', () => {
      expect(both(payload({ repos: mapped, live: live('s1') }), sessions([link(working)]))).toEqual(['live', 'a Run on PAY-1 is still working']);
    });

    it('an unreachable dashboard holds a quiet Run: not seen by the dashboard', () => {
      expect(both(payload({ repos: mapped, live: live('s1') }), sessions([link()], false))).toEqual(['live', 'a Run on PAY-1 is not seen by the dashboard']);
    });

    it('a confirmed status entry the payload has no live link for holds it: not quiet yet', () => {
      expect(both(payload({ repos: mapped, live: live('s2') }), sessions([link()]))).toEqual(['live', 'a Run on PAY-1 is not quiet yet']);
    });

    it('a starting reservation holds it: starting', () => {
      expect(both(payload({ repos: mapped, live: live('s2', true) }), sessions([link()]))).toEqual(['live', 'a Run on PAY-1 is starting']);
    });

    it('with no sessions payload a confirmed entry holds it: not quiet yet', () => {
      expect(both(payload({ repos: mapped, live: live('s1') }), null)).toEqual(['live', 'a Run on PAY-1 is not quiet yet']);
    });

    it('two live Runs: the newest that does not yield names the reason, and one non-yielding Run is enough', () => {
      const st = payload({ repos: mapped, live: live('b') });
      expect(both(st, sessions([link({ sessionId: 'a' }), link({ sessionId: 'b', startedAt: at(5), ...working })]))).toEqual([
        'live',
        'a Run on PAY-1 is still working'
      ]);
      expect(both(st, sessions([link({ sessionId: 'a', ...working }), link({ sessionId: 'b', startedAt: at(5) })]))).toEqual([
        'live',
        'a Run on PAY-1 is still working'
      ]);
      expect(both(st, sessions([link({ sessionId: 'a', ...working }), link({ sessionId: 'b', startedAt: at(5), ...asking })]))).toEqual([
        'live',
        'a Run on PAY-1 is waiting on you'
      ]);
    });

    it('a working branch link never holds it, and an unmapped project is still no-repo', () => {
      expect(both(payload({ repos: mapped }), sessions([link({ how: 'branch', ...working })]))).toEqual(['ready', null]);
      expect(both(payload({ repos: {}, live: live('s1') }), sessions([link(working)]))).toEqual(['no-repo', null]);
    });
  });
});

describe('defaultModeFor', () => {
  it('per action (the setting is empty): plan for context and acceptEdits for execute and for a skill', () => {
    expect(defaultModeFor('context', '')).toBe('plan');
    expect(defaultModeFor('execute', '')).toBe('acceptEdits');
    expect(defaultModeFor('review', '')).toBe('acceptEdits');
    expect(defaultModeFor('review', 'plan')).toBe('plan');
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

  it('fetchJiraPrompt sends a review skill\'s five MR fields and no half', async () => {
    const f = answer(200, null);
    const skillMr = { project: 'g/p', iid: 7, url: 'https://gl/g/p/-/merge_requests/7', source: 'pay-1-x', target: 'develop' };
    await fetchJiraPrompt('PAY-1', { skill: 's_0a1b2c3d' }, '/r', { mode: 'none' }, { skillMr });
    const q = new URL(f.mock.calls[0][0], 'http://x').searchParams;
    expect(q.get('mrProject')).toBe('g/p');
    expect(q.get('mrIid')).toBe('7');
    expect(q.get('mrUrl')).toBe(skillMr.url);
    expect(q.get('mrSource')).toBe('pay-1-x');
    expect(q.get('mrTarget')).toBe('develop');
    expect(q.has('half')).toBe(false);
  });

  it('fetchJiraPrompt adds mode, and branch/base/openMr/target only for the modes that carry them', async () => {
    let f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'new', branch: 'feature/pay-1-x', base: 'develop', openMr: false, review: false });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=new&branch=feature%2Fpay-1-x&base=develop');
    f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'continue', branch: 'pay-1-x', openMr: true, review: false, target: 'main' });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=continue&branch=pay-1-x&openMr=true&target=main');
    f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'continue', branch: 'pay-1-x', openMr: false, review: false, target: null });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=continue&branch=pay-1-x');
    f = answer(200, null);
    await fetchJiraPrompt('PAY-1', 'execute', '/r', { mode: 'new', branch: 'b', base: 'develop', openMr: false, review: true });
    expect(f.mock.calls[0][0]).toBe('/api/jira/prompt?key=PAY-1&action=execute&repo=%2Fr&mode=new&branch=b&base=develop&review=true');
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

  it('a 200 whose body is not JSON rejects with exactly `malformed response`, never the parser\'s SyntaxError (#587)', async () => {
    // A proxy or an HTML error page answering 200: `res.json()` rejects with `Unexpected token '<'…`, which used to escape as the read's sentence.
    const html = () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) });
    };
    html();
    await expect(fetchJiraDetail('PAY-1')).rejects.toThrow(/^malformed response$/);
    html();
    await expect(fetchJiraRefs('/r', null)).rejects.toThrow(/^malformed response$/);
    html();
    await expect(fetchJiraWorktrees()).rejects.toThrow(/^malformed response$/);
    html();
    await expect(fetchJiraSessions(false)).rejects.toThrow(/^malformed response$/);
  });

  describe('fetchJiraProjects', () => {
    it('reads the list in order from /api/jira/projects', async () => {
      const f = answer(200, [{ key: 'PAY', name: 'Payments' }, { key: 'OPS', name: 'Platform' }]);
      await expect(fetchJiraProjects()).resolves.toEqual([{ key: 'PAY', name: 'Payments' }, { key: 'OPS', name: 'Platform' }]);
      expect(f.mock.calls[0][0]).toBe('/api/jira/projects');
    });
    it('drops a row without a string key and name, and keeps the rest', async () => {
      answer(200, [{ key: 'PAY', name: 'Payments' }, { key: 7, name: 'x' }, null, { key: 'OPS' }]);
      await expect(fetchJiraProjects()).resolves.toEqual([{ key: 'PAY', name: 'Payments' }]);
    });
    it('rejects a body that is not a list as malformed', async () => {
      answer(200, { projects: [] });
      await expect(fetchJiraProjects()).rejects.toThrow('the project list could not be read — malformed response');
    });
    it('rejects with the server’s sentence, else the HTTP status', async () => {
      answer(502, { error: 'Jira refused: forbidden' });
      await expect(fetchJiraProjects()).rejects.toThrow('Jira refused: forbidden');
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
      await expect(fetchJiraProjects()).rejects.toThrow('the project list could not be read (HTTP 500)');
    });
    it('says the server did not answer when fetch itself rejects', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(fetchJiraProjects()).rejects.toThrow('the project list could not be read — the server did not answer');
    });
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
    it('execute with a ticket branch: Continue on it, and New and the target still filled for a switch', () => {
      expect(branchDraft('execute', tickets, 'TIMIFY-123', 'Export contacts', undefined)).toEqual({
        mode: 'continue',
        continueBranch: 'timify-123-x',
        newBranch: 'timify-123-export-contacts',
        base: 'develop',
        openMr: false,
        review: true,
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
        review: true,
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
        review: true,
        target: 'main'
      });
    });
    // #503: the ticket's last session's branch, passed as a preference.
    describe('with a preferred branch', () => {
      const two = refsOf([branch('timify-123-a', true), branch('timify-123-b', true), branch('develop', false)]);
      const plain = branchDraft('execute', two, 'TIMIFY-123', 'Export', undefined);
      it('opens on Continue on the preferred branch, where no preference stays on the first ticket branch', () => {
        expect(branchDraft('execute', two, 'TIMIFY-123', 'Export', undefined, 'timify-123-b')).toMatchObject({ mode: 'continue', continueBranch: 'timify-123-b' });
        expect(plain).toMatchObject({ mode: 'continue', continueBranch: 'timify-123-a' });
      });
      it('a preferred branch the refs do not list is the draft without one', () => {
        expect(branchDraft('execute', two, 'TIMIFY-123', 'Export', undefined, 'timify-123-x')).toEqual(plain);
      });
      it('the mapped checkout\'s own branch is the draft without one', () => {
        expect(branchDraft('execute', two, 'TIMIFY-123', 'Export', undefined, 'develop')).toEqual(plain);
      });
      it('context with a preferred branch still opens on No branch', () => {
        expect(branchDraft('context', two, 'TIMIFY-123', 'Export', undefined, 'timify-123-b').mode).toBe('none');
      });
      it('unavailable or unread refs are the draft without one', () => {
        const down: JiraRepoRefs = { repo: '/r', available: false, reason: 'does not exist' };
        expect(branchDraft('execute', down, 'TIMIFY-123', 'Export', { base: 'main' }, 'timify-123-b')).toEqual(
          branchDraft('execute', down, 'TIMIFY-123', 'Export', { base: 'main' })
        );
        expect(branchDraft('execute', null, 'TIMIFY-123', 'Export', undefined, 'timify-123-b')).toEqual(branchDraft('execute', null, 'TIMIFY-123', 'Export', undefined));
      });
      it('a preference applied leaves New and its base as the draft without one has them', () => {
        const preferred = branchDraft('execute', two, 'TIMIFY-123', 'Export', undefined, 'timify-123-b');
        expect([preferred.newBranch, preferred.base]).toEqual([plain.newBranch, plain.base]);
      });
      it('applies to a branch that is not the ticket\'s too, and to a skill action', () => {
        const other = refsOf([branch('timify-123-a', true), branch('feature/other', false), branch('develop', false)]);
        expect(branchDraft({ skill: 's_0a1b2c3d' }, other, 'TIMIFY-123', 'Export', undefined, 'feature/other')).toMatchObject({
          mode: 'continue',
          continueBranch: 'feature/other'
        });
      });
      it('preferredBranchApplies says the same', () => {
        expect(preferredBranchApplies('execute', two, 'timify-123-b')).toBe(true);
        expect(preferredBranchApplies('execute', two, null)).toBe(false);
        expect(preferredBranchApplies('execute', two, '')).toBe(false);
        expect(preferredBranchApplies('context', two, 'timify-123-b')).toBe(false);
        expect(preferredBranchApplies('execute', two, 'develop')).toBe(false);
      });
    });

    it('the choice keeps only the fields its mode and action own', () => {
      const draft = { mode: 'continue' as const, continueBranch: 'b', newBranch: 'n', base: 'develop', openMr: true, review: true, target: 'main' };
      expect(branchChoiceOf(draft, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: true, review: true, target: 'main' });
      expect(branchChoiceOf({ ...draft, target: '' }, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: true, review: true, target: null });
      // #567: review alone carries the target too — it is the base the review diffs against — and with both switches off nothing reads it.
      expect(branchChoiceOf({ ...draft, openMr: false, target: 'develop' }, 'execute')).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: false,
        review: true,
        target: 'develop'
      });
      expect(branchChoiceOf({ ...draft, openMr: false, target: '' }, 'execute')).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: false,
        review: true,
        target: null
      });
      expect(branchChoiceOf({ ...draft, openMr: false, review: false }, 'execute')).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: false,
        review: false,
        target: null
      });
      expect(branchChoiceOf({ ...draft, review: false }, 'execute')).toEqual({ mode: 'continue', branch: 'b', openMr: true, review: false, target: 'main' });
      expect(branchChoiceOf(draft, 'context')).toEqual({ mode: 'continue', branch: 'b', openMr: false, review: false, target: null });
      expect(branchChoiceOf({ ...draft, openMr: false }, { skill: 's_0a1b2c3d' })).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: false,
        review: false,
        target: null
      });
      expect(branchChoiceOf({ ...draft, mode: 'new' }, 'execute')).toEqual({ mode: 'new', branch: 'n', base: 'develop', openMr: true, review: true });
      expect(branchChoiceOf({ ...draft, mode: 'new' }, { skill: 's_0a1b2c3d' })).toEqual({ mode: 'new', branch: 'n', base: 'develop', openMr: false, review: false });
      expect(branchChoiceOf({ ...draft, mode: 'none' }, 'context')).toEqual({ mode: 'none' });
    });
    it('the dispatch fields are the five flat ones, each only with its mode', () => {
      expect(branchDispatchFields({ mode: 'none' })).toEqual({ mode: 'none' });
      expect(branchDispatchFields({ mode: 'new', branch: 'n', base: 'develop', openMr: false, review: false })).toEqual({
        mode: 'new',
        branch: 'n',
        base: 'develop',
        openMr: false,
        review: false
      });
      expect(branchDispatchFields({ mode: 'continue', branch: 'b', openMr: true, review: true, target: 'main' })).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: true,
        review: true,
        target: 'main'
      });
      expect(branchDispatchFields({ mode: 'continue', branch: 'b', openMr: false, review: false, target: null })).toEqual({
        mode: 'continue',
        branch: 'b',
        openMr: false,
        review: false
      });
    });
    it('the draft refusal reads the mode\'s own fields, then a typed target', () => {
      const draft = { mode: 'new' as const, continueBranch: 'develop', newBranch: 'timify-123-n', base: '', openMr: false, review: true, target: '' };
      expect(draftRefusal(draft, 'execute', 'TIMIFY-123', tickets)?.text).toBe('base is required for a new branch');
      expect(draftRefusal({ ...draft, mode: 'continue' }, 'execute', 'TIMIFY-123', tickets)?.text).toBe(
        'develop is checked out in the mapped checkout /repos/app'
      );
      const cont = { ...draft, mode: 'continue' as const, continueBranch: 'timify-123-x', openMr: true };
      expect(draftRefusal({ ...cont, target: 'a..b' }, 'execute', 'TIMIFY-123', null)?.text).toBe('target may not contain ..');
      expect(draftRefusal(cont, 'execute', 'TIMIFY-123', null)).toBeNull();
      // #567: review alone carries the target, so a typed bad one is refused with the MR off too; with both switches off it is not sent, so not judged.
      expect(draftRefusal({ ...cont, target: 'a:b', openMr: false }, 'execute', 'TIMIFY-123', null)?.text).toBe('target may hold only A-Z a-z 0-9 . _ / -');
      expect(draftRefusal({ ...cont, target: 'a..b', openMr: false, review: false }, 'execute', 'TIMIFY-123', null)).toBeNull();
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
      expect(continueOffTicket({ mode: 'continue', branch: 'develop', openMr: false, review: false, target: null }, 'TIMIFY-123')).toBe(true);
      expect(continueOffTicket({ mode: 'continue', branch: 'feature/timify-123-x', openMr: false, review: false, target: null }, 'TIMIFY-123')).toBe(false);
      expect(continueOffTicket({ mode: 'continue', branch: 'timify-1234', openMr: false, review: false, target: null }, 'TIMIFY-123')).toBe(true);
      expect(continueOffTicket({ mode: 'continue', branch: '  ', openMr: false, review: false, target: null }, 'TIMIFY-123')).toBe(false);
      expect(continueOffTicket({ mode: 'new', branch: 'develop', base: 'main', openMr: false, review: false }, 'TIMIFY-123')).toBe(false);
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
  const child = issue({ key: 'PAY-2', summary: 'Child', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'PAY-1', summary: 'Top', type: null, status: null } });
  const other = issue({ key: 'PAY-3', summary: 'Other' });
  /** `boardAgents` over `issues` as the page calls it: the loaded list and the kept parents `laneBoard` read off that same list. */
  const agentsOn = (issues: JiraIssue[], payload: JiraSessionsPayload | null, live: Record<string, JiraLiveSession> = {}) =>
    boardAgents(issues, laneBoard(issues).parentOf, payload, live);
  const loaded = [top, child, other];

  it('boardAgents gives one session linked to two on-board tickets two entries with distinct ids', () => {
    const entries = agentsOn(loaded, answer([link('PAY-1', 's1', 'working', 3), link('PAY-3', 's1', 'working', 3)]));
    expect(entries.map((e) => e.issue.key).sort()).toEqual(['PAY-1', 'PAY-3']);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });

  it('deckGroup puts the four wait states in Needs you, and the rest where §7.1 says', () => {
    expect(['plan', 'permission', 'reply', 'answer'].map((s) => deckGroup(s as Link['state']))).toEqual(['needs', 'needs', 'needs', 'needs']);
    expect(deckGroup('working')).toBe('working');
    expect(deckGroup('quiet')).toBe('quiet');
    expect([deckGroup('starting'), deckGroup('lost')]).toEqual(['other', 'other']);
  });

  it('boardAgents orders by group, then newest start, and draws a reservation from `live` and never an ended link', () => {
    const entries = agentsOn(
      loaded,
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
    expect(agentsOn(loaded, null, { 'PAY-1': { ...reservation(1), starting: false, sessionId: 's' } })).toEqual([]);
  });

  /*
    The deck on the lane model (parent-lanes spec §5): an entry names the parent the lanes KEPT for its own issue — `↳ <KEY>` on the card and the crumb's
    lead — whichever kind of lane that is. PAY-42 sits under on-board PAY-41; PAY-71 and PAY-72 name each other, so the walk drops both links (§1.4);
    PAY-11 and PAY-12 sit under off-board PAY-1, each carrying its own copy of the parent, and PAY-12 — the fresher — is the one the lane's stub is read from.
  */
  describe('boardAgents and deckCrumb on the lane model', () => {
    const p41 = issue({ key: 'PAY-41', summary: 'Ledger epic', updated: hoursAgo(9) });
    const p42 = issue({ key: 'PAY-42', summary: 'Ledger story', parent: { key: 'PAY-41', summary: 'Ledger epic', type: null, status: null }, updated: hoursAgo(8) });
    const p71 = issue({ key: 'PAY-71', summary: 'Loop one', parent: { key: 'PAY-72', summary: 'Loop two', type: null, status: null }, updated: hoursAgo(7) });
    const p72 = issue({ key: 'PAY-72', summary: 'Loop two', parent: { key: 'PAY-71', summary: 'Loop one', type: null, status: null }, updated: hoursAgo(6) });
    const p11 = issue({ key: 'PAY-11', summary: 'Card form', parent: { key: 'PAY-1', summary: 'Checkout', type: null, status: null }, updated: hoursAgo(5) });
    const p12 = issue({ key: 'PAY-12', summary: 'Wallet form', parent: { key: 'PAY-1', summary: 'Checkout v2', type: null, status: null }, updated: hoursAgo(2) });
    const deep = [p41, p42, p71, p72, p11, p12];
    const only = (key: string, live: Record<string, JiraLiveSession> = {}) => {
      const entries = agentsOn(deep, answer([link(key, 'w', 'working', 1)]), live).filter((e) => e.issue.key === key);
      expect(entries).toHaveLength(1);
      return entries[0];
    };

    it('names the on-board parent the lanes kept', () => {
      expect(only('PAY-42').parent?.key).toBe('PAY-41');
    });

    it('names no parent for a cycle member, whose link the walk dropped', () => {
      expect(only('PAY-71').parent).toBeNull();
    });

    it('names an off-board parent with the card’s OWN copy of it, not the lane stub’s', () => {
      // The stub is the fresher sibling's copy — the case only discriminates while the two differ.
      const offLane = laneBoard(deep).lanes.find((l) => l.key === 'PAY-1');
      expect(offLane?.stub?.summary).toBe('Checkout v2');
      const entry = only('PAY-11');
      expect(entry.parent?.key).toBe('PAY-1');
      expect(entry.parent?.summary).toBe('Checkout');
    });

    it('draws no entry for a session on a key that is not in the loaded list', () => {
      expect(agentsOn(deep, answer([link('PAY-99', 'x', 'working', 1)]))).toEqual([]);
    });

    it('draws a starting reservation from `live` as today, with its parent', () => {
      const [entry] = agentsOn(deep, answer([]), { 'PAY-42': reservation(1) });
      expect(entry.state).toBe('starting');
      expect(entry.issue.key).toBe('PAY-42');
      expect(entry.parent?.key).toBe('PAY-41');
    });

    it('deckCrumb leads with `↳ <parent>` unless told not to, and never without a parent', () => {
      const withParent = only('PAY-42');
      expect(deckCrumb(withParent, [])).toMatch(/^↳ PAY-41 · /);
      expect(deckCrumb(withParent, [])).toContain('pay');
      expect(deckCrumb(withParent, [], { lead: false })).not.toContain('↳');
      expect(deckCrumb(only('PAY-71'), [])).not.toContain('↳');
      // A parentless issue on the first fixture reads the run's own words alone.
      const [own] = agentsOn(loaded, answer([link('PAY-1', 'a', 'working', 2)]));
      expect(own.parent).toBeNull();
      expect(deckCrumb(own, [])).not.toContain('↳');
    });
  });

  describe('childSessions (Detail\u2019s Children rows and the Agent pane\u2019s on-a-child line)', () => {
    const grand = issue({ key: 'PAY-4', summary: 'Grandchild', parent: { key: 'PAY-2', summary: 'Child', type: null, status: null } });
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
      // A Children row is not a lane: it draws no `↳`, so the entry names no parent.
      expect(first.parent).toBeNull();
      expect(first.since).toBe(payload.links[1].stateSince);
    });

    it('counts a reservation from the status as `starting`, which the sessions payload never carries', () => {
      expect(keys(childSessions([child, grand], answer([]), { 'PAY-4': { ...reservation(1), starting: true } }))).toEqual([['PAY-4', 'starting']]);
    });

    it('ignores a session on an issue that is not in the list it was handed', () => {
      expect(childSessions([grand], answer([link('PAY-2', 'a', 'working', 1)]), {})).toEqual([]);
    });
  });

  /*
    The lane card's session cell (parent-lanes spec §3.4): keyed by the session's OWN issue — a card is one issue now, and nothing rolls up to a top. PAY-12 has
    two live entries, the needs-you one first in `deckOrder`; PAY-13 one; PAY-14 only ended links; PAY-2 is a child whose session must not reach PAY-1.
  */
  describe('sessionCells', () => {
    const lanesOf = [top, child, other, issue({ key: 'PAY-12' }), issue({ key: 'PAY-13' }), issue({ key: 'PAY-14' }), issue({ key: 'PAY-15' })];

    it('leads a key with its first live entry in deckOrder, counts the rest as `more`, and gives each key its own entry', () => {
      const agents = agentsOn(lanesOf, answer([link('PAY-12', 'w', 'working', 2), link('PAY-12', 'p', 'plan', 4), link('PAY-13', 'q', 'quiet', 1)]), {});
      const cells = sessionCells(agents, []);
      const twelve = cells.get('PAY-12');
      expect(twelve?.state).toBe('plan');
      expect(twelve?.since).toBe(hoursAgo(4));
      expect(twelve?.more).toBe(1);
      expect(twelve?.lead).toBe(agents[0]);
      expect(twelve?.lead?.id).toBe('PAY-12:p');
      expect(cells.get('PAY-13')).toEqual({ state: 'quiet', since: hoursAgo(1), more: 0, lead: agents.find((e) => e.id === 'PAY-13:q') });
    });

    it('reads `ended` with the newest endedAt for a key with ended links and none live', () => {
      const one = link('PAY-14', 'a', 'ended', 9, { endedAt: hoursAgo(7) });
      expect(sessionCells([], [one]).get('PAY-14')).toEqual({ state: 'ended', since: hoursAgo(7), more: 0, lead: null });
      const newer = link('PAY-14', 'b', 'ended', 6, { endedAt: hoursAgo(3) });
      expect(sessionCells([], [one, newer]).get('PAY-14')).toEqual({ state: 'ended', since: hoursAgo(3), more: 0, lead: null });
      // Newest, not last: the same two links fed newest first still read the newer one.
      expect(sessionCells([], [newer, one]).get('PAY-14')).toEqual({ state: 'ended', since: hoursAgo(3), more: 0, lead: null });
    });

    it('a live session wins over an ended one on the same key, and a key with neither has no entry', () => {
      const agents = agentsOn(lanesOf, answer([link('PAY-13', 'q', 'quiet', 1)]), {});
      const cells = sessionCells(agents, [link('PAY-13', 'z', 'ended', 9, { endedAt: hoursAgo(5) })]);
      expect(cells.get('PAY-13')?.state).toBe('quiet');
      expect(cells.has('PAY-15')).toBe(false);
    });

    it('a session on a child gives its parent’s key no entry', () => {
      const agents = agentsOn(lanesOf, answer([link('PAY-2', 'c', 'working', 2)]), {});
      const cells = sessionCells(agents, [link('PAY-2', 'd', 'ended', 9, { endedAt: hoursAgo(5) })]);
      expect(cells.get('PAY-2')?.state).toBe('working');
      expect(cells.has('PAY-1')).toBe(false);
    });
  });

  it('endedByKey lists each key’s ended links newest end first, and leaves a live link out', () => {
    const old = link('PAY-3', 'o', 'ended', 9, { endedAt: hoursAgo(8) });
    const fresh = link('PAY-3', 'n', 'ended', 5, { endedAt: hoursAgo(2) });
    const other = link('PAY-2', 'f', 'ended', 5, { endedAt: hoursAgo(1) });
    const running = link('PAY-3', 'r', 'working', 1);
    const byKey = endedByKey(answer([old, fresh, other, running]));
    expect(byKey.get('PAY-3')?.map((l) => l.sessionId)).toEqual(['n', 'o']);
    expect(byKey.get('PAY-2')?.map((l) => l.sessionId)).toEqual(['f']);
    expect(endedByKey(null).size).toBe(0);
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
    expect(launchFootLine('/Users/ada/microservice', { mode: 'new', branch: 'b', base: 'main', openMr: false, review: false })).toBe('Starts in microservice on a new worktree');
    expect(launchFootLine('/Users/ada/microservice', { mode: 'continue', branch: 'pay-131-a', openMr: false, review: false, target: null })).toBe(
      'Starts in microservice on pay-131-a'
    );
  });
  it('is null without a repository and ends after the basename without a choice', () => {
    expect(launchFootLine(null, { mode: 'none' })).toBeNull();
    expect(launchFootLine('/Users/ada/microservice', null)).toBe('Starts in microservice');
  });
});

// `clampJiraPanelFilters` reads its accepted Delivery values from the labels table, the list the UI draws (#600 broke the import cycle that once forced a
// hand-kept copy in `lib/jira.ts`). The first case pins the two together; the second names the five values outright, so a key dropped from the table —
// which the first would follow silently — goes red here instead of clamping a stored pick to `all`.
describe('clampJiraPanelFilters keeps every Delivery filter value the UI offers', () => {
  it.each(Object.keys(DELIVERY_FILTER_LABELS))('keeps `%s`', (value) => {
    expect(clampJiraPanelFilters({ ...NO_JIRA_PANEL_FILTERS, delivery: value }).delivery).toBe(value);
  });
  it.each(['all', 'has-mr', 'failing', 'done-not-merged', 'review-open'])('keeps `%s` by name', (value) => {
    expect(clampJiraPanelFilters({ ...NO_JIRA_PANEL_FILTERS, delivery: value }).delivery).toBe(value);
  });
  it('keeps `review-open` by name', () => {
    expect(clampJiraPanelFilters({ delivery: 'review-open' }).delivery).toBe('review-open');
  });
});

// #503: the launch sheet prefills from the ticket's last session — which one that is, and the line that says so.
describe('lastJiraLink and prefilledLine', () => {
  const l = (key: string, startedAt: string, id: string) => ({ key, startedAt, sessionId: id });
  it('takes the newest link for the key by startedAt, and null for an unknown key or no links', () => {
    const links = [l('A', '2026-11-10T10:00:00Z', 'a10'), l('B', '2026-11-10T13:00:00Z', 'b13'), l('A', '2026-11-10T12:00:00Z', 'a12')];
    expect(lastJiraLink(links, 'A')?.sessionId).toBe('a12');
    expect(lastJiraLink(links, 'C')).toBeNull();
    expect(lastJiraLink([], 'A')).toBeNull();
  });
  it('recency, not liveness: an ended link newer than a live one wins', () => {
    const live = { ...l('A', '2026-11-10T10:00:00Z', 'live'), endedAt: null };
    const ended = { ...l('A', '2026-11-10T12:00:00Z', 'ended'), endedAt: '2026-11-10T12:30:00Z' };
    expect(lastJiraLink([live, ended], 'A')?.sessionId).toBe('ended');
  });
  it('an unparseable startedAt sorts last', () => {
    expect(lastJiraLink([l('A', 'garbage', 'bad'), l('A', '2026-11-10T10:00:00Z', 'ok')], 'A')?.sessionId).toBe('ok');
  });
  it('prefilledLine ages on the elapsedSince ladder, `just now` under a minute, no age for a bad stamp', () => {
    const now = Date.parse('2026-11-10T14:00:00Z');
    expect(prefilledLine('2026-11-10T12:00:00Z', now)).toBe('Prefilled from the last session · 2h ago');
    expect(prefilledLine('2026-11-10T13:59:30Z', now)).toBe('Prefilled from the last session · just now');
    expect(prefilledLine('garbage', now)).toBe('Prefilled from the last session');
  });
});

describe('defaultModeFor for a reply', () => {
  it('is acceptEdits when the setting is blank (the session runs jira.mjs through Bash, which plan refuses), else the setting', () => {
    expect(defaultModeFor('reply', '')).toBe('acceptEdits');
    expect(defaultModeFor('reply', 'plan')).toBe('plan');
  });
});

describe('replyRepos', () => {
  it('lists the project’s own repos first, then every other mapped repo, each once', () => {
    expect(replyRepos('PAY', { PAY: ['/a'], SUP: ['/b', '/a'] })).toEqual(['/a', '/b']);
    expect(replyRepos('XYZ', { PAY: ['/a'], SUP: ['/b', '/a'] })).toEqual(['/a', '/b']);
    expect(replyRepos('PAY', {})).toEqual([]);
  });
});

describe('dispatchReply', () => {
  afterEach(() => jest.restoreAllMocks());

  // The server refuses a reply body that omits mode/assign/transitionId or carries anything else (plan ruling R2), so the exact body is the contract.
  it('posts the narrow R2 body with the three values explicit, and the sheet’s defaults', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ assigned: false, transitioned: null }) } as Response));
    global.fetch = fetchMock as unknown as typeof fetch;
    await dispatchReply('PAY-1', '/r/a', { dispatchDefaultModel: 'opus', dispatchDefaultEffort: '', jiraDefaultPermission: '' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agents/dispatch-jira');
    expect(JSON.parse(init.body as string)).toEqual({
      key: 'PAY-1',
      repo: '/r/a',
      action: 'reply',
      assign: false,
      transitionId: null,
      mode: 'none',
      model: 'opus',
      permissionMode: 'acceptEdits',
      remoteControl: true
    });
  });
});

describe('lane views', () => {
  const now = Date.now();
  const todo = { status: { name: 'To Do', category: 'new' as const } };
  const doing = { status: { name: 'In Progress', category: 'indeterminate' as const } };
  const done = { status: { name: 'Done', category: 'done' as const } };
  const n = (key: string, parent: string | null, ms: number, over: Partial<JiraIssue> = {}): JiraIssue =>
    issue({
      key,
      summary: `${key} summary`,
      parent: parent === null ? null : { key: parent, summary: `${parent} summary`, type: null, status: null },
      updated: ago(now, ms),
      ...todo,
      ...over
    });
  const only = (...ks: string[]) => (i: JiraIssue): boolean => ks.includes(i.key);
  const sum = (p: { done: number; doing: number; todo: number }): number => p.done + p.doing + p.todo;
  const nesting = (): JiraIssue[] => [
    n('PAY-40', null, 6 * HOUR),
    n('PAY-41', 'PAY-40', 5 * HOUR),
    n('PAY-42', 'PAY-41', 1 * HOUR),
    n('PAY-43', 'PAY-41', 2 * HOUR),
    n('PAY-44', 'PAY-40', 3 * HOUR)
  ];
  const off = (): JiraIssue[] => [n('PAY-11', 'PAY-1', 3 * HOUR), n('PAY-12', 'PAY-1', 1 * HOUR), n('PAY-13', 'PAY-1', 2 * HOUR), n('PAY-20', null, 4 * HOUR)];

  it('keeps only the matching cards of a lane and counts them', () => {
    const v = laneViews(laneBoard(off()), only('PAY-13'));
    const lane = v.find((x) => x.lane.key === 'PAY-1')!;
    expect(lane.cards.map((i) => i.key)).toEqual(['PAY-13']);
    expect(lane.count).toBe(1);
    expect(sum(lane.progress)).toBe(1);
    expect(lane.headerMatches).toBe(false);
  });

  it('draws no view for a lane nothing in matches', () => {
    expect(laneViews(laneBoard(off()), () => false)).toEqual([]);
    expect(laneViews(laneBoard(off()), only('PAY-20')).map((x) => x.lane.key)).toEqual([NO_PARENT_LANE]);
  });

  it('draws a lane for a matching on-board header alone, with empty cells and count 0', () => {
    const board = laneBoard([n('PAY-30', null, 5 * HOUR), n('PAY-31', 'PAY-30', 1 * HOUR), n('PAY-32', 'PAY-30', 2 * HOUR)]);
    const v = laneViews(board, only('PAY-30'));
    expect(v).toHaveLength(1);
    expect(v[0].headerMatches).toBe(true);
    expect(v[0].cards).toEqual([]);
    expect(v[0].count).toBe(0);
  });

  it('keeps the ancestors of a nested lane drawn when only the nested header matches', () => {
    const v = laneViews(laneBoard(nesting()), only('PAY-41'));
    expect(v).toHaveLength(1);
    expect(v[0].lane.key).toBe('PAY-40');
    expect(v[0].headerMatches).toBe(false);
    expect(v[0].cards).toEqual([]);
    expect(v[0].count).toBe(1);
    expect(v[0].lanes).toHaveLength(1);
    expect(v[0].lanes[0].lane.key).toBe('PAY-41');
    expect(v[0].lanes[0].headerMatches).toBe(true);
    expect(v[0].lanes[0].count).toBe(0);
  });

  it('counts nested headers in the parent lane, and the own header in neither', () => {
    const v = laneViews(laneBoard(nesting()), () => true);
    expect(v[0].count).toBe(4);
    expect(v[0].lanes[0].count).toBe(2);
    expect(sum(v[0].progress)).toBe(4);
    expect(sum(v[0].lanes[0].progress)).toBe(2);
  });

  it('keeps the lanes’ own order', () => {
    const board = laneBoard(off());
    expect(laneViews(board, () => true).map((x) => x.lane.key)).toEqual(board.lanes.map((l) => l.key));
  });

  it('never mutates a lane or its stub', () => {
    const board = laneBoard(off());
    const before = JSON.stringify(board.lanes);
    laneViews(board, only('PAY-13'));
    expect(JSON.stringify(board.lanes)).toBe(before);
  });


  describe('laneParents', () => {
    it('counts lanes that are not No parent, every depth', () => {
      expect(laneParents(laneBoard(nesting()))).toBe(2);
      expect(laneParents(laneBoard(off()))).toBe(1);
      expect(laneParents(laneBoard([n('PAY-71', 'PAY-72', HOUR), n('PAY-72', 'PAY-71', 2 * HOUR)]))).toBe(0);
    });
  });
});

describe('laneCell', () => {
  const cards = (k: number): JiraIssue[] => Array.from({ length: k }, (_, i) => issue({ key: `PAY-${i + 1}` }));
  const keysOf = (l: JiraIssue[]): string[] => l.map((i) => i.key);
  const live = (...ks: string[]) => (k: string): boolean => ks.includes(k);

  it('cuts at five when closed', () => {
    expect(LANE_CELL_LIMIT).toBe(5);
    const r = laneCell(cards(7), live(), false);
    expect(keysOf(r.shown)).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5']);
    expect(r.hidden).toBe(2);
  });
  it('keeps a live card past the fifth, in order', () => {
    const r = laneCell(cards(7), live('PAY-7'), false);
    expect(keysOf(r.shown)).toEqual(['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-7']);
    expect(r.hidden).toBe(1);
  });
  it('shows everything when open', () => {
    const r = laneCell(cards(7), live(), true);
    expect(r.shown).toHaveLength(7);
    expect(r.hidden).toBe(0);
  });
  it('hides nothing at five, or at six with the sixth live', () => {
    expect(laneCell(cards(5), live(), false).hidden).toBe(0);
    const r = laneCell(cards(6), live('PAY-6'), false);
    expect(r.shown).toHaveLength(6);
    expect(r.hidden).toBe(0);
  });
});

describe('lane folds', () => {
  const none = (v: unknown, id: string): boolean => Object.keys(laneOverrides(clampLaneFolds(v), id)).length === 0;
  const lane = (key: string, lanes: JiraLane[] = []): JiraLane =>
    ({ key, kind: key === 'none' ? 'none' : 'off', header: null, stub: null, cards: [], lanes, depth: 0, subtree: [], settled: false, stamp: 0 }) as JiraLane;
  const boardOf = (lanes: JiraLane[]): JiraLanes => ({ lanes, childrenOf: new Map(), parentOf: new Map() });

  it('clamps a value that is not an object of board entries to no overrides', () => {
    for (const v of [null, 'x', 42, [], [{ 'PAY-1': 'closed' }]]) expect(none(v, 'b1')).toBe(true);
  });
  it('drops a bad board entry and a bad lane value alone', () => {
    const f = clampLaneFolds({ b1: { 'PAY-1': 'closed', 'PAY-2': 'junk' }, b2: 'nope', b3: ['open'], b4: null });
    expect(laneOverrides(f, 'b1')).toEqual({ 'PAY-1': 'closed' });
    for (const id of ['b2', 'b3', 'b4']) expect(laneOverrides(f, id)).toEqual({});
  });

  it('reads prototype names as absent', () => {
    const f = clampLaneFolds(JSON.parse('{"b1":{"PAY-1":"closed"}}'));
    for (const id of ['constructor', '__proto__', 'toString']) expect(laneOverrides(f, id)).toEqual({});
  });
  it('stores a board named like a prototype member and survives a JSON round trip', () => {
    const board = boardOf([lane('PAY-1')]);
    for (const id of ['constructor', '__proto__']) {
      const start = clampLaneFolds(JSON.parse('{"b1":{"PAY-1":"open"}}'));
      const r = setLaneFold(start, id, board, 'PAY-1', false);
      expect(laneOverrides(r, id)).toEqual({ 'PAY-1': 'closed' });
      expect(laneOverrides(r, 'b1')).toEqual({ 'PAY-1': 'open' });
      const back = clampLaneFolds(JSON.parse(JSON.stringify(r)));
      expect(Object.keys(back).sort()).toEqual([id, 'b1'].sort());
      expect(laneOverrides(back, id)).toEqual({ 'PAY-1': 'closed' });
    }
  });
  it('reads a __proto__ board from storage without touching Object.prototype', () => {
    const f = clampLaneFolds(JSON.parse('{"__proto__":{"PAY-1":"closed"},"b1":{"PAY-1":"open"}}'));
    expect(laneOverrides(f, '__proto__')).toEqual({ 'PAY-1': 'closed' });
    expect(laneOverrides(f, 'b1')).toEqual({ 'PAY-1': 'open' });
    expect((({}) as Record<string, unknown>)['PAY-1']).toBeUndefined();
  });

  it('opens a lane by override, else by whether it is settled', () => {
    const settled = { ...lane('PAY-1'), settled: true };
    const open = lane('PAY-2');
    expect(laneOpen(settled, {})).toBe(false);
    expect(laneOpen(open, {})).toBe(true);
    expect(laneOpen(settled, { 'PAY-1': 'open' })).toBe(true);
    expect(laneOpen(open, { 'PAY-2': 'closed' })).toBe(false);
    expect(laneOpen(open, JSON.parse('{"constructor":"closed"}'))).toBe(true);
  });

  it('writes a toggle, prunes stale lanes at any depth, leaves other boards and the input alone', () => {
    const folds: JiraLaneFolds = { b1: { 'PAY-9': 'closed', 'PAY-1': 'open', 'PAY-2': 'closed' }, b2: { 'PAY-9': 'closed' } };
    const snapshot = JSON.stringify(folds);
    const board = boardOf([lane('PAY-1', [lane('PAY-2')]), lane('none')]);
    const r = setLaneFold(folds, 'b1', board, 'none', false);
    expect(laneOverrides(r, 'b1')).toEqual({ 'PAY-1': 'open', 'PAY-2': 'closed', none: 'closed' });
    expect(laneOverrides(r, 'b2')).toEqual({ 'PAY-9': 'closed' });
    expect(JSON.stringify(folds)).toBe(snapshot);
  });
  it('stores a toggle equal to the default', () => {
    const r = setLaneFold({}, 'b1', boardOf([lane('PAY-1')]), 'PAY-1', true);
    expect(laneOverrides(r, 'b1')).toEqual({ 'PAY-1': 'open' });
  });
});

/**
 * #599: the band's cap fact is built from `JIRA_BOARD_CAP` (`shared/types.ts`), the value the poller keeps, so the band can never name a number the server no
 * longer applies. Before, `bandSub` hard-coded `first 500 shown`, and the cap was private to the poller. A literal anywhere in the client is that copy back.
 */
describe('the board cap is never a literal in the client', () => {
  it('no file under client/src spells the cap as a number before "shown"', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const hits = walk(join(__dirname, '..', '..', 'client', 'src')).filter((f) => /500 shown/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
