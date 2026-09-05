/*
 * Type-only, and deliberately so: `shared/agent.ts` imports a VALUE from this
 * file (`RUN_CLAIMED_STAGES`), so on paper the two now reference each other.
 * An `import type` is erased before any bundler, Nest build or runtime sees
 * it, so no cycle exists outside the type checker — and the alternative is
 * spelling the action union out by hand in the two request/response shapes
 * below, which is the exact duplication `deriveAction` living in one shared
 * module exists to rule out. Do not "break the cycle" by re-inlining the
 * union.
 */
import type { AgentAction } from './agent';

/** The registry file's shape — written only by skills/backlog/tools/backlog.mjs,
 *  read by the server. */
export interface RegistryProject {
  /** basename of the project's git root — display name on the board */
  name: string;
  /** absolute path of the project's git root */
  path: string;
  /** first registration, ISO string; never rewritten on later upserts */
  createdAt: string;
}

export interface Registry {
  projects: RegistryProject[];
}

/** The five store sections. Directory names, verbatim — these strings are the
 *  contract with backlog.mjs's SECTIONS map, not display labels.
 *
 *  `refactors` is a peer section, not a facet on ideas: ideas are NEW (a
 *  feature, an optimisation), refactors are EXISTING things that should be
 *  improved — not new, not broken, so neither an idea nor a bug. Its id prefix
 *  is `ref` (see SECTIONS in backlog.mjs for why the short form is
 *  load-bearing), and its lifecycle matches ideas exactly: open -> done,
 *  promotable to a task, rejectable to out-of-scope. */
export type Section = 'bugs' | 'ideas' | 'tasks' | 'refactors' | 'out-of-scope';

/** An item's status IS the directory it lives in (open/ vs done/), never a
 *  frontmatter field — backlog.mjs rejects a status: key outright. out-of-scope
 *  is flat and terminal. In progress is deliberately NOT a member here: it is a
 *  marker on an open item (see BacklogItem.started), not a fourth place a file
 *  can live — and neither is the board's `'started'` status-filter value
 *  (`StatusFilter` in BoardView.tsx). That string picks out a view over these
 *  same three members (open items where `isInProgress` holds); it does not
 *  name a fourth one. */
export type ItemStatus = 'open' | 'done' | 'terminal';

