import { useId, useMemo, useState } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useSettings } from '../../hooks/useSettings';
import { isInProgress } from '../../lib/item-progress';
import { isStale, leavesBoard } from '../../lib/item-stale';
import { buildProjectHues } from '../../lib/project-hue';
import { projectDispatchGate, runClaimBlock } from '../../../../shared/agent';
import { ItemCard } from './ItemCard';
import { ItemDrawer } from './ItemDrawer';
import { LaunchSheet } from './LaunchSheet';
import { OrchestrateSheet } from './OrchestrateSheet';
import { RunDrawer } from './RunDrawer';
import { RunStrip } from './RunStrip';
import type { BacklogItem, OrchestratorRun, RunStage, Section } from '../../../../shared/types';

const PROJECT_KEY = 'backlog-manager.project';
const STATUS_KEY = 'backlog-manager.status';
const SORT_KEY = 'backlog-manager.sort';

/** The "not narrowed" sentinel — a sentinel rather than '', so a stored value
 *  always reads as itself and never as "the field was cleared". */
const ALL = 'all';

type StatusFilter = 'open' | 'started' | 'done' | 'all';
type SortKey = 'created' | 'name' | 'project';

/** The endpoint's wrapper shape (Task 8) — the same local alias RunStrip.tsx
 *  declares for its own `run` prop, redeclared here rather than imported:
 *  neither file exports it, and a two-field intersection type is cheaper to
 *  restate per consumer than to thread a shared export through for. */
type RunPayload = OrchestratorRun & { fresh: boolean; pastRuns: number };

/**
 * Fixed column order — the design's order (Refactoring · Ideas · Bugs ·
 * Tasks), not the store's directory order and not alphabetical. It reads
 * left-to-right as increasing commitment: a refactor is a wish, an idea is a
 * proposal, a bug is work that found us, a task is work we chose and planned.
 *
 * Out-of-scope has no column here at all. A rejected item is terminal — it is
 * a record, not queue work — and it gets its own column in Archive instead
 * (Task 6). That eviction is why `matches` below drops the section outright
 * rather than relying on there being no column to land in: filtering at the
 * column level would leave rejected cards counted in `visible`, which decides
 * the "no matches" empty state and whether the board installs a live clock.
 *
 * `slug` is the CSS hook (`.board-col-<slug>`), not the section name. Every
 * one of the four matches its section now that `oos` — the one abbreviation,
 * and only ever a class-name fragment — is gone with its column.
 */
const COLUMNS: { section: Section; label: string; slug: string }[] = [
  { section: 'refactors', label: 'Refactoring', slug: 'refactors' },
  { section: 'ideas', label: 'Ideas', slug: 'ideas' },
  { section: 'bugs', label: 'Bugs', slug: 'bugs' },
  { section: 'tasks', label: 'Tasks', slug: 'tasks' }
];

/**
 * `created` compares as a string: backlog.mjs writes fixed-width UTC
 * YYYY-MM-DD, where lexicographic order is chronological order, and an
 * unparseable value sorts predictably instead of NaN-scrambling the list.
 *
 * A record keyed on `SortKey`, not the three-branch if/else this used to be:
 * `sortItems` below gives every sort a shared primary key (in-progress
 * first), and a primary key that has to run in front of whichever comparator
 * is selected can only be written once against a record's shared call site —
 * three separate branches would each need their own copy of it.
 */
const COMPARATORS: Record<SortKey, (a: BacklogItem, b: BacklogItem) => number> = {
  name: (a, b) => a.title.localeCompare(b.title),
  project: (a, b) => a.project.localeCompare(b.project) || b.created.localeCompare(a.created),
  created: (a, b) => b.created.localeCompare(a.created)
};

/**
 * 0 for a card someone is actively on, 1 for everything else. Lower sorts
 * first, so this is the primary key every sort shares: in-progress cards
 * float to the top of the column no matter which comparator is selected, and
 * whichever one is selected still decides order *within* each half — two
 * live cards do not collapse to file order against each other just because
 * they tied on rank.
 */
const inProgressRank = (item: BacklogItem): 0 | 1 => (isInProgress(item) ? 0 : 1);

