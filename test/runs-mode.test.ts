import { isRunsMode, RUNS_MODE_KEY, RUNS_MODES } from '../client/src/lib/runs-mode';

/**
 * The Runs section's one view switch (task-18). A guard rather than a bare
 * cast because the value is PERSISTED: an older build, a hand-edited
 * localStorage entry or a future rename all read back through here, and the
 * one thing that must never happen is the section rendering neither surface.
 */
describe('isRunsMode', () => {
  it('accepts exactly the two modes', () => {
    expect(isRunsMode('runs')).toBe(true);
    expect(isRunsMode('watchdog')).toBe(true);
  });

  it('rejects everything else, including the shapes localStorage can hand back', () => {
    expect(isRunsMode('banana')).toBe(false);
    expect(isRunsMode(undefined)).toBe(false);
    expect(isRunsMode(null)).toBe(false);
    expect(isRunsMode(42)).toBe(false);
    expect(isRunsMode({})).toBe(false);
  });

  it('states the union and the storage key once', () => {
    expect(RUNS_MODES).toEqual(['runs', 'watchdog']);
    expect(RUNS_MODE_KEY).toBe('backlog-manager.runs-mode');
  });
});