export interface BacklogItem {
  id: string;
  title: string;
  /** YYYY-MM-DD from frontmatter; '' when the file lacks one (still renderable) */
  created: string;
  /**
   * When the item was picked up (`backlog.mjs start`), '' when nobody has.
   * "Picked up" now spans two different callers, not one: `backlog-execute`
   * stamps it and holds it all the way to archive, while `backlog-groom`
   * stamps it too, holding it only for the length of one groom session and
   * clearing it again once a verdict lands. Either can stamp an idea —
   * deciding an idea's verdict (promote it, or reject it outright) is itself
   * the active work the marker exists to describe, so an idea is no longer
   * refused the way a done or out-of-scope item still is.
   *
   * Two shapes, both permanent. `start` writes a second-precision UTC timestamp
   * (`2026-08-28T14:03:07Z`); every file stamped before it did carries a bare
   * `YYYY-MM-DD`, and nothing rewrites an existing item's frontmatter, so both
   * are on disk forever. Readers accept both — the client ages a bare date in
   * days only, since UTC midnight is not the hour anyone started work.
   *
   * Surfaced verbatim, never interpreted here: an archived item keeps the moment
   * it was started as history, so "is this in progress" is `started !== ''` AND
   * `status === 'open'` — a question the client answers, since it is the only
   * side that renders it.
   */
  started: string;
  /**
   * Second-precision UTC timestamp (same shape as the newer `started`) of the
   * last `start` or `stop` on this item. Written by both, so it moves every
   * time work opens OR closes — unlike `started`, which is fixed at the
   * moment work opened and only clears on `stop`. '' when the item has never
   * been started or stopped. Surfaced verbatim, same as `started`: it is
   * history the client renders, not something this side interprets.
   */
  updated: string;
  /**
   * Committer date (`%cI`, so ISO 8601 with an offset — a third stamp shape
   * beside the bare date and the `Z` timestamp) of the last commit touching
   * this item's file. `''` for an untracked file, a project outside git, or an
   * unavailable git.
   *
   * Derived from git rather than the file, because `updated:` has one writer
   * and the file has several editors — a groom session that writes Cause/Fix
   * without `start --as groom` leaves it silent. Surfaced verbatim, same
   * contract as `created`/`updated`/`started`: the client owns the precedence
   * between the three (`lib/item-touched.ts`).
   */
  lastCommit: string;
  /**
   * Which clock is currently running: `'groom'` while a groom session holds
   * the item, `'execute'` while an execute session does. `stop` removes the
   * key entirely, so a stopped item legitimately has no `phase` — that state
   * is `''`, the same value an item that was never started has. There is no
   * way to tell "stopped" from "never started" from `phase` alone; that
   * distinction lives in `started`.
   *
   * Clamped, not validated: an unrecognised value on disk (a typo, a future
   * third phase this reader doesn't know about yet) becomes `''` rather than
   * throwing. A malformed `phase:` must not 500 the board or drop the item
   * from the index — `''` degrades to "in progress, phase unknown", the same
   * value an item that was never started carries, and it is up to the client
   * to render something sensible for that case (a generic in-progress bar
   * rather than a groom- or execute-specific one).
   */
  phase: '' | 'groom' | 'execute';
  /**
   * Whole seconds accumulated across every groom session on this item, kept
   * running by `start`/`stop`. `0` both when the key is absent (nobody has
   * groomed it yet) and when the value on disk isn't a plain non-negative
   * integer — the CLI never writes anything else, so a negative, fractional,
   * or non-numeric string only reaches here via a hand edit, and the read
   * side clamps it to `0` instead of surfacing NaN or throwing. A session
   * shorter than a second still bills, so `0` is also a legitimate accrued
   * value, not only the "absent" sentinel.
   */
  groomElapsed: number;
  /** Same accumulation and same clamping as `groomElapsed`, for time spent
   *  under `backlog-execute` instead of `backlog-groom`. */
  executeElapsed: number;
  /**
   * Tokens accumulated across every groom session on this item — the
   * token-shaped sibling of `groomElapsed`, kept running by the same
   * `start`/`stop` pair and clamped by the same reader (absent, negative,
   * fractional and non-numeric all read as `0`). Elapsed time says how long an
   * item took; this says roughly how much model work it took, and neither
   * implies the other.
   *
   * Two things a reader of this type must not re-decide, because both are
   * answers rather than oversights:
   *
   * 1. **Cache reads are excluded.** The number is
   *    `input + cache_creation + output`, never `cache_read_input_tokens`.
   *    Measured on one live session, fresh 89,210 against cache_read 804,246 —
   *    a raw total is ~90% re-read context floor, which scales with turn count
   *    and is nearly identical for a trivial item and a hard one. It would
   *    swamp the signal this number exists to carry.
   * 2. **Attribution is whole-session-within-the-window**, not per-item. The
   *    CLI bills every token the calling session spent between `start` and
   *    `stop`, so grooming an item and then chatting about something else in
   *    the same session counts both. Under `backlog-orchestrate` — the
   *    consumer that matters, and where the expensive items are — each item
   *    gets its own headless session and the window covers nothing else, so it
   *    is very nearly exact; for hand grooming in a shared terminal it is
   *    noisy by exactly as much as the unrelated work in the window.
   *
   * Treat it as a rough complexity signal: right for "which items were
   * expensive", wrong for anything claiming precision.
   */
  groomTokens: number;
  /** Same accumulation, same clamping and the same two caveats as
   *  `groomTokens`, for work done under `backlog-execute`. */
  executeTokens: number;
  /**
   * A refactor's flavour: `'chore'` (tidying that carries no risk anyone is
   * tracking) or `'debt'` (a shortcut taken deliberately, now due). `''` when
   * the key is absent, which is every non-refactor item and any refactor
   * nobody classified.
   *
   * Surfaced verbatim rather than clamped to the two known values, unlike
   * `phase` above — the difference is what each side does with the result.
   * `phase` drives a label the client has to choose between, so an
   * unrecognised value has to collapse to a known state. `kind` drives a
   * badge that is simply not rendered when the value isn't one it knows, so
   * passing the string through costs nothing and keeps the frontmatter
   * round-trip honest: an unknown `kind:` is preserved on disk by the CLI and
   * reported as-is here, so a third kind added later is one enum value in the
   * client rather than a change on this side.
   */
  kind: string;
  tags: string[];
  section: Section;
  status: ItemStatus;
  /** display name of the owning project (registry `name`) */
  project: string;
  /** registry `path` of the owning project — the stable key for filtering:
   *  two checkouts of one repo share a name but never a path */
  projectPath: string;
  /**
   * Derived, never stored. bugs: `## Cause` and `## Fix` both filled (not
   * "unknown"). tasks: `## Plan` non-empty (capture refuses a task without
   * one, so this is effectively always true). ideas / refactors /
   * out-of-scope: null — groomed is not a state they have. For a refactor as
   * for an idea, the state that matters is being PROMOTED, not being groomed;
   * `false` would claim a refactor is waiting on a groom it can never pass.
   */
  groomed: boolean | null;
  /** absolute path of the item's file — the key /api/items/body takes */
  path: string;
}

export interface ItemsIndex {
  items: BacklogItem[];
  /** malformed files skipped during the scan, one message per file, each
   *  prefixed with the file's absolute path — same semantics as
   *  `backlog.mjs board` exiting 1 with a partial board */
  errors: string[];
}

export type SectionCounts = Record<Section, number>;

export interface ProjectSummary {
  name: string;
  path: string;
  createdAt: string;
  /** registered path no longer has a backlog/ directory (or is gone entirely).
   *  Reported rather than hidden: a disappeared backlog is information. */
  missing: boolean;
  /** open items per section (out-of-scope counts its terminal items) */
  counts: SectionCounts;
}

/**
 * The dashboard's permission-mode ladder, lowest to highest. Re-declared here
 * rather than imported from ../claude-agents-dashboard: that repo is a sibling
 * checkout, not a dependency, and a cross-repo import would make this app
 * unbuildable without it. Four strings, pinned by test/agents-shared.test.ts.
 */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';

