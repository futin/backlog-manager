import { dispatchDotTone } from '../shared/agent';
import type { AgentsStatus, MachineHealth } from '../shared/types';

/** One rung per case, each fixture differing from `LIVE` in exactly the field under test, so a case that passes does so for that field and no other. */
const LIVE = { enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true } as const;

describe('dispatchDotTone — "a launch could go there now", read once', () => {
  it('is null while there is no answer yet', () => {
    expect(dispatchDotTone(null)).toBeNull();
  });

  it('is null when dispatch is off, whatever else is true', () => {
    expect(dispatchDotTone({ ...LIVE, enabled: false })).toBeNull();
  });

  it('is crashed when the dashboard is unreachable', () => {
    expect(dispatchDotTone({ ...LIVE, reachable: false })).toBe('crashed');
  });

  it('is paused when remote answers are off', () => {
    expect(dispatchDotTone({ ...LIVE, remoteAnswer: false })).toBe('paused');
  });

  it('is paused when there is no CLAUDE_BIN — the rung the old three-tier dot was blind to', () => {
    expect(dispatchDotTone({ ...LIVE, spawnAvailable: false })).toBe('paused');
  });

  it('is live when all four are true', () => {
    expect(dispatchDotTone(LIVE)).toBe('live');
  });

  it('takes a full AgentsStatus (with projectPaths) as its argument, and AgentsStatus is assignable to MachineHealth', () => {
    const full: AgentsStatus = { ...LIVE, spawnMaxPermission: 'auto', projectPaths: ['/a'] };
    const health: MachineHealth = full;
    expect(dispatchDotTone(full)).toBe('live');
    expect(dispatchDotTone(health)).toBe('live');
  });
});
