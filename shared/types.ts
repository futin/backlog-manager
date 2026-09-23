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

/**
 * Which adapter produced an item — the closed list of item sources THIS BUILD
 * ships, deliberately narrow: `'files'` and, since phase 2 of the
 * tracker-backed design registered the GitHub adapter
 * (docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md §4.2 and
 * §5, task-43 then task-45), `'github'`.
 *
 * Closed and narrow because a kind named here without an adapter behind it
 * would be a lie the resolver could not keep: `resolveSource` answers
 * `unsupported` for a marker kind no registered adapter serves, and a type
 * that admitted a kind this build does not ship would let a caller write a
 * field the server could never produce. The union grows with each adapter,
 * never ahead of one — `'github'` arrived in the same commit that appended
 * `GithubSource` to `ITEM_SOURCES`, and the next kind (GitLab, Jira — spec
 * §10) waits for its own adapter the same way.
 */
export type SourceKind = 'files' | 'github';

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
  /**
   * Which adapter produced this row — beside `path` because the two answer
   * one question together: where this row came from, and how to ask for its
   * body. `'files'` for a row off the store on disk, `'github'` for one the
   * tracker poller's cache produced (see `SourceKind`), and the two answer
   * `path` differently: a filesystem path against a URN.
   *
   * Required rather than optional, so the shape stays total: every fixture
   * literal in `test/` has to name its source and the compiler is the
   * checklist, the same reason `SectionCounts` spells out every section.
   *
   * Two readers on the client since task-45, and they are the two worth
   * knowing about: `deriveAction` (`shared/agent.ts`) answers `null` for any
   * row that is not `'files'`, which is what hides the dispatch control on a
   * tracker project, and `lib/tracker.ts` reads `ProjectSummary.source` (not
   * this one) to decide which projects get a poll-age line. Nothing else
   * branches on it — the board draws a tracker row exactly as it draws a file
   * row.
   */
  source: SourceKind;
  /**
   * Where a person can open this item in the source's own UI — an issue's
   * `html_url` for a tracker row, `null` for a files row, which has no URL to
   * give (its `path` is a path on one machine's disk and means nothing on
   * another's). The client draws a link-out control exactly when this is set
   * (spec §5.5), which is why it is `null` rather than `''`: the question is
   * "is there somewhere to go", and an empty string is a value that has to be
   * checked for emptiness at every site instead of once at the type.
   *
   * Required, like `source` and for the same reason task-43 gave: the
   * compiler is the checklist for the fixture literals in `test/`.
   */
  url: string | null;
  /**
   * The login of the person the tracker says owns this item — the FIRST
   * assignee where a tracker allows several, because the board draws one name
   * and picking the first is an answer a reader can predict, while joining
   * them is a string nobody can scan at card width. `null` for a files item
   * (a file has no assignee) and for an unassigned issue; the two are
   * deliberately the same value, since neither has anyone to name.
   *
   * Not a claim. Phase 2 has no claim protocol at all — `started`/`phase` stay
   * `''` for a tracker row — so a surface that draws this must not draw it as
   * if someone were working the item (spec §5.5: the login renders only where
   * it does not imply a claim). Phase 3 is what gives the in-progress bar a
   * claim to stand on.
   */
  assignee: string | null;
  /**
   * A tracker issue carrying no `type:*` label: there is nothing on it saying
   * which section it belongs to, so the mapping puts it in `ideas` and sets
   * this, and the client draws a badge saying so (spec §5.3).
   *
   * **A rendered badge, and nothing derived reads it.** Not `deriveGroomed`,
   * not `isStale`, not `lastTouched`, not the orchestrator gate. An untyped
   * issue IS an idea to every predicate until someone labels it — that is the
   * whole point of choosing `ideas` as the fallback rather than inventing a
   * sixth section — and a predicate that branched on this would make the badge
   * a second, invisible status. `false` for every files item, which cannot be
   * untyped: its section is the directory it lives in.
   */
  untyped: boolean;
  /**
   * The `runner-fix` marker, for a TRACKER item only (task-47): the issue
   * carries the `runner-fix` label, which means what a files item's
   * `runner-fix: true` frontmatter line means — executing this item repairs
   * machinery the rest of the queue depends on, so the orchestrator's gate
   * hoists it to the front.
   *
   * **Optional, `true` or absent, and never `false`.** Absence is the negative,
   * for the same reason `ItemCreateRequest.runnerFix` is read with a strict
   * `=== true`: the mapper is the only writer, so every files item and every
   * unmarked issue carries no key at all and their payloads stay byte-identical
   * to what they were before this field existed. A `false` would put a new key
   * on every row in every fixture in `test/`, for a value that says nothing the
   * absence does not.
   *
   * Required nowhere and derived from nothing. The files half of the same fact
   * is read by `orchestrate.mjs`'s own `parseItemForGate` straight off the item
   * file, which never becomes a `BacklogItem` at all — so this field exists
   * because a tracker item has no file for the gate to read, not because the
   * gate wanted a field.
   */
  runnerFix?: true;
  /**
   * The `orchestrator:queued` label, for a TRACKER item only (task-52): a live
   * orchestrator run has this issue in its queue and has not picked it up yet.
   * The card reads it as a badge (live or stale, decided in
   * `client/src/lib/tracker.ts`); nothing else does. It is advisory — a plan,
   * not a claim — so no gate, queue builder or claim reads it, and a session
   * that claims a queued item by hand is doing nothing wrong.
   *
   * **Optional, `true` or absent, and never `false`,** for exactly the reason
   * `runnerFix` above gives: the mapper is the only writer, so every files
   * item and every unqueued issue carries no key at all, and `'queued' in item`
   * means what it says.
   */
  queued?: true;
}

export interface ItemsIndex {
  items: BacklogItem[];
  /**
   * What the read could not make sense of, one message per cause, each
   * prefixed with the absolute path of the file that caused it — same
   * semantics as `backlog.mjs board` exiting 1 with a partial board.
   *
   * Three kinds of entry, all subject-prefixed and deliberately not
   * distinguished by shape: a malformed ITEM file skipped during a scan
   * (path-prefixed), a project whose `backlog/source.json` could not be
   * honoured (prefixed with the marker's path), which contributes this one
   * message and no items at all, and — since task-45 — a tracker issue this
   * build cannot map unambiguously, prefixed with its URN (`gh:owner/repo#31`)
   * rather than a path, because that is the handle that issue HAS. A reader
   * that needs to tell them apart has the prefix.
   */
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
  /**
   * Which source owns this project's items, resolved per request from its
   * committed `backlog/source.json` (spec §3.2, task-43):
   *
   * - `null` exactly when `missing` is `true` — no store, so no source. Not a
   *   fifth string: "this project has no backlog at all" is already `missing`'s
   *   news, and a second spelling of it would be a second thing to keep true.
   * - `'unsupported'` when a marker IS present but cannot be honoured —
   *   malformed, no string `kind`, or a kind no adapter in this build serves.
   *   The reason travels in `ItemsIndex.errors`, prefixed with the marker's
   *   path like every other scan error; it never travels here, because a
   *   summary that carried it would be the second home of a message the index
   *   already owns.
   * - otherwise the kind of the adapter that produced this project's items.
   *
   * `unsupported` NEVER reads as `'files'`. A tracker project whose marker the
   * server cannot read would otherwise render whatever stale files a clone
   * still carries, as ghosts beside the real items on another machine's board
   * (spec §3.2).
   */
  source: SourceKind | 'unsupported' | null;
  /**
   * The four fields below are the tracker connection's live state (spec §5.4),
   * and all four are `null` for a files project, a project with no store and an
   * unsupported marker alike.
   *
   * `null` rather than optional, and decided once for all four: `source: null`
   * set that precedent in task-43 and the reason is the same — the shape stays
   * TOTAL, so every fixture literal in `test/` names every field and the
   * compiler is the checklist rather than a reviewer. An optional field is a
   * field a new call site can silently forget.
   *
   * `owner/name` of the connected repo, read off the project's marker.
   */
  repo: string | null;
  /**
   * When the poller last successfully read this repo, ISO, or `null` before
   * the first successful sync. The board renders its AGE (`polled 12 s ago`),
   * which is what keeps the one cache in this server honest: the items are at
   * most one poll interval old and the number says exactly how old.
   */
  polledAt: string | null;
  /**
   * Whether this app can currently read the connected repo, and if not, why —
   * `no-token` (nothing in `BM_GITHUB_TOKEN`), `forbidden` (the token cannot
   * see this repo), `not-found` (no such repo, or the token cannot see that it
   * exists — GitHub answers 404 for both and so does this), `rate-limited`,
   * or `error` for anything else. `null` for a non-tracker project, which has
   * no connection to have a state.
   *
   * A tracker project with no token is `access: 'no-token'` and **`missing:
   * false`** — `missing` keeps its one meaning, no `backlog/` directory at
   * all, and a connected project with an unreadable credential still has its
   * store (the marker) exactly where it belongs.
   */
  access: 'ok' | 'no-token' | 'forbidden' | 'not-found' | 'rate-limited' | 'error' | null;
  /**
   * The human half of `access`: the rate limit's reset time, or the error
   * text. `null` when there is nothing to add — including when `access` is
   * `ok`.
   *
   * Note the asymmetry with `unsupported`, whose reason deliberately lives in
   * `ItemsIndex.errors` and NOT here. That reason is a per-read parse failure
   * of a file, which is what `errors` is for and where every other one of them
   * already travels; this is a LIVE CONNECTION STATE that moves on every tick
   * and belongs to the project rather than to any one read. Putting it here
   * therefore does not make `errors` a second home for anything, and putting
   * `unsupported`'s reason here would make this a second home for `errors`.
   */
  detail: string | null;
}