/**
 * `GET /api/agents/status`. Every field is false/empty when `enabled` is false —
 * that case never leaves this process, so there is nothing to report about a
 * dashboard we did not call.
 */
export interface AgentsStatus {
  /** BM_AGENTS is on. False ⇒ no outbound request was made at all. */
  enabled: boolean;
  /** The dashboard answered GET /api/health. */
  reachable: boolean;
  /** Its remote-answer toggle. POST /api/spawn 404s without it. */
  remoteAnswer: boolean;
  /** Its CLAUDE_BIN probe. Also a 404 on spawn when false. */
  spawnAvailable: boolean;
  /** The ceiling every launch is clamped to; null when we could not read it. */
  spawnMaxPermission: PermissionMode | null;
  /**
   * Absolute project paths the dashboard can currently resolve to a session
   * directory — i.e. those with a Claude transcript inside its LOOKBACK_HOURS.
   * A registered project missing from this list cannot be spawned into.
   */
  projectPaths: string[];
  /** Why `reachable` is false. Rendered verbatim in Settings. */
  error?: string;
}

/**
 * `POST /api/agents/plan` — everything the launch sheet needs, and nothing the
 * client could have decided for itself. Deliberately carries no dashboard
 * `dirName`: that key is internal to the spawn call, the client has no use for
 * it, and dispatch re-resolves it from `itemPath` anyway.
 */
export interface AgentPlan {
  action: AgentAction;
  /** The composed default. The sheet may edit it before dispatching. */
  prompt: string;
  /** Display name of the project the session will run in. */
  project: string;
  /** The ladder truncated at the dashboard's ceiling — never wider. */
  allowedModes: PermissionMode[];
  defaultMode: PermissionMode;
  /**
   * Set when the item is dispatchable in principle but not right now (the
   * dashboard is off, unreachable, or cannot see the project). Re-checked here
   * rather than trusted from the board's older status read, which may be
   * minutes stale — the sheet renders this instead of a Launch button.
   */
  blocked?: string;
}

/** Body of `POST /api/agents/dispatch`. */
export interface AgentDispatchRequest {
  itemPath: string;
  /** Checked against the server's own derivation, never obeyed. */
  action: AgentAction;
  prompt: string;
  permissionMode: PermissionMode;
  /**
   * `--model` / `--effort` for the spawned CLI. Optional, and plain `string`
   * rather than a literal union on purpose: the accepted names live in the
   * dashboard, not here, so the server validates against its own mirrored copy
   * (`pickFrom`, shared/agent.ts) and drops anything else. Absent means "send
   * no flag" — the CLI's own default, which is what the sheet's `default`
   * option submits.
   */
  model?: string;
  effort?: string;
  remoteControl: boolean;
}

/** 201 body of `POST /api/agents/dispatch` — the dashboard's minted session id. */
export interface AgentDispatchResult {
  sessionId: string;
}

/**
 * The one machine-readable discriminator `POST /api/agents/orchestrate`
 * ever sends — a `code` field alongside that 409's human-readable `error`
 * string, present ONLY on the activeRun-lock refusal (agents.service.ts's
 * `orchestrate()`), never on that endpoint's other 409s (project-invisible,
 * no CLAUDE_BIN, remote-answers-off, the dirName race).
 *
 * Fix round 2's whole reason to exist: that endpoint has several distinct
 * 409 reasons sharing one HTTP status, so status alone cannot tell a client
 * which one happened — and a client parsing the `error` PROSE to guess is
 * exactly the fragility a fix round already had to remove once
 * (OrchestrateSheet.tsx's own history: a message-substring match broke
 * silently the moment the wording changed). `code` turns "is this the
 * lock, specifically" from a guess into a question with one right answer.
 * Deliberately not a wider taxonomy — no other 409 on this or any other
 * route gets a `code`, and none should without its own reason to exist;
 * this is the one case, kept minimal on purpose.
 *
 * Exported once here rather than declared as a bare string literal in both
 * agents.service.ts (which sends it) and OrchestrateSheet.tsx (which reads
 * it), so the two sides can never drift on the one string that has to
 * match exactly — the same "one implementation, every side imports it"
 * rule this file and shared/agent.ts already apply to everything else two
 * sides of this app have to agree on.
 */
export const RUN_IN_PROGRESS_CODE = 'run-in-progress';

/**
 * What a successful run does with a verified item's branch: merge it into
 * `main` and clean up, or leave it for a person to merge by hand. Declared
 * beside `RunStage` because the two are the same feature — `branch` mode
 * exists to make `RunStage` need a second success exit (`branched`, below).
 *
 * - `merge` — today's behaviour, byte for byte. The run merges each verified
 *   item into `main` (`git merge --no-ff`) and deletes its worktree and
 *   branch.
 * - `branch` — the run commits, reviews and verifies exactly as `merge`
 *   mode does, then removes the worktree and **keeps the branch**. `main` is
 *   never touched. The branch is the deliverable a person merges by hand.
 */
export type MergeMode = 'merge' | 'branch';

