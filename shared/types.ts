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
   * YYYY-MM-DD the item was picked up (`backlog.mjs start`), '' when nobody
   * has. Surfaced verbatim, never interpreted here: an archived item keeps the
   * date it was started as history, so "is this in progress" is `started !== ''`
   * AND `status === 'open'` — a question the client answers, since it is the
   * only side that renders it.
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
