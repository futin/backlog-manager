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

/** The four store sections. Directory names, verbatim — these strings are the
 *  contract with backlog.mjs's SECTIONS map, not display labels. */
export type Section = 'bugs' | 'ideas' | 'tasks' | 'out-of-scope';

/** An item's status IS the directory it lives in (open/ vs done/), never a
 *  frontmatter field — backlog.mjs rejects a status: key outright. out-of-scope
 *  is flat and terminal. In progress is deliberately NOT a member here: it is a
 *  marker on an open item (see BacklogItem.started), not a fourth place a file
 *  can live. */
export type ItemStatus = 'open' | 'done' | 'terminal';

export interface BacklogItem {
  id: string;
  title: string;
  /** YYYY-MM-DD from frontmatter; '' when the file lacks one (still renderable) */
  created: string;
  /**
   * When the item was picked up (`backlog.mjs start`), '' when nobody has.
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
   * one, so this is effectively always true). ideas / out-of-scope: null —
   * groomed is not a state they have.
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
  action: 'groom' | 'execute';
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
  action: 'groom' | 'execute';
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