/**
 * Every member of `MergeMode`, as a value — what a request body's
 * `mergeMode` and the CLI's `--merge-mode` flag are both checked against.
 * Exported so neither caller has to restate the union by hand, the same
 * reason `AGENT_ACTIONS` exists in `shared/agent.ts` beside `isAgentAction`.
 */
export const MERGE_MODES: readonly MergeMode[] = ['merge', 'branch'];

/**
 * The orchestrator's one-way pipeline for a single queue item, pending
 * through merged, plus the terminal exits that leave the pipeline early.
 * Written out as a flat union rather than modelled as "pipeline stage" +
 * "terminal outcome" because a queue item's `stage` field is exactly one of
 * these strings at any moment — there is no second field to disagree with it,
 * so nothing is gained by splitting the type and a split type would let a
 * reader ask "which pipeline stage is `failed`?", a question with no answer.
 *
 * Order here is the pipeline order, not alphabetical, because Task 5's watch
 * loop and Task 6's client render a "how far along" indicator by finding a
 * stage's position in this list — the members exist as much for a reader
 * scanning the sequence as for the string values themselves. `pending` is
 * the only stage every item starts in; `merged` and `branched` are the two
 * success exits — same terminal position in the pipeline, one per
 * `MergeMode`, and a queue item reaches exactly one of them, never both;
 * `failed`, `skipped`, `needs-answers`, `ungroomed`, and `parked` are the
 * five ways an item leaves the pipeline without merging. `needs-answers` and
 * `ungroomed` are reachable straight from `pending` (a preflight question
 * with no answer, or an item the gate never queues past parse) without ever
 * touching `preflight` — the type does not encode reachability, only the
 * vocabulary; `orchestrate.mjs` (Task 3) owns which transitions are legal.
 *
 * `branched` is the `branch`-mode success exit, positioned beside `merged`
 * rather than off with the failure exits: it is what a *successful* item
 * reaches when the run was told to stop at a reviewed branch instead of
 * merging it, and it is a true exit like `merged` — the run holds nothing
 * once an item is there. See `MergeMode` above for what the two modes do
 * differently, and `RUN_HELD_STAGES` (shared/agent.ts) for why `branched`
 * counts as one of the exits and not one of the claims.
 */
export type RunStage =
  | 'pending' | 'preflight' | 'dispatched' | 'inspecting' | 'reviewing'
  | 'fixing' | 'verifying' | 'merging' | 'merged' | 'branched'
  | 'failed' | 'skipped' | 'needs-answers' | 'ungroomed' | 'parked';

/**
 * The stages at which a run still OWNS the item — the eight non-terminal
 * members of `RunStage` above, and the whole input to `runClaimBlock`
 * (shared/agent.ts), which is what disables a card's dispatch control while
 * an orchestrator run is working it.
 *
 * Lives here rather than beside that function because it is a partition of
 * `RunStage`, not a fact about dispatch: a new stage added to the union three
 * lines up has to be classified as claimed-or-finished in the same edit, and
 * the only place a reader will look for that decision is next to the union
 * itself. `test/agents-shared.test.ts` pins the partition against a
 * `Record<RunStage, true>` literal, so the compiler forces a new member into
 * that test and the test then forces it into one of the two halves.
 *
 * `pending` and `preflight` are IN this list deliberately, which is the one
 * judgement call here. A pending item is already claimed — the run will reach
 * it without asking anyone — so a manual session that grooms or archives it
 * first leaves the run dispatching into an item that moved under it. The
 * seven members left out (`merged`, `branched`, `failed`, `skipped`,
 * `needs-answers`, `ungroomed`, `parked`) are the run's exits: it is finished
 * with that item and a human picking it up by hand is the intended next
 * move. `parked` most of all — a park exists precisely to hand the item back
 * to a person, so blocking it would break the one recovery path it was built
 * for. `branched` joins the exits for the same reason `merged` is one: a
 * branch-mode run that finished the item successfully has let go of it just
 * as completely as a merge-mode run has.
 *
 * NOT the same list as `ACTIVE_RUN_STAGES` (client ItemCard.tsx), and the two
 * must not be unified: that one answers "does this card show a live stage
 * badge" and correctly EXCLUDES `pending`/`preflight` (a badge that flickers
 * on for the fraction of a poll cycle preflight takes is noise). They overlap
 * by six members today and are answering different questions.
 */
export const RUN_CLAIMED_STAGES: readonly RunStage[] = [
  'pending', 'preflight', 'dispatched', 'inspecting', 'reviewing',
  'fixing', 'verifying', 'merging'
];