/** Onto a copy, never in place — the array belongs to the fetched index. */
function sortItems(items: BacklogItem[], sort: SortKey): BacklogItem[] {
  const out = [...items];
  /* The `??` is not defensive noise, and the `SortKey` type is not a promise
     that it can't fire. `sort` arrives from localStorage through
     `usePersistedState`, which JSON.parses whatever is stored and hands back
     any string it finds — the type describes what this build WRITES, never
     what it is capable of READING. A key hand-edited, or written by a later
     build and then rolled back, misses this record entirely, and an
     unguarded miss is *called*: `undefined(a, b)` throws inside render, and
     with no ErrorBoundary anywhere in client/src React unmounts the tree to a
     blank page that only clearing site data recovers. Degrading to `created`
     is precisely what the if/else chain this record replaced did in its final
     `else`, so this restores behaviour rather than adding a new rule.
     Deliberately NOT matched by the Status select below, which reads the same
     unvalidated storage and is left unguarded on purpose: a stale status value
     just matches nothing in the four type columns, leaving a visibly
     narrowed board whose cause is the select sitting right above it and whose
     fix is one click. (The Project select goes further still and fails open to
     "all".) The asymmetry is the point — a degraded board a user can reason
     about is a different class of problem from a page that isn't there. */
  const compare = COMPARATORS[sort] ?? COMPARATORS.created;
  out.sort((a, b) => inProgressRank(a) - inProgressRank(b) || compare(a, b));
  return out;
}

/**
 * The board: every registered project's items in four fixed type columns.
 * All narrowing happens here, client-side, over the fetched index — the whole
 * corpus is a few hundred rows of title-and-date, and a server-side filter
 * would cost a round trip per keystroke (guide-manager's rationale, kept).
 */
