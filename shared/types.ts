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
 * the only stage every item starts in; `merged` is the only success exit;
 * `failed`, `skipped`, `needs-answers`, `ungroomed`, and `parked` are the
 * five ways an item leaves the pipeline without merging. `needs-answers` and
 * `ungroomed` are reachable straight from `pending` (a preflight question
 * with no answer, or an item the gate never queues past parse) without ever
 * touching `preflight` — the type does not encode reachability, only the
 * vocabulary; `orchestrate.mjs` (Task 3) owns which transitions are legal.
 */
export type RunStage =
  | 'pending' | 'preflight' | 'dispatched' | 'inspecting' | 'reviewing'
  | 'fixing' | 'verifying' | 'merging' | 'merged'
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
 * first leaves the run dispatching into an item that moved under it. The six
 * members left out (`merged`, `failed`, `skipped`, `needs-answers`,
 * `ungroomed`, `parked`) are the run's exits: it is finished with that item
 * and a human picking it up by hand is the intended next move. `parked` most
 * of all — a park exists precisely to hand the item back to a person, so
 * blocking it would break the one recovery path it was built for.
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
 * carries about itself).
 */
export interface OrchestratorRunsPayload {
  runs: Array<OrchestratorRun & { fresh: boolean; pastRuns: number }>;
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
