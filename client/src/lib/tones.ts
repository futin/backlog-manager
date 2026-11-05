import type { JiraSessionState } from '../../../shared/jira-sessions';
import type { OrchestratorRun } from '../../../shared/types';

/**
 * The four marks a state can wear — the colour of a `.ui-stripe` edge and a `.ui-stripe-dot`. Amber is "a person is wanted", green "alive and moving", grey
 * "nothing to do" and red "something broke"; every state-bearing row and card derives its mark from here so a Sessions row and its Runs sibling cannot
 * disagree on what amber means.
 */
export type StateTone = 'amber' | 'green' | 'grey' | 'red';

/** Exhaustive on purpose: a new `JiraSessionState` member is a type error here, not a silently grey row. */
export function sessionTone(state: JiraSessionState): StateTone {
  switch (state) {
    case 'plan':
    case 'permission':
    case 'reply':
    case 'answer':
      return 'amber';
    case 'starting':
    case 'working':
      return 'green';
    case 'quiet':
    case 'ended':
      return 'grey';
    case 'lost':
      return 'red';
  }
}

/** Exhaustive for the same reason; `paused` is amber because only a person's resume moves it. */
export function runTone(status: OrchestratorRun['status']): StateTone {
  switch (status) {
    case 'running':
      return 'green';
    case 'paused':
      return 'amber';
    case 'done':
    case 'aborted':
      return 'grey';
    case 'failed':
      return 'red';
  }
}