/**
 * `GET /api/trackers` — everything the Shared Settings page's Trackers card
 * draws (task-45, spec §5.6), and deliberately nothing else. Read-only: no
 * surface POSTs to a tracker route in this phase, and there is no connections
 * file — a project is connected by committing `backlog/source.json`, which is
 * `backlog.mjs connect`'s job and nobody else's.
 *
 * **The token is not in this payload and never will be.** It is process-only
 * (spec §11): `hasToken` says whether one is configured and `login` says who
 * it authenticates as, which is what an operator needs in order to know
 * whether the right credential is loaded. `test/tracker-items.test.ts`'s
 * `never puts the token in a payload` asserts the value appears in no response
 * of any route this module serves — `/api/items`, `/api/projects` and
 * `/api/trackers` alike.
 */
export interface TrackersPayload {
  platforms: TrackerPlatform[];
  projects: TrackerProjectRow[];
}

/** One row per platform this build can talk to — `github` alone today, the
 *  same list `SourceKind` grows with. */
export interface TrackerPlatform {
  kind: SourceKind;
  /** Whether `BM_GITHUB_TOKEN` holds anything. Never the value. */
  hasToken: boolean;
  /** Who the token authenticates as, or `null` before the first poll — the
   *  login is read once per process inside a sweep that already holds the
   *  credential, never per card render. */
  login: string | null;
  /** The hourly rate limit as the last response reported it; every field is
   *  `null` until this process has made a request. */
  limit: number | null;
  remaining: number | null;
  /** Unix seconds, as GitHub sends it — the client formats it. */
  reset: number | null;
}

/** One row per registered project: where its items come from, and — for a
 *  files project whose `origin` is on GitHub — the exact command that would
 *  connect it. */
