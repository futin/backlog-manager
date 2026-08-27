import type { AgentsStatus, BacklogItem, PermissionMode } from './types';

/**
 * agent.ts — what a card's button does, decided once for both sides.
 *
 * The server is the authority (it re-scans the file and refuses a request whose
 * action disagrees), but the board needs the same answer to label and enable a
 * button without a round trip per card. Two implementations would drift, so
 * this module lives in shared/ and both import it — the same arrangement
 * shared/types.ts already has, and shared/theme.css before it.
 */

/** What a click dispatches. Derived from the item; never chosen by the caller. */
export type AgentAction = 'groom' | 'execute';

/**
 * The next step this item actually has, or null when it has none.
 *
 * `status !== 'open'` covers both archives in one line: a `done/` item is
 * history, and out-of-scope is `terminal` — neither has a next step. Ideas go
 * to groom unconditionally (grooming is what promotes them; `groomed` is null
 * for them by construction). Bugs and tasks turn on the groomed derivation
 * alone, which is exactly the condition backlog-execute refuses to work
 * without: a bug whose Fix still reads "unknown" gets groomed first.
 */
export function deriveAction(item: BacklogItem): AgentAction | null {
  if (item.status !== 'open') return null;
  if (item.section === 'ideas') return 'groom';
  return item.groomed === true ? 'execute' : 'groom';
}

/**
 * The button's word. An idea names its destination because grooming *moves* it
 * out of the column you clicked in — a bug groomed in place does not, so it
 * says only what it does.
 */
export function actionLabel(item: BacklogItem, action: AgentAction): string {
  if (action === 'execute') return 'execute';
  return item.section === 'ideas' ? 'groom → task' : 'groom';
}

/** Lowest to highest. Order is the whole meaning — do not sort this. */
export const PERMISSION_LADDER: readonly PermissionMode[] = [
  'plan', 'acceptEdits', 'auto', 'bypassPermissions'
];

/**
 * The modes a launch may actually ask for. A null ceiling means we never read
 * one (the dashboard was unreachable), and the safe reading of "unknown
 * ceiling" is the floor, not the top.
 */
export function modesUpTo(ceiling: PermissionMode | null): PermissionMode[] {
  if (ceiling === null) return ['plan'];
  const i = PERMISSION_LADDER.indexOf(ceiling);
  // An unrecognised ceiling string is a dashboard newer than this client:
  // treat it as the floor rather than guessing where it sits on the ladder.
  return i === -1 ? ['plan'] : PERMISSION_LADDER.slice(0, i + 1);
}

/**
 * Clamp a requested mode to the ceiling. Takes a `string`, not a
 * `PermissionMode`, because its whole job is to be the place an unvalidated
 * value from a request body becomes a valid one.
 *
 * A naive search of the truncated `allowed` array alone cannot distinguish
 * "mode we do not recognise" from "mode we recognise but the ceiling forbids".
 * Both yield -1 with indexOf, but they need different answers: junk goes to
 * the floor, while a legitimate-but-too-high request belongs at the ceiling.
 * Consult the full PERMISSION_LADDER to tell them apart.
 */
export function clampMode(want: string, ceiling: PermissionMode | null): PermissionMode {
  const allowed = modesUpTo(ceiling);

  if (allowed.includes(want as PermissionMode)) {
    return want as PermissionMode;
  }

  const fullIndex = PERMISSION_LADDER.indexOf(want as PermissionMode);

  if (fullIndex === -1) {
    return allowed[0];
  }

  return allowed[allowed.length - 1];
}

/**
 * Why this item cannot be dispatched right now, or null when it can.
 *
 * Ordered most-fundamental first so the message names the thing to fix rather
 * than a symptom of it: with BM_AGENTS off there is nothing to say about
 * reachability. Shared because the board disables a button with it, the launch
 * sheet re-checks it, and the server refuses with it — one wording, three
 * places.
 */
export function dispatchBlock(item: BacklogItem, status: AgentsStatus): string | null {
  if (!status.enabled) return 'dispatch is off — set BM_AGENTS=on for the API';
  if (!status.reachable) {
    return `dashboard unreachable${status.error ? `: ${status.error}` : ''}`;
  }
  if (!status.spawnAvailable) return 'the dashboard has no CLAUDE_BIN configured';
  if (!status.remoteAnswer) return 'remote answers are off in the dashboard';
  if (!status.projectPaths.includes(item.projectPath)) {
    return `the dashboard cannot see ${item.projectPath} — no Claude session there inside its LOOKBACK_HOURS`;
  }
  return null;
}