/**
 * The two `RunStage` values that mean the run has STOPPED and will not restart
 * until a person does something. Together with `RUN_CLAIMED_STAGES` above they
 * are every stage a run still HOLDS the item at — `runHoldsItem`
 * (shared/agent.ts) is that union, and
 * `merged`/`branched`/`failed`/`skipped`/`ungroomed` are the five true exits
 * it leaves out.
 *
 * Moved here from `client/src/components/board/ItemCard.tsx` by bug-11, and
 * the move is the interesting part. On the card these two were a rendering
 * fact — which cards wear an amber bar rather than a cyan one, the theme's own
 * "a human is involved here" legend — and its sibling `ACTIVE_RUN_STAGES` is
 * still exactly that and still lives there. This list stopped being one the
 * moment `client/src/lib/item-stale.ts` began reading it to decide Board
 * versus Archive: a `lib/` module importing a React component to get a stage
 * partition would invert the layering both surfaces depend on, and the
 * partition is a fact about `RunStage` in any case. Which is the same argument
 * `RUN_CLAIMED_STAGES` makes directly above — a new member of the union three
 * dozen lines up has to be classified in the same edit, and the only place a
 * reader will look for that decision is next to the union itself. There are
 * now TWO such classifications, claimed-or-terminal and live-or-exited, and
 * `test/agents-shared.test.ts` pins both against one `Record<RunStage, true>`
 * literal so a new stage cannot satisfy one and be forgotten by the other.
 *
 * `parked` belongs here rather than with the claimed stages and that
 * asymmetry is deliberate, not an oversight: a park exists precisely to hand
 * the item back to a person, so it must NOT block a manual dispatch
 * (`runClaimBlock` leaves it out for that reason) while it very much must keep
 * the card on the surface that person is looking at.
 */
export const ATTENTION_RUN_STAGES: readonly RunStage[] = ['needs-answers', 'parked'];

/**
 * One row of the verify step's output, kept verbatim rather than summarised
 * to a pass/fail count: `tail` is the last few lines of the command's own
 * output, which is what a human actually needs to tell a flaky test from a
 * real regression without re-running anything. `ok` is stored redundantly
 * alongside `tail` rather than derived from it (a green tail and a red tail
 * do not share a recognisable shape across arbitrary project test runners),
 * so the drawer can render a checkmark without parsing prose.
 */
export interface RunVerification {
  /** The exact command that ran, e.g. `pnpm test`. */
  cmd: string;
  /** Its exit status, already collapsed to pass/fail. */
  ok: boolean;
  /** The last few lines of its output — enough to diagnose, not the whole log. */
  tail: string;
}

/**
 * One backlog item's full run record. Every field survives the item's whole
 * time in the queue rather than being cleared on a stage change, because the
 * run file is the only place this history exists once a worktree is removed
 * — `sessionId`/`worktree`/`branch` stay populated after `merged` so the
 * drawer (Task 6) can still say which session and branch produced a given
 * merge, and `verification`/`fixLoops` stay populated after a park so a
 * resumed run does not have to re-discover what already happened.
 */
export interface RunQueueItem {
  /** The backlog item's own id — the same id `backlog.mjs` uses. */
  id: string;
  title: string;
  stage: RunStage;
  /**
   * The headless `claude -p` session working this item, or `null` before
   * dispatch and for an item skipped before dispatch (`needs-answers` from a
   * preflight question, or `ungroomed`) — those two exits never reach the
   * point where a session would exist to record.
   */
  sessionId: string | null;
  /** Absolute path of this item's git worktree, or `null` for the same reasons as `sessionId`. */
  worktree: string | null;
  /** The item's working branch name, or `null` for the same reasons as `sessionId`. */
  branch: string | null;
  /**
   * The `--permission-mode` the headless session was dispatched under, or
   * `null` before dispatch and for an item skipped before it (same reasons
   * as `sessionId`). Recorded because the mode can now vary between runs: it
   * used to be a constant of the design — every session ran under one
   * hard-coded `--dangerously-skip-permissions` — and is now `auto`, a rung
   * whose classifier can genuinely refuse a call. A denial found in a
   * transcript is only interpretable next to the mode that produced it.
   * Deliberately a free string rather than `PermissionMode`: the CLI's own
   * `--permission-mode` accepts six values (`manual` and `dontAsk` among
   * them) and `PERMISSION_LADDER` names four, so narrowing this to the
   * ladder would make the field unable to record a mode that was actually
   * used.
   */
  permissionMode: string | null;
  /**
   * How many times this item has gone through the fix-and-re-review loop in
   * the *current* run attempt. Reset by a fresh `init`, not carried across a
   * park-then-resume from an earlier run — a past exhaustion is history that
   * belongs in `attention`, not a count this run's loop cap has to weigh.
   */
  fixLoops: number;
  /**
   * First-arrival timestamp for each stage this item has actually visited,
   * keyed by the stage name. `Partial` because an item's route through
   * `RunStage` is not the full member list even on a clean run (verify is
   * skipped along with merge for anything that exits early), and a
   * fix-and-re-review loop revisits `reviewing`/`fixing` without adding a
   * second key — only the first arrival is kept, so this is a shape record,
   * not a full event log.
   */
  stageAt: Partial<Record<RunStage, string>>;
  /** Verify-step output, oldest first; `[]` for an item that never reached verify. */
  verification: RunVerification[];
  /**
   * Unanswered preflight questions, verbatim, for a `needs-answers` item;
   * `[]` for every other stage. Kept as a plain array rather than folded
   * into `note` because the drawer (Task 6) renders these questions
   * verbatim as a list, not as prose it would have to re-split out of a
   * free-text field.
   */
  questions: string[];
  /**
   * A short free-text explanation for anything the other fields don't
   * already say on their own — why an `ungroomed` item was skipped, or what
   * a `parked` item is waiting on. `null` when the stage speaks for itself
   * (a plain `merged` or `pending` item has nothing to add).
   */
  note: string | null;
}

