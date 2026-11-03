import { QUIET_TITLE, STATE_LABEL, needsYou, sessionState } from '../shared/jira-sessions';
import type { JiraSessionState } from '../shared/jira-sessions';
import type { DashboardRow, JiraLink } from '../shared/types';

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
