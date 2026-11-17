import { QUIET_TITLE, STATE_LABEL, needsYou, runBlockPhrase, runYields, sessionState } from '../../shared/jira-sessions';
import type { JiraSessionState, RunBlockPhrase } from '../../shared/jira-sessions';
import type { DashboardRow, JiraLink } from '../../shared/types';

/**
 * The pure session-state mapping (spec §6): one case per row of the first-match table, plus the ordering ties the table leaves to its row order and the
 * totality rule — a live link nothing matches reads Quiet, never throws, never ends.
 */

function link(over: Partial<JiraLink> = {}): JiraLink {
  return {
    key: 'PAY-131',
    sessionId: 'sess-1',
    how: 'run',
    action: 'execute',
    name: 'PAY-131 execute',
    repo: '/work/pay',
    branch: null,
    surface: 'desktop',
    model: null,
    effort: null,
    snapshot: { summary: 'A ticket', type: 'Task', parentKey: null },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    ...over
  };
}

const row = (over: Partial<DashboardRow> = {}): DashboardRow => ({ id: 'sess-1', status: 'working', ...over });

describe('sessionState', () => {
  it('Starting… — our entry has no session id yet, whatever the dashboard says', () => {
    expect(sessionState(link({ sessionId: null }), null, true)).toBe('starting');
    expect(sessionState(link({ sessionId: null }), row({ remotePlan: true }), false)).toBe('starting');
  });

  it('Ended — an ended entry, even when a stale row or an unreachable dashboard would say otherwise', () => {
    const ended = link({ endedAt: new Date().toISOString(), endReason: 'stopped' });
    expect(sessionState(ended, row({ status: 'working' }), true)).toBe('ended');
    expect(sessionState(ended, null, false)).toBe('ended');
  });

  it('Waiting for plan approval — remotePlan', () => {
    expect(sessionState(link(), row({ status: 'question', remotePlan: true }), true)).toBe('plan');
  });

  it('Waiting for permission — permissionWait', () => {
    expect(sessionState(link(), row({ status: 'question', permissionWait: true }), true)).toBe('permission');
  });

  it('Waiting for a reply — remoteReply', () => {
    expect(sessionState(link(), row({ status: 'question', remoteReply: true }), true)).toBe('reply');
  });

  it('the three flags win over question in row order: plan, then permission, then reply', () => {
    expect(sessionState(link(), row({ status: 'question', remotePlan: true, permissionWait: true, remoteReply: true }), true)).toBe('plan');
    expect(sessionState(link(), row({ status: 'question', permissionWait: true, remoteReply: true }), true)).toBe('permission');
    expect(sessionState(link(), row({ status: 'question', remoteReply: true }), true)).toBe('reply');
  });

  it('a flag counts whatever the status says — it is the row\'s own statement that something waits', () => {
    expect(sessionState(link(), row({ status: 'working', permissionWait: true }), true)).toBe('permission');
  });

  it('Waiting on your answer — question with none of the three flags, with or without remoteQuestion', () => {
    expect(sessionState(link(), row({ status: 'question' }), true)).toBe('answer');
    expect(sessionState(link(), row({ status: 'question', remoteQuestion: true }), true)).toBe('answer');
  });

  it('Working — status working', () => {
    expect(sessionState(link(), row({ status: 'working' }), true)).toBe('working');
  });

  it('Quiet — incomplete with quietSince set', () => {
    expect(sessionState(link({ quietSince: new Date().toISOString() }), row({ status: 'incomplete' }), true)).toBe('quiet');
  });

  it('Quiet — an idle row with quietSince not yet set (inside the grace)', () => {
    expect(sessionState(link(), row({ status: 'idle' }), true)).toBe('quiet');
  });

  it('Quiet — an incomplete row with quietSince not yet set', () => {
    expect(sessionState(link(), row({ status: 'incomplete' }), true)).toBe('quiet');
  });

  it('Quiet — no row while the dashboard answers (the total fallback)', () => {
    expect(sessionState(link(), null, true)).toBe('quiet');
  });

  it('Quiet — a status this mapping has never heard of', () => {
    expect(sessionState(link(), row({ status: 'something-new' }), true)).toBe('quiet');
  });

  it('Lost contact — the dashboard did not answer: a live link keeps no last state on screen, whatever its last row said', () => {
    expect(sessionState(link(), row({ status: 'working' }), false)).toBe('lost');
    expect(sessionState(link(), row({ status: 'question', remotePlan: true }), false)).toBe('lost');
    expect(sessionState(link(), null, false)).toBe('lost');
  });
});