/**
 * One entry in the run's surfaced list of things a human should look at:
 * an unanswered preflight question, a merge left parked, or an item that
 * used up its fix-and-re-review loops without converging. Deliberately not
 * one-to-one with a *current* queue stage — `id` names the queue item this
 * is about, but the item may have since been resumed and moved on (a
 * `parked` merge that got checked out and merged by hand, say), so this list
 * is a log of what happened, not a live filter over `queue`.
 */
export interface RunAttention {
  /** The `RunQueueItem.id` this entry is about. */
  id: string;
  kind: 'needs-answers' | 'parked' | 'fix-exhausted';
  /** Human-readable detail — what happened and, where relevant, what unblocks it. */
  detail: string;
}

/**
 * Fifteen minutes. The orchestrator's watch loop (Task 5) heartbeats — i.e.
 * re-stamps `OrchestratorRun.updatedAt` — at most roughly every 9.5 minutes
 * even when nothing else changes, so any single missed beat still leaves the
 * run under this threshold; only two consecutive missed beats (a genuinely
 * wedged or crashed process, not a slow item) push `updatedAt` stale enough
 * for the UI to call the run dead and offer resume/abort. This is the one
 * freshness number in the app — every "is this run still alive" check reads
 * this constant rather than hard-coding its own guess.
 */
export const RUN_STALE_MS = 15 * 60 * 1000;

/**
 * The orchestrator's run-state file for one project, as written by
 * `orchestrate.mjs` (Task 3) at `~/.backlog-manager/orchestrator/<project
 * key>/run.json` and read back by the server and client unmodified — this
 * app never writes one. `status` mirrors the run file's own lifecycle, not
 * any one item's: `running` until every queued item has left the pipeline
 * (merged or otherwise), then `done`; `aborted`/`failed` record how a
 * non-`running` run file got that way rather than staying `running` forever.
 */
export interface OrchestratorRun {
  /** Identifies one run's archived file among `runs/<runId>.json` siblings for the same project. */
  runId: string;
  /** The registered project's absolute path — the same string as `RegistryProject.path`. */
  project: string;
  status: 'running' | 'done' | 'aborted' | 'failed';
  startedAt: string;
  /** Re-stamped on every write to the run file — the heartbeat `RUN_STALE_MS` measures against. */
  updatedAt: string;
  /** The `--max` the run was started with, or `null` for "work the whole gated queue". */
  maxItems: number | null;
  /**
   * What this run was ASKED to do — `init --merge-mode`'s value, or
   * `'merge'` when the flag was omitted. Never rewritten after `init`: it is
   * the answer to "what did the user request", and `mergeModeEffective`
   * below is the separate answer to "what is the run actually doing". The
   * two are split into two fields rather than one because an archive that
   * only kept the final effective mode could no longer tell a run that
   * *chose* branch mode up front apart from a run that started in merge
   * mode and was degraded into branch mode by a denied merge — exactly the
   * distinction a post-mortem on a run like that needs.
   */
  mergeMode: MergeMode;
  /**
   * What this run is actually doing right now. Starts equal to `mergeMode`
   * and only ever moves `merge` → `branch`, never back — a run can be
   * denied a merge mid-queue (§5.2 of the design) and fall back to leaving
   * branches for the rest of the queue, but nothing pushes it the other way:
   * once a run has proven the classifier will refuse it, retrying merge mode
   * on a later item would just repeat the four-hour failure this field
   * exists to prevent.
   */
  mergeModeEffective: MergeMode;
  /**
   * Why `mergeModeEffective` differs from `mergeMode`, or `null` when they
   * still agree. Set once, at the moment a merge is denied — see
   * `mergeModeEffective`'s own comment for why that move is one-directional
   * and this note is never cleared back to `null` afterwards.
   */
  mergeModeNote: string | null;
  queue: RunQueueItem[];
  attention: RunAttention[];
}

/**
 * `GET /api/orchestrator/runs` (Task 8) — one entry per project with any run
 * history, each run annotated with what the run file alone cannot say:
 * `fresh` is the `RUN_STALE_MS` freshness check the server performs once so
 * every client doesn't re-implement it against its own clock, and
 * `pastRuns` is a count the client has no other way to obtain (it is a
 * directory listing on the server's filesystem, not a field the run file
 * carries about itself). `watchdog` (orchestrator-watchdog design, Task 2)
 * is optional for a reason distinct from `fresh`/`pastRuns` being mandatory:
 * every run this endpoint lists has a freshness fact and a history count
 * whether or not anyone is watching it, but a watchdog record only exists
 * once a run has actually BEEN a watchdog subject — `status === 'running'
 * && !fresh`, the crashed case (see `RunWatchdog` below). A fresh, healthy
 * run was never armed against, so there is nothing true to attach to it;
 * forcing the field to be present with some placeholder value would make
 * every caller branch on a default that means nothing, instead of on
 * absence, which means exactly "this run has never crashed."
 */
export interface OrchestratorRunsPayload {
  runs: Array<OrchestratorRun & { fresh: boolean; pastRuns: number; watchdog?: RunWatchdog }>;
}

