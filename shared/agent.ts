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
 * The button's word: `execute` or `groom`, and nothing else.
 *
 * An idea used to read `groom → task`, on the reasoning that grooming *moves*
 * it out of the column you clicked in and the label should warn about that.
 * Dropped: the destination is the groom skill's business, not the button's, and
 * spelling it out on one of four columns made the control look like two
 * different actions when it is one. What grooming does to the file differs by
 * section already — a bug is groomed in place and stays a bug, an idea is
 * promoted — and the label was the only place claiming otherwise.
 *
 * `item` is still in the signature: the caller passes the item it is labelling
 * either way, and a label that varies by section is a change away rather than
 * a signature change away at every call site.
 */
export function actionLabel(_item: BacklogItem, action: AgentAction): string {
  return action === 'execute' ? 'execute' : 'groom';
}

/** Lowest to highest. Order is the whole meaning — do not sort this. */
export const PERMISSION_LADDER: readonly PermissionMode[] = [
  'plan', 'acceptEdits', 'auto', 'bypassPermissions'
];

/**
 * The `--model` names the dashboard's spawn accepts, mirroring its
 * `server/lib/spawn.ts` MODELS verbatim. Duplicated rather than fetched: the
 * dashboard publishes neither list on its `/api/health`, and adding a
 * round trip per sheet open to learn four strings that change once a year is
 * the wrong trade. PERMISSION_LADDER above is duplicated on the same terms.
 *
 * Order is display order, not a ladder — nothing here is clamped, so unlike
 * PERMISSION_LADDER this array may be reordered freely.
 */
export const MODELS: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

/** Mirrors the dashboard's EFFORTS. Lowest to highest, for the reader's sake
 *  only — see MODELS on why neither list is clamped against. */
export const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A value from `list`, or undefined for anything else — including the empty
 * string the "default" option submits.
 *
 * Undefined is the whole point: the caller spreads the result into the spawn
 * body, `JSON.stringify` drops an undefined value, and the dashboard omits the
 * flag from its argv when the field is missing. So "no pick" and "a name this
 * build has never heard of" both land on the CLI's own default rather than on
 * a guess.
 *
 * Dropped, not rejected. Unlike `clampMode` there is no ladder to clamp along,
 * and unlike `action` there is nothing in the item file to check against — a
 * model name is neither more nor less privileged than another. Rejecting would
 * only make this app the thing that breaks the day the dashboard learns a
 * fifth model, which is exactly the drift these duplicated lists invite.
 */
export function pickFrom(want: unknown, list: readonly string[]): string | undefined {
  return typeof want === 'string' && list.includes(want) ? want : undefined;
}

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
 * What the board should do with this item's dispatch control, and why.
 *
 * The three cases are not three severities of the same thing — they are two
 * genuinely different kinds of "no", and the UI owes them different answers:
 *
 *  - `hidden` — an ENVIRONMENT-level block: dispatch is off, the dashboard is
 *    unreachable, it has no `CLAUDE_BIN`, its remote answers are off. None of
 *    those is about this card, none is fixable from the board, and all four
 *    are true of every card at once. A disabled control on all forty of them
 *    is noise the reader cannot act on, so the control is not rendered at all.
 *    This is also what makes the promise the spec and `.env.example` both
 *    make — with `BM_AGENTS` off the board "renders exactly as it does today"
 *    and "shows no dispatch buttons" — literally true.
 *  - `disabled` — a PER-ITEM block: the dashboard cannot see this item's
 *    project. That one IS about this card, it is fixable (open a session
 *    there, or raise the dashboard's `LOOKBACK_HOURS`), and it names a path,
 *    so a control that states the reason is worth more than silence. It is
 *    precisely the behaviour chosen when the lookback limit was accepted
 *    rather than worked around.
 *  - `enabled` — nothing is in the way.
 *
 * Ordered most-fundamental first so the reason names the thing to fix rather
 * than a symptom of it: with BM_AGENTS off there is nothing to say about
 * reachability.
 */
export type DispatchGate =
  | { control: 'enabled' }
  | { control: 'hidden'; reason: string }
  | { control: 'disabled'; reason: string };

export function dispatchGate(item: BacklogItem, status: AgentsStatus): DispatchGate {
  if (!status.enabled) {
    return { control: 'hidden', reason: 'dispatch is off — set BM_AGENTS=on for the API' };
  }
  if (!status.reachable) {
    return {
      control: 'hidden',
      reason: `dashboard unreachable${status.error ? `: ${status.error}` : ''}`
    };
  }
  if (!status.spawnAvailable) {
    return { control: 'hidden', reason: 'the dashboard has no CLAUDE_BIN configured' };
  }
  if (!status.remoteAnswer) {
    return { control: 'hidden', reason: 'remote answers are off in the dashboard' };
  }
  if (!status.projectPaths.includes(item.projectPath)) {
    return {
      control: 'disabled',
      reason: `the dashboard cannot see ${item.projectPath} — no Claude session there inside its LOOKBACK_HOURS`
    };
  }
  return { control: 'enabled' };
}

/**
 * Why this item cannot be dispatched right now, or null when it can.
 *
 * The same decision as `dispatchGate`, flattened for the two callers that only
 * ever refuse — the launch sheet's re-check and the server's own — because
 * hidden-versus-disabled is a rendering question and neither of them renders
 * anything. Derived from `dispatchGate` rather than repeating the ladder, so
 * one ordering and one set of wordings serves the board, the sheet and the API.
 */
export function dispatchBlock(item: BacklogItem, status: AgentsStatus): string | null {
  const gate = dispatchGate(item, status);
  return gate.control === 'enabled' ? null : gate.reason;
}
