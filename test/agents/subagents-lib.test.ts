/**
 * subagents-lib.test.ts — the client's formatting of one session's subagents (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md,
 * "Copy"). Every string asserted here is the spec's copy table verbatim; the state derivation itself is `subagents-shared.test.ts`'s, so this suite
 * only pins how a state, a duration and a row's facts are worded.
 *
 * Times are offsets from one fixed `NOW` passed in, never the real clock.
 */
import {
  SUBAGENT_ORPHAN_TITLE,
  SUBAGENT_REASON_WORD,
  SUBAGENT_STATE_TONE,
  subagentBadge,
  subagentDuration,
  subagentRowFacts,
  subagentSummary
} from '../../client/src/lib/subagents';
import type { SubagentDetail, SubagentJob } from '../../shared/types';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

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

const working = () => job({ id: 'w', lastWriteAt: ago(MIN) });
const quiet = () => job({ id: 'q', lastWriteAt: ago(7 * MIN) });
const stuck = () => job({ id: 's', lastWriteAt: ago(25 * MIN) });
const blocked = () => job({ id: 'b', blockedReason: 'rate-limit' });
const killed = () => job({ id: 'k', endStatus: 'killed', status: 'done' });
const ended = () => job({ id: 'e', status: 'done', endStatus: 'completed' });

describe('subagentSummary', () => {
  it('1: counts the agents, then each state present, singular for one', () => {
    expect(subagentSummary(detail([working(), blocked(), ended()]), NOW)).toBe('3 subagents · 1 working · 1 blocked · 1 ended');
    expect(subagentSummary(detail([stuck()]), NOW)).toBe('1 subagent · 1 stuck');
    expect(subagentSummary(detail([]), NOW)).toBe('0 subagents');
  });

  it('2: states in the spec’s order, whatever order the agents came in', () => {
    const all = [ended(), killed(), blocked(), stuck(), quiet(), working()];
    expect(subagentSummary(detail(all), NOW)).toBe('6 subagents · 1 working · 1 quiet · 1 stuck · 1 blocked · 1 killed · 1 ended');
  });
});

describe('subagentDuration', () => {
  it('3: <1m, minutes, hours and minutes, days and hours, and an absent one', () => {
    expect(subagentDuration(59_999)).toBe('<1m');
    expect(subagentDuration(60_000)).toBe('1m');
    expect(subagentDuration(3 * MIN)).toBe('3m');
    expect(subagentDuration(72 * MIN)).toBe('1h 12m');
    expect(subagentDuration(52 * 60 * MIN)).toBe('2d 4h');
    expect(subagentDuration(null)).toBe('—');
  });
});

describe('subagentRowFacts', () => {
  it('4: label is the description, else the type, else `subagent`', () => {
    const d = detail([]);
    expect(subagentRowFacts(job({ description: 'fix x' }), d, NOW).label).toBe('fix x');
    expect(subagentRowFacts(job({ description: '', type: 'Explore' }), d, NOW).label).toBe('Explore');
    expect(subagentRowFacts(job({ description: '', type: '' }), d, NOW).label).toBe('subagent');
  });

  it('5: meta is type · fg|bg · model, absent parts omitted', () => {
    const d = detail([]);
    expect(subagentRowFacts(job({ type: 'Explore', background: false, model: 'opus' }), d, NOW).meta).toBe('Explore · fg · opus');
    expect(subagentRowFacts(job({ type: 'Explore', background: true }), d, NOW).meta).toBe('Explore · bg');
    expect(subagentRowFacts(job({ type: '' }), d, NOW).meta).toBe('');
  });

  it('6: an ended job reads `ran <duration>` — durationMs first, else endedAt − startedAt — and no since-write', () => {
    const d = detail([]);
    const started = ago(10 * MIN);
    const endedAt = ago(4 * MIN);
    const withDuration = subagentRowFacts(job({ status: 'done', startedAt: started, endedAt, durationMs: 4 * MIN }), d, NOW);
    expect(withDuration.age).toBe('ran 4m');
    expect(withDuration.sinceWrite).toBeNull();
    expect(subagentRowFacts(job({ status: 'done', startedAt: started, endedAt }), d, NOW).age).toBe('ran 6m');
  });

  it('7: a running job reads its age and the time since its last write, `—` with none', () => {
    const d = detail([]);
    const facts = subagentRowFacts(job({ startedAt: ago(12 * MIN), lastWriteAt: ago(7 * MIN) }), d, NOW);
    expect(facts.age).toBe('12m');
    expect(facts.sinceWrite).toBe('7m');
    expect(subagentRowFacts(job({ startedAt: ago(12 * MIN) }), d, NOW).sinceWrite).toBe('—');
  });

  it('7: lastTool is passed as sent, null when absent', () => {
    const d = detail([]);
    expect(subagentRowFacts(job({ lastTool: 'Bash(pnpm test)' }), d, NOW).lastTool).toBe('Bash(pnpm test)');
    expect(subagentRowFacts(job(), d, NOW).lastTool).toBeNull();
  });

  it('8: a blocked job’s reason in words; anything else null', () => {
    const d = detail([]);
    expect(subagentRowFacts(job({ blockedReason: 'rate-limit' }), d, NOW).reason).toBe('rate limit');
    expect(subagentRowFacts(job({ blockedReason: 'rejected' }), d, NOW).reason).toBe('tool use rejected');
    expect(subagentRowFacts(job({ blockedReason: 'interrupted' }), d, NOW).reason).toBe('interrupted');
    expect(subagentRowFacts(job(), d, NOW).reason).toBeNull();
    expect(SUBAGENT_REASON_WORD).toEqual({ 'rate-limit': 'rate limit', rejected: 'tool use rejected', interrupted: 'interrupted' });
  });

  it('9: each state’s tone, and the parent’s badge words', () => {
    expect(SUBAGENT_STATE_TONE).toEqual({ working: 'live', quiet: 'neutral', stuck: 'warn', blocked: 'bad', killed: 'bad', ended: 'done' });
    expect(subagentRowFacts(stuck(), detail([]), NOW)).toMatchObject({ state: 'stuck', tone: 'warn' });
    expect(subagentBadge('waiting')).toBe('waiting on subagent');
    expect(subagentBadge('waiting-blocked')).toBe('waiting on a blocked subagent');
    expect(subagentBadge(null)).toBeNull();
  });

  it('10: orphan only for a running background job under a dead parent', () => {
    const bg = job({ background: true });
    expect(subagentRowFacts(bg, detail([bg], { parentLive: false }), NOW).orphan).toBe(true);
    expect(subagentRowFacts(bg, detail([bg], { parentLive: null }), NOW).orphan).toBe(false);
    expect(subagentRowFacts(bg, detail([bg]), NOW).orphan).toBe(false);
    const fg = job({ background: false });
    expect(subagentRowFacts(fg, detail([fg], { parentLive: false }), NOW).orphan).toBe(false);
    expect(SUBAGENT_ORPHAN_TITLE).toBe('background agent whose parent process is gone — nothing will wake the parent when it stops');
  });
});