/**
 * The orchestrator watchdog's own configuration — see
 * `docs/superpowers/specs/2026-09-04-orchestrator-watchdog-design.md` §5 for
 * the full "why". Lives beside the run-payload shapes above rather than in
 * `server/src/agents/config.util.ts` (which owns the OTHER three env vars
 * this repo has) because this one is not env-only: it is read and written by
 * both the server (`watchdog-config.util.ts`, the clamp and the file) and the
 * client (the Settings group's `<select>` ladders, design §6.4), and a shape
 * both sides must agree on can only have one definition — the same reason
 * `MergeMode`/`isMergeMode` live here rather than in either side alone.
 */
export interface WatchdogConfig {
  /**
   * The user's own switch (design §1's "Disabled"), orthogonal to the
   * sweeper's phase below: a disabled watchdog still arms, ticks and
   * reports the crashed run it would have resumed — it only ever withholds
   * the resume spawn itself. Watching stays cheap and honest even while
   * spawning is turned off.
   */
  enabled: boolean;
  /** How often the sweeper re-reads every project's run file for staleness, while armed. */
  tickMs: number;
  /**
   * How long a crashed run is left alone after any resume attempt OR
   * failure before the sweeper will try it again (design §1's "Grace") —
   * long enough for a resumed session to reach its first heartbeat even on
   * a bad day, short enough that a genuine crash is not left unattended for
   * the whole window.
   */
  graceMs: number;
  /** How many resume spawns a single crashed run gets before the sweeper marks it exhausted and stops trying. */
  maxAttempts: number;
}

/**
 * The floor, ceiling and default for each numeric `WatchdogConfig` field.
 * Lives here, in `shared/`, rather than as a server-only constant, because
 * BOTH the server's clamp (`clampWatchdogConfig`, `watchdog-config.util.ts`)
 * and the Settings group's `<select>` ladders (design §6.4 — `TICK_LADDER`
 * etc, each a small subset of the range below) read the same triples: if a
 * floor changed on only one side, the UI could offer a value the server
 * would silently clamp away, or the server could accept a value the UI
 * would never let anyone select. One definition rules that drift out rather
 * than relying on two files being edited together forever.
 *
 * The specific numbers are design §5.2's, not chosen here: `graceMs`'s
 * five-minute floor in particular is not a placeholder — the incident this
 * design responds to was an overload event, and a resume spawned into the
 * same overload can take several minutes just to run its first command,
 * against a measured ninety-second time-to-heartbeat on a good day.
 */
export const WATCHDOG_LIMITS = {
  tickMs: { min: 30_000, max: 600_000, default: 60_000 },
  graceMs: { min: 300_000, max: 3_600_000, default: 600_000 },
  maxAttempts: { min: 1, max: 5, default: 2 }
} as const;

/**
 * The config an unreadable, missing or non-object `watchdog.json` degrades
 * to — the same "never a 500, always a default" posture the registry and
 * `run.json` readers both already take on a bad file. `enabled: true`
 * because the design's whole premise is a watchdog that watches unless a
 * person turns it off, not one a fresh install has to opt into by hand —
 * the same reasoning `BM_AGENTS` deliberately does NOT follow (that one
 * defaults off because it can spawn a session with file-write permission in
 * another repo; the watchdog can only ever resume a run `orchestrate.mjs`
 * itself already started).
 */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  tickMs: 60_000,
  graceMs: 600_000,
  maxAttempts: 2
};

/**
 * The sweeper's own three phases (design §1) — NOT the same axis as
 * `WatchdogConfig.enabled` above, which is the user's toggle. `'off'` means
 * `BM_AGENTS` is off (nothing on this server can spawn at all) or
 * `BM_WATCHDOG=off` (the operator's kill switch, §5.1) — either way no timer
 * ever exists. `'idle'` means no run file anywhere says `running`, so
 * nothing is being watched. `'armed'` means at least one does, fresh or
 * crashed alike: a crashed run is still `running` until a human or a
 * resumed session says otherwise, so arming does not wait for trouble, it
 * starts the moment there is anything to lose track of.
 */
export type WatchdogPhase = 'off' | 'idle' | 'armed';

/**
 * Every kind of line the Settings Activity feed (design §6.4) can print.
 * `'armed'`/`'idle'` are phase transitions, not spawn outcomes, logged so
 * the feed can answer "when did watching last start or stop" without a
 * viewer having polled `phase` at the right moment themselves. `'disabled'`
 * is not a phase — it is one tick observing a crashed run while
 * `config.enabled` is false, worth its own line because it is the one
 * situation where the sweeper is doing everything BUT the one thing anyone
 * actually wants from it, and that is worth surfacing on its own.
 */
export type WatchdogEventKind =
  | 'armed'
  | 'idle'
  | 'spawned'
  | 'failed'
  | 'exhausted'
  | 'recovered'
  | 'disabled';

/**
 * One line of the watchdog's own history — entirely separate from a run
 * file's own contents, because nothing here is a fact `orchestrate.mjs`
 * ever records: this is the sweeper's memory of what IT did, not a change
 * to the run it acted on. `project`/`runId` are `null` for an event that is
 * not about one particular run (`'armed'`, `'idle'`). `detail` is the
 * pre-rendered sentence a person reads, not fields for the feed to
 * reassemble — the same choice `RunVerification.tail` makes: a history list
 * is for reading, not recomputing.
 */