export interface TrackerProjectRow {
  name: string;
  path: string;
  source: SourceKind | 'unsupported' | null;
  repo: string | null;
  polledAt: string | null;
  access: ProjectSummary['access'];
  detail: string | null;
  /**
   * The copyable `backlog.mjs connect github <owner>/<name>` line, or `null`
   * when there is nothing to suggest — a project that is already connected, or
   * one whose `origin` is not on GitHub. The repo is read off `origin` per
   * request, the way `uncommitted` reads git per request, and joins no memo.
   */
  connect: string | null;
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
 * 200 body of `POST /api/agents/pause` (task-17) — whether a pause request
 * is now effective for this project's run, re-derived from what was just
 * written rather than echoed back from the request. A `cancel` answers
 * `false`; so does a request the predicate refuses for any reason, which is
 * what makes this a confirmation rather than an acknowledgement.
 */
export interface PauseResult {
  pauseRequested: boolean;
}

/**
 * 200 body of `POST /api/agents/stop` (bug-39) — three fields, because
 * recording the fact and ending the run are TWO outcomes and only the first
 * one is guaranteed.
 *
 * `stopRequested` is the guaranteed half, re-derived from what landed on
 * disk exactly as `PauseResult.pauseRequested` is. Once it is `true` the
 * watchdog is already standing down and `abort` will already take the lease,
 * whatever happened to the other two fields.
 *
 * `abortSession` is the id of the `/backlog-orchestrate --abort` session the
 * route spawned, or `null` when it spawned none. `abortRefused` carries the
 * refusal's own sentence when that happened, and `null` otherwise — the two
 * are never both non-null. There is no `cancel` answer any more (bug-53): the
 * route refuses one with a 409, because a stop cannot be withdrawn. A gate
 * refusal is deliberately NOT an error status here: the request is on disk,
 * so the honest answer is a 200 that says what did and did not happen, plus
 * the one command a person can run instead.
 */
export interface StopResult {
  stopRequested: boolean;
  abortSession: string | null;
  abortRefused: string | null;
}

/**
 * The app's ONE machine-readable 409 discriminator — a `code` field alongside
 * a 409's human-readable `error` string. It means exactly one thing:
 *
 *     a run for this project is alive right now.
 *
 * **One CODE, not one occasion, and that distinction is the whole rule.**
 * This comment used to enumerate the single refusal that sent it and list
 * that endpoint's other 409s by name, and it was falsified twice — by
 * bug-19, which gave `resume()`'s fresh-run refusal the same code, and by
 * bug-21, which gave `orchestrate()` a second lock (a `starting` entry: the
 * window in which no run file exists yet but the server holds the record
 * proving a session is booting into one) and the same code again. Both
 * reuses are correct and deliberate: every one of those refusals states the
 * identical fact, reached from a different direction, and every reader of
 * the code — `OrchestrateSheet`, `RunStrip`, `RunControls` — reacts to it
 * identically. Two codes for one fact is the drift this constant exists to
 * rule out; a THIRD sender of it is not drift at all.
 *
 * So no site in this repo enumerates where it appears or counts a route's
 * 409 reasons. That tally has now gone stale in five files across two
 * branches, which is the same failure CLAUDE.md's origin-guard invariant
 * already records for its own route list. What a caller may rely on is the
 * MEANING above and nothing narrower; what a caller must never do is guess
 * from the `error` prose, which is the fragility this replaced
 * (OrchestrateSheet.tsx's own history: a message-substring match broke
 * silently the moment the wording changed).
 *
 * Deliberately still not a wider taxonomy. Every other 409 in this app —
 * dispatch's run claim, the environment and visibility refusals, the dirName
 * race, `resume()`'s own resume-spawn lock — is uncoded, because nothing
 * about them needs telling apart by a machine, and none should gain a code
 * without its own reason to exist.
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
 * What a run does with an item's open questions when nobody can answer them.
 * Run-scoped, chosen per launch, and travelling the exact route `MergeMode`
 * above travels: Settings seed → sheet picker → `POST /api/agents/orchestrate`
 * → the server-composed spawn prompt → `orchestrate.mjs init` → `run.json`.
 *
 * - `park` — today's behaviour, byte for byte. The run records the questions
 *   (`attention --kind needs-answers`), stages the item `needs-answers` and
 *   moves on to the next one.
 * - `decide` — the run answers the questions itself, writes those answers
 *   into the item body through the same write path an answered question
 *   already uses (so they ride the worktree's commit and show up in the
 *   diff), records the pairs with `orchestrate.mjs assume`, and executes the
 *   item.
 *
 * The two modes are **identical whenever `AskUserQuestion` is reachable** —
 * the ask itself is unchanged, once, best-effort, in both. The mode governs
 * only the unanswered branch, and the tool's absence is in practice the
 * "nobody is watching" signal, so this only ever takes effect in a headless
 * run. Which gives the whole feature its one-sentence doctrine: want control
 * over a question, start the run from a harness that has `AskUserQuestion`;
 * start it from the board and you are choosing between skipping the item and
 * letting the runner answer.
 *
 * The values name the outcome rather than the posture. `park` in an archived
 * run file says what happened to the item, where `manual` would need the
 * reader to already know what the run would have done instead.
 */
export type QuestionMode = 'decide' | 'park';

/**
 * Every member of `QuestionMode`, as a value — what a request body's
 * `questionMode`, the CLI's `--question-mode` flag and the Settings clamp are
 * all checked against, for the same reason `MERGE_MODES` above exists: no
 * caller restates the union by hand.
 */
export const QUESTION_MODES: readonly QuestionMode[] = ['decide', 'park'];

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
  | 'pending'
  | 'preflight'
  | 'dispatched'
  | 'inspecting'
  | 'reviewing'
  | 'fixing'
  | 'verifying'
  | 'merging'
  | 'merged'
  | 'branched'
  | 'failed'
  | 'skipped'
  | 'needs-answers'
  | 'ungroomed'
  | 'parked';

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
export const RUN_CLAIMED_STAGES: readonly RunStage[] = ['pending', 'preflight', 'dispatched', 'inspecting', 'reviewing', 'fixing', 'verifying', 'merging'];

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
 * What one dispatched headless session cost, copied out of the `result`
 * event its `--output-format stream-json` transcript ends with (task-27).
 * Written by `orchestrate.mjs usage` and by nothing else, one entry per
 * transcript — so an item that took a retry or two fix loops carries three
 * or four of these, not one summed figure. The sum belongs to whoever is
 * reading (`runUsageTotals`/`itemUsageTotals`, client/src/lib/run-stats.ts);
 * what the run file stores is the per-session evidence, because "this run
 * cost $18" and "the fix loop cost more than the item did" are different
 * questions and only the second one survives an early fold.
 *
 * It is a COPY, deliberately, of numbers that already exist in the log
 * directory. The alternative — leave them there and parse on demand — is
 * what the 2026-09-06 cross-run sweep actually had to do: 43MB of
 * transcripts for this project alone, a purpose-written script, and a
 * fitted per-token rate because the logs are pruned long before the run
 * history is. A hundred bytes on the queue item makes the archive
 * self-contained for as long as the run file itself lives.
 *
 * EVERY NUMERIC FIELD IS NULLABLE, and that is the same rule the command's
 * own "no result event writes no entry at all" refusal follows, applied one
 * level down: a `0` here would read as "measured, and it was free", which
 * is a claim no absent field justifies. A transcript from a future CLI that
 * renames `total_cost_usd` must leave a hole, not a zero.
 */
export interface RunSessionUsage {
  /**
   * The session the transcript belongs to — the `result` event's own
   * `session_id`, falling back to the transcript's `init` event, `null` when
   * neither carries one.
   *
   * Deliberately NOT this entry's identity, which is the surprise worth
   * recording here: `claude -p --resume` keeps the id it was handed, so an
   * item's `<id>.jsonl`, `<id>-retry-1.jsonl` and `<id>-fix-1.jsonl` all
   * report the SAME session (verified against this machine's own
   * `task-22`/`task-22-fix-1` pair, 2026-09-07). Identity is `kind` + `loop`
   * — the transcript slot the caller named — because that is the thing there
   * is exactly one of per session segment. The plan for this task said
   * "idempotent by sessionId"; on real transcripts that would have made a
   * fix loop's entry OVERWRITE the execute session's, which is precisely
   * what the same plan's next sentence forbids.
   */
  sessionId: string | null;
  /**
   * Which dispatch produced this transcript: the item's first session, a
   * step-5 retry, or a step-7 fix loop. Derived from the file name the
   * caller passed (`<id>.jsonl`, `<id>-retry-<n>.jsonl`,
   * `<id>-fix-<n>.jsonl`) and never guessed from the content, for the reason
   * above — the content cannot tell them apart.
   */
  kind: 'execute' | 'retry' | 'fix';
  /** The `<n>` of a `retry`/`fix` transcript; absent on an `execute` one, which has no loop to count. */
  loop?: number;
  /** `total_cost_usd`, in whatever the CLI billed — dollars, list price, as the transcript reports it. */
  costUsd: number | null;
  /** `num_turns` — assistant turns in this session segment, the cheapest proxy for "how hard was this item". */
  turns: number | null;
  /**
   * The four token counts, `usage.*` on the result event, kept SEPARATE
   * rather than summed. `cacheReadTokens` routinely runs ~90% of the total
   * (15.2M against 205k fresh on one measured session) and is billed at a
   * different rate, so a single "tokens" number would be dominated by
   * re-read context and say nothing about the work — the same reason
   * `backlog.mjs stop` excludes cache reads from `execute-tokens:`.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** `duration_ms` — wall time of the session itself, which is NOT the item's stage time (`itemDurationMs` measures that, and it includes everything around the session). */
  durationMs: number | null;
  /**
   * The model the session ran on: the single key of the result event's
   * `modelUsage`, or every key joined when a session spanned more than one.
   * `null` when the transcript carries no `modelUsage` at all. A joined
   * string rather than an array because this is a label, not a breakdown —
   * the per-model split is in the transcript for anyone who needs it.
   */
  model: string | null;
  /** When the entry was written, not when the session ended — this command runs at inspect time, minutes after. Named for what a reader will do with it (order the entries) rather than promising a precision the source cannot give. */
  endedAt: string;
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
   *
   * Written by `stage --session` and by `watch`, and — since bug-52 — filled
   * by `abort` from `<dir>/logs/<id>.jsonl` when still `null`, because a stop
   * inside the dispatch block never reaches `watch`. Never overwritten there.
   */
  sessionId: string | null;
  /**
   * The dispatched child's process id, or `null` for every item that never
   * had one recorded (bug-39).
   *
   * **Mandatory in the TYPE and absent from every run file written before
   * bug-39, and those two facts do not contradict each other.** Required is
   * what makes the compiler the fixture checklist — the same argument
   * `BacklogItem.source` carries — so a constructor that could record a pid
   * and does not goes red rather than quietly writing `undefined`. At RUN
   * TIME, absent and `null` mean the identical thing ("this FIELD holds no
   * pid") and the one reader treats them identically: `resolveItemPid`
   * guards with `Number.isInteger` before anything goes near a signal, so an
   * old run file strands nothing. Since bug-43 that is no longer the same as
   * "nothing to kill" — a `null` here falls through to `<dir>/logs/<id>.pid`,
   * which is where the address actually is for the run a force stop exists
   * to clean up. Do not add a sanitiser for it the way `base` has one:
   * `base` is substituted into commands and must have a value, this one is
   * asked `is there a pid?` and absence is a perfectly good answer.
   *
   * It exists because `abort` is the run-ending command and, until this, the
   * only thing it could end was the run FILE: a driver killed by hand leaves
   * an orphaned `claude -p` executor that nothing anywhere holds an address
   * for, since `run.driver` is `{ sessionId, at }` and a session id is not a
   * process. A stop that cannot reach that child is a force stop in name
   * only. Read by `cmdAbort` alone, and only behind three guards (the item is
   * non-terminal, `pidAlive`, and `ps` naming a `claude` process) — see that
   * function for why a bare `kill` on a recorded pid is not good enough.
   *
   * bug-43 made it the SECOND of two sources rather than the only one, for
   * the run this whole field exists for: the stop gate refuses the
   * `stage <id> dispatched --pid <p>` call that writes it, so a force stop's
   * own run reaches `abort` with `null` here and a live child. `cmdAbort`
   * resolves `<dir>/logs/<id>.pid` first and writes back here whatever it
   * actually signalled, which is the one place anything but `stage` writes
   * this field.
   */
  pid: number | null;
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
  /**
   * What this run decided on its own for this item, under
   * `questionMode: 'decide'` — the questions nobody was there to answer and
   * the answers the runner settled on. `[]` for every item that never had to
   * assume anything, which is every item of every `park` run.
   *
   * **Pairs, not bare strings**, unlike `questions` above. That field carries
   * bare strings because at the moment it is written there is no answer to
   * carry; this one exists so the archive can answer "what was asked, *and*
   * what did the runner decide", and half of that pair is useless on its own
   * — an archived question with no answer cannot be told apart from one the
   * run never got to.
   *
   * Written by `orchestrate.mjs assume` and by nothing else, appending rather
   * than replacing so a second question decided later in the same item's
   * pre-flight does not erase the first. `ArchiveQueueItem` is
   * `Omit<RunQueueItem, 'verification'> & {…}`, so this field reaches the
   * archive payload with no second declaration — which is the whole point of
   * putting it on the queue item rather than inventing a parallel structure
   * beside `attention`.
   */
  assumptions: { question: string; answer: string }[];
  /**
   * What every session dispatched for this item cost (task-27), one entry
   * per transcript, oldest first. Written by `orchestrate.mjs usage` at
   * inspect time — see `RunSessionUsage` for the shape and for why identity
   * is the transcript slot rather than the session id.
   *
   * OPTIONAL, and it is the first field on this interface that is: every run
   * file written before this task exists on disk right now and is served
   * verbatim by both archive endpoints, so the client must read a missing
   * key as "this run predates the feature" rather than as an empty run. That
   * is also why it is not `[]`-defaulted anywhere on the way through — the
   * distinction between "no sessions recorded" and "recorded nothing" is the
   * one the Runs view renders (absent usage renders nothing, never `$0.00`),
   * and a default at the seam would erase it before the view could ask.
   */
  usage?: RunSessionUsage[];
  /**
   * The claim comment this run holds the item's issue with, on a TRACKER
   * project only (task-47). Present once `stage <n> preflight` has WON the
   * claim, and absent everywhere else — every files run, and every tracker
   * item the run has not reached or lost.
   *
   * Just the comment id, and deliberately nothing else. The claim's own
   * contents live on GitHub, where every machine can read them; what this
   * machine needs locally is the one number that says WHICH comment to edit
   * next — `heartbeat` and `release` both take it, and neither can rediscover
   * it without a request. Storing a copy of the record beside it would be a
   * second source of truth for a thing the protocol says is authoritative
   * exactly once, in the comment.
   *
   * Optional for the reason `usage` above is: every run file already on disk
   * predates it, and both archive endpoints serve those verbatim.
   */
  claim?: { commentId: number };
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
  /**
   * `paused` (task-17) is the fifth member and the only one with a future:
   * the run stopped itself at an item boundary because the board asked it
   * to, and `orchestrate.mjs unpause` — the sole writer of that transition —
   * is what puts it back to `running`. It is deliberately a status rather
   * than a flag beside one: everything that already branches on "is this run
   * still going" (the watchdog, which only ever walks `running`; `init`,
   * which archives any non-`running` file; `runClaimBlock`) gets the right
   * answer for free, where a `running` run carrying a `paused: true` flag
   * would have needed each of them taught about it separately.
   */
  status: 'running' | 'done' | 'aborted' | 'failed' | 'paused';
  startedAt: string;
  /** Re-stamped on every write to the run file — the heartbeat `RUN_STALE_MS` measures against. */
  updatedAt: string;
  /**
   * When this run last came back from `paused`, written by
   * `orchestrate.mjs unpause` and by nothing else — not `heartbeat`, which
   * stays a pure `updatedAt` stamp that never touches a status or this field.
   *
   * Optional because every run file written before task-17 lacks it, and
   * because a run that was never paused never gains one; both read as "this
   * run has only ever begun once", which is exactly what `startedAt` alone
   * already says.
   *
   * Read by both copies of the pause-effectiveness predicate (the tool's
   * `pauseRequestEffective` and the server's, `pause-control.util.ts`) as the
   * later of the two clocks a request must post-date: a request that paused
   * this run is retired the instant the run resumes, so the resumed session
   * does not immediately pause itself again on the same file.
   */
  unpausedAt?: string;
  /** The `--max` the run was started with, or `null` for "work the whole gated queue". */
  maxItems: number | null;
  /**
   * The branch this run gates its queue at, cuts each item worktree from, and
   * merges each finished item into — `init --base`'s value, or `'main'` when
   * the flag was omitted. It is the run's answer to "where did this work
   * land", and after the fact nothing else can answer it: the merge commits
   * themselves are on the base, not in any file this app keeps.
   *
   * **Required, not optional**, unlike `unpausedAt` and `driver` below, and
   * that is the whole reason it is declared this way. An optional `base`
   * would make every reader — the detail sheet, the archive, any predicate
   * that ever wants to know which branch a run wrote to — re-implement
   * `?? 'main'` for itself, and the first one to forget would silently read
   * a `feature/x` run as a `main` run. That is exactly the mistake
   * `mergeModeEffective` one field below exists to prevent, so this field
   * declines to repeat it.
   *
   * A run file written before task-44 has no `base` on disk. That absence is
   * resolved to `'main'` **once**, in the server's run reader
   * (`orchestrator.service.ts`), at the point it parses the file — which is
   * what makes this required field total for every consumer above that
   * layer. The mode those older runs actually had was `main` and nothing
   * else, so the resolution is a statement of fact rather than a default
   * papering over an unknown. Nothing rewrites an archived run on disk.
   *
   * There is deliberately no `baseEffective` and no `baseNote` beside it, the
   * three-field shape `mergeMode` needs directly below. Nothing degrades a
   * base mid-run: a base that cannot be merged into parks the item, and a
   * parked item is already a recorded state with its own detail. A second
   * field here would record a divergence that cannot occur.
   */
  base: string;
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
  /**
   * What this run does with an item's open questions when nobody can answer
   * them — `init --question-mode`'s value, or `'park'` when the flag was
   * omitted. Written once by `init` and never touched again by anything.
   *
   * **One field, not three**, deliberately unlike `mergeMode` directly above.
   * That one needs `mergeModeEffective` and `mergeModeNote` because a denied
   * merge moves a run from `merge` to `branch` mid-queue and the archive has
   * to answer "did this run merge, and was that the plan?". Nothing moves
   * `questionMode`: there is no mid-run event that degrades `decide` into
   * `park` or promotes the reverse. A second field would record a divergence
   * that cannot occur, and every later reader would spend real time working
   * out which of the two to trust.
   *
   * A run file written before this field existed simply lacks it, and absent
   * means `park` — the mode whose behaviour those runs actually had. The
   * archive endpoints serve run files verbatim, so tolerating that absence is
   * a display concern in `RunDetail`, not a migration.
   */
  questionMode: QuestionMode;
  /**
   * Which session is driving this run (bug-19) — its `CLAUDE_CODE_SESSION_ID`
   * and when it took the run over — or `null` for a run nobody has claimed.
   *
   * Written by `orchestrate.mjs init` and `orchestrate.mjs claim`, read back
   * by every mutating command in that same tool, and by **nothing on this
   * side of the wire**: no server route derives anything from it and no view
   * renders it. It is declared here because the run file is a contract shared
   * with `shared/types.ts` (the tool's own key-set test asserts `init`'s
   * output against this repo's fixture), and because the archive endpoints
   * serve run files verbatim — a field the type did not know about would be
   * dropped from nothing, but would also be invisible to anyone reading this
   * declaration to find out what a run file contains.
   *
   * `--resume` is not a command, it is a prose flow carried out with the
   * ordinary ones, so `init`'s lock never sees it and two resume sessions —
   * one from this app, one from the dashboard's own session-resume, which
   * this app can neither request nor observe — could both drive one run file
   * to a merge. The lease is what makes the survivor deterministic; see
   * `orchestrate.mjs`'s own "the driver lease" comment for the mechanism, and
   * why last-writer-wins is safe for `claim` alone.
   *
   * **Optional, and absent means unclaimed rather than locked.** Every run
   * file written before this existed lacks it, and a missing field must never
   * be able to strand a run.
   *
   * `aborting` (bug-54) is present only on a lease `orchestrate.mjs abort`
   * took, and equals its `at`: it is how a second abort — one board Stop
   * reaches a live run twice, once through the driver's `watch` and once
   * through the session the server spawns — sees that another session is
   * already ending the run and refuses with exit `7`. `claim` never writes it.
   * The server reads the run file but does nothing with this field.
   */
  driver?: { sessionId: string; at: string; aborting?: string } | null;
  queue: RunQueueItem[];
  attention: RunAttention[];
}

/**
 * `GET /api/orchestrator/runs` (Task 8) — one entry per project with any run
 * history, each run annotated with what the run file alone cannot say:
 * `fresh` is the `RUN_STALE_MS` freshness check the server performs once so
 * every client doesn't re-implement it against its own clock, and
 * `pastRuns` is a count the client has no other way to obtain (it is a
 * count of the RUN FILES on the server's filesystem — `runs/*.json`, since
 * task-31 put each archived run's sidecar directory in that same listing —
 * not a field the run file carries about itself). `watchdog` (orchestrator-watchdog design, Task 2)
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
  /**
   * `pauseRequested` (task-17, design §2.3) is mandatory like `fresh` and for
   * the same reason: it is a fact the server can state about EVERY run it
   * lists, not one that only some runs have ever had. It is derived per
   * request — the control file read and the effectiveness predicate applied
   * against this very run — and never stored anywhere, because a stored copy
   * would be a second answer to a question whose inputs (the file, the run's
   * `startedAt`/`unpausedAt`) both move underneath it. Same posture as
   * "Groomed is derived" and the watchdog's `exhausted`.
   *
   * `stopRequested` (bug-39) is its sibling in every one of those respects —
   * mandatory, derived per request, stored nowhere — and is read from the
   * SAME control-file read in the same loop, which is what makes the two
   * mutually exclusive rather than merely usually so.
   *
   * **Both sides read this ONE field; neither re-derives it, and it is
   * deliberately NOT a third input to `watchdogStoodDown`.** That predicate
   * answers "will the sweeper spawn a resume", and the board renders its hand
   * Resume on the same answer being TRUE — so folding a stop into it would
   * make the board offer a Resume on precisely the runs a person just
   * stopped. A stop must suppress BOTH sides, which one boolean read verbatim
   * by two readers does and two agreeing expressions do not.
   */
  runs: Array<OrchestratorRun & { fresh: boolean; pastRuns: number; pauseRequested: boolean; stopRequested: boolean; watchdog?: RunWatchdog }>;
  /**
   * Projects this server has spawned an orchestrator session for that have
   * not yet produced a run file — the starting-run placeholder (task-14).
   * See `StartingRun` below for what one entry is and how long it lives.
   *
   * **A separate top-level array, deliberately NOT a `status: 'starting'`
   * member of `runs` above.** `OrchestratorRun` is documented (its own
   * comment) as a verbatim read of a file `orchestrate.mjs` wrote, and
   * `runs` is iterated by `aggregateRuns` (client/src/lib/run-stats.ts), by
   * `ArchiveView` and by `RunsView`. A synthetic member of that array would
   * reach every one of those consumers plus every `RunStage`/`RunStatus`
   * exhaustiveness site, and each would have to learn to skip a run that
   * has no queue, no runId and no startedAt — for a card that exists for a
   * minute or two. A separate field reaches only what opts into reading it,
   * which today is exactly one component (`RunChip`, which counts it).
   */
  starting: StartingRun[];
  /**
   * Runs on a TRACKER project that another machine drove (task-48, spec
   * §7.3) — assembled from the tracker cache's claim comments, never from a
   * file. See `RemoteRun` for one entry.
   *
   * **A separate top-level array, never members of `runs`**, the precedent
   * `starting` set one field up, and for a stronger reason than that one's.
   * `runs` means "this machine's run files, one per project", and three
   * things lean on exactly that: the `RUN_IN_PROGRESS_CODE` lock, which would
   * 409 a local Orchestrate because another machine is draining the same
   * project (spec §7.4 says two machines must NOT block each other — the
   * claims keep them disjoint); `runClaimBlock`; and the watchdog, which must
   * never try to resume a run whose driver is on another machine. Keeping
   * remote runs out of `runs` leaves all three local-only with no change.
   *
   * Required rather than optional so the compiler finds every fixture that
   * builds a payload. `OrchestratorService.runs()` fills `[]` — the service is
   * the run-state directory's reader and knows nothing about claims — and the
   * controller overwrites it, so a direct caller of the service (the agents
   * lock, `resume()`) sees none.
   */
  remote: RemoteRun[];
}

