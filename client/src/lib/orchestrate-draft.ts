import { deriveAction, type AgentAction } from '../../../shared/agent';
import type { BacklogItem, MergeMode, PermissionMode, ProjectSummary, QuestionMode, StartOrchestrateRequest, UncommittedItems } from '../../../shared/types';
import { modelEffortFlags } from './agents';

/**
 * orchestrate-draft.ts — the Orchestrate sheet's derivations, pure (#306). Every value here used to be computed inline in `OrchestrateSheet`'s render body;
 * they moved out whole, comments with them, so each can be unit-tested without jsdom (`test/orchestrate-draft.test.ts`) — the board's "every derivation has
 * one home in `lib/`" rule. `hooks/useOrchestrateDraft.ts` holds the state these read and calls them every render; nothing here is memoised, and nothing
 * here may be, for the reason each derivation's own comment gives: the inputs are props BoardView re-polls, and a stored answer is a stale one.
 */

/** One previewed row: the item and the action its card's dispatch button would take. */
export interface QueueRow {
  item: BacklogItem;
  action: AgentAction;
}

/**
 * The queue preview — deliberately client-side and deliberately only an
 * approximation, per brief context point 6: there is no server endpoint
 * that runs the orchestrator's real gate against a whole project (adding
 * one would mean either shelling out to orchestrate.mjs on every sheet
 * open, or reimplementing its gate a second time in TypeScript — both
 * rejected), and the tool's own gate remains the only authority. That gate
 * (gateItem/gateTask/gateBug in orchestrate.mjs) inspects PROSE inside a
 * `## Plan`/`## Fix` section — a lone "TBD" earns `needs-answers` rather
 * than `ungroomed`, for instance — which is content this `BacklogItem`
 * shape never carries at all; the only signal the board already has is
 * exactly the one `deriveAction` (shared/agent.ts) already turns into
 * every card's own dispatch button — the same `groomed` flag DispatchButton
 * reads. So this preview reuses that identical derivation rather than
 * inventing a second, looser notion of "ready", and the note rendered
 * alongside it says outright that the real run may disagree once it
 * actually re-gates each item.
 *
 * The section filter is NOT part of that approximation, and is why
 * `deriveAction` alone is not the whole predicate here. `deriveAction`
 * answers "what would this card's dispatch button do", and for an idea or a
 * refactor the honest answer is `'groom'` (shared/agent.ts) — but an
 * orchestrate run's queue is bugs and tasks and nothing else, by
 * construction: `GATE_SECTIONS = { bugs, tasks }` in orchestrate.mjs, which
 * mirrors backlog-execute's own "never touches ideas, refactors or
 * out-of-scope". So a preview built on `deriveAction` alone listed rows the
 * run can never look at — a project with a dozen ideas showed a dozen of
 * them — and the sheet's disclaimer does not cover that: it promises the
 * run may re-gate an item to a different VERDICT, not that whole sections
 * are out of scope. This is the last screen before a multi-hour unattended
 * operation, so it lists what the run will actually consider and nothing
 * else. An ungroomed bug or task stays in the list, labelled `groom`,
 * because the run really will look at it and really will report it as
 * ungroomed — that is information, not noise.
 */
export function orchestrateQueue(items: BacklogItem[]): QueueRow[] {
  return items
    .filter((item) => item.status === 'open' && (item.section === 'bugs' || item.section === 'tasks'))
    .map((item) => ({ item, action: deriveAction(item) }))
    .filter((row): row is QueueRow => row.action !== null);
}

export interface Selection {
  selectedIds: string[];
  narrowed: boolean;
  emptySelection: boolean;
  isSelected: (id: string) => boolean;
}

