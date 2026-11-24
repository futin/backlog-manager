/**
 * subagents-shared.test.ts — the subagent state derivation both sides read (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md,
 * "Shared types and derivation").
 *
 * Times are offsets from one fixed `NOW` passed in, never the real clock: `subagentState` takes `nowMs` precisely so a case can sit exactly on a threshold.
 * The cases that matter most are the older-dashboard ones (5, 7, 12): a dashboard that has not shipped its half of the contract sends none of the new
 * fields, and BM must then draw nothing false — no `stuck` from age alone, no orphan, no badge.
 */
import { SUBAGENT_QUIET_MS, SUBAGENT_STUCK_MS, isOrphan, subagentState, waitingOnSubagent } from '../../shared/agent';
import type { SubagentDetail, SubagentJob } from '../../shared/types';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function job(over: Partial<SubagentJob> = {}): SubagentJob {
  return {
    id: 'toolu_1',
    type: 'Explore',
    description: 'look around',
    status: 'running',
    startedAt: ago(2 * MIN),
    endedAt: null,
    durationMs: null,
    tokens: null,
    agentId: 'a1',
    toolUses: null,
    ...over
  };
}

function detail(agents: SubagentJob[], over: Partial<SubagentDetail> = {}): SubagentDetail {
  const running = agents.filter((a) => a.status === 'running').length;
  return { agents, running, finished: agents.length - running, ...over };
}

describe('the thresholds', () => {
  it('are 5 and 20 minutes', () => {
    expect(SUBAGENT_QUIET_MS).toBe(5 * MIN);
    expect(SUBAGENT_STUCK_MS).toBe(20 * MIN);
  });
});

describe('subagentState', () => {
  it('1: a failed, killed or stopped endStatus is killed, whatever status says', () => {
    expect(subagentState(job({ endStatus: 'failed', status: 'running' }), NOW)).toBe('killed');
    expect(subagentState(job({ endStatus: 'killed', status: 'running' }), NOW)).toBe('killed');
    expect(subagentState(job({ endStatus: 'stopped', status: 'running' }), NOW)).toBe('killed');
    expect(subagentState(job({ endStatus: 'killed', status: 'done' }), NOW)).toBe('killed');
  });

  it('2: done is ended, with or without a completed endStatus', () => {
    expect(subagentState(job({ status: 'done', endStatus: 'completed' }), NOW)).toBe('ended');
    expect(subagentState(job({ status: 'done' }), NOW)).toBe('ended');
  });

  it('3: running with a blockedReason is blocked, however recent the write', () => {
    expect(subagentState(job({ blockedReason: 'rate-limit', lastWriteAt: ago(MIN) }), NOW)).toBe('blocked');
  });

  it('4: working / quiet / stuck on the since-write thresholds, edges included', () => {
    expect(subagentState(job({ lastWriteAt: ago(5 * MIN - 1000) }), NOW)).toBe('working');
    expect(subagentState(job({ lastWriteAt: ago(5 * MIN) }), NOW)).toBe('quiet');
    expect(subagentState(job({ lastWriteAt: ago(20 * MIN - 1000) }), NOW)).toBe('quiet');
    expect(subagentState(job({ lastWriteAt: ago(20 * MIN) }), NOW)).toBe('stuck');
  });

  it('5: no lastWriteAt is working, never startedAt as a stand-in', () => {
    expect(subagentState(job({ startedAt: ago(120 * MIN) }), NOW)).toBe('working');
    expect(subagentState(job({ startedAt: ago(120 * MIN), lastWriteAt: null }), NOW)).toBe('working');
  });
});

describe('isOrphan', () => {
  it('6: a running background job under a dead parent', () => {
    const j = job({ background: true });
    expect(isOrphan(j, detail([j], { parentLive: false }))).toBe(true);
  });

  it('7: a null, absent or live parent proves nothing', () => {
    const j = job({ background: true });
    expect(isOrphan(j, detail([j], { parentLive: null }))).toBe(false);
    expect(isOrphan(j, detail([j]))).toBe(false);
    expect(isOrphan(j, detail([j], { parentLive: true }))).toBe(false);
  });

  it('8: a foreground, finished or killed job is never an orphan', () => {
    const fg = job({ background: false });
    expect(isOrphan(fg, detail([fg], { parentLive: false }))).toBe(false);
    const done = job({ background: true, status: 'done' });
    expect(isOrphan(done, detail([done], { parentLive: false }))).toBe(false);
    const killed = job({ background: true, endStatus: 'killed' });
    expect(isOrphan(killed, detail([killed], { parentLive: false }))).toBe(false);
  });
});

describe('waitingOnSubagent', () => {
  it('9: a running foreground job is waiting; a blocked foreground one makes it waiting-blocked; a blocked background one does not', () => {
    const fg = job({ id: 'fg', background: false });
    expect(waitingOnSubagent(detail([fg]))).toBe('waiting');
    const fgBlocked = job({ id: 'fgb', background: false, blockedReason: 'rate-limit' });
    expect(waitingOnSubagent(detail([fg, fgBlocked]))).toBe('waiting-blocked');
    const bgBlocked = job({ id: 'bgb', background: true, blockedReason: 'rate-limit' });
    expect(waitingOnSubagent(detail([fg, bgBlocked]))).toBe('waiting');
  });

  it('10: only background, only finished, or none is null', () => {
    expect(waitingOnSubagent(detail([job({ background: true })]))).toBeNull();
    expect(waitingOnSubagent(detail([job({ background: false, status: 'done' })]))).toBeNull();
    expect(waitingOnSubagent(detail([]))).toBeNull();
  });

  it('11: a dead parent is never drawn waiting', () => {
    expect(waitingOnSubagent(detail([job({ background: false })], { parentLive: false }))).toBeNull();
  });

  it('12: a job with no background key (an older dashboard) never counts', () => {
    expect(waitingOnSubagent(detail([job()]))).toBeNull();
  });
});
