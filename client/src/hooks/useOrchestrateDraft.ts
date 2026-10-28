import { useState } from 'react';

import { useAction } from './useAction';
import { useFetched } from './useFetched';
import { useRunOn, type RunOnState } from './useRunOn';
import { useSettings } from './useSettings';
import { ApiError, fetchBranches, fetchMergeCheck, fetchUncommitted, startOrchestrate } from '../lib/agents';
import { mergeModeOptionLabels } from '../lib/merge-mode';
import {
  arrangeOrder,
  branchOptions,
  buildStartRequest,
  effectiveMergeMode,
  moveRow,
  orchestrateQueue,
  prOffered as sourceOffersPr,
  resolveSelection,
  toggleSelected,
  uncommittedFates,
  withoutIds,
  type Fate,
  type QueueRow
} from '../lib/orchestrate-draft';
import { clampMode, modesUpTo } from '../../../shared/agent';
import { RUN_IN_PROGRESS_CODE } from '../../../shared/types';
import type { BacklogItem, MergeCheckResult, MergeMode, PermissionMode, ProjectSummary, QuestionMode } from '../../../shared/types';

/**
 * Everything the Orchestrate sheet's three step views and its footer read (#306) — one props currency, so each view renders alone from a hand-built one
 * (`test/orchestrate-steps.test.tsx`). Values are this render's; the actions are the only writers, and none of them is a raw `setState`, so a view cannot
 * put the draft into a shape the derivations below would not produce.
 */
export interface OrchestrateDraft {
  /** Registry path — the setup hint prints it. */
  project: string;
  allowedModes: PermissionMode[];
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
  /** The machine picker's state, model and effort included — `useRunOn`'s, passed through whole. */
  runOn: RunOnState;
  prOffered: boolean;
  mergeMode: MergeMode;
  setMergeMode: (mode: MergeMode) => void;
  mergeModeLabels: Record<MergeMode, string>;
  questionMode: QuestionMode;
  setQuestionMode: (mode: QuestionMode) => void;
  base: string;
  setBase: (base: string) => void;
  branches: string[];
  mergeCoverage: MergeCheckResult | null;
  queue: QueueRow[];
  queueIds: string[];
  selectedIds: string[];
  narrowed: boolean;
  emptySelection: boolean;
  isSelected: (id: string) => boolean;
  uncommittedIds: string[];
  absentCount: number;
  staleCount: number;
  fateOf: (path: string) => Fate | null;
  uncommittedSelected: string[];
  /** The hand order, or `null` for queue order — read only to disable `reset order`. */
  order: string[] | null;
  arranged: string[];
  byId: Map<string, BacklogItem>;
  toggle: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  deselectUncommitted: () => void;
  move: (index: number, delta: number) => void;
  resetOrder: () => void;
  busy: boolean;
  error: string | null;
  start: () => void;
}

export interface OrchestrateDraftInput {
  project: string;
  source: ProjectSummary['source'];
  items: BacklogItem[];
  spawnMaxPermission: PermissionMode | null;
  /** `useOrchestratorRuns()`'s own refresh — see `OrchestrateSheet`'s prop of the same name. */
  refresh: () => void;
  onClose: () => void;
}

/**
 * useOrchestrateDraft — the Orchestrate sheet's run state (#306): every pick the sheet sends, the three `useFetched` reads behind its hints and its base
 * picker, and `start`. `OrchestrateSheet` keeps only `step`, which is screen state (its own comment says why), and the step views are presentational over
 * the `OrchestrateDraft` this returns. The derivations themselves are `lib/orchestrate-draft.ts`'s, called here every render.
 */