/**
 * The selection, resolved against the queue as it stands right now.
 *
 * Everything below is derived rather than stored, which is what keeps
 * `selected` from drifting out of step with `queue`: an id that has left
 * the queue since it was ticked simply stops appearing here, so a stale
 * id can never reach the request.
 *
 * `narrowed` is the strict-subset test the whole request shape turns on,
 * and it is deliberately a comparison against the queue rather than a
 * "has the user touched anything" flag. Select-none followed by
 * select-all lands back on the full queue, and must therefore land back
 * on the full-queue REQUEST — a touched-flag would send an explicit list
 * there and quietly reintroduce the snapshot problem `selected`'s own
 * comment (hooks/useOrchestrateDraft.ts) describes.
 *
 * `narrowed` is no longer the whole request condition, though — `buildStartRequest`
 * below sends `ids` for `narrowed || order !== null` (§7.3). A hand order
 * forces an explicit list even when nothing is deselected, which
 * reintroduces exactly the snapshot this test was built to avoid: an item
 * groomed between opening the sheet and pressing Start will not be in the
 * run. That is unavoidable rather than an oversight — choosing an order IS
 * choosing a membership, since there is no way to say "these three, in
 * this sequence, plus anything else that shows up" — so the cost is paid
 * deliberately and step 2 states it on screen rather than leaving it to be
 * discovered afterwards. The reset control is what gives it back.
 */
export function resolveSelection(queueIds: string[], selected: Set<string> | null): Selection {
  const isSelected = (id: string): boolean => selected === null || selected.has(id);
  const selectedIds = queueIds.filter(isSelected);
  const narrowed = selectedIds.length < queueIds.length;
  /** Nothing ticked, with rows to tick — refused below. An EMPTY QUEUE is
   *  not this state: there is nothing to narrow, so the sheet keeps its
   *  pre-selector behaviour and starts a plain whole-queue run. Refusing
   *  there would be the board overruling the orchestrator's own gate on the
   *  strength of a preview that says outright it is not authoritative. */
  const emptySelection = queueIds.length > 0 && selectedIds.length === 0;
  return { selectedIds, narrowed, emptySelection, isSelected };
}

/**
 * The selection in the order it will actually run, resolved against the
 * live selection on every render — the same discipline `selectedIds`
 * itself uses one derivation up, and for the same reason: `order` is a
 * list of ids somebody arranged at some past moment, and a stored
 * RESOLVED list would let an id that has since left the queue reach the
 * request.
 *
 * The two halves are the whole reconciliation rule (§7.2). Ids still
 * selected keep their arranged position; ids that were not in `order` at
 * all — freshly groomed while the sheet sat open, or unticked and ticked
 * again — append at the end, which is the only position that cannot claim
 * a preference nobody expressed. An id that vanishes just fails the
 * filter.
 */
export function arrangeOrder(order: string[] | null, selectedIds: string[]): string[] {
  return order === null ? selectedIds : [...order.filter((id) => selectedIds.includes(id)), ...selectedIds.filter((id) => !order.includes(id))];
}

/** `arranged` with the row at `index` moved by `delta` — a new list, the input untouched. The hook's `move` writes the result back as `order`. */
export function moveRow(arranged: string[], index: number, delta: number): string[] {
  const next = [...arranged];
  const [row] = next.splice(index, 1);
  next.splice(index + delta, 0, row);
  return next;
}