export default function BoardView() {
  const { items: index, projects, loading, error } = useBoard();
  /* Task 5: only `staleDays` is read here, but the whole control comes back —
     `useSettings` falls back to the defaults outside a provider (see its own
     comment), which is what lets every board test that never mounts one still
     get the documented 30-day window rather than undefined. */
  const { settings } = useSettings();
  const [open, setOpen] = useState<BacklogItem | null>(null);
  const { status: agents } = useAgents();
  // Task 11: the orchestrator's own view of any project's queue, polled live
  // while any run is fresh (useOrchestratorRuns.ts) and not at all otherwise.
  // `refresh` (Task 13): OrchestrateSheet's own Start button calls this
  // directly after both a successful start and a 409 "already running"
  // conflict, so the strip has the fresh run ahead of the next scheduled
  // poll rather than up to `POLL_MS` late — see OrchestrateSheet.tsx's own
  // comment on `start` for why the conflict path needs it just as much as
  // the success path does.
  const { runs, refresh: refreshRuns } = useOrchestratorRuns();
  /* Separate from `open`: the sheet can be opened from a card (drawer closed)
     or from inside the drawer (drawer stays open behind it), so one piece of
     state cannot serve both. */
  const [dispatching, setDispatching] = useState<BacklogItem | null>(null);
  /* Task 13: which project's Orchestrate sheet is open, or null. A project
     PATH rather than a boolean — the same reasoning `openRunProject` below
     already uses: keeping the sheet's own render keyed on an identity that
     does not change out from under it, independent of whatever the
     toolbar's OWN project filter (`project`/`projectValue`, below) happens
     to read on a later render. A plain boolean would have re-rendered the
     sheet against whatever `projectValue` currently was, which breaks the
     moment a value it is not actually reading changes — e.g. the filter
     resetting to "All" while the sheet is still open would otherwise erase
     `orchestrateProject` (see that value's own guard) and unmount the sheet
     with no `onClose` ever firing. */
  const [orchestrating, setOrchestrating] = useState<string | null>(null);
  // The reason span DispatchButton's own `reasonId` documents in full: an
  // aria-describedby target has to be unique across the page, and this
  // button (unlike DispatchButton's forty-per-board) only ever renders once,
  // but `useId()` is still the right tool for a value that must survive
  // Strict Mode's double-invoke with the same identity both times.
  const orchestrateReasonId = useId();
  /*
   * Task 12: which project's run drawer is open, keyed by `project` (the
   * registry path) rather than holding the clicked run object itself. That
   * distinction is load-bearing, not stylistic — a run keeps changing every
   * poll while it is fresh (useOrchestratorRuns.ts), and RunDrawer's whole
   * reason to exist is to say so the moment a heartbeat goes quiet (see its
   * own file-level comment). Storing the clicked object would freeze the
   * drawer at whatever the pipeline looked like at click time — exactly the
   * "frozen pipeline that looks live" this feature exists to rule out. Keyed
   * on `project` rather than `runId` for the same reason `runStagesByProject`
   * below already is: `runs` is one entry PER PROJECT (Task 8's own doc
   * comment on OrchestratorRunsPayload), so a project path is a stable
   * handle across every poll for as long as the SAME run is what that
   * project is on — including after it goes stale, since a stale run stays
   * in `runs` with `fresh: false` rather than dropping out (RunStrip.tsx
   * relies on that same fact to know when to render nothing).
   */
  const [openRunProject, setOpenRunProject] = useState<string | null>(null);

  /* The query is plain useState — deliberately not remembered. A remembered
     query is a board that opens showing three cards out of forty for no
     visible reason. The selects survive that objection because each one
     permanently states its own value in the bar. */
  const [query, setQuery] = useState('');
  const [project, setProject] = usePersistedState<string>(PROJECT_KEY, ALL);
  const [status, setStatus] = usePersistedState<StatusFilter>(STATUS_KEY, 'open');
  const [sort, setSort] = usePersistedState<SortKey>(SORT_KEY, 'created');

  const all = index?.items ?? [];
  const registered = projects ?? [];

  /* One assignment for the whole board, built here rather than per card: the
     hue a project gets depends on which projects were registered before it, so
     it is a property of the registry and not of any one item. Keyed on
     `projects` and not on `registered` — the pass is cheap either way, but
     `registered` is a fresh [] on every render while the fetch is in flight,
     which would make the memo a no-op and hand every card a new prop object on
     each keystroke in the search box. */
  const hues = useMemo(() => buildProjectHues(projects ?? []), [projects]);

  /* Fail-open on a stale stored project (unregistered since): an unmatched
     filter that emptied the board would look like the server broke. The
     fallback feeds back into the select, so control and board agree. */
  const knownPaths = new Set(registered.map((p) => p.path));
  const projectValue = knownPaths.has(project) ? project : ALL;

  const needle = query.trim().toLowerCase();
  const matches = (i: BacklogItem): boolean =>
    (projectValue === ALL || i.projectPath === projectValue) &&
    (needle === '' || i.title.toLowerCase().includes(needle)) &&
    // The Board is queue work only; rejected items belong to Archive (Task 6).
    // Dropped here rather than left to fall through a column that no longer
    // exists, so `visible` — which drives the "no matches" empty state and the
    // `hasLive` clock — never counts a card the board cannot show.
    //
    // This one predicate replaces what used to be a status *bypass* for the
    // section (`i.section === 'out-of-scope' || …`), which existed so
    // Open/Done/All showed rejected cards regardless of their status, and which
    // the 'started' branch below had to be ordered in front of so a terminal
    // card carrying a stale `started` stamp could not leak into a view that
    // claims to list live work. With the section gone from the board entirely,
    // both the bypass and the ordering rule it needed are moot.
    i.section !== 'out-of-scope' &&
    (status === 'started'
      ? isInProgress(i)
      : status === 'all' || i.status === status);

  /* Everything the toolbar admits, before the staleness split below. Named
     rather than inlined because `hasLive` has to be computed off THIS set —
     see its own comment for why that is not just an ordering convenience. */
  const matched = all.filter(matches);

  /* One clock for the whole board, and only while something needs one. An
     in-progress card's elapsed reading is the only thing here that goes stale
     with no event at all — `20m` is wrong sixty seconds later whether or not
     anyone touches the tab, and the item fetches only refresh on mount and
     focus. Gated on the rendered items so a board with nothing live installs no
     interval; passed down as a value so the cards stay pure and their tests
     never have to fake a timer.

     Computed on `matched` rather than on `visible` below, which reads like a
     bug and is not: `useNow` is a hook, so it cannot be called after a filter
     that itself needs the clock it returns, and the two sets agree on this
     question anyway. An in-progress item is never stale (item-stale.ts
     sequences that rule ahead of the arithmetic on purpose), so staleness can
     only ever remove cards that answer `false` here — the `.some` is
     identical either way. */
  const hasLive = matched.some(isInProgress);
  const now = useNow(hasLive);

  /* Task 5: the Board/Archive split. Everything the toolbar matched, minus the
     open refactors, ideas and bugs nobody has touched inside the window — those
     are Archive's half (Task 6) and this is the same predicate read from the
     other side, never a second copy of the rule. Tasks are exempt by
     construction inside `leavesBoard`, so a stale one is still here below,
     carrying the marker `staleFor` hands its card.

     Applied AFTER `matches` rather than folded into it so the two narrowings
     stay separable: `matches` is what the toolbar says, this is what the
     calendar says, and only the second one can be changed from Settings. */
  const visible = matched.filter((i) => !leavesBoard(i, settings.staleDays, now));

  /* The marker a surviving stale card wears — in practice only ever a task,
     since `leavesBoard` has already taken every other stale section out of
     `visible`. Computed here rather than in ItemCard for the same reason `now`
     and `runStage` are: the card stays a pure function of its props, with no
     opinion about the window or the clock. */
  const staleFor = (item: BacklogItem): boolean => isStale(item, settings.staleDays, now);

  const missing = registered.filter((p) => p.missing);
  const warnings = [
    ...missing.map((p) => `unreachable: ${p.name} — no backlog/ at ${p.path}`),
    ...(index?.errors ?? [])
  ];

  // Fresh runs only: a stale one has already gone silent as far as RunStrip
  // is concerned (see its own comment on why), and a card badge is the same
  // claim in miniature — "this item is executing right now" — so it has to
  // go silent on exactly the same condition, not linger because this map
  // forgot to check.
  const freshRuns = runs.filter((run) => run.fresh);

  /*
   * Task 13's toolbar button. Four conditions, matching the brief's own
   * four test cases in order:
   *  1. Unfiltered (`projectValue === ALL`) — an orchestrate run is scoped
   *     to ONE project's whole queue, so the control has nothing to name
   *     until the board's own filter already narrows to one, the same
   *     reading every other narrowed-view feature on this bar gives
   *     `projectValue`.
   *  2/3. `projectDispatchGate` (shared/agent.ts, imported — fix round 1
   *     hoisted this out of a local copy here after a review found it
   *     hand-duplicated the same reason string `dispatchGate` and
   *     `orchestrate()` each already had their own copy of; see that
   *     function's own doc comment for the full story) — the environment
   *     ladder hides the control outright, project-invisibility disables it
   *     with a reason.
   *  4. A fresh run already owns this project's whole story on the board
   *     (the strip): a second Start would only race the 409 the server
   *     already enforces (agents.service.ts's own activeRun check) — same
   *     "nothing to add" reasoning as DispatchButton returning null for an
   *     item with no next step. A STALE run does not count here — see
   *     RunStrip's own comment on why a stale run renders nothing at all;
   *     the control has to still be there to start a fresh one once the
   *     last one has gone silent.
   */
  const orchestrateGate = projectValue === ALL || agents === null
    ? null
    : projectDispatchGate(agents, projectValue);
  const orchestrateHasFreshRun = freshRuns.some((run) => run.project === projectValue);
  const showOrchestrate = orchestrateGate !== null && orchestrateGate.control !== 'hidden' && !orchestrateHasFreshRun;
  const orchestrateBlockedReason = orchestrateGate?.control === 'disabled' ? orchestrateGate.reason : null;
  // The registry's own display name, for the button's title and the sheet's
  // header — falls back to the raw path only in the unreachable case where
  // `projectValue` names a project `registered` no longer carries (the same
  // "unregistered since" staleness `knownPaths`/`projectValue` above already
  // guard against, restated here since a fallback still has to resolve to
  // SOME string for a title attribute).
  const orchestrateProjectName = registered.find((p) => p.path === projectValue)?.name ?? projectValue;

  // The id→stage lookup Task 11's brief asks for, one map per fresh run,
  // keyed by the run's own `project` — the registry's absolute path, the
  // exact string `BacklogItem.projectPath` already carries on every item
  // (shared/types.ts documents both as "the same string"). This is the
  // "association BoardView already knows" the brief points at: every card
  // below is matched to a run by comparing that path directly, never by
  // deriving a project identity from `item.path` or from the display name
  // on its pill — two checkouts of the same repo would share the name but
  // never the path, and only the path is what the run itself reports.
  const runStagesByProject = new Map<string, Map<string, RunStage>>();
  for (const run of freshRuns) {
    runStagesByProject.set(run.project, new Map(run.queue.map((q) => [q.id, q.stage])));
  }
  const runStageFor = (item: BacklogItem): RunStage | undefined =>
    runStagesByProject.get(item.projectPath)?.get(item.id);

  /*
   * The dispatch half of the same run payload: why a run forbids dispatching
   * this item, or null. Fed to BOTH render sites below — the card's tear-off
   * tab and the drawer's chip — since they are two independent buttons for one
   * item, and only one of them being run-aware is half of the bug this fixes.
   *
   * Deliberately reading the FULL `runs` list rather than going through
   * `runStagesByProject` above: `runClaimBlock` applies its own `fresh` filter
   * (see its doc comment), so routing it through a map already filtered to
   * fresh runs would put that rule in two places, and the map's stage list is
   * the badge's rule (`ACTIVE_RUN_STAGES`), not this one — `pending` and
   * `preflight` block dispatch while showing no badge at all.
   */
  const runBlockFor = (item: BacklogItem): string | null => runClaimBlock(item, runs);

  // Looked up from the FULL `runs` list, not `freshRuns` above — the drawer
  // has to keep showing a run that just went stale (that is the entire
  // point of `openRunProject`'s own comment), and `freshRuns` has already
  // dropped exactly that entry by the time it goes stale. Re-derived on
  // every render rather than cached: this is what makes the drawer track
  // each new poll instead of freezing at whatever `runs` looked like when
  // it was opened.
  const openRun: RunPayload | null =
    openRunProject === null ? null : runs.find((r) => r.project === openRunProject) ?? null;

  /*
   * Task 12 fix round 1: ItemDrawer and RunDrawer each render a
   * role="dialog" `.drawer` aside with no focus trap of its own — mirrored,
   * deliberately, from ItemDrawer's own choice not to add one (see
   * RunDrawer.tsx's file comment) — so two mounted at once is not just a
   * visual overlap but a real keyboard hazard: Tab from the frontmost
   * drawer's backdrop walks a keyboard-only user straight into the
   * interactive elements of whichever drawer is still mounted behind it,
   * and a screen reader is left with two dialogs and no signal for which
   * one is current. `open` and `openRunProject` stay two separate pieces of
   * state rather than one tagged union (every other reader of `open` below
   * — the ItemDrawer render, its onDispatch — wants a plain
   * `BacklogItem | null`, and a union would push a `.kind` discriminant
   * into each of those reads to buy a guarantee two setters already give
   * just as reliably). These two functions are still the ONLY place either
   * goes NON-null — both call sites below go through one of them, never
   * `setOpen`/`setOpenRunProject` directly — but Task 13's fix round 1
   * (below) added a third caller that clears them, so "opening either
   * closes the other" is no longer the whole story; see that comment for
   * the rest of it.
   */
  const openItemDrawer = (item: BacklogItem): void => {
    setOpenRunProject(null);
    // Task 13 fix round 1 — see openOrchestrateSheet's own comment for why
    // this line was added here (it was not, at first).
    setOrchestrating(null);
    setOpen(item);
  };
  const openRunDrawer = (project: string): void => {
    setOpen(null);
    setOrchestrating(null);
    setOpenRunProject(project);
  };

  /*
   * Task 13 adds a second overlay pair, and the same hazard the comment
   * above describes applies to it for the same structural reason:
   * OrchestrateSheet reuses LaunchSheet's own `.sheet` shape verbatim
   * (OrchestrateSheet.tsx's own header comment), which means it has exactly
   * the same "no focus trap of its own" property the two `.drawer`s share.
   * `dispatching` and `orchestrating` get the identical treatment LaunchSheet
   * and OrchestrateSheet's two openers already gave each other in Task 13's
   * first pass: two separate pieces of state, cleared by each other's opener,
   * never set directly outside these two functions.
   *
   * Fix round 1 (Important): the first pass stopped there and left
   * `orchestrating` free to coexist with an open `open`/`openRunProject`
   * drawer, reasoning by analogy that OrchestrateSheet was "the same kind of
   * overlay as LaunchSheet" and LaunchSheet already coexists with ItemDrawer
   * on purpose (test/dispatch-button.test.tsx's "opens the sheet from inside
   * the drawer, leaving the drawer open behind it"). Review found the
   * analogy does not actually hold: LaunchSheet's coexistence is reachable
   * only through a per-item dispatch control that lives INSIDE the drawer it
   * coexists with (or on the card the drawer was opened from), which is a
   * narrow, deliberately-tested path. OrchestrateSheet's own trigger is the
   * toolbar button, which is on screen and clickable at the exact same time
   * as every card and every run strip — "drawer open, then Orchestrate" is
   * not an edge case here, it is the ordinary path a keyboard user (Tab past
   * either drawer's own untrapped focus) or even a mouse user (the drawer's
   * backdrop covers the columns, but not the toolbar above it) reaches
   * without trying to. So `orchestrating` now clears BOTH `open` and
   * `openRunProject` too (see `openItemDrawer`/`openRunDrawer` above), and
   * both drawer openers clear `orchestrating` right back — a true three-way
   * exclusion, not a two-way one with a gap. `dispatching` (LaunchSheet)
   * deliberately still does NOT participate in that three-way exclusion:
   * the coexistence it has with the two drawers remains the proven,
   * deliberate, tested behaviour described above, and nothing in this fix
   * touches it.
   */
  const openLaunchSheet = (item: BacklogItem): void => {
    setOrchestrating(null);
    setDispatching(item);
  };
  const openOrchestrateSheet = (proj: string): void => {
    setDispatching(null);
    setOpen(null);
    setOpenRunProject(null);
    setOrchestrating(proj);
  };

  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Board</div>
        <div className="board-tools">
          <input
            type="search"
            className="board-search"
            aria-label="Search items"
            placeholder="search titles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="board-select"
            aria-label="Project"
            value={projectValue}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value={ALL}>All projects</option>
            {/* Valued by path, labelled by name — two checkouts of one repo
                stay two selectable options. */}
            {registered.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
          </select>
          <select
            className="board-select"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="open">Open</option>
            <option value="started">In progress</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          <select
            className="board-select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="created">Newest first</option>
            <option value="name">By name</option>
            <option value="project">By project</option>
          </select>
          {/* Task 13: the "drain this project's groomed queue" control.
              `showOrchestrate`/`orchestrateBlockedReason` (computed above)
              already encode all four visibility rules from the brief, so
              this markup only has to react to them — the same hide-vs-disable
              shape DispatchButton renders, restated by hand rather than
              reused because DispatchButton's signature is fixed around one
              `BacklogItem`, which a project-level control does not have. */}
          {showOrchestrate && (
            <>
              <button
                type="button"
                className="board-orchestrate"
                title={orchestrateBlockedReason ?? `drain ${orchestrateProjectName}'s groomed queue in a Claude session`}
                aria-disabled={orchestrateBlockedReason !== null}
                aria-describedby={orchestrateBlockedReason === null ? undefined : orchestrateReasonId}
                onClick={() => {
                  // The other half of aria-disabled: the browser fires a
                  // click on it regardless, so this guard is what actually
                  // makes a blocked button inert — same reasoning as
                  // DispatchButton's identical guard.
                  if (orchestrateBlockedReason !== null) return;
                  openOrchestrateSheet(projectValue);
                }}
              >
                Orchestrate
              </button>
              {orchestrateBlockedReason !== null && (
                <span id={orchestrateReasonId} className="sr-only">{orchestrateBlockedReason}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* One row per fresh run, ahead of the warnings: a run actually in
          flight is live, actionable information, where the warnings below
          are a standing fact about the registry that will still be true the
          next time this board loads. RunStrip filters its own staleness (see
          its file-level comment) — `freshRuns` here exists for the id→stage
          map above, not to protect this render, but reusing it keeps this
          from ever mounting a strip only to have it immediately render null. */}
      {freshRuns.length > 0 && (
        <div className="run-strips">
          {freshRuns.map((run) => (
            <RunStrip
              key={run.runId}
              run={run}
              // `r.project`, not the run object itself — see
              // `openRunProject`'s own comment for why the drawer has to be
              // keyed on identity rather than holding a frozen snapshot. Goes
              // through `openRunDrawer`, not `setOpenRunProject` directly —
              // see that function's own comment for why.
              onOpen={(r) => openRunDrawer(r.project)}
            />
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="board-warn" data-testid="board-warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="board-empty">loading…</div>
      ) : error && all.length === 0 ? (
        <div className="board-empty">board unavailable</div>
      ) : all.length === 0 ? (
        /* Two distinct empty states: an empty registry is fixed by running a
           backlog skill in some project; an empty RESULT is fixed by the
           controls two inches above the message. */
        <div className="board-empty">nothing registered yet</div>
      ) : visible.length === 0 ? (
        <div className="board-empty">no matches</div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map((col) => {
            const colItems = sortItems(visible.filter((i) => i.section === col.section), sort);
            return (
              <div className={`board-col board-col-${col.slug}`} key={col.section} data-testid="board-col">
                <div className="board-col-h">
                  <span className="board-col-tick" />
                  <span className="board-col-name" data-testid="col-name">{col.label}</span>
                  <span className="board-col-count" data-testid="col-count">{colItems.length}</span>
                </div>
                <div className="board-col-cards">
                  {colItems.map((item) => (
                    <ItemCard
                      key={item.path}
                      item={item}
                      hues={hues}
                      // Goes through `openItemDrawer`, not `setOpen`
                      // directly — see that function's own comment for why.
                      onOpen={() => openItemDrawer(item)}
                      agents={agents}
                      // Goes through `openLaunchSheet`, not `setDispatching`
                      // directly — see that function's own comment for why.
                      onDispatch={() => openLaunchSheet(item)}
                      now={now}
                      stale={staleFor(item)}
                      runStage={runStageFor(item)}
                      runBlock={runBlockFor(item)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open !== null && (
        <ItemDrawer
          item={open}
          hues={hues}
          onClose={() => setOpen(null)}
          agents={agents}
          // Goes through `openLaunchSheet`, not `setDispatching` directly —
          // see that function's own comment for why.
          onDispatch={() => openLaunchSheet(open)}
          runBlock={runBlockFor(open)}
        />
      )}
      {openRun !== null && (
        <RunDrawer run={openRun} onClose={() => setOpenRunProject(null)} />
      )}
      {dispatching !== null && (
        /* `key` on a singleton element, which looks redundant and is not: it
           makes re-targeting the sheet a REMOUNT rather than a prop change.
           LaunchSheet holds nine pieces of state and its only effect refetches
           the plan without resetting any of them, so without this, switching
           from item A to item B rendered A's `sessionId` success panel under
           B's title — B reading as already launched, with no launch button at
           all — and A's `planError` kept B permanently blocked with A's
           message, since `blocked = plan?.blocked ?? planError`. Launching
           inside the in-flight plan fetch also POSTed B's path with A's
           prompt.
           One key resets all nine, which is smaller and more honest than
           nine resets in an effect that would have to be extended every time
           the sheet grows a tenth. Contrast ItemDrawer, which DOES clear its
           own state on an `item.path` change: it holds two fields and both
           are derived from the fetch that effect already owns, so the reset
           is the effect's own business there. The difference is deliberate. */
        <LaunchSheet key={dispatching.path} item={dispatching} onClose={() => setDispatching(null)} />
      )}
      {orchestrating !== null && (
        /* `key` on this singleton for the same reason LaunchSheet's own
           comment just above gives, scaled down to this sheet's smaller
           state: without it, re-opening Orchestrate for project B while an
           error from project A is still in `error` would show A's stale
           message under B's title. `items` is recomputed from `all` on
           every render rather than memoised — this is the same "a few
           hundred rows" corpus the file-level comment on `BoardView`
           already reasons is cheap to filter, and it is what makes the
           preview see a groom that just landed via `refresh`/`refetch`
           without any extra plumbing. */
        <OrchestrateSheet
          key={orchestrating}
          project={orchestrating}
          // Looked up from `orchestrating` itself, NOT `orchestrateProjectName`
          // (which tracks the toolbar's CURRENT filter, `projectValue`) —
          // this sheet's header has to keep naming the project it actually
          // opened for even if the filter is changed out from under it
          // while the sheet is still up, the same "keyed on identity, not on
          // whatever else changed" reasoning `orchestrating` itself is
          // declared with above.
          projectName={registered.find((p) => p.path === orchestrating)?.name ?? orchestrating}
          items={all.filter((i) => i.projectPath === orchestrating)}
          spawnMaxPermission={agents?.spawnMaxPermission ?? null}
          onClose={() => setOrchestrating(null)}
          refresh={refreshRuns}
        />
      )}
    </div>
  );
}