/**
 * A run derived from the claim comments one tracker repository carries
 * (task-48), for a run whose `run.json` is on some OTHER machine.
 *
 * An `OrchestratorRun` so every reader that draws a run can draw this one, plus
 * three facts the claims answer: `fresh` (the newest heartbeat in the group
 * against `RUN_STALE_MS`, as `runs` computes it from a file's `updatedAt`),
 * `remote: true` (the discriminator — a literal, so a narrowing reads it) and
 * `repo` (`owner/name`, the one thing a claim names that this machine's
 * `project` path does not).
 *
 * `project` is THIS machine's registry path for the repo, never anything the
 * claim said: a claim carries no path, and another machine's would mean
 * nothing here. `driver` is `null` and `mergeModeNote` is `null` — neither is
 * published — and `mergeMode` equals `mergeModeEffective`, because a claim
 * publishes only the effective mode (`ClaimRun.mergeMode`).
 *
 * The queue holds only the items the run has CLAIMED. An item the run has not
 * reached yet has no comment and cannot be seen from here, which the Runs page
 * says rather than hiding.
 */
export type RemoteRun = OrchestratorRun & { fresh: boolean; remote: true; repo: string };

/**
 * One "the board asked for a run and this server spawned it, but
 * `orchestrate.mjs init` has not written `run.json` yet" record (task-14).
 *
 * This exists because `GET /api/orchestrator/runs` can only see run files,
 * and the first one is written in SKILL.md §2 — so the dashboard spawning
 * `claude -p`, the session booting, the model reading a 1360-line SKILL.md
 * and the §1 `plan` turn are all invisible, 1–5 minutes of a board that
 * looks like the click did nothing. It closes the FEEDBACK gap only; boot
 * latency is unchanged and nothing here makes a run start sooner.
 *
 * Held in server memory (`StartingRunsService`), never written to disk and
 * in particular never into a run file — CLAUDE.md's single-writer invariant
 * is untouched by this feature, and this is not a cache of anything
 * `orchestrate.mjs` wrote. Consequences worth stating rather than
 * discovering: an API restart forgets every entry (the real run is
 * unaffected — this is a hint about a request this process made, not state
 * anything depends on), and an entry that never gets a matching run file
 * disappears after `RUN_STALE_MS` rather than lying forever.
 */