export interface WatchdogEvent {
  at: string;
  project: string | null;
  runId: string | null;
  kind: WatchdogEventKind;
  detail: string;
}

/**
 * How many `WatchdogEvent`s the state service keeps before dropping the
 * oldest. A plain number here in `shared/`, rather than a constant private
 * to the server, because the Settings Activity list (design §6.4) is SIZED
 * to this exact cap — its own "showing all N" / empty-state wording reads
 * this constant rather than hard-coding a second `50` that could silently
 * drift from the one the ring buffer actually enforces.
 */
export const WATCHDOG_EVENT_CAP = 50;

/**
 * One crashed run's watchdog record, held by `WatchdogStateService`
 * in-memory (design §4) — never written into `run.json` itself, which stays
 * `orchestrate.mjs`'s alone to touch (design's own non-goals: no durable
 * per-run record of "auto-resumed"). `lastSessionId` is the id a resume
 * spawn returned, the same role `RunQueueItem.sessionId` plays for the
 * original dispatch, so the strip and drawer can link to whichever session
 * is (or was) actually doing the recovery work.
 *
 * `exhausted` rides alongside `attempts` and `maxAttempts` so the strip and
 * the Settings row can render a boolean directly instead of every reader
 * re-deriving the same comparison — but it is DERIVED from those same two
 * numbers at the one place this record is built
 * (`WatchdogStateService.annotate()`, through `watchdogExhausted` in
 * shared/agent.ts), never stored anywhere and never carried forward from an
 * earlier read. It used to be a flag the sweeper set once and never cleared,
 * which is how raising "Give up after" in Settings could restart the sweeper
 * while this field still said it had given up — see `watchdogExhausted`'s own
 * comment for the failure that produced, and `watchdogStoodDown` for why the
 * board and the sweeper must agree about this field to the letter.
 */
export interface RunWatchdog {
  enabled: boolean;
  attempts: number;
  maxAttempts: number;
  lastSpawnAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  exhausted: boolean;
}

/**
 * `GET /api/agents/watchdog` (design §4.2) — the whole state the Settings
 * group and the strip's watchdog clause read in one call. `config` rides
 * along rather than needing a second fetch, because every save in Settings
 * has to redraw the State row too: flipping `enabled` changes what the
 * phase-plus-config combination means without the phase itself moving.
 * `watching` (run ids currently `running`) and `events` (newest first, at
 * most `WATCHDOG_EVENT_CAP`) are independent axes on purpose — a viewer
 * needs both "what is being watched right now" and "what happened
 * recently", and a run that just recovered can leave the first list in the
 * same tick that produces the newest line in the second.
 */
export interface WatchdogStatus {
  phase: WatchdogPhase;
  reason?: string;
  nextTickAt: string | null;
  config: WatchdogConfig;
  watching: string[];
  events: WatchdogEvent[];
}

/**
 * `RunVerification` with `tail` removed. `tail` is the last few lines of a
 * verify command's own output — useful for diagnosing one run in the live
 * drawer, but it is also ~90% of a run file's bytes (a real 19KB file is
 * mostly test output), and `GET /api/orchestrator/archive` (Task 1) has to
 * hold every run a project has ever produced in one payload rather than
 * just its current run. Keeping `cmd`/`ok` and dropping `tail` is what makes
 * that payload's size grow with run *count* instead of run count times
 * average test-output size; the detail endpoint (Task 2) still serves the
 * full `RunVerification` with `tail` intact for the one run a user actually
 * opens.
 */
export type VerificationSummary = Pick<RunVerification, 'cmd' | 'ok'>;

/** `RunQueueItem` with its verification list summarised the same way. */
export type ArchiveQueueItem = Omit<RunQueueItem, 'verification'> & {
  verification: VerificationSummary[];
};

/**
 * `OrchestratorRun` as the archive listing returns it: tails stripped from
 * every queue item's verification list, plus `current`. `current` exists
 * because a finished run's own file is not proof of where it lives — the
 * latest run for a project stays in `run.json` until the *next* `init`
 * archives it into `runs/<runId>.json`, so `runId`/`status`/`startedAt`
 * alone cannot tell the client "this is the newest run" from "this is one
 * of however many came before it." Without this flag the archive view
 * (Task 4) would have no way to distinguish the entry it should treat as
 * live-until-superseded from ordinary history.
 */
export type OrchestratorArchiveRun = Omit<OrchestratorRun, 'queue'> & {
  queue: ArchiveQueueItem[];
  /** true when this entry came from run.json (the current/latest run),
   *  false for an archived runs/<runId>.json file. */
  current: boolean;
};

/**
 * `GET /api/orchestrator/archive` (Task 1) — every run the orchestrator
 * state directory has ever recorded, across every project, flat like
 * `OrchestratorRunsPayload`. Unlike that payload this carries no `fresh` or
 * `pastRuns` annotation: those exist for the live board strip's "is this
 * run still going" question, which an archive view (Task 4, built for
 * browsing history rather than watching a live run) does not ask.
 */
export interface OrchestratorArchivePayload {
  runs: OrchestratorArchiveRun[];
}
