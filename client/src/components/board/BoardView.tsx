import { useId, useMemo, useState } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { hasTracker, trackerLine } from '../../lib/tracker';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useReverify } from '../../hooks/useReverify';
import { useSettings } from '../../hooks/useSettings';
import { isInProgress } from '../../lib/item-progress';
import { isStale, leavesBoard } from '../../lib/item-stale';
import { buildProjectHues } from '../../lib/project-hue';
import { PROJECT_KEY } from '../../lib/view-keys';
import { projectDispatchGate, runClaimBlock } from '../../../../shared/agent';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { BoardColumn } from './BoardColumn';
import type { BoardColumnSlug } from './BoardColumn';
import { ACTIVE_RUN_STAGES, ItemCard } from './ItemCard';
import type { RunCardState } from './ItemCard';
import { ItemModal } from './ItemModal';
import { LaunchSheet } from './LaunchSheet';
import { OrchestrateSheet } from './OrchestrateSheet';
import { RunChip } from './RunChip';
import { ATTENTION_RUN_STAGES } from '../../../../shared/types';
import type { BacklogItem, RunStage, Section } from '../../../../shared/types';

/* PROJECT_KEY is imported, not declared here: Archive reads the same one, and
   the two surfaces are separate lazy chunks — see lib/view-keys.ts for why a
   shared module rather than an export off this file. The two below stay local
   because Archive has neither control. */
const STATUS_KEY = 'backlog-manager.status';
const SORT_KEY = 'backlog-manager.sort';

/** The "not narrowed" sentinel — a sentinel rather than '', so a stored value
 *  always reads as itself and never as "the field was cleared". */
const ALL = 'all';

type StatusFilter = 'open' | 'started' | 'done' | 'all';
type SortKey = 'created' | 'name' | 'project';

/**
 * The noun the band's count line uses for whatever the Status filter is
 * currently admitting (DESIGN.md §8.3). One word per filter value rather than
 * a fixed "open", because the number beside it is the filtered count: `4 open`
 * printed under the Done filter would be counting done items and calling them
 * open.
 *
 * `all` gets `items` rather than the filter's own label — "4 all" is not
 * English, and the line's job is to say what was counted.
 */