export interface StartingRun {
  /** The registered project's absolute path — the same string
   *  `OrchestratorRun.project` and `RegistryProject.path` carry, which is
   *  what lets eviction be a plain string compare against a real run. */
  project: string;
  /** ISO timestamp of the moment the spawn RESOLVED (not of the request):
   *  a spawn that throws never records anything, so this always names an
   *  instant at which a session really was on its way. */
  requestedAt: string;
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
/**
 * `'stopped'` (bug-39) is the eighth and is unlike the other seven in what it
 * reports: every other kind is something the sweeper did or found out about
 * ITSELF, while this one records that it declined to act because a PERSON
 * asked for this run to end. It is logged once per condition behind its own
 * per-entry flag, the same shape `'disabled'` and `'exhausted'` use and for
 * the identical reason — the event log is a ring buffer and cannot answer
 * "did I already say this".
 */
/**
 * `'stalled'` (bug-35) is the ninth: the sweeper standing down because this
 * run's resumes have been REFUSED `maxAttempts` times in a row, which is a
 * different fact from `'exhausted'` and deliberately not a reuse of it. Both
 * the Activity list and the strip render exhaustion as `exhausted after
 * ${attempts} attempts`, and the state this kind reports is reached with
 * `attempts` still at 0 — not one refusal started a session — so that sentence
 * would be false exactly when it mattered. Logged once per condition behind
 * its own flag, like the three above it.
 */
export type WatchdogEventKind = 'armed' | 'idle' | 'spawned' | 'failed' | 'exhausted' | 'recovered' | 'disabled' | 'stopped' | 'stalled';

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
 *
 * `failures`/`failing` (bug-35) are that pair's sibling over the other
 * counter: resumes REFUSED in a row since the last one that started a session,
 * and whether that count has reached the same `maxAttempts` ceiling. Derived
 * at the same single place from the same single config read, for the same
 * reason — a `POST /api/agents/watchdog/config` landing between two reads must
 * never be able to publish `failing: true` beside numbers that contradict it.
 * Both are required rather than optional: the compiler is the fixture
 * checklist here, exactly as it is for `BacklogItem.source`.
 */
export interface RunWatchdog {
  enabled: boolean;
  attempts: number;
  maxAttempts: number;
  lastSpawnAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  exhausted: boolean;
  failures: number;
  failing: boolean;
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

/* ===========================================================================
 * The write side of a tracker project (task-46, spec §6) — the claim protocol's
 * vocabulary and the eight write routes' request/response shapes.
 *
 * It sits at the END of this file, after `RUN_STALE_MS`, for one mechanical
 * reason worth stating rather than rediscovering: `CLAIM_STALE_MS` is an ALIAS
 * of that constant, and a `const` that reads another `const` declared further
 * down the module hits the temporal dead zone at import time. Everything else
 * in this block is a type, which is erased and could live anywhere; keeping the
 * vocabulary in one place beat splitting it across two sections of the file.
 * =========================================================================== */

/**
 * The four accumulating counters a files item keeps in frontmatter
 * (`groom-elapsed:`, `execute-elapsed:`, `groom-tokens:`, `execute-tokens:`),
 * carried inside a tracker item's claim comment instead.
 *
 * They live in the CLAIM rather than in the issue body because spec §6.4 is
 * explicit that counters never live in the body: the body is the item's text,
 * groom rewrites it wholesale, and a number embedded in prose somebody edits in
 * the web UI is a number that silently resets. A claim comment is machine-owned
 * — this app writes it, this app reads it — which is exactly the property
 * frontmatter has for a files item.
 *
 * Four non-negative integers, always all four present, for the same reason
 * `SectionCounts` spells out every section: the totals are read as a group, and
 * an absent key would have to be defaulted at every one of the (server, CLI,
 * mapper) sites that touch them.
 */
export interface ClaimCounters {
  groomElapsed: number;
  executeElapsed: number;
  groomTokens: number;
  executeTokens: number;
}

/**
 * The fenced JSON inside a claim comment — the one machine-readable shape
 * phases 3 and 4 share (spec §6.3).
 *
 * A COMMENT rather than a label or an assignee because a comment is the only
 * thing GitHub gives that is append-only, timestamped, editable in place, and
 * ordered by an id every machine agrees on. That last property is the whole
 * protocol: two sessions on two machines both post a claim, both list the
 * comments, and both compute the same winner — the LOWEST live comment id —
 * without a lock, a lease server, or a clock they have to agree on.
 *
 * `run` and `state` are phase 4's (§7.1). Task-46 declared both as `unknown` so
 * the phase-4 shape would not force `v: 2`, and task-47 typed `run` when the
 * server began branching on its `runId` — see each field below for why exactly
 * one of the two moved. `state` is still round-tripped untouched, which is what
 * makes a mixed-version pair of machines safe rather than merely lucky.
 */
export interface ClaimRecord {
  /** The protocol version. `1` is the only value this build writes or accepts;
   *  `parseClaim` answers `null` for anything else, which reads as "not a
   *  claim" — deliberately, so a future version's comment is ignored by an old
   *  build rather than half-understood by it. */
  v: 1;
  /** Who holds it: `CLAUDE_CODE_SESSION_ID`, or `<user>@<host>` when a session
   *  has none. Never a GitHub login — two sessions on one machine under one
   *  account are two claimants, and the login cannot tell them apart. */
  session: string;
  /**
   * WHERE the holder is — `<user>@<host>`, written by whichever CLI took the
   * claim (bug-46). Never derived server-side: this server may be running in
   * the compose stack, where `os.hostname()` is a container id rather than the
   * machine anybody is sitting at.
   *
   * Optional because every claim stored before this field existed has none,
   * and **absent means "the machine was not recorded", never "local"** — a
   * reader must not infer that a hostless claim is its own. That inference is
   * the whole bug: `session` alone names a transcript under
   * `~/.claude/projects` on exactly one host, so the one check a remote reader
   * can actually run answers "no" for every foreign claim, live or dead, and
   * the "no" gets read as proof of death.
   *
   * No `v: 2` for it: `parseClaim` accepts `v: 1` and passes unknown fields
   * through, so an old build ignores `host` and a new build reading an old
   * claim says less rather than throwing — the precedent `run` and `state`
   * set. And `session` is NOT widened to carry it: three sites compare
   * `session` raw (`stop`'s holder check, `heartbeat`'s and `release`'s author
   * tests, `claim`'s same-run takeover), so a composite value would stop
   * matching across a version gap — a new build could not release a claim an
   * old build wrote.
   */
  host?: string;
  /** Which skill phase is running, the same vocabulary `BacklogItem.phase`
   *  carries and for the same reason: it decides which pair of counters a
   *  `release` bills into. */
  phase: 'groom' | 'execute';
  /** When the claim was made — ISO 8601. Becomes `BacklogItem.started`, so it
   *  is the moment work began and it never moves, not even across a heartbeat. */
  at: string;
  /** Re-stamped by `heartbeat`. `isLive` measures THIS against
   *  `CLAIM_STALE_MS`, never `at`: a groom that has run for an hour with
   *  heartbeats is alive, and one that stopped answering four minutes in is
   *  not. */
  heartbeat: string;
  counters: ClaimCounters;
  /** Set once, by `release`, and never unset — which is what makes a claim
   *  comment a permanent record of one session's work rather than a mutable
   *  flag. `by` is the session that released it, which is NOT always the
   *  holder: a dead claim may be retired by whoever next contests the issue,
   *  with `reason: 'stale'`. */
  released?: { at: string; reason: string; by: string };
  /**
   * Which orchestrator run holds this claim (task-47, spec §7.1).
   *
   * Typed now, where task-46 reserved it as `unknown`, because the server
   * READS one field of it: `runId` is what makes a resumed driver's re-claim a
   * TAKEOVER of its own earlier claim rather than a contest with it (see
   * `GithubSource.claim`). A field the server branches on cannot stay an
   * opaque blob — parsing one at the moment a decision depends on it is how a
   * mis-shaped value becomes a wrong winner.
   *
   * Absent for a claim a SKILL made (`backlog.mjs start`), which is not a run
   * and has no run to name. That absence is load-bearing: a hand claim is
   * never same-run with anything, so it is never taken over and always has to
   * be contested or waited out.
   */
  run?: ClaimRun;
  /**
   * The item's machine state, published for other machines to read (§7.1) —
   * `ClaimState`, carried opaque HERE and typed at its one writer.
   *
   * Still `unknown` on the wire, deliberately, where `run` above became
   * typed. It is written by `orchestrate.mjs` through `heartbeat` and
   * round-tripped verbatim, and it has exactly one reader: task-48's
   * cross-machine run assembly (`server/src/orchestrator/remote-runs.util.ts`),
   * which reads it TOLERANTLY through `readClaimState` — keeping each field
   * only when it has the right shape and dropping the rest — rather than
   * trusting a type. Nothing the server decides branches on it (a remote run
   * is drawn from it, never acted on), so a claim from a newer build that
   * carries more, or a hand-edited one that carries nonsense, makes the drawn
   * run say less rather than making the read throw.
   */
  state?: unknown;
  /**
   * How the RUN ended, stamped by `orchestrate.mjs finish` on the run's
   * last-touched claim (task-48, spec §7.3) — the one fact another machine
   * needs to tell a finished run from a crashed one, since a run file it
   * cannot see is the only other place that fact lives.
   *
   * Written through the `heartbeat` route rather than an eighth one, and
   * accepted on a RELEASED claim, where it moves nothing else: by the time a
   * run finishes, its last item's terminal stage has normally released that
   * claim already. It is a fact about the run riding on one of its items'
   * comments, not a fact about the item, so it never un-releases anything.
   *
   * Absent on every claim but that one, and on every claim a run that never
   * finished left behind — which is how a derived run reads as crashed rather
   * than done (see `deriveRemoteRuns`).
   */
  finished?: ClaimFinished;
}

/**
 * `ClaimRecord.finished` — the run's closing status and when it was reached.
 * `status` is `finish --status`'s vocabulary, i.e. every `OrchestratorRun`
 * status but `running`, which is the one a finished run cannot have.
 */
export interface ClaimFinished {
  at: string;
  status: ClaimFinishedStatus;
}

export type ClaimFinishedStatus = 'done' | 'aborted' | 'failed' | 'paused';

/** The four `ClaimFinished.status` values — the route validates against this
 *  list, never a hand-written comparison chain. */
export const CLAIM_FINISHED_STATUSES: readonly ClaimFinishedStatus[] = ['done', 'aborted', 'failed', 'paused'];

/**
 * Which run a claim belongs to (task-47, spec §7.1) — the six facts about an
 * orchestrator run that ride in EVERY one of its claims, redundantly.
 *
 * Redundant on purpose. A run's items are claims on different issues, and the
 * only thing that groups them is this object; a reader that had to find "the
 * first claim of the run" to learn the run's mode would be a reader that
 * cannot start from any item it happens to have. §7.3's cross-machine
 * assembly (task-48) groups by `runId` and reads the rest off whichever claim
 * it saw — which works only while every claim carries all of it.
 *
 * `base` is this plan's addition to §7.1's list, and it is not decoration:
 * "where did this run's work land" has no other answer once the run file is on
 * a machine you are not sitting at. The merge commits are on the base branch
 * and in no file this app keeps.
 */
export interface ClaimRun {
  /** `run-YYYYMMDD-HHMMSS`, minted by `orchestrate.mjs init` — the grouping key. */
  runId: string;
  /** The run's `startedAt`, ISO 8601. */
  startedAt: string;
  /** What the run is actually doing, i.e. `mergeModeEffective` rather than what
   *  `init` was asked for: a reader on another machine wants to know whether
   *  this item will be merged, not what was hoped for before a classifier said
   *  no. */
  mergeMode: MergeMode;
  questionMode: QuestionMode;
  /** The run's `--max`, `null` for an uncapped run — the same value
   *  `OrchestratorRun.maxItems` carries, and `null` for the same reason. */
  maxItems: number | null;
  /** The ref every item of this run is cut from and merged into. */
  base: string;
}

/**
 * What `orchestrate.mjs` publishes about ONE item through the `heartbeat`
 * route's `state` field (spec §7.1) — exactly the `RunQueueItem` fields a
 * reader needs to draw the item, and nothing else.
 *
 * Its one reader is task-48's cross-machine run assembly
 * (`readClaimState` in `server/src/orchestrator/remote-runs.util.ts`), which
 * reads it tolerantly — field by field, dropping any that is mis-shaped — and
 * only ever to DRAW a remote run, never to decide anything. It is declared here rather
 * than inside the tool because the tool cannot export a type at all (a plugin
 * skill's `tools/` is plain `.mjs`), and a shape whose whole purpose is to be
 * read by a second program needs one written-down home.
 *
 * The fields are `RunQueueItem`'s, restated rather than `Pick`ed. A `Pick`
 * would look tidier and would be wrong in the one way that matters: it would
 * make this shape MOVE whenever `RunQueueItem` moves, silently, across a
 * boundary that is a published comment on somebody's issue and therefore has
 * mixed-version readers by construction. What another machine reads has to be
 * a decision, not a consequence.
 *
 * Every field is optional for the same reason: this object is composed by a
 * tool reading a run file that may predate any of them, and a reader on the
 * other side of a version gap must degrade to "says less" rather than to a
 * crash.
 */
export interface ClaimState {
  stage?: RunStage;
  stageAt?: Partial<Record<RunStage, string>>;
  worktree?: string | null;
  branch?: string | null;
  sessionId?: string | null;
  fixLoops?: number;
  verification?: RunVerification[];
  usage?: RunSessionUsage[];
  assumptions?: { question: string; answer: string }[];
  note?: string | null;
}

/**
 * The marker that makes a comment a claim. One constant, one home: a comment IS
 * a claim if and only if its body contains this string, which is why it is an
 * HTML comment — invisible in GitHub's rendered view, so the claim comment
 * reads as the human sentence under it and nothing else.
 */
export const CLAIM_MARKER = '<!-- bm:claim -->';

/**
 * How long a claim stays live without a heartbeat.
 *
 * A named ALIAS of `RUN_STALE_MS`, deliberately not a second `15 * 60 * 1000`:
 * the two answer different questions — "is the orchestrator run alive" and "is
 * the session holding this issue alive" — and today's answer is the same
 * number. The alias exists so phase 4 can give a hand-driven skill claim a
 * longer window (nothing heartbeats a hand groom automatically; see the item's
 * Decision 8) without touching run semantics, which is exactly what a shared
 * literal would have made impossible to do safely.
 */
export const CLAIM_STALE_MS = RUN_STALE_MS;

/**
 * The eight write routes' request bodies (spec §6.2, and the orchestrator:queued
 * spec §2 for the eighth). Declared here so the
 * server's validation and the CLI's expectations are checked against ONE
 * declaration rather than against each other.
 *
 * `skills/backlog/tools/backlog.mjs` cannot import them — a plugin skill's
 * `tools/` is installed as a standalone copy of what was pushed, with no build
 * step and no path back into this repo, which is the same boundary
 * `tracker/labels.ts` documents for the label list. It reads the fields by
 * name, and `backlog.test.mjs`'s API-mode suite asserts the exact bodies it
 * sends, which is the mechanical half of the same arrangement.
 *
 * Every one of them carries `project` — the registry `path` string, which the
 * server compares raw (never realpath), the same gate `uncommitted` and
 * `dispatchGate` use.
 */
export interface ItemWriteRequest {
  project: string;
}

/** `POST /api/items/create`. `section` is the store's own vocabulary, not
 *  GitHub's: the adapter turns it into the `type:*` label, and `out-of-scope`
 *  into a close with `state_reason: 'not_planned'` and no type label at all. */
export interface ItemCreateRequest extends ItemWriteRequest {
  section: Section;
  title: string;
  body: string;
  /** A refactor's flavour — `chore` or `debt`, becoming `kind:<kind>`. Any
   *  other value is a 400, never a dropped field: a caller that asked for a
   *  label this build does not know has made a mistake worth hearing about. */
  kind?: string;
  /** `true` adds the `runner-fix` label. Strictly `=== true`, the same parse
   *  rule `remoteControl` follows. */
  runnerFix?: boolean;
  /** The item this one came from — a promotion or a revive. Prepended to the
   *  body as `_From #<n>._`, which is the GitHub-native cross-link; nothing
   *  derived reads it, exactly as nothing derived read `from:` in frontmatter. */
  from?: string;
}

/** `POST /api/items/state` — the tracker spelling of `move <id> done|out-of-scope`. */
export interface ItemStateRequest extends ItemWriteRequest {
  id: string;
  status: 'done' | 'out-of-scope';
  /** Posted as a comment BEFORE the close, so the issue's timeline reads in
   *  the order the work happened. Empty means no comment at all. */
  outcome?: string;
}

/** `POST /api/items/claim` — the protocol's entry point. */
export interface ItemClaimRequest extends ItemWriteRequest {
  id: string;
  phase: 'groom' | 'execute';
  session: string;
  /**
   * The machine the claiming session is on (bug-46), written verbatim into
   * `ClaimRecord.host`. **CLI-sent, never derived here**: this server may be
   * running in the compose stack, where `os.hostname()` is a container id
   * rather than the machine anybody is sitting at.
   *
   * Absent for any caller that does not send one, which is every build older
   * than this one — validated as a non-empty string when present, the shape
   * rule `session` already follows.
   */
  host?: string;
  /**
   * The orchestrator run taking the claim (task-47), written verbatim into
   * `ClaimRecord.run`. Absent for a skill claim — `backlog.mjs start` sends no
   * `run` key at all, and that is what makes a hand claim un-takeoverable.
   *
   * Validated field by field by the route rather than taken as a blob: it is
   * the one field on the claim routes the SERVER branches on (same-run
   * takeover), so a malformed one is a 400 naming the field rather than a
   * value that silently fails to match any `runId` and contests its own run.
   */
  run?: ClaimRun;
}

/**
 * `POST /api/items/release`. `counters` are the CLI's totals, written
 * verbatim: the CLI is the biller (it holds the transcript and the clock), and
 * the server never computes a counter of its own.
 *
 * `runId` (bug-42) is the run ASSERTING it owns this claim — the SECOND clause
 * of "the holder always, the RUN that owns the claim, the HOST that holds the
 * claim once it can show the session is gone, ANYONE once the claim is dead"
 * (the third is bug-48's `host`, directly below). Nothing writes it into the
 * record; one line in `GithubSource.release`
 * compares it against the claim's stored `run.runId`, which is how a
 * `/backlog-orchestrate --abort` spawned by `POST /api/agents/stop` releases
 * claims its own run took while the driver that posted them is dead.
 *
 * Deliberately a bare `runId` rather than the whole `ClaimRun` that `claim`
 * takes: `claim` STORES the object, `release` only asks a question about one
 * already stored, and a second validated blob would be a second place
 * `ClaimRun`'s shape has to be kept true.
 */
export interface ItemReleaseRequest extends ItemWriteRequest {
  id: string;
  commentId: number;
  session: string;
  reason: string;
  counters?: ClaimCounters;
  runId?: string;
  /**
   * The machine the RELEASING caller is on (bug-48) — the fourth clause of the
   * release rule: **the holder always, the RUN that owns the claim, the HOST
   * that holds the claim once it can show the session is gone, ANYONE once the
   * claim is dead.**
   *
   * A hand-run session killed mid-item passes through no terminal stage, so it
   * releases nothing, and every clause of the old triple then answers about
   * somebody who no longer exists: the holder is gone, a hand claim carries no
   * `run` by construction (so a run can never evict a person at a terminal),
   * and `isLive` is true because `heartbeat` was re-stamped seconds before the
   * kill. The item reads as in progress on every machine for a full
   * `CLAIM_STALE_MS` with no command anywhere to clear it.
   *
   * Same shape and same validation as `runId` — a 400 on a present non-string,
   * and `typeof`/`length` guards at the comparison so a request with no `host`
   * against a claim with no `host` never compares `undefined === undefined`
   * into a match. **A claim with no `host` is never same-host with anything**,
   * the sentence `run` already carries, for the reason `ClaimRecord.host`
   * gives: absence means "the machine was not recorded", never "this one".
   *
   * **The PROOF that the holder is gone is the CLI's, not this server's.** The
   * server can see neither the caller's filesystem nor its process table, so
   * its clause is `sameHost` alone; `backlog.mjs abort` runs the liveness check
   * where the evidence is — Claude Code's process registry under
   * `<configDir>/sessions/` and the process table it names (bug-49) — exactly
   * as billing lives on the CLI side because that is where the clock and the
   * transcript are. That is a MISTAKE boundary
   * rather than a security one: `stop` has always let a caller send any
   * `session` it likes, and the holder's id is printed in the refusal.
   */
  host?: string;
}

/** `POST /api/items/heartbeat`. `state` is the `ClaimState` task-47's driver
 *  publishes, carried opaque here and round-tripped into the record when
 *  given — its only reader is the remote-run assembly, which reads it
 *  tolerantly. `finished` (task-48) is `finish`'s stamp, validated field by
 *  field by the route and accepted on a released claim too — see
 *  `ClaimRecord.finished`. */
export interface ItemHeartbeatRequest extends ItemWriteRequest {
  id: string;
  commentId: number;
  /**
   * Who is beating (bug-45). Required, exactly as `release`'s is: a heartbeat
   * is an assertion that the CALLER still holds the claim, and a route that
   * took nobody's name could neither refuse a stranger nor answer the question
   * "is this claim mine?" — which is what a session on the losing side of a
   * race asked it, got a 201 for, and went on to groom an issue another
   * machine was already executing.
   */
  session: string;
  /** The same optional assertion `release` takes — "this is my run's claim" —
   *  and the reason a RESUMED driver, which has a new session id and the same
   *  `runId`, keeps heartbeating the items its run already holds (task-47
   *  §7.6). A bare `runId` rather than the whole `ClaimRun`, for the reason
   *  `ItemReleaseRequest` states. */
  runId?: string;
  state?: unknown;
  finished?: ClaimFinished;
}

/**
 * `POST /api/items/body` — groom's route, and the ONE route that rewrites an
 * issue body (§6.4). `ifUpdatedAt` is the optimistic-concurrency token: the
 * `updated_at` the caller read, checked against a FRESH `GET` before the patch,
 * so two grooms on two machines cannot silently overwrite each other.
 */
export interface ItemBodyRequest extends ItemWriteRequest {
  id: string;
  body: string;
  ifUpdatedAt: string;
  /**
   * The `runner-fix` label, moved by the same call that rewrote the body
   * (task-47) — `true` adds it, `false` removes it, ABSENT leaves it exactly
   * as it is.
   *
   * Three states rather than two, and the third is the important one: a groom
   * that has an opinion says so, and every other body patch — a re-groom, a
   * plan rewrite, `import`'s second pass — must not silently clear a marker
   * somebody set deliberately. The files half of this is a frontmatter line
   * that survives every edit that does not name it, which is the behaviour
   * `undefined` reproduces here.
   *
   * It rides `body` rather than getting a route of its own because the
   * judgement is the groom's and the groom makes exactly one write: a
   * separate call would be a second request that can fail on its own, leaving
   * a body that says "this repairs the runner" on an issue that is not
   * labelled as one.
   */
  runnerFix?: boolean;
}

/** `POST /api/items/comment` — appends a comment and nothing else. Execute's
 *  failure path uses it: the Outcome is recorded and the item does not move. */
export interface ItemCommentRequest extends ItemWriteRequest {
  id: string;
  body: string;
}

/**
 * `POST /api/items/queue` — the eighth write route (the orchestrator:queued
 * spec, §2). `true` adds `orchestrator:queued`, `false` removes it, and there
 * is no third state: every caller is either a run's `init` saying "I intend to
 * work this" or a sweep saying "I no longer do", and both have an opinion.
 *
 * The label is advisory. Nothing that decides who works an item reads it —
 * the claim is the lock — so this route writes a plan, never a reservation.
 */
export interface ItemQueueRequest extends ItemWriteRequest {
  id: string;
  queued: boolean;
}

/** What `claim`, `release` and `heartbeat` answer on success: the comment that
 *  IS the claim, and the record now inside it. */
export interface ClaimResult {
  commentId: number;
  record: ClaimRecord;
}

/**
 * What `claim` answers with a 409, and what `release` answers when the claim it
 * names is live and held by someone else. `ageMs` is the heartbeat's age at the
 * moment of refusal — computed here rather than left to the caller, because the
 * caller's clock is not the one the liveness decision was made on.
 */
export interface ClaimRefused {
  error: string;
  holder: {
    session: string;
    /** Where the holder is, when the claim recorded it (bug-46). Absent means
     *  the claim was written before this field existed — never that the holder
     *  is on the reader's own machine. */
    host?: string;
    heartbeat: string;
    ageMs: number;
    commentId: number;
  };
}