describe('needsYou', () => {
  it.each<[JiraSessionState, boolean]>([
    ['plan', true],
    ['permission', true],
    ['reply', true],
    ['answer', true],
    ['starting', false],
    ['working', false],
    ['quiet', false],
    ['lost', false],
    ['ended', false]
  ])('%s -> %s', (state, expected) => {
    expect(needsYou(state)).toBe(expected);
  });
});

describe('copy', () => {
  it('STATE_LABEL is spec §6 verbatim, one entry per state', () => {
    expect(STATE_LABEL).toEqual({
      starting: 'Starting…',
      plan: 'Waiting for plan approval',
      permission: 'Waiting for permission',
      reply: 'Waiting for a reply',
      answer: 'Waiting on your answer',
      working: 'Working',
      quiet: 'Quiet',
      lost: 'Lost contact',
      ended: 'Ended'
    });
  });

  it('QUIET_TITLE is the spec\'s sentence', () => {
    expect(QUIET_TITLE).toBe('Turn finished or stalled — the dashboard cannot tell which');
  });
});

/**
 * The quiet-only Run gate (spec 2026-11-17, Design → One predicate / Refusal text): a live Run yields to the next one only when the reconciler has marked it
 * quiet AND the dashboard's latest good read carries its row AND that row reads Quiet. Every unknown blocks, and the phrase says why, first match wins.
 */
describe('runBlockPhrase / runYields', () => {
  const QUIET = '2026-11-17T09:00:00.000Z';
  const cases: [string, string | null, DashboardRow | null, boolean, RunBlockPhrase | null, boolean][] = [
    ['quiet with a row that reads Quiet', QUIET, row({ status: 'idle' }), true, null, true],
    ['quiet, but no row in the latest read (a restart, or off a full list)', QUIET, null, true, 'not seen by the dashboard', false],
    ['quiet, but the dashboard is unreachable', QUIET, row({ status: 'idle' }), false, 'not seen by the dashboard', false],
    ['quiet, a question row waiting on a remote reply', QUIET, row({ status: 'question', remoteReply: true }), true, 'waiting on you', false],
    ['quiet, an idle row waiting on a permission', QUIET, row({ status: 'idle', permissionWait: true }), true, 'waiting on you', false],
    ['quiet, an idle row waiting on plan approval', QUIET, row({ status: 'idle', remotePlan: true }), true, 'waiting on you', false],
    ['quiet, a bare question row', QUIET, row({ status: 'question' }), true, 'waiting on you', false],
    ['quiet, a working row (the reconciler has not caught up)', QUIET, row({ status: 'working' }), true, 'still working', false],
    ['an idle row not yet marked quiet (inside the grace)', null, row({ status: 'idle' }), true, 'not quiet yet', false],
    ['an incomplete row not yet marked quiet', null, row({ status: 'incomplete' }), true, 'not quiet yet', false]
  ];

  it.each(cases)('%s', (_name, quietSince, r, reachable, phrase, yields) => {
    const l = link({ quietSince });
    expect(runBlockPhrase(l, r, reachable)).toBe(phrase);
    expect(runYields(l, r, reachable)).toBe(yields);
  });

  it('only a LIVE run link can yield — an ended link and a branch link never do, whatever their row says', () => {
    const r = row({ status: 'idle' });
    expect(runYields(link({ quietSince: QUIET, endedAt: '2026-11-17T09:05:00.000Z', endReason: 'idle' }), r, true)).toBe(false);
    expect(runYields(link({ quietSince: QUIET, how: 'branch', action: null }), r, true)).toBe(false);
  });
});