/** `setSelected`'s updater for one row's checkbox. */
export function toggleSelected(prev: Set<string> | null, queueIds: string[], id: string): Set<string> {
  // `prev ?? queueIds` is where "the whole queue" becomes an explicit set:
  // the first tick has to start from everything, because that is what the
  // sheet has been showing since it opened.
  const next = new Set(prev ?? queueIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * `setSelected`'s updater for `deselect uncommitted`.
 *
 * `prev ?? queueIds` is `toggle`'s own first step, for its own reason: "the
 * whole queue" has to become an explicit set before anything can be removed
 * from it, because that is what the sheet has been showing since it opened.
 */
export function withoutIds(prev: Set<string> | null, queueIds: string[], ids: string[]): Set<string> {
  const next = new Set(prev ?? queueIds);
  for (const id of ids) next.delete(id);
  return next;
}

export type Fate = 'absent' | 'stale';

export interface UncommittedFates {
  uncommittedIds: string[];
  absentCount: number;
  staleCount: number;
  fateOf: (path: string) => Fate | null;
}

/**
 * The rows whose file on disk is not the file a board-started run will read
 * (task-32) — never "the rows it cannot see", since a row present at `main`
 * and edited since is one the run finds, gates and executes, just not from
 * these bytes. What follows from that is the note's business, and it splits
 * it; this derivation only decides membership.
 *
 * `known` gates the whole derivation rather than being a decorative field:
 * `{ paths: [], absent: [], known: false }` means the server could not make the read at
 * all — no git, the project is not the repo toplevel, no `main` ref — and an
 * absent answer must never render as "nothing is uncommitted", since the
 * chip below is a statement of fact about someone's repository. An empty set
 * is therefore the answer to both "nothing to flag" and "no idea", which is
 * exactly right: neither one flags anything.
 *
 * Matched on `item.path`, never on an id parsed out of a filename. The
 * server's `id` comes from frontmatter while its path comes from the
 * directory walk, so deriving one from the other would be a SECOND identity
 * rule for the two sides to drift apart on — and the server already builds
 * these strings with the same construction `scanProject` uses for
 * `BacklogItem.path`, so a plain `Set.has` compares equal with no realpath
 * on either side.
 *
 * Ids, not paths, come out the far end: the selection, the order and the
 * request all speak in ids (see `selected` in hooks/useOrchestrateDraft.ts), and `deselectUncommitted`
 * there has to hand `setSelected` the same currency `toggle` does.
 *
 * Each flagged row's FATE (#235) comes from the server's `absent`, gated on
 * `known` the same way: `absent` when its path is in both sets — `main` does
 * not hold it, so the run skips it — and `stale` when it is flagged and not
 * absent — `main` holds older bytes, which the run gates and executes. An
 * `absent` entry that is not also in `paths` is ignored, because membership
 * stays decided by `paths` alone. The two counts are taken over the same
 * queued rows `uncommittedIds` is, so they always sum to its length.
 */
export function uncommittedFates(queue: QueueRow[], uncommitted: UncommittedItems | null): UncommittedFates {
  const uncommittedPaths = new Set(uncommitted?.known === true ? uncommitted.paths : []);
  const absentPaths = new Set(uncommitted?.known === true ? uncommitted.absent : []);
  const fateOf = (path: string): Fate | null => (uncommittedPaths.has(path) ? (absentPaths.has(path) ? 'absent' : 'stale') : null);
  const uncommittedIds = queue.filter(({ item }) => uncommittedPaths.has(item.path)).map(({ item }) => item.id);
  const absentCount = queue.filter(({ item }) => fateOf(item.path) === 'absent').length;
  const staleCount = uncommittedIds.length - absentCount;
  return { uncommittedIds, absentCount, staleCount, fateOf };
}

/**
 * The base picker's options. `['main']` until the fetch lands, and `['main']`
 * forever if it never does — `fetched` is the branches read's `useFetched` answer (hooks/useOrchestrateDraft.ts), and anything but `ok` is that case.
 *
 * `'main'` is unioned in rather than assumed present, because a repository
 * whose trunk is named something else has no `main` branch at all — the
 * picker still has to offer the value the run will default to, and the
 * server still refuses it if it does not exist, which is the honest answer.
 */
export function branchOptions(fetched: { status: string; value: string[] | null }): string[] {
  return fetched.status === 'ok' ? (fetched.value!.includes('main') ? fetched.value! : ['main', ...fetched.value!]) : ['main'];
}

/**
 * `pr` opens a pull request through the tracker, so only a project whose source is `github` can run it; the server refuses it for any other with a 400,
 * and this is the same rule one step earlier, as a picker that does not list it (spec §5). Settings cannot do the same, being pre-project — which is why a
 * stored `pr` default has to be survivable here: it is read through `mergeMode` (this function's answer), not `pickedMergeMode`, and falls back to `merge`,
 * the posture an out-of-range stored value already gets (`clampSettings`). Derived in render rather than written back into state, so a project list that
 * refreshes under an open sheet cannot leave a `pr` pick standing on a source that no longer offers it.
 */
export function prOffered(source: ProjectSummary['source']): boolean {
  return source === 'github';
}

/**
 * The merge mode a launch actually sends, derived from the person's pick and never written back over it.
 *
 * A remote machine takes PR only (the server's 400 `merge mode must be pr on <label>`), so the mode is DERIVED from the pick the way the source rule above
 * derives it: the person's own choice stays in `pickedMergeMode` and comes back untouched on a switch to home (Review Focus 5).
 */
export function effectiveMergeMode(picked: MergeMode, source: ProjectSummary['source'], prOnly: boolean): MergeMode {
  return prOnly ? 'pr' : picked === 'pr' && !prOffered(source) ? 'merge' : picked;
}

export interface StartInputs {
  project: string;
  model: string;
  effort: string;
  mergeMode: MergeMode;
  /** `RunOnState.request` — `{ machine }` for a remote pick, `{}` on home. */
  machine: { machine?: string };
  questionMode: QuestionMode;
  base: string;
  narrowed: boolean;
  order: string[] | null;
  arranged: string[];
  mode: PermissionMode;
}

/** The body `start` (hooks/useOrchestrateDraft.ts) posts to `POST /api/agents/orchestrate`. */
export function buildStartRequest(input: StartInputs): StartOrchestrateRequest {
  const { project, model, effort, mergeMode, machine, questionMode, base, narrowed, order, arranged, mode } = input;
  return {
    project,
    // Absent-not-empty, the convention every launch sheet shares — see `modelEffortFlags`.
    ...modelEffortFlags(model, effort),
    // Unlike model/effort above and ids below, this is NEVER wrapped in a
    // conditional spread — see `mergeMode`'s own state comment (hooks/useOrchestrateDraft.ts). It is the
    // sheet's explicit answer to "what should this run do", sent even
    // when it equals the untouched Settings default, because inferring it
    // server-side from an absent field would put that one decision in two
    // places (design §2.2).
    mergeMode,
    // Only a remote pick names its machine; home sends no key at all, so a home-only board's body is byte-identical to what it was before the picker
    // existed (Review Focus 1).
    ...machine,
    // Unconditional for exactly `mergeMode`'s reason, restated in this
    // field's terms: absent means `park` server-side, so an omitted field
    // would resolve to the same value the untouched sheet is showing — but
    // that value is written verbatim into `run.json` and read out of the
    // archive months later, and "the runner was told to park" is a
    // different claim from "nobody said". The sheet always knows which of
    // the two it is, so it always says.
    questionMode,
    // Unconditional for the same reason as its two neighbours above, with
    // one extra consequence of its own: which branch a run wrote to is not
    // recoverable from anything afterwards, so a launch that stayed silent
    // about it would leave the archive unable to answer where that work
    // landed. `'main'` is sent explicitly and the server appends no flag
    // for it, so the prompt is byte-identical to a pre-task-44 one.
    base,
    // The same absent-not-empty convention, for the field it matters most
    // on: `ids` rides along ONLY for a strict subset. A full list would be
    // a different instruction from no list at all (see `selected` in hooks/useOrchestrateDraft.ts and
    // `narrowed` above), and an EMPTY list is refused outright by the
    // server — `parseIdsArg` in orchestrate.mjs keeps "no flag" and "an
    // explicit empty selection" apart precisely so that `--ids ''` cannot
    // silently mean "everything", and `emptySelection` above is what stops
    // this sheet from ever posing that question.
    //
    // `|| order !== null` is task-20's one wire-visible change, and
    // `narrowed`'s own comment above carries the reasoning: an order is a
    // membership decision, so a run that was arranged sends its list even
    // when nothing was deselected. `arranged` rather than `selectedIds`
    // because the two are the same list in a different sequence, and the
    // sequence is the point — `resolveIds` and `buildGatedQueue` both run
    // `--ids` in the order given, which is why this step needed no server,
    // tool or wire change at all.
    ...(narrowed || order !== null ? { ids: arranged } : {}),
    permissionMode: mode
  };
}