export function useOrchestrateDraft({ project, source, items, spawnMaxPermission, refresh, onClose }: OrchestrateDraftInput): OrchestrateDraft {
  const { settings } = useSettings();
  const allowedModes = modesUpTo(spawnMaxPermission);
  // Same rule LaunchSheet's own defaultMode gets from the server
  // (`clampMode('auto', status.spawnMaxPermission)`, agents.service.ts's
  // `plan()`) — restated here as the same client-side call rather than a
  // second implementation, since `clampMode` is exactly the function that
  // makes it one rule instead of two: "auto, or the ceiling if auto is too
  // high" always lands on the same rung this way, whether it runs on the
  // server for a per-item plan or here for a whole project.
  //
  // The pick is stored and the sent value derived in render, `mergeMode`'s pattern below (#306): seeded once, `mode` would keep a pick above a ceiling that
  // dropped while the sheet was open — sent with Start and refused by the server — and clamping it into state would lose the pick when the ceiling rose again.
  const [pickedMode, setMode] = useState<PermissionMode>(clampMode('auto', spawnMaxPermission));
  const mode: PermissionMode = clampMode(pickedMode, spawnMaxPermission);
  // Seeded from Settings and nowhere else — same invariant, same fields,
  // same reasoning as LaunchSheet's identical two lines (see that file's own
  // comment): a sticky per-launch pick is exactly the failure mode a stored
  // default exists to prevent, and reusing `Settings.dispatchDefaultModel` /
  // `dispatchDefaultEffort` rather than adding project-scoped defaults means
  // one Settings row governs every launch surface in the app, this one
  // included.
  //
  // Both live in `useRunOn` now (multi-dashboard task 9): picking a remote machine narrows them to its lists and writes the narrowed value back, which is
  // state the hook owns. Still seeded from Settings and from nowhere else.
  const runOn = useRunOn(project);
  const { model, effort } = runOn;
  /**
   * The merge-mode picker (Task 8; design §2.2) — seeded from Settings and
   * overridable for this launch only, the identical rule `model`/`effort`
   * above already follow. `'merge'` runs exactly as every launch before this
   * feature existed; `'branch'` tells the run to stop at a reviewed
   * `backlog/<id>` branch instead of merging it into `main` (`MergeMode`'s
   * own doc comment, shared/types.ts, has the full behavioural difference).
   * See `start` below for why the request always carries this value, even
   * when it is the untouched default.
   */
  const [pickedMergeMode, setMergeMode] = useState<MergeMode>(settings.orchestrateDefaultMergeMode);
  // `prOffered` and `effectiveMergeMode` (lib/orchestrate-draft.ts) carry the two rules that derive the sent mode from the pick: the source's, and a remote
  // machine's PR-only lock.
  const prOffered = sourceOffersPr(source);
  const mergeMode: MergeMode = effectiveMergeMode(pickedMergeMode, source, runOn.lock.prOnly);
  /**
   * The question-mode picker (task-20; design §7) — seeded from Settings and
   * overridable for this launch only, the identical rule `mergeMode` above
   * follows, and sent on every launch for the identical reason.
   *
   * Worth being explicit about what this control does NOT do, since the
   * screen it sits on invites the opposite reading: it changes nothing about
   * whether the run ASKS. SKILL.md §3's `AskUserQuestion` attempt is
   * unchanged in both modes; the mode governs only the branch where that ask
   * could not reach anybody, which — because the board can only ever start a
   * headless run — is every question this picker will actually decide the
   * fate of. Hence the hint beside it rather than a tooltip: "start it from
   * the board and you are choosing between skipping the item and letting the
   * runner answer" is the whole doctrine, and this is one of the four places
   * a reader can meet it first.
   */
  const [questionMode, setQuestionMode] = useState<QuestionMode>(settings.orchestrateDefaultQuestionMode);
  /**
   * The base picker (task-44) — the branch this run gates at, cuts worktrees
   * from and merges into.
   *
   * **Seeded to the literal `'main'`, NOT from Settings**, and that is a
   * deliberate departure from both pickers directly above rather than an
   * oversight to be tidied up into consistency later. `mergeMode` and
   * `questionMode` each have two permanently sensible values, so a stored
   * preference stays true indefinitely. A base is temporary by construction:
   * it names one experiment's branch, and a stored one would outlive that
   * experiment and silently send a later run onto a stale feature branch —
   * a worse failure than re-picking it, because nothing about the sheet would
   * look wrong at the time. Per launch, every time (design, non-goals).
   */
  const [base, setBase] = useState<string>('main');
  /**
   * The base picker's options (task-44) — `GET /api/agents/branches`, a
   * `useFetched` read like the merge-check hint and uncommitted flag below,
   * keyed on `[project]` so it runs once per sheet open and never again as
   * modes are picked or steps walked.
   *
   * **A failure here leaves the picker holding `'main'` alone and never
   * blocks a launch.** That is the strongest form of the silent-failure rule
   * this file already follows twice: the other two reads exist to warn, so
   * losing one costs a warning, while this one exists to offer alternatives
   * to the default — so losing it costs the alternatives and leaves the
   * default, which is exactly what a run that asked for nothing else wants.
   * A sheet that refused to start because it could not list branches would
   * fail every ordinary `main` run over a feature nobody in that run used.
   */
  const fetchedBranches = useFetched(() => fetchBranches(project), [project]);
  const branches: string[] = branchOptions(fetchedBranches);
  /**
   * The setup hint's own data (§6) — whether this project's Claude Code
   * settings already grant `git merge`. `null` covers three different
   * states at once: not asked yet, still in flight, and "the request failed
   * outright" — all three render no hint at all (brief case 7), because a
   * hint is not worth a loading spinner or an error banner bolted onto a
   * control that launches a run just fine without it.
   *
   * The data source — fetched while `mergeMode` is anything
   * but `'branch'` (brief case 6: branch mode fetches nothing at all). `pr`
   * counts with `merge`: a pr run asks the classifier for the same `git merge`
   * at every item, only into its run branch, so the allow rule matters to it
   * just as much. Branch mode never touches the base, so this project's `git
   * merge` coverage is none of its business — asking anyway would spend a request
   * nobody reads the answer to, and risk a hint flashing into view for the
   * one instant between picking 'merge' and picking 'branch' right back.
   *
   * The stale-answer guard is `useFetched`'s (#285), shared with
   * `LaunchSheet`'s plan read and the two reads below. It matters for two
   * reasons at once: a slow response landing after the mode has flipped back
   * to `branch`, or after this sheet has closed, must not land on a render
   * that no longer wants the answer. A change of mode or project drops the
   * previous coverage while the new answer is pending — the rule the
   * uncommitted flag below already follows.
   *
   * A failure is deliberately silent (brief case 7) — anything but `ok` reads
   * as `null`: this hint exists to
   * make a merge more likely to succeed, not to gate one, and a network
   * hiccup here must cost the user nothing more than a hint that never shows
   * up. `error`/`busy` stay `start`'s own state below, untouched either way
   * — a failed merge-check must never block or blemish a launch that
   * otherwise works.
   */
  // Skipped for a remote pick as well: the hint is about THIS machine's `settings.local.json`, and the run is going somewhere else.
  const fetchedCoverage = useFetched(mergeMode === 'branch' || runOn.remote ? null : () => fetchMergeCheck(project), [mergeMode, project, runOn.remote]);
  const mergeCoverage: MergeCheckResult | null = fetchedCoverage.status === 'ok' ? fetchedCoverage.value : null;
  /**
   * Which of this project's item files differ from the picked `base` (task-32; `main` by default, #254) — the
   * rows whose bytes on disk are not the bytes the run will act on, which is
   * broader than "the rows it cannot see" and is the whole reason the note
   * below splits by fate (`absent`, #235) rather than stating one. `null`
   * covers the same three
   * states `mergeCoverage`'s
   * does — not asked, in flight, request failed — and all three render
   * nothing: this is a warning, not a gate, and no failure of it may cost
   * anyone a launch. `known: false` (the server could not make the read)
   * renders nothing either; see `uncommittedFates` (lib/orchestrate-draft.ts) for why that is a
   * separate condition rather than an empty list.
   *
   * The uncommitted flag's data source (task-32) — `GET
   * /api/items/uncommitted`, the same `useFetched` read the merge-check hint
   * above is, silent failure included.
   *
   * Keyed on `[project, base]`, and that is the whole cadence: once per
   * sheet open plus once per base picked, never again when a mode is picked
   * or a step is walked. The base is the one thing on this sheet that
   * changes the answer (#254): a run gates at its base, so "differs from the
   * run's copy" is a question about THAT ref, and asked about `main` it
   * flagged the wrong rows for every other base — and the `deselect
   * uncommitted` chip then dropped items the run would have executed.
   * Nothing else here can change it, since the rest of the answer is about
   * someone's working tree and this screen has no writers. Three git reads
   * per ask is the budget this feature was accepted at (see
   * uncommitted.util.ts on why it is not memoised server-side); making it
   * per-step would multiply that by however many times someone walks back
   * and forth.
   *
   * The previous answer is dropped the moment the base changes, before the
   * new one lands: it is an answer about a different ref, and drawn under the
   * new base's name it would be exactly the mislabelling this keying fixes.
   *
   * A failure is silent for the merge-check hint's reason exactly: this
   * exists to stop a run wasting a slot, not to gate one, and a network
   * hiccup here must cost nothing more than a warning that never shows up.
   * `error`/`busy` stay `start`'s own state, untouched.
   */
  const fetchedUncommitted = useFetched(() => fetchUncommitted(project, base), [project, base]);
  const uncommitted = fetchedUncommitted.status === 'ok' ? fetchedUncommitted.value : null;
  const { busy, error, run } = useAction();
  /**
   * Which previewed rows are selected, by item id, or `null` for "the whole
   * queue" — the state this sheet opens in and the state it must be able to
   * return to.
   *
   * `null` rather than "a set holding every id" is the entire mechanism
   * behind the strict-subset rule below, and it is worth being explicit
   * about why a plain full set is wrong. A full set and `null` describe the
   * same selection but not the same INSTRUCTION: an explicit list freezes
   * the run to the queue as it stood when this sheet opened, so an item
   * groomed and committed while someone was reading the list would be
   * silently dropped from a run they believe is draining everything. Keeping
   * "no restriction" as its own value means the untouched sheet — and a
   * sheet toggled all the way off and all the way back on — sends the
   * request it sent before this control existed, byte for byte.
   *
   * Keyed by id, not by path: ids are what the request carries and what the
   * orchestrator's own `--ids` flag takes, so there is no second identity to
   * keep in step. (The rows themselves still key on `item.path`, which is
   * what React needs and what stays unique across sections.)
   */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  /**
   * The hand order step 2 writes, or `null` for "queue order" — the state
   * this sheet opens in and, via the reset control, the state it must be
   * able to return to.
   *
   * `null` rather than "the queue's own ids, listed out" is the same
   * mechanism `selected === null` is, and it carries the same weight: a
   * resolved list and `null` describe the same sequence but not the same
   * INSTRUCTION, and only the second one lets the request stay the
   * whole-queue request it was before this control existed (see `narrowed`
   * in lib/orchestrate-draft.ts for what an explicit order costs).
   *
   * A list of ids rather than a list of items or indices: ids are what the
   * request carries, so there is no second identity to keep in step, and an
   * index would mean something different the instant the queue moved
   * underneath the open sheet — which it can, since `items` is a prop
   * BoardView re-polls.
   */
  const [order, setOrder] = useState<string[] | null>(null);

  const queue = orchestrateQueue(items);
  const queueIds = queue.map(({ item }) => item.id);
  const { selectedIds, narrowed, emptySelection, isSelected } = resolveSelection(queueIds, selected);
  const { uncommittedIds, absentCount, staleCount, fateOf } = uncommittedFates(queue, uncommitted);
  /** Only the flagged rows that are still ticked — the control's own count,
   *  so pressing it once disables it rather than leaving a button that claims
   *  there is still something to deselect. */
  const uncommittedSelected = uncommittedIds.filter(isSelected);

  /**
   * Narrow the selection to the committed rows — the person's act, not the
   * sheet's (Decision 5).
   *
   * The default selection is deliberately NOT changed by this feature:
   * `selected === null` is the difference between "drain the queue" and "run
   * exactly these ids", and auto-excluding flagged rows would force an
   * explicit `ids` list into every launch — freezing the queue snapshot for a
   * run the person believes is draining everything, and having this screen
   * overrule the orchestrator's own gate on the strength of a preview that
   * says outright it is not authoritative. It also buys almost nothing: the
   * run skips these items at the cost of one gate verdict, with no dispatch
   * and no worktree.
   */
  const deselectUncommitted = (): void => {
    setSelected((prev) => withoutIds(prev, queueIds, uncommittedIds));
  };

  /** Step 2's rows, and the lookup they render from. Keyed by id because
   *  that is what the order and the request both speak in; the row itself
   *  still keys on `item.path` for React, exactly as step 1's does. */
  const byId = new Map(queue.map(({ item }) => [item.id, item]));
  const arranged = arrangeOrder(order, selectedIds);

  /**
   * Move one row, by index into `arranged` — never by index into the queue,
   * which is a different list the moment anything is unticked.
   *
   * Writes the whole arranged list back as the new `order` rather than
   * patching the previous one: `order` is allowed to be `null` (natural),
   * and "the natural order with one swap applied" has to become an explicit
   * list somewhere. Doing it here means every subsequent move starts from a
   * list that is already reconciled against the live queue, so a stale id
   * can never be reintroduced by a swap.
   */
  const move = (index: number, delta: number): void => {
    setOrder(moveRow(arranged, index, delta));
  };

  const toggle = (id: string): void => {
    setSelected((prev) => toggleSelected(prev, queueIds, id));
  };

  const start = (): void => {
    run(
      () =>
        startOrchestrate(
          buildStartRequest({ project, model, effort, mergeMode, machine: runOn.request, questionMode, base, narrowed, order, arranged, mode })
        ),
      {
        onSuccess: () => {
          // No session link to show (see `OrchestrateSheet`'s own header comment) —
          // the band's run chip is what takes over from here, and `refresh()`
          // fetches it ahead of the next scheduled poll so it is already
          // there the instant this sheet closes rather than up to 5s later.
          refresh();
          onClose();
        },
        onError: (e) => {
          // `useAction` sets the message after this returns — this returns nothing, so the message is still shown, the same order as before (#286).
          //
          // The ONE failure this sheet cannot offer a useful retry for: the
          // activeRun lock — a DIFFERENT run already exists for this project
          // (agents.service.ts's `orchestrate()`, "a run is already in
          // progress for this project (<runId>)"). Retrying from this sheet
          // cannot fix that; `refresh()` pulls the winning run in and
          // `onClose()` hands the screen to the chip that already counts it.
          //
          // Fix round 1 tried `e.status === 409` alone — an improvement over
          // matching the message's own prose, but still wrong, because this
          // endpoint answers 409 for THREE OTHER reasons too (project just
          // lost visibility, no CLAUDE_BIN, remote answers off — all folded
          // into `gate.control === 'hidden'`/`'disabled'` server-side, plus
          // the dirName race). Status alone cannot tell those apart from the
          // lock, and reporting "already running" for a capability or
          // visibility problem is not a milder version of the bug the
          // message-substring check had — it is a confidently WRONG answer,
          // worse than the brittle one it replaced. Fix round 2: the server
          // sends a `code` field (RUN_IN_PROGRESS_CODE, shared/types.ts) on a
          // refusal that means "a run for this project is alive right now",
          // so this checks status AND that exact code — every other 409
          // (uncoded) falls through to `useAction`'s generic path and shows the
          // server's own, accurate error text instead.
          //
          // Both of that endpoint's locks answer with it, and closing is right
          // for both: the activeRun lock means a run file is already there to
          // count, and bug-21's starting lock means the chip is already counting
          // the spawn this sheet is trying to duplicate. It does not care which.
          if (e instanceof ApiError && e.status === 409 && e.code === RUN_IN_PROGRESS_CODE) {
            refresh();
            onClose();
          }
        }
      }
    );
  };

  /*
   * bug-36. Derived here, in render, rather than read off a module constant:
   * `merge`'s label names the branch this run would merge into, so it has to
   * re-derive on every `setBase`. A plain call rather than a `useMemo` — it
   * builds two strings, and memoising it would cost more than it saves while
   * adding a dependency list that could silently go stale on exactly the
   * state this bug was about.
   */
  const mergeModeLabels = mergeModeOptionLabels(base);

  return {
    project,
    allowedModes,
    mode,
    setMode,
    runOn,
    prOffered,
    mergeMode,
    setMergeMode,
    mergeModeLabels,
    questionMode,
    setQuestionMode,
    base,
    setBase,
    branches,
    mergeCoverage,
    queue,
    queueIds,
    selectedIds,
    narrowed,
    emptySelection,
    isSelected,
    uncommittedIds,
    absentCount,
    staleCount,
    fateOf,
    uncommittedSelected,
    order,
    arranged,
    byId,
    toggle,
    selectAll: () => setSelected(null),
    selectNone: () => setSelected(new Set()),
    deselectUncommitted,
    move,
    resetOrder: () => setOrder(null),
    busy,
    error,
    start
  };
}
