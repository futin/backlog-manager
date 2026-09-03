import { ATTENTION_RUN_STAGES, RUN_CLAIMED_STAGES } from './types';
import type {
  AgentsStatus, BacklogItem, OrchestratorRunsPayload, PermissionMode, RunQueueItem, RunStage
} from './types';

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
export type AgentAction = 'groom' | 'execute' | 'capture';

/**
 * Every member of `AgentAction`, as a value — what a request body's `action`
 * is checked against.
 *
 * Exported so the controller (`agents.controller.ts`) can validate a body
 * without restating the union by hand, which is the one thing this module
 * exists to prevent: a hand-written `!== 'groom' && !== 'execute'` chain is a
 * second copy of the vocabulary, and it is exactly the copy that got missed
 * when a third action was added. `test/agents-shared.test.ts` pins it against
 * the type.
 */
export const AGENT_ACTIONS: readonly AgentAction[] = ['groom', 'execute', 'capture'];

/** Is this unvalidated value one of the three actions? The type guard the
 *  controller narrows a request body's `action` with. */
export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === 'string' && (AGENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * The next step this item actually has, or null when it has none.
 *
 * **The section check runs first, and the ordering is the rule.** An
 * out-of-scope item is `terminal`, so the `status !== 'open'` line below would
 * swallow it — which is precisely what it used to do, back when that one line
 * covered both archives at once. It no longer does, and the two archives no
 * longer share a branch, because they are not the same kind of ending: a
 * `done/` item is history and genuinely has no next step, while a rejection
 * does. Reviving a rejection is `capture` — a NEW item citing the original with
 * `from: <id>`, never a move out of `out-of-scope/`, which `moveItem` refuses
 * and this does not lift. The old shared branch read as one rule and was two,
 * and the second one was wrong.
 *
 * Ideas go to groom unconditionally (grooming is what promotes them; `groomed`
 * is null for them by construction). Bugs and tasks turn on the groomed
 * derivation alone, which is exactly the condition backlog-execute refuses to
 * work without: a bug whose Fix still reads "unknown" gets groomed first.
 *
 * Refactors reach the same answer as ideas without a branch of their own, and
 * that is deliberate rather than an oversight: `groomed` is null for them too
 * (see deriveGroomed), so `groomed === true` is false and the return is
 * 'groom'. Adding `|| section === 'refactors'` to the line above would read as
 * a rule and encode none — the null derivation is the rule, and every future
 * section that has no groomed state inherits it for free. Note this is NOT the
 * same shape as composePrompt in server/src/agents/prompt.util.ts, which does
 * name refactors explicitly: there the fall-through led somewhere wrong (the
 * task fallback), so the branch had to be widened.
 */
export function deriveAction(item: BacklogItem): AgentAction | null {
  if (item.section === 'out-of-scope') return 'capture';
  if (item.status !== 'open') return null;
  if (item.section === 'ideas') return 'groom';
  return item.groomed === true ? 'execute' : 'groom';
}

/**
 * The word on every control, keyed by action rather than chosen by a ternary.
 *
 * A record, not `action === 'execute' ? … : 'groom'`, and the difference is
 * the compiler: every label happens to equal its own action string today, so
 * the record buys exactly one thing — a fourth action cannot be added without
 * someone deciding what it says. The ternary silently labelled everything that
 * was not `execute` as `groom`, which is how a third action would have shipped
 * reading as the wrong word.
 */
const ACTION_LABEL: Record<AgentAction, string> = {
  groom: 'groom',
  execute: 'execute',
  capture: 'capture'
};

/**
 * The button's word: one of the three actions, and nothing else.
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
  return ACTION_LABEL[action];
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
 *    project. That one IS about this card, it is usually fixable (open a
 *    session there, or raise the dashboard's `LOOKBACK_HOURS`), and it names a
 *    path, so a control that states the reason is worth more than silence. It
 *    is precisely the behaviour chosen when the lookback limit was accepted
 *    rather than worked around. "Usually", because a caller reading a status
 *    it fetched some time ago cannot tell a project the dashboard genuinely
 *    cannot see from one whose absence is only news to its own stale copy of
 *    the list — which is why the wording below states the absence as fact and
 *    the lookback as a likelihood, and why the board now re-asks on a click
 *    instead of swallowing it (bug-13).
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

/**
 * The four ENVIRONMENT-level dispatch blockers — dispatchGate's `hidden`
 * ladder, with its one item-specific line (project visibility) left out.
 * None of these four ever reads an item: BM_AGENTS off, the dashboard
 * unreachable, no `CLAUDE_BIN`, remote answers off are all true of every
 * card/project at once or none of them, which is exactly dispatchGate's own
 * definition of `hidden` above.
 *
 * Extracted into its own function so a caller with no `BacklogItem` at all
 * can run these same four checks without either widening dispatchGate's
 * signature (its fifth line is genuinely item-shaped — `item.projectPath` —
 * so a plain `projectPath: string` parameter would only fit four of its five
 * lines) or re-deriving them by hand. The second path is not hypothetical:
 * an earlier version of `AgentsService.orchestrate()`
 * (server/src/agents/agents.service.ts) did exactly that — reimplemented
 * only the project-visibility line and silently dropped these four — so an
 * unreachable dashboard produced a flatly wrong "cannot see this project"
 * refusal, and a dashboard with no `CLAUDE_BIN` or remote answers off let an
 * actual spawn request through that this ladder would have refused before
 * any outbound call. `projectDispatchGate` below is this function's one
 * caller now (`dispatchGate` and `orchestrate()` both go through it in
 * turn), so there is exactly one place these four conditions and their
 * wording live.
 */
export function environmentBlock(status: AgentsStatus): string | null {
  if (!status.enabled) {
    return 'dispatch is off — set BM_AGENTS=on for the API';
  }
  if (!status.reachable) {
    return `dashboard unreachable${status.error ? `: ${status.error}` : ''}`;
  }
  if (!status.spawnAvailable) {
    return 'the dashboard has no CLAUDE_BIN configured';
  }
  if (!status.remoteAnswer) {
    return 'remote answers are off in the dashboard';
  }
  return null;
}

/**
 * The per-PROJECT half of `dispatchGate` — the same environment ladder plus
 * the one project-visibility check, keyed on a project path directly rather
 * than a whole `BacklogItem`. `dispatchGate` below is one caller (it merely
 * supplies `item.projectPath`); `AgentsService.orchestrate()`
 * (server/src/agents/agents.service.ts) and the board's own toolbar
 * Orchestrate button (`client/src/components/board/BoardView.tsx`) are the
 * other two — a project-scoped control, unlike a per-item one, never has a
 * `BacklogItem` to hand `dispatchGate` in the first place.
 *
 * Hoisted here in Task 13's fix round 1 after a review found THREE
 * independent copies of this exact reason string: `dispatchGate` below,
 * `orchestrate()`'s own inline check, and BoardView's toolbar gate. All
 * three agreed verbatim at the time, but that is exactly the drift class
 * `environmentBlock` above was hoisted to prevent one level down — its own
 * doc comment tells that story (`orchestrate()` once reimplemented only ONE
 * of dispatchGate's five lines and silently dropped the other four). Three
 * copies of the fifth line is the same failure shape one level up: one
 * implementation, three callers, one reason string, so a wording change can
 * never land in one copy and not the other two.
 */
export function projectDispatchGate(status: AgentsStatus, projectPath: string): DispatchGate {
  const blocked = environmentBlock(status);
  if (blocked !== null) {
    return { control: 'hidden', reason: blocked };
  }
  if (!status.projectPaths.includes(projectPath)) {
    return {
      control: 'disabled',
      /*
       * bug-13: the first clause is what the caller KNOWS — this path is not
       * in the `projectPaths` list it is holding — and the second is only the
       * usual explanation for that. The wording used to assert the lookback
       * as fact, which turned a status a browser tab had held for a while
       * into confidently wrong advice: it sent people to open a session in a
       * repo that already had one, for a project the dashboard could see
       * perfectly well. Every reader of this string is one step removed from
       * the dashboard's own answer (a cached project map here, a tab's copy
       * of it there), so none of them can promote the likelihood to a fact.
       */
      reason: `the dashboard does not list ${projectPath} — most likely no Claude session there inside its LOOKBACK_HOURS`
    };
  }
  return { control: 'enabled' };
}

/** `item.projectPath` is the one item-shaped input `projectDispatchGate`
 *  needs; every other line of the gate is already project-scoped. Signature
 *  and behaviour unchanged by the Task 13 fix round 1 hoist above — every
 *  existing caller and test keeps reading exactly the same answer for
 *  exactly the same inputs. */
export function dispatchGate(item: BacklogItem, status: AgentsStatus): DispatchGate {
  return projectDispatchGate(status, item.projectPath);
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

/**
 * Why an orchestrator run forbids dispatching this item right now, or null
 * when none does.
 *
 * The fourth kind of dispatch block, and the only one that reads something
 * other than an item file and a dashboard status. It exists because the two
 * things it compares can never learn about each other on their own: an
 * orchestrator run works each item inside its own git worktree and nothing
 * reaches `main` until the item merges, so while a run has `task-7` at
 * `reviewing`, the `task-7` file `/api/items` scans on `main` looks untouched
 * — no `started:`, no `phase:`, nothing `isInProgress` could key off. The item
 * is not lying; it is telling the truth about `main`. "This item is claimed by
 * a run" therefore exists in exactly one place, the run payload, and every
 * surface that needs it has to be handed it explicitly.
 *
 * ONE function doing the whole lookup — the project match, the id match and
 * the freshness filter together — rather than a stage-to-reason helper each
 * caller invokes after its own lookup. Those three lines are exactly the part
 * a second copy gets subtly wrong, and `environmentBlock` above records that
 * having already happened once in this very file: `orchestrate()` once
 * reimplemented one of `dispatchGate`'s five lines and silently dropped the
 * other four.
 *
 * `fresh`, not `status === 'running'`: a stale run has stopped reporting, and
 * freshness is already the rule every other run-derived surface uses (the run
 * strip renders nothing for a stale run, and the board's badge map is built
 * from fresh runs only). A crashed run may still hold a worktree, so blocking
 * on staleness is arguable — but that is a recovery problem `--resume` and
 * `--abort` own, and cards dead until someone runs one of those is a worse
 * failure than the double-dispatch this exists to prevent.
 *
 * `runs` is the payload shape `GET /api/orchestrator/runs` answers with, which
 * is what both callers already hold: the board from `useOrchestratorRuns`, the
 * server from `OrchestratorService.runs()`.
 */
export function runClaimBlock(
  item: BacklogItem,
  runs: OrchestratorRunsPayload['runs']
): string | null {
  const claimed = runEntryAt(item, runs, RUN_CLAIMED_STAGES);
  return claimed === null
    ? null
    : `an orchestrator run is working this item (${claimed.stage})`;
}

/**
 * The queue entry a FRESH run in this item's project holds this item at, when
 * that stage is one of `stages` — or null.
 *
 * The three lines this hoists out of `runClaimBlock` (the freshness filter,
 * the project match, the id match) are the ones its own doc comment above
 * calls "exactly the part a second copy gets subtly wrong", and bug-11 needed
 * a second caller asking the same lookup with a wider stage list. Hoisting
 * rather than writing that second scan is the whole of the rule
 * `environmentBlock` already records having learned the hard way in this very
 * file. The stage list is the ONLY thing the two callers differ by, and it is
 * therefore the only thing this takes as a parameter.
 *
 * Private on purpose: what callers outside this module need is a named
 * question — "may I dispatch this" or "is a run holding this" — not a scan
 * they parameterise themselves, which would be the vocabulary leaking back out
 * one level.
 */
function runEntryAt(
  item: BacklogItem,
  runs: OrchestratorRunsPayload['runs'],
  stages: readonly RunStage[]
): RunQueueItem | null {
  for (const run of runs) {
    // The registry's absolute path on both sides — `OrchestratorRun.project`
    // and `BacklogItem.projectPath` are documented as the same string. Never
    // the display name: two checkouts of one repo share a name and never a
    // path, and only the path is what the run itself reports.
    if (!run.fresh || run.project !== item.projectPath) continue;
    const found = run.queue.find((q) => q.id === item.id && stages.includes(q.stage));
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Every stage a run still HOLDS the item at: the eight it is actively working
 * it through, plus the two it has stopped at waiting for a person. The
 * complement is the four true exits — `merged`, `failed`, `skipped`,
 * `ungroomed` — after which nobody is on the item at all.
 *
 * Composed from the two exported partitions rather than written out, which is
 * the one place in this pair of lists that composing is right: both halves are
 * hand-written next to `RunStage` itself (see their comments), so this union
 * cannot silently gain or lose a member without one of them changing, and
 * `test/agents-shared.test.ts` asserts the three-way partition against a
 * `Record<RunStage, true>` literal in any case.
 */
const RUN_HELD_STAGES: readonly RunStage[] = [...RUN_CLAIMED_STAGES, ...ATTENTION_RUN_STAGES];

/**
 * Is a fresh orchestrator run holding this item — working it, or stopped on it
 * waiting for a person?
 *
 * The second question over the same payload `runClaimBlock` reads, and the two
 * differ by exactly two stages, which is the point rather than an accident.
 * `runClaimBlock` answers "may a human dispatch this", and a `parked` or
 * `needs-answers` item may be dispatched by hand — that is what parking is
 * FOR. This answers "is this live work", and a run blocked on a question is
 * the most live thing on the board: somebody is being asked something. Fold
 * the two together and one of those two behaviours has to be given up.
 *
 * Exists because staleness cannot see a run any other way (bug-11). `isStale`
 * (client/src/lib/item-stale.ts) exempts an item someone is working from its
 * date arithmetic, but it read that fact from the item file's `started:` —
 * and an orchestrator run stamps only its own worktree's copy, so the copy
 * both surfaces render stays silent for the whole run. A long-untouched bug a
 * run had just picked up therefore left the Board for Archive: the one card
 * the run strip and the column rank exist to point at was the one card not on
 * the board. Same principle `runClaimBlock`'s comment states above — the fact
 * lives in exactly one place, the run payload, and every surface that needs it
 * has to be handed it explicitly.
 *
 * `fresh`, for the reason `runClaimBlock` gives at length: a run that has
 * stopped heartbeating is not working anything, and recovering it is
 * `--resume`/`--abort`'s job. An item held by a crashed run goes back to being
 * as stale as its file says it is, which is the honest answer.
 */
export function runHoldsItem(
  item: BacklogItem,
  runs: OrchestratorRunsPayload['runs']
): boolean {
  return runEntryAt(item, runs, RUN_HELD_STAGES) !== null;
}

/**
 * The shape of a backlog item id: a section prefix and a number, nothing else.
 *
 * Deliberately the same regex `backlog.mjs`'s own `ID_SHAPE` enforces
 * (`skills/backlog/tools/backlog.mjs`), restated here rather than imported:
 * the skills are a published plugin with git as their publishing boundary
 * (see CLAUDE.md), so the server and client cannot import from them at all,
 * and the two copies are kept honest by the prefixes being a closed set that
 * has changed exactly once (`refactors: 'ref'`) in this repo's life.
 *
 * `[a-z]+` rather than a literal alternation of the five known prefixes on
 * purpose: this predicate answers "could this string be an id", and the
 * authoritative answer to "is this an id that exists" is the membership scan
 * in `AgentsService.orchestrate`, which is the only check that can be right.
 * Naming the prefixes here would add a second place to edit when a section is
 * added, and buy nothing the scan does not already refuse.
 */
const ITEM_ID_SHAPE = /^[a-z]+-\d+$/;

/**
 * Longer than any id this store can mint and short enough that nothing
 * absurd reaches the directory scan behind it. Not a security boundary — the
 * anchoring above already rules out every dangerous character — just a cap on
 * how much nonsense a caller can make the server walk over.
 */
const ITEM_ID_MAX = 64;

/**
 * Is this value syntactically an item id?
 *
 * The cheap first gate on `POST /api/agents/orchestrate`'s `ids` list, and the
 * reason that route can compose a prompt out of caller-supplied strings at all
 * without weakening the "the orchestrate spawn prompt is a server-side
 * constant" invariant: what survives this predicate is a bare identifier —
 * no whitespace, no path separator, no shell metacharacter, no newline to
 * split the one-line prompt with — and what survives the membership check
 * after it is the id of a real open item in the project being orchestrated.
 * Free text never gets near the prompt either way.
 *
 * Takes `unknown` for the same reason `pickFrom` does: the server is
 * narrowing a body it cannot trust, so the type guard is the point rather
 * than an afterthought at the call site.
 */
export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ITEM_ID_MAX && ITEM_ID_SHAPE.test(value);
}
