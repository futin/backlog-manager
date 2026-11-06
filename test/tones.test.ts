import { STATE_LABEL, type JiraSessionState } from '../shared/jira-sessions';
import type { OrchestratorRun } from '../shared/types';
import { sessionTone, runTone, type StateTone } from '../client/src/lib/tones';

describe('sessionTone', () => {
  const CASES: Array<[JiraSessionState, StateTone]> = [
    ['plan', 'amber'],
    ['permission', 'amber'],
    ['reply', 'amber'],
    ['answer', 'amber'],
    ['starting', 'green'],
    ['working', 'green'],
    ['quiet', 'grey'],
    ['ended', 'grey'],
    ['lost', 'red']
  ];
  it.each(CASES)('%s reads %s', (state, tone) => {
    expect(sessionTone(state)).toBe(tone);
  });
  it('covers every session state', () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual(CASES.map(([s]) => s).sort());
  });
});

describe('runTone', () => {
  const CASES: Array<[OrchestratorRun['status'], StateTone]> = [
    ['running', 'green'],
    ['paused', 'amber'],
    ['done', 'grey'],
    ['aborted', 'grey'],
    ['failed', 'red']
  ];
  it.each(CASES)('%s reads %s', (status, tone) => {
    expect(runTone(status)).toBe(tone);
  });
});