const COUNT_WORDS: Record<StatusFilter, string> = {
  open: 'open',
  started: 'in progress',
  done: 'done',
  all: 'items'
};

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
const COLUMNS: { section: Section; label: string; slug: BoardColumnSlug }[] = [
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
 * `sortItems` below gives every sort a shared primary key (live work
 * first — `liveRank`), and a primary key that has to run in front of whichever comparator
 * is selected can only be written once against a record's shared call site —
 * three separate branches would each need their own copy of it.
 */
const COMPARATORS: Record<SortKey, (a: BacklogItem, b: BacklogItem) => number> = {
  name: (a, b) => a.title.localeCompare(b.title),
  project: (a, b) => a.project.localeCompare(b.project) || b.created.localeCompare(a.created),
  created: (a, b) => b.created.localeCompare(a.created)
};

/**
 * The primary sort key every comparator shares, and the board's one answer to
 * "is anybody on this right now". Lower sorts first, so live cards float to the
 * top of their column no matter which comparator is selected, and whichever one
 * is selected still decides order *within* each rank — two live cards do not
 * collapse to file order against each other just because they tied.
 *
 *   0 — a fresh run is BLOCKED on a person (`ATTENTION_RUN_STAGES`).
 *   1 — a fresh run is working it (`ACTIVE_RUN_STAGES`), or a hand-run session
 *       has stamped `started:` on the file (`isInProgress`).
 *   2 — everything else.
 *
 * Rank 0 sits above running work because it is the only one of the three that
 * is waiting on the reader: a run that has stopped and will not restart on its
 * own is the single most actionable thing a column can contain.
 *
 * Hand-run and orchestrator-run live work deliberately TIE at rank 1. Both mean
 * "somebody is on this", and there is no reading under which one of them
 * deserves to sit above the other — the selected sort orders them against each
 * other exactly as it always has.
 *
 * Three readers, and they must not disagree: this rank orders the columns, its
 * `< 2` half is the Status filter's `started` predicate, and the same `< 2` half
 * gates the board's clock (`hasLive`). It is also, by construction, exactly the
 * set of cards `liveBarFor` (ItemCard.tsx) draws a bar for — the rank and the
 * marker are the same claim, one sorted and one painted, which is why neither
 * restates the other's stage lists.
 */
const liveRank = (item: BacklogItem, stage: RunStage | undefined): 0 | 1 | 2 => {
  if (stage !== undefined && ATTENTION_RUN_STAGES.includes(stage)) return 0;
  if ((stage !== undefined && ACTIVE_RUN_STAGES.includes(stage)) || isInProgress(item)) return 1;
  return 2;
};

/**
 * Onto a copy, never in place — the array belongs to the fetched index.
 *
 * `stageFor` is threaded in rather than read off the item: an orchestrated
 * item's file says nothing about the run working it (see `liveBarFor`'s own
 * comment for why), so the primary key can no longer be a pure function of one
 * item and the lookup has to come from the caller that holds the run payload.
 */
function sortItems(items: BacklogItem[], sort: SortKey, stageFor: (item: BacklogItem) => RunStage | undefined): BacklogItem[] {
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
  out.sort((a, b) => liveRank(a, stageFor(a)) - liveRank(b, stageFor(b)) || compare(a, b));
  return out;
}

/**
 * The board: every registered project's items in four fixed type columns.
 * All narrowing happens here, client-side, over the fetched index — the whole
 * corpus is a few hundred rows of title-and-date, and a server-side filter
 * would cost a round trip per keystroke (guide-manager's rationale, kept).
 *
 * `onOpenRuns` is the rail's own section setter, threaded down for the run
 * chip (DESIGN.md §8.3) — the one control on this page that navigates. A prop
 * rather than a second copy of `App`'s state: the chip and the rail's Runs
 * entry have to mean the same thing by construction, and the section lives in
 * `AppShell`. Optional, because every suite that renders this view bare
 * predates the chip and none of them needs a destination for it.
 */
export default function BoardView({ onOpenRuns }: { onOpenRuns?: () => void }) {
  const { items: index, projects, loading, error } = useBoard();
  /* Task 5: only `staleDays` is read here, but the whole control comes back —
     `useSettings` falls back to the defaults outside a provider (see its own
     comment), which is what lets every board test that never mounts one still
     get the documented 30-day window rather than undefined. */
  const { settings } = useSettings();
  const [open, setOpen] = useState<BacklogItem | null>(null);
  /* `reload` (bug-13) is threaded down to every dispatch control as
     `reverify`: the hook's mount+focus cadence cannot recover a board whose
     window never loses focus, and the one block that cadence can leave
     falsely disabled is the one a click is now allowed to re-ask. Named for
     what the button does with it rather than for the hook's own verb — the
     board itself never calls it. */
  const { status: agents, reload: reverifyAgents } = useAgents();
  // Task 11: the orchestrator's own view of any project's queue, polled live
  // while any run is fresh (useOrchestratorRuns.ts) and not at all otherwise.
  // `refresh` (Task 13): OrchestrateSheet's own Start button calls this
  // directly after both a successful start and a 409 "already running"
  // conflict, so the run chip has the fresh run ahead of the next scheduled
  // poll rather than up to `POLL_MS` late — see OrchestrateSheet.tsx's own
  // comment on `start` for why the conflict path needs it just as much as
  // the success path does.
  //
  // task-37: `noteResume`/`resuming` are no longer read here. They belonged to
  // the Resume control on `RunStrip`, which left the Board with the strip —
  // resume is the Runs section's now (§8.4.1's moved-rules table), and this
  // view has no control that can start one. The hook still exports both for
  // that surface; what it no longer has on this page is a second caller.
  const { runs, starting, refresh: refreshRuns } = useOrchestratorRuns();
  /* Separate from `open`: the sheet can be opened from a card (modal closed)
     or from inside the modal (the modal stays open behind it), so one piece of
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
  /* bug-16: the toolbar's own half of the one-question click, from the same
     hook DispatchButton uses. Declared up here with the other board-level
     state rather than beside the gate below, because it is a hook and the
     gate is a derivation. */
  const { verifying: orchestrateVerifying, ask: askOrchestrate } = useReverify(reverifyAgents);
  /*
   * Task 12's `openRunProject` — which project's run drawer is open — is gone
   * with `RunDrawer` itself (task-37, DESIGN.md §8.3's "What leaves"). The
   * drawer's whole content is the Runs page's detail sheet now, always beside
   * the list rather than behind a click, so there is no per-project overlay
   * state for this view to hold and no fourth dialog on the Escape stack.
   */

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

  /* Fresh runs only: a stale run has stopped reporting, and a card's live
     strip is the claim "this item is being worked right now" — so it has to go
     silent on exactly that condition, not linger because this
     map forgot to check. That single `fresh` filter is the ONLY thing
     unpinning a card when a run's heartbeat stops; there is deliberately no
     second check downstream, and test/board-live-cards.test.tsx pins this
     one in place so a future refactor sourcing the map from `runs` fails here
     rather than leaving a dead run pinning cards to the top of a column
     forever.

     Declared this high up — well above the columns that render from it — because
     `matches` and `hasLive` just below now need the run's own view of an item:
     the Status filter's "In progress" and the board's ticking clock both have
     to count orchestrated work, and an orchestrated item's FILE says nothing
     about the run working it (ItemCard's `liveBarFor` has the full finding).

     orchestrator-watchdog (design §6.2): stays exactly this — freshness-based,
     feeding cards, badges and `runClaimBlock` alone — because a crashed run
     must not keep a card pinned to the top of its column or dead to dispatch
     forever. The surface that needed a wider view was `RunStrip`, through a
     second list beside this one; `RunChip` is its replacement and takes the
     whole `runs` array instead (see the note where that list used to be), so
     this one is still narrow and still means exactly what it says. */
  const freshRuns = runs.filter((run) => run.fresh);

  /* `stripRuns` — the wider `running || paused` list the run strip rendered
     from — went with the strip (task-37). `RunChip` takes the WHOLE `runs`
     array instead, and that is a deliberate widening rather than an oversight:
     the chip's rule (DESIGN.md §8.3) is that it is absent only when the
     payload carries no run and no starting entry, so a finished run still
     counts one, where the strip rendered null for it. What the chip does NOT
     do is treat a stale run as live — `runChipReading` reads `isCrashed`, the
     same single implementation everything else on this board reads.

     `freshRuns` above stays exactly as it was and keeps its narrow job: cards,
     badges and dispatch claims are freshness-only, and nothing here widens
     them. */

  /* task-14's placeholders are read straight off `starting` now. This used
     to be a filtered copy subtracting any project that already had a
     `running` run file — bug-21 moved that rule into
     `StartingRunsService.expired()` (its third eviction rule), where the
     payload itself carries the guarantee and the four gates bug-21 added can
     all inherit it. Keeping a client-side filter beside a server-side rule
     that says the same thing would be the two-agreeing-expressions shape
     this repo pins tests against everywhere else (`watchdogStoodDown`,
     `isStale`) — and the crashed-run case that filter existed for is now
     tested where the rule lives (test/orchestrator-starting.test.ts). */

  /* The id→queue-entry lookup, one map per fresh run, keyed by the run's own
     `project` — the registry's absolute path, the exact string
     `BacklogItem.projectPath` already carries on every item (shared/types.ts
     documents both as "the same string"). Every card below is matched to a run
     by comparing that path directly, never by deriving a project identity from
     `item.path` or from the display name on its pill — two checkouts of the
     same repo would share the name but never the path, and only the path is
     what the run itself reports.

     The narrow `{ stage, stageAt }` record rather than the bare stage this used
     to carry: the card's bar reads an elapsed off `stageAt`, and rather than the
     whole `RunQueueItem` (whose sessionId/worktree/verification belong to
     RunDrawer) it carries exactly what a card can render. */
  const runEntriesByProject = new Map<string, Map<string, RunCardState>>();
  for (const run of freshRuns) {
    runEntriesByProject.set(run.project, new Map(run.queue.map((q) => [q.id, { stage: q.stage, stageAt: q.stageAt }])));
  }
  const runEntryFor = (item: BacklogItem): RunCardState | undefined => runEntriesByProject.get(item.projectPath)?.get(item.id);
  /** The rank's and the filter's half of the same lookup — neither needs `stageAt`. */
  const runStageFor = (item: BacklogItem): RunStage | undefined => runEntryFor(item)?.stage;

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
    /* `liveRank(...) < 2`, not `isInProgress`. The two used to be the same
       question and stopped being one the moment a run could work an item
       without stamping the file this board reads: resolving "In progress"
       through the file's `started:` alone hid exactly the items the
       orchestrator was working — the precise opposite of what this view is
       for. Expressed as the rank rather than as its own copy of the two stage
       lists so the filter and the column order can never disagree about which
       cards are live. */
    (status === 'started' ? liveRank(i, runStageFor(i)) < 2 : status === 'all' || i.status === status);

  /* Everything the toolbar admits, before the staleness split below. Named
     rather than inlined because `hasLive` has to be computed off THIS set —
     see its own comment for why that is not just an ordering convenience. */
  const matched = all.filter(matches);

  /* One clock for the whole board, and only while something needs one. A live
     card's elapsed reading is the only thing here that goes stale with no event
     at all — `20m` is wrong sixty seconds later whether or not anyone touches
     the tab, and the item fetches only refresh on mount and focus. Gated on the
     rendered items so a board with nothing live installs no interval; passed
     down as a value so the cards stay pure and their tests never have to fake a
     timer.

     `liveRank(...) < 2`, not `isInProgress`: it is the same predicate the rank
     and the Status filter read, and it has to be, because an orchestrator-active
     card's bar carries an elapsed of its own. Left at `isInProgress` the reading
     on those cards would freeze at whatever it said on first paint — a board
     that looks live and is lying about how long by however long the tab has
     been open.

     Computed on `matched` rather than on `visible` below, which reads like a
     bug and is not: `useNow` is a hook, so it cannot be called after a filter
     that itself needs the clock it returns. That ordering constraint is the
     whole reason and it is unrelated to which items the two sets contain.

     The two sets now agree in every case, which they did not always: staleness
     used to read the item FILE alone, so a long-untouched open bug an
     orchestrator had just picked up was still stale by the file's own
     reckoning and left for Archive — a card this clock was running for and no
     column was showing. bug-11 widened `leavesBoard`/`isStale` to take the run
     payload for exactly that reason, and the widening landed in item-stale.ts
     rather than in the filter below so ArchiveView gets the same answer by
     construction. `liveRank(...) < 2` and `leavesBoard` are consequently two
     readings of one fact now, off one payload. */
  const hasLive = matched.some((i) => liveRank(i, runStageFor(i)) < 2);
  /* A registered tracker project is the board's second reason to hold a clock
     (task-45). The band prints a POLL AGE, which goes stale with no event in
     this tab exactly the way an in-progress card's elapsed does — and it goes
     stale faster: the server polls every fifteen seconds, so a minute-long
     period would show one number for four cycles. Hence one clock, running
     faster while a tracker is registered, rather than a second interval beside
     the first: every reading on this board is aged against one instant, which
     is the rule `now` exists to keep. */
  const tracked = hasTracker(projects);
  const now = useNow(hasLive || tracked, tracked ? 5_000 : 60_000);

  /* Task 5: the Board/Archive split. Everything the toolbar matched, minus the
     open refactors, ideas and bugs nobody has touched inside the window — those
     are Archive's half (Task 6) and this is the same predicate read from the
     other side, never a second copy of the rule. Tasks are exempt by
     construction inside `leavesBoard`, so a stale one is still here below,
     carrying the marker `staleFor` hands its card.

     Applied AFTER `matches` rather than folded into it so the two narrowings
     stay separable: `matches` is what the toolbar says, this is what the
     calendar says, and only the second one can be changed from Settings.

     The full `runs`, not `freshRuns`: `runHoldsItem` behind this applies its
     own `fresh` filter (its doc comment says why), and routing a
     pre-filtered list in would put that rule in two places — the same reason
     `runBlockFor` below reads the full list. */
  const visible = matched.filter((i) => !leavesBoard(i, settings.staleDays, now, runs));

  /* The marker a surviving stale card wears — in practice only ever a task,
     since `leavesBoard` has already taken every other stale section out of
     `visible`. Computed here rather than in ItemCard for the same reason `now`
     and `runStage` are: the card stays a pure function of its props, with no
     opinion about the window or the clock. */
  const staleFor = (item: BacklogItem): boolean => isStale(item, settings.staleDays, now, runs);

  /* The band's 13 px count line — `21 open across 3 projects` (DESIGN.md
     §8.3's own example reading).
   *
   * The noun is the Status filter's own word rather than a fixed "open",
   * because the count it sits beside is `visible`, which the filter decides:
   * a line reading `4 open` under the Done filter would be counting done
   * items and calling them open. `?? 'items'` for the same reason
   * `COMPARATORS` above has a fallback — `status` comes back out of
   * localStorage as whatever some other build wrote there, and the type
   * describes what this build WRITES, never what it can read.
   *
   * The project half is the projects the counted items actually belong to,
   * not `registered.length`: an unreachable project (`missing`) contributes
   * no items and the warning line above already names it, so counting it here
   * would make the line disagree with the board under it. It is dropped
   * entirely once the filter names one project, because the answer would be
   * `across 1 project` on every board a reader narrowed themselves. */
  const countWord = COUNT_WORDS[status] ?? 'items';
  const countProjects = new Set(visible.map((i) => i.projectPath)).size;
  const countLine =
    projectValue === ALL
      ? `${visible.length} ${countWord} across ${countProjects} ${countProjects === 1 ? 'project' : 'projects'}`
      : `${visible.length} ${countWord}`;

  /* One line per CONNECTED project — the poll age, or the access reason in
     its place when the connection is not `ok` (spec §5.5). The band is where
     the run chip lives, so it is already this page's status line, and a
     tracker's freshness is exactly that kind of fact: not about any one card,
     and wrong to repeat on forty of them.
     Derived by `lib/tracker.ts` and merely rendered here, the same discipline
     every other board derivation follows. `null` for every files project, so
     a board with no tracker prints exactly what it printed before. */
  const trackerLines = registered.map((p) => trackerLine(p, now)).filter((line): line is string => line !== null);

  const missing = registered.filter((p) => p.missing);
  const warnings = [...missing.map((p) => `unreachable: ${p.name} — no backlog/ at ${p.path}`), ...(index?.errors ?? [])];

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
   *     (the run chip): a second Start would only race the 409 the server
   *     already enforces (agents.service.ts's own activeRun check) — same
   *     "nothing to add" reasoning as DispatchButton returning null for an
   *     item with no next step. A STALE run does not count here: a run that
   *     has stopped reporting is not a run in progress, and the control has
   *     to still be there to start a fresh one once the last one has gone
   *     silent.
   */
  const orchestrateGate = projectValue === ALL || agents === null ? null : projectDispatchGate(agents, projectValue);
  /* bug-21 widened condition 4 to cover the window BEFORE that fresh run
     exists. The server's own pre-spawn lock was blind for the same window,
     so a second press returned 200 and spawned a second session; both
     booted, and whichever reached `init` second exited `4` (lock held) and
     died. That lock is now closed too (agents.service.ts) — this half is
     what stops the board offering the click at all, rather than letting it
     race a 409.

     Folded into the SAME expression rather than added as a fifth condition:
     "a run already owns this project's whole story on the board" is one
     question, and the starting placeholder is one of the two rows that can
     be telling that story. */
  const orchestrateBusy = freshRuns.some((run) => run.project === projectValue) || starting.some((s) => s.project === projectValue);
  const showOrchestrate = orchestrateGate !== null && orchestrateGate.control !== 'hidden' && !orchestrateBusy;
  const orchestrateBlockedReason = orchestrateGate?.control === 'disabled' ? orchestrateGate.reason : null;
  // The registry's own display name, for the button's title and the sheet's
  // header — falls back to the raw path only in the unreachable case where
  // `projectValue` names a project `registered` no longer carries (the same
  // "unregistered since" staleness `knownPaths`/`projectValue` above already
  // guard against, restated here since a fallback still has to resolve to
  // SOME string for a title attribute).
  const orchestrateProjectName = registered.find((p) => p.path === projectValue)?.name ?? projectValue;

  /*
   * The dispatch half of the same run payload: why a run forbids dispatching
   * this item, or null. Fed to BOTH render sites below — the card's tear-off
   * tab and the modal's chip — since they are two independent buttons for one
   * item, and only one of them being run-aware is half of the bug this fixes.
   *
   * Deliberately reading the FULL `runs` list rather than going through
   * `runEntriesByProject` above: `runClaimBlock` applies its own `fresh` filter
   * (see its doc comment), so routing it through a map already filtered to
   * fresh runs would put that rule in two places, and the map's stage lists are
   * the live bar's rule (`ACTIVE_RUN_STAGES`/`ATTENTION_RUN_STAGES`), not this
   * one — `pending` and `preflight` block dispatch while showing no marker at
   * all.
   *
   * `starting` alongside it (bug-21): for the 1–5 minutes before `init` writes
   * the run file, `runs` is empty for a project a run is booting into, and
   * this gate read `runs` alone — so every card kept a live dispatch button
   * for an item the pending run was about to claim in its own worktree. The
   * block that produces is project-wide and deliberately coarse; see
   * `runClaimBlock`'s own comment for why per-item is not available here at
   * all.
   */
  /* The tracker line for one item's project, or null when its project is not
     a tracker. Looked up by `projectPath`, the stable key — two checkouts of
     one repo share a name but never a path. */
  const trackerLineFor = (item: BacklogItem): string | null => {
    const project = registered.find((p) => p.path === item.projectPath);
    return project === undefined ? null : trackerLine(project, now);
  };

  const runBlockFor = (item: BacklogItem): string | null => runClaimBlock(item, runs, starting);

  /*
   * Task 12 fix round 1 paired the item drawer with `RunDrawer` here: two
   * role="dialog" `.drawer` asides, neither with a focus trap of its own, so
   * two mounted at once was a real keyboard hazard rather than a visual
   * overlap — Tab from the frontmost one's backdrop walked a keyboard-only
   * user into the interactive elements of whichever was still mounted
   * behind it, and a screen reader was left with two dialogs and no signal for
   * which one was current. The pair is gone with `RunDrawer` (task-37) and the
   * survivor is `ItemModal` (task-40), so what is left here is the one opener
   * and the three-way exclusion the sheets still need.
   *
   * This function is still the ONLY place `open` goes non-null — every call
   * site below goes through it, never `setOpen` directly — but Task 13's fix
   * round 1 (below) added a caller that clears it, so "opening either closes
   * the other" is no longer the whole story; see that comment for the rest.
   */
  const openItemModal = (item: BacklogItem): void => {
    // Task 13 fix round 1 — see openOrchestrateSheet's own comment for why
    // this line was added here (it was not, at first).
    setOrchestrating(null);
    setOpen(item);
  };

  /*
   * Task 13 adds a second overlay pair, and the same hazard the comment
   * above describes applies to it for the same structural reason:
   * OrchestrateSheet and LaunchSheet wear the same `FormSheet` shell
   * (task-40), which means both have exactly the same "no focus trap of its
   * own" property the two `.drawer`s shared.
   * `dispatching` and `orchestrating` get the identical treatment LaunchSheet
   * and OrchestrateSheet's two openers already gave each other in Task 13's
   * first pass: two separate pieces of state, cleared by each other's opener,
   * never set directly outside these two functions.
   *
   * Fix round 1 (Important): the first pass stopped there and left
   * `orchestrating` free to coexist with an open item modal, reasoning by
   * analogy that OrchestrateSheet was "the same kind of
   * overlay as LaunchSheet" and LaunchSheet already coexists with the item
   * modal on purpose (test/dispatch-button.test.tsx's "opens the sheet from
   * inside the modal, leaving it open behind it"). Review found the
   * analogy does not actually hold: LaunchSheet's coexistence is reachable
   * only through a per-item dispatch control that lives INSIDE the modal it
   * coexists with (or on the card the modal was opened from), which is a
   * narrow, deliberately-tested path. OrchestrateSheet's own trigger is the
   * band's chip, which is on screen and clickable at the exact same time
   * as every card — "modal open, then Orchestrate" is not an edge case here,
   * it is the ordinary path a keyboard user (Tab past the modal's own
   * untrapped focus) or even a mouse user (the modal's scrim covers the
   * columns, but not the band above it) reaches without trying to. So
   * `orchestrating` clears `open` too (see `openItemModal` above), and the
   * modal's opener clears `orchestrating` right back. `dispatching`
   * (LaunchSheet) deliberately still does NOT participate in that exclusion:
   * the coexistence it has with the item modal remains the proven,
   * deliberate, tested behaviour described above, and nothing here touches it.
   */
  const openLaunchSheet = (item: BacklogItem): void => {
    setOrchestrating(null);
    setDispatching(item);
  };
  const openOrchestrateSheet = (proj: string): void => {
    setDispatching(null);
    setOpen(null);
    setOrchestrating(proj);
  };

  return (
    <div className="board">
      {/* The page header is a band, not a card (DESIGN.md §8.2/§8.3): the
          19/500 title over the 13 px count line, then right-aligned the run
          chip, the 36 px search field, the three filter chips and — last, and
          the page's ONE ink chip — Orchestrate. */}
      <Band
        title="Board"
        sub={
          <>
            {countLine}
            {trackerLines.map((line) => (
              <span className="board-band-tracker" key={line} data-testid="tracker-line">
                {line}
              </span>
            ))}
          </>
        }
      >
        {/* Left of the controls (spec §3.2). Everything the Board still says
            about runs, in one control that opens Runs; absent entirely when
            the payload carries no run and no starting entry. */}
        <RunChip runs={runs} starting={starting} onOpen={() => onOpenRuns?.()} />
        <input
          type="search"
          className="board-band-search"
          aria-label="Search items"
          placeholder="search titles"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Each filter is a `Chip` wrapping its own native select — `as:
            'label'`, the mode the primitive already has for a chip that wraps
            its own control. The chip owns the shell (32 px, 12 px radius, the
            `--hairline2` stroke) and the select owns the value text and the
            picker, which is what keeps a project list of any length working
            without this file growing a menu of its own. The `aria-label` stays
            on the select, as it always was: it is the control, the label is
            only its shell. */}
        <Chip as="label">
          <select className="board-filter" aria-label="Project" value={projectValue} onChange={(e) => setProject(e.target.value)}>
            <option value={ALL}>All projects</option>
            {/* Valued by path, labelled by name — two checkouts of one repo
                stay two selectable options. */}
            {registered.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
          {/* The UA's own arrow went with `appearance: none` (the select had to
              lose its box, and the arrow is part of it). This is the design's
              own, at the board's size and ink; aria-hidden, because the select
              already announces itself as a combobox. */}
          <span className="board-filter-mark" aria-hidden="true">
            ▾
          </span>
        </Chip>
        <Chip as="label">
          <select className="board-filter" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="open">Open</option>
            <option value="started">In progress</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          {/* The UA's own arrow went with `appearance: none` (the select had to
              lose its box, and the arrow is part of it). This is the design's
              own, at the board's size and ink; aria-hidden, because the select
              already announces itself as a combobox. */}
          <span className="board-filter-mark" aria-hidden="true">
            ▾
          </span>
        </Chip>
        <Chip as="label">
          <select className="board-filter" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="created">Newest first</option>
            <option value="name">By name</option>
            <option value="project">By project</option>
          </select>
          {/* The UA's own arrow went with `appearance: none` (the select had to
              lose its box, and the arrow is part of it). This is the design's
              own, at the board's size and ink; aria-hidden, because the select
              already announces itself as a combobox. */}
          <span className="board-filter-mark" aria-hidden="true">
            ▾
          </span>
        </Chip>
        {/* Task 13: the "drain this project's groomed queue" control.
            `showOrchestrate`/`orchestrateBlockedReason` (computed above)
            already encode all four visibility rules from the brief, so
            this markup only has to react to them — the same hide-vs-disable
            shape DispatchButton renders, restated by hand rather than
            reused because DispatchButton's signature is fixed around one
            `BacklogItem`, which a project-level control does not have.
            task-37 redrew it as the page's one ink chip (DESIGN.md §8.3) and
            touched none of those rules. */}
        {showOrchestrate && (
          <>
            <Chip
              variant="ink"
              title={orchestrateBlockedReason ?? `drain ${orchestrateProjectName}'s groomed queue in a Claude session`}
              aria-disabled={orchestrateBlockedReason !== null}
              aria-describedby={orchestrateBlockedReason === null ? undefined : orchestrateReasonId}
              // The one signal that a swallowed-looking click was actually
              // answered (bug-16), for the reason DispatchButton carries the
              // same attribute: the re-ask below is one request long, and
              // styles.css keys a `progress` cursor and a lighter label off
              // this, so the feedback is not screen-reader-only either.
              aria-busy={orchestrateVerifying}
              onClick={() => {
                // The other half of aria-disabled: the browser fires a
                // click on it regardless, so this is what decides what a
                // blocked button does — and since bug-16 that is "ask the
                // question once", not "nothing".
                //
                // Only ONE block can be speaking here, which is why there is
                // no equivalent of DispatchButton's three-condition
                // `reverifiable`: `showOrchestrate` above hides the control
                // outright for the environment ladder, for an unfiltered
                // board, and for a project with a fresh run, so a rendered
                // disabled button is necessarily blocked on project
                // visibility alone — the one block that can be silently
                // stale, because `useAgents` refetches on mount and window
                // focus only and a window that never loses focus is never
                // asked again. (The fresh-run rule is fed by
                // `useOrchestratorRuns`, which polls every 5s while any run
                // is fresh, so it is never stale in this way and a status
                // refetch could not see runs at all.) Nothing else recovers
                // it here: unlike LaunchSheet, OrchestrateSheet re-derives
                // no gate on open — its only server re-check is at Start,
                // as an uncoded 409 — so the sheet that would correct a
                // stale answer sits behind the control the stale answer
                // made inert.
                if (orchestrateBlockedReason !== null) {
                  // Captured, not re-read at resolve time: the filter is a
                  // live <select>, and the sheet must open for the project
                  // the reader actually clicked for. Deliberately no "the
                  // filter moved, discard the answer" guard — `orchestrating`
                  // is keyed on the project path precisely so a sheet
                  // outlives a filter change (see its declaration), and the
                  // window here is one request wide.
                  const path = projectValue;
                  askOrchestrate((fresh) => {
                    // Re-derived from the FRESH answer through the same
                    // gate, so a status that came back with dispatch off or
                    // the dashboard gone opens nothing either.
                    if (projectDispatchGate(fresh, path).control === 'enabled') openOrchestrateSheet(path);
                  });
                  return;
                }
                openOrchestrateSheet(projectValue);
              }}
            >
              Orchestrate
            </Chip>
            {orchestrateBlockedReason !== null && (
              <span id={orchestrateReasonId} className="sr-only">
                {orchestrateBlockedReason}
              </span>
            )}
          </>
        )}
      </Band>

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
            const colItems = sortItems(
              visible.filter((i) => i.section === col.section),
              sort,
              runStageFor
            );
            return (
              <BoardColumn key={col.section} slug={col.slug} label={col.label} count={colItems.length}>
                {colItems.map((item) => (
                  <ItemCard
                    key={item.path}
                    item={item}
                    hues={hues}
                    // Goes through `openItemModal`, not `setOpen`
                    // directly — see that function's own comment for why.
                    onOpen={() => openItemModal(item)}
                    agents={agents}
                    // Goes through `openLaunchSheet`, not `setDispatching`
                    // directly — see that function's own comment for why.
                    onDispatch={() => openLaunchSheet(item)}
                    now={now}
                    stale={staleFor(item)}
                    /* The whole queue entry, not just its stage: the
                       card's live strip reads an elapsed off `stageAt`. See
                       `runEntriesByProject` for why one prop and not two. */
                    run={runEntryFor(item)}
                    runBlock={runBlockFor(item)}
                    reverify={reverifyAgents}
                  />
                ))}
              </BoardColumn>
            );
          })}
        </div>
      )}

      {open !== null && (
        <ItemModal
          item={open}
          hues={hues}
          onClose={() => setOpen(null)}
          agents={agents}
          // Goes through `openLaunchSheet`, not `setDispatching` directly —
          // see that function's own comment for why.
          onDispatch={() => openLaunchSheet(open)}
          runBlock={runBlockFor(open)}
          reverify={reverifyAgents}
          /* The same line the band prints, for the project THIS item belongs
             to: the modal shows a body that came out of the poller's cache, so
             it says how old that cache is right beside it (spec §5.5). Derived
             here rather than in the modal because this view owns the clock and
             the project list, exactly as it does for `runBlock` and `now`. */
          trackerLine={trackerLineFor(open)}
        />
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
           the sheet grows a tenth. Contrast ItemModal, which DOES clear its
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
