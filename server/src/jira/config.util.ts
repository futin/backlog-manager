import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { defaultBaseProblem, patternProblem } from '../../../shared/jira-branch';
import {
  DEFAULT_JIRA_INTERVAL,
  SYNC_INTERVALS,
  isJiraKey,
  isSyncInterval,
  type JiraBoard,
  type JiraQuery,
  type JiraRepoDefaults,
  type JiraRepoDefaultsWriteResult,
  type JiraSkill,
  type SyncInterval
} from '../../../shared/types';

/**
 * config.util.ts — ~/.backlog-manager/settings/jira.json: the readers (spec §2, phase 1) and the writers (spec §5, phase 2).
 *
 * This is the fourth file the server writes, after `watchdog.json`, the pause-control files and `tracker-sync.json`, and the writers sit on
 * `writeSyncInterval`'s contract: read the RAW parsed file, change exactly ONE entry (a board by id, one project's repo list by key), keep everything else —
 * malformed entries and unknown top-level keys included, because the file is hand-edited and a writer that re-serialised only what it understood would
 * delete the rest — and write `JSON.stringify(next, null, 2) + '\n'` to a temp file beside it and `rename` it over, so a reader never sees half a file.
 * A file that exists and cannot be read or parsed is REPORTED by the reader (`unreadable`, which becomes `configUnreadable` on the status payload) and
 * REFUSED by every writer (`JiraConfigUnreadableError`, a 409 at the route), never replaced: rewriting it from `{}` would turn one stray comma, or a file
 * truncated by a full disk, into a file holding only the entry being written — every board, saved query and repo path gone, with nothing on disk left to
 * recover them from (#270 is the same failure in `tracker-sync.json`). The Board page can then say `jira.json cannot be read` rather than the false, and
 * later destructive, `No boards yet`. A parsed NON-object (`[1, 2]`, `null`, a bare string) has nothing in it to preserve and is replaced; a MISSING file is
 * written fresh.
 *
 * It restates `sync-config.util.ts`'s argument for a per-ENTRY fallback. The file holds hand-edited, user-authored data — boards, saved JQL, repo paths, skill
 * prompts — and one stray value must cost only its own entry, never its neighbours: a board with a mistyped id is not a reason to lose the next board, and a
 * `boards` key that is not an array is not a reason to lose `repos`. Spec §2 draws the line at the ENTRY (a board, a skill, one project's list). This reader
 * goes one level finer, by design and recorded here as the deviation it is: a bad ROOT costs the root and a bad QUERY costs the query, not the board they sit
 * in, because a board that loses its whole contents over one lower-case key is the more surprising failure of the two.
 *
 * Read fresh on every call and cached nowhere — the file is edited by hand and by the writers, and a cache would be a second copy that disagrees with
 * the disk for as long as it lives. A parsed non-object folds into "nothing" and is NOT unreadable, exactly as `sync-config.util.ts`'s `readRaw` does, so this
 * reader and the writers (which replace a parsed non-object, as `writeSyncInterval` does) agree on what such a file means. A MISSING file is also nothing, not
 * unreadable: a fresh install has no `jira.json` and has done nothing wrong.
 *
 * One validating function per entry kind (`readBoard`, `readQuery`, `readRepos`, `readSkill`); the write-side parsers (`parseBoardWrite`, `parseReposWrite`)
 * validate with the same helpers (`isJiraKey`, `isSyncInterval`, `JIRA_PROJECT_KEY_RE`, `JIRA_JQL_MAX_CHARS`) and add spec §5's stricter WRITE-time rules
 * (lengths, counts) on top — the reader accepts whatever is well-formed, because refusing a long-but-valid entry on read would make a hand-edit that the
 * writers would also have accepted vanish from the board. Each dropped entry is warned about once, naming the file and the entry's index or id, so a vanished
 * entry leaves a trace in the server log.
 */

/** The file, or `BM_JIRA_FILE` when set — `syncConfigFile()`'s shape, `env` a parameter for the same reason. */
export function jiraConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_JIRA_FILE || join(homedir(), '.backlog-manager', 'settings', 'jira.json');
}

/** An id this server mints: a one-letter kind (`b`oard, `q`uery, `s`kill), an underscore and eight lower-case hex digits. */
export const JIRA_ID_RE = /^(b|q|s)_[0-9a-f]{8}$/;

/**
 * Whether `value` is an id of exactly this kind. The prefix is checked against `kind`, not merely against the three that exist: a route that validates a
 * board id with the bare `JIRA_ID_RE` would accept a query's or a skill's id, and the lookup that follows would then miss it for the wrong reason.
 */
export function isJiraId(kind: 'b' | 'q' | 's', value: unknown): value is string {
  return typeof value === 'string' && JIRA_ID_RE.test(value) && value.startsWith(`${kind}_`);
}

/** A Jira project key, the part of an issue key before the dash: upper-case, two characters or more, letters, digits and `_`. */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/;

/**
 * The longest JQL this server takes from a person, in characters. The ONE home of this number: `GET /api/jira/jql/check` (phase 1, the board sheet's check
 * line) is its first consumer and phase 2's save route will be the second, so the cap cannot be spelled two ways. The jira.json READER does not enforce
 * it (see the header): a file that already holds a longer query still loads, and the rule is applied where a person's text ENTERS the server, not where
 * it is read back.
 */
export const JIRA_JQL_MAX_CHARS = 2000;

/**
 * R3: the longest `transitionId` a route will pass on. Jira's ids are short integers; this bounds a paste accident, not a format. Here rather than in
 * `jira-write.controller.ts`, its first consumer, because `POST /api/agents/dispatch-jira` checks the same field and a service never imports a controller.
 */
export const JIRA_TRANSITION_ID_MAX_CHARS = 64;

export interface JiraConfig {
  boards: JiraBoard[];
  /** Project key → absolute repository paths, in file order, deduplicated. */
  repos: Record<string, string[]>;
  /** Normalised repo path → its default base and name pattern, each already past Table A / Table E; a path with neither is absent. */
  repoDefaults: Record<string, JiraRepoDefaults>;
  skills: JiraSkill[];
  /** `null`, or why the file exists but could not be read or parsed — in which case every other field is empty and nothing may replace the file. */
  unreadable: string | null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function drop(file: string, what: string, why: string): null {
  console.warn(`${file}: ${what} dropped — ${why}`);
  return null;
}

/** One saved query, or `null` (warned) when its id is not a `q_` id or its label or JQL is empty or not a string. `where` names the entry for the warning. */
export function readQuery(value: unknown, file: string, where: string): JiraQuery | null {
  if (!isRecord(value)) return drop(file, where, 'not an object');
  if (!isJiraId('q', value.id)) return drop(file, where, 'its id is not a q_ id');
  if (!nonEmptyString(value.label)) return drop(file, where, 'its label is empty');
  if (!nonEmptyString(value.jql)) return drop(file, where, 'its jql is empty');
  return { id: value.id, label: value.label, jql: value.jql };
}

/**
 * One board, or `null` (warned) when it is not an object, its id is not a `b_` id or its name is empty. Everything inside a valid board degrades alone: roots
 * that are not issue keys and queries that fail `readQuery` are dropped one by one, a `roots` or `queries` that is not an array reads as none, and an
 * interval that is missing or not one of the four tokens reads as `DEFAULT_JIRA_INTERVAL`.
 */
export function readBoard(value: unknown, file: string, where: string): JiraBoard | null {
  if (!isRecord(value)) return drop(file, where, 'not an object');
  if (!isJiraId('b', value.id)) return drop(file, where, 'its id is not a b_ id');
  if (!nonEmptyString(value.name)) return drop(file, where, 'its name is empty');
  const roots: string[] = [];
  if (Array.isArray(value.roots)) {
    value.roots.forEach((root, i) => {
      if (isJiraKey(root)) roots.push(root);
      else drop(file, `${where} root #${i}`, 'not an issue key');
    });
  }
  const queries: JiraQuery[] = [];
  if (Array.isArray(value.queries)) {
    value.queries.forEach((query, i) => {
      const read = readQuery(query, file, `${where} query #${i}`);
      if (read !== null) queries.push(read);
    });
  }
  return {
    id: value.id,
    name: value.name,
    roots,
    queries,
    interval: isSyncInterval(value.interval) ? value.interval : DEFAULT_JIRA_INTERVAL
  };
}

/**
 * The repository map, whole: project key → absolute paths. A key that fails `JIRA_PROJECT_KEY_RE`, a value that is not an array, a path that is not a non-empty
 * string and a list that ends empty each cost only themselves; paths dedup in file order. A `repos` that is not an object (an array included) reads as `{}`.
 * `__proto__` is skipped by name — `JSON.parse` makes it an own key, and assigning it would set the result's prototype instead of adding an entry — though the
 * key regex would refuse it anyway; the explicit skip keeps that safety from resting on a regex someone may later loosen.
 */
export function readRepos(value: unknown, file: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(value)) return out;
  for (const [key, list] of Object.entries(value)) {
    if (key === '__proto__') continue;
    if (!JIRA_PROJECT_KEY_RE.test(key)) {
      drop(file, `repos entry "${key}"`, 'not a project key');
      continue;
    }
    if (!Array.isArray(list)) {
      drop(file, `repos entry "${key}"`, 'not an array of paths');
      continue;
    }
    const paths: string[] = [];
    for (const path of list) {
      if (!nonEmptyString(path)) drop(file, `repos entry "${key}" path`, 'not a non-empty string');
      else if (!paths.includes(path)) paths.push(path);
    }
    if (paths.length === 0) drop(file, `repos entry "${key}"`, 'no usable path');
    else out[key] = paths;
  }
  return out;
}

/**
 * The per-path defaults (spec §5.1), whole: absolute normalised path → `{ base?, namePattern? }`. The fallback is per VALUE, one level finer than the entry: a
 * key that is not an absolute, already-normalised path (`normaliseRepoPath` with no home returns it unchanged — a `~` key would expand to something else and a
 * relative one is refused) costs the entry; a value that is not a string or fails the same check the write route applies — `defaultBaseProblem` for the base,
 * `patternProblem` for the pattern — costs only itself, so a hand-edited bad pattern leaves that path's good base working; an entry left with neither is
 * dropped. Each drop is warned once. A `repoDefaults` that is not an object reads as `{}`. `__proto__` is skipped by name, as `readRepos` does, though the
 * absolute-path test would refuse it anyway.
 */
export function readRepoDefaults(value: unknown, file: string): Record<string, JiraRepoDefaults> {
  const out: Record<string, JiraRepoDefaults> = {};
  if (!isRecord(value)) return out;
  for (const [path, entry] of Object.entries(value)) {
    if (path === '__proto__') continue;
    const what = `repoDefaults entry "${path}"`;
    if (!path.startsWith('/') || normaliseRepoPath(path, '') !== path) {
      drop(file, what, 'not an absolute normalised path');
      continue;
    }
    if (!isRecord(entry)) {
      drop(file, what, 'not an object');
      continue;
    }
    const defaults: JiraRepoDefaults = {};
    if (entry.base !== undefined) {
      const problem = typeof entry.base !== 'string' ? 'is not a string' : defaultBaseProblem(entry.base);
      if (problem === null) defaults.base = entry.base as string;
      else drop(file, `${what} base`, problem);
    }
    if (entry.namePattern !== undefined) {
      const problem = typeof entry.namePattern !== 'string' ? 'is not a string' : patternProblem(entry.namePattern);
      if (problem === null) defaults.namePattern = entry.namePattern as string;
      else drop(file, `${what} namePattern`, problem);
    }
    if (defaults.base === undefined && defaults.namePattern === undefined) drop(file, what, 'no usable value');
    else out[path] = defaults;
  }
  return out;
}

/** One skill, or `null` (warned) when its id is not an `s_` id or its name or prompt is empty or not a string. */
export function readSkill(value: unknown, file: string, where: string): JiraSkill | null {
  if (!isRecord(value)) return drop(file, where, 'not an object');
  if (!isJiraId('s', value.id)) return drop(file, where, 'its id is not an s_ id');
  if (!nonEmptyString(value.name)) return drop(file, where, 'its name is empty');
  if (!nonEmptyString(value.prompt)) return drop(file, where, 'its prompt is empty');
  return { id: value.id, name: value.name, prompt: value.prompt };
}

function readList<T>(raw: unknown, file: string, kind: string, read: (value: unknown, file: string, where: string) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  raw.forEach((entry, i) => {
    const item = read(entry, file, `${kind} #${i}`);
    if (item !== null) out.push(item);
  });
  return out;
}

export function readJiraConfig(file: string = jiraConfigFile()): JiraConfig {
  const empty = { boards: [], repos: {}, repoDefaults: {}, skills: [] };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...empty, unreadable: null };
    console.warn(`${file}: cannot be read (${(e as Error).message})`);
    return { ...empty, unreadable: 'cannot be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`${file}: exists but does not parse as JSON`);
    return { ...empty, unreadable: 'does not parse as JSON' };
  }
  if (!isRecord(raw)) {
    console.warn(`${file}: parsed but is not an object — read as empty`);
    return { ...empty, unreadable: null };
  }
  return {
    boards: readList(raw.boards, file, 'board', readBoard),
    repos: readRepos(raw.repos, file),
    repoDefaults: readRepoDefaults(raw.repoDefaults, file),
    skills: readList(raw.skills, file, 'skill', readSkill),
    unreadable: null
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Writers (phase 2). Called by the six config POST routes under `/api/jira` (boards, boards/delete, repos, repo-defaults, skills, skills/delete) and nothing
// else.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Thrown by every writer when `jira.json` EXISTS but cannot be read as JSON (or cannot be read at all, for any reason other than not existing), and mapped to a
 * 409 by the routes. A class rather than a bare `Error` so a route can tell this refusal — a state of the file the user has to repair by hand — from an I/O
 * failure in the write itself, which stays a 500. `SyncConfigUnreadableError`'s twin.
 */
export class JiraConfigUnreadableError extends Error {
  constructor(
    readonly file: string,
    reason: string
  ) {
    super(`settings/jira.json ${reason} — fix or delete it by hand; nothing was written`);
    this.name = 'JiraConfigUnreadableError';
  }
}

/**
 * Thrown by `writeBoard` (an update), `deleteBoard`, `writeSkill` (an update) and `deleteSkill` when the file holds no entry of that kind with the id; the
 * routes map it to a 404, and nothing was written. It carries the entry `kind` it was thrown for, so one `writing()` can answer `unknown board` or
 * `unknown skill` — the sentence names what the caller asked about, and an id of the other kind is simply an id this kind does not hold.
 */
export class JiraUnknownIdError extends Error {
  constructor(
    readonly id: string,
    readonly kind: 'board' | 'skill' = 'board'
  ) {
    super(`no ${kind} with id ${id}`);
    this.name = 'JiraUnknownIdError';
  }
}

/** Spec §5's write-time bounds. The reader enforces none of them (see the header). */
const JIRA_NAME_MAX_CHARS = 80;
const JIRA_SKILL_NAME_MAX_CHARS = 60;
const JIRA_SKILL_PROMPT_MAX_CHARS = 2000;
const JIRA_ROOTS_MAX = 20;
const JIRA_QUERIES_MAX = 10;
const JIRA_REPO_PATHS_MAX = 10;

/** What `POST /api/jira/boards` validated: `id` is `null` for a create and whatever string the client sent for an update; a query's `id` likewise. */
export interface JiraBoardWrite {
  id: string | null;
  name: string;
  roots: string[];
  queries: { id: string | null; label: string; jql: string }[];
  interval: SyncInterval;
}

/** What `POST /api/jira/skills` validated: `id` is absent for a create and whatever string the client sent for an update. */
export interface JiraSkillWrite {
  id?: string;
  name: string;
  prompt: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function trimmedLengthWithin(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= max;
}

/**
 * Validate a `POST /api/jira/boards` body (spec §5) and return it trimmed. The error names the offending field, because the route returns it as the 400's
 * `error` and the board sheet puts the sentence under the field. Whether an `id` EXISTS is not asked here — `writeBoard` knows the file; a malformed id on an
 * update is the 404 the route gives, and only a value that is not a string or `null` is a 400 here.
 */
export function parseBoardWrite(body: unknown): Parsed<JiraBoardWrite> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  let id: string | null = null;
  if (typeof body.id === 'string') id = body.id;
  else if (body.id !== undefined && body.id !== null) return { ok: false, error: 'id must be a string or null' };
  if (!trimmedLengthWithin(body.name, JIRA_NAME_MAX_CHARS)) return { ok: false, error: `name must be 1–${JIRA_NAME_MAX_CHARS} characters` };
  if (!isSyncInterval(body.interval)) return { ok: false, error: `interval must be one of ${Object.keys(SYNC_INTERVALS).join(', ')}` };
  const rawRoots = body.roots === undefined ? [] : body.roots;
  if (!Array.isArray(rawRoots)) return { ok: false, error: 'roots must be an array of issue keys' };
  const roots: string[] = [];
  for (const root of rawRoots) {
    const key = typeof root === 'string' ? root.trim() : root;
    if (!isJiraKey(key)) return { ok: false, error: `roots must hold issue keys like PAY-1: ${JSON.stringify(root)}` };
    if (!roots.includes(key)) roots.push(key);
  }
  if (roots.length > JIRA_ROOTS_MAX) return { ok: false, error: `roots holds at most ${JIRA_ROOTS_MAX} issue keys` };
  const rawQueries = body.queries === undefined ? [] : body.queries;
  if (!Array.isArray(rawQueries)) return { ok: false, error: 'queries must be an array' };
  if (rawQueries.length > JIRA_QUERIES_MAX) return { ok: false, error: `queries holds at most ${JIRA_QUERIES_MAX} queries` };
  const queries: JiraBoardWrite['queries'] = [];
  for (const [i, q] of rawQueries.entries()) {
    if (!isRecord(q)) return { ok: false, error: `queries[${i}] must be an object` };
    if (!trimmedLengthWithin(q.label, JIRA_NAME_MAX_CHARS)) return { ok: false, error: `queries[${i}].label must be 1–${JIRA_NAME_MAX_CHARS} characters` };
    if (!trimmedLengthWithin(q.jql, JIRA_JQL_MAX_CHARS)) return { ok: false, error: `queries[${i}].jql must be 1–${JIRA_JQL_MAX_CHARS} characters` };
    // A query id that is not a string is no id at all (an id only matters when the stored board holds it), so it reads as `null`, not as a 400.
    queries.push({ id: typeof q.id === 'string' ? q.id : null, label: q.label.trim(), jql: q.jql.trim() });
  }
  if (roots.length === 0 && queries.length === 0) return { ok: false, error: 'a board needs at least one of roots or queries' };
  return { ok: true, value: { id, name: body.name.trim(), roots, queries, interval: body.interval } };
}

/**
 * Validate a `POST /api/jira/skills` body (spec §5) and return it trimmed: `name` of 1–60 and `prompt` of 1–2 000 characters, measured after trimming, so a
 * paste with a trailing newline is not charged for it and an all-blank one is empty. The error names the field, as `parseBoardWrite`'s does. As there, whether
 * an `id` EXISTS is `writeSkill`'s question; only a value that is neither a string nor absent/`null` is a 400 here. A `null` id reads as no id, the create.
 */
export function parseSkillWrite(body: unknown): Parsed<JiraSkillWrite> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  let id: string | undefined;
  if (typeof body.id === 'string') id = body.id;
  else if (body.id !== undefined && body.id !== null) return { ok: false, error: 'id must be a string or null' };
  if (!trimmedLengthWithin(body.name, JIRA_SKILL_NAME_MAX_CHARS)) return { ok: false, error: `name must be 1–${JIRA_SKILL_NAME_MAX_CHARS} characters` };
  if (!trimmedLengthWithin(body.prompt, JIRA_SKILL_PROMPT_MAX_CHARS)) {
    return { ok: false, error: `prompt must be 1–${JIRA_SKILL_PROMPT_MAX_CHARS} characters` };
  }
  const value: JiraSkillWrite = { name: body.name.trim(), prompt: body.prompt.trim() };
  if (id !== undefined) value.id = id;
  return { ok: true, value };
}

/**
 * One spelling per path, or `null` when `raw` has none. The dashboard compares repository paths as raw strings, so the server stores exactly one
 * spelling: `~` and a leading `~/` expand to `home`, `~user/…` is refused, the result must be absolute with no empty, `.` or `..` segment, and one trailing
 * `/` is dropped (`/` alone stays `/`).
 */
export function normaliseRepoPath(raw: string, home: string): string | null {
  let path = raw.trim();
  if (path === '~' || path.startsWith('~/')) path = home + path.slice(1);
  else if (path.startsWith('~')) return null;
  if (!path.startsWith('/')) return null;
  // `/` alone is the root and is kept; it is checked BEFORE the trailing slash is dropped, because `//` would otherwise shrink to `/` and pass for it
  // without ever reaching the empty-segment check below.
  if (path === '/') return path;
  if (path.endsWith('/')) path = path.slice(0, -1);
  return path
    .slice(1)
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..')
    ? null
    : path;
}

/** Validate a `POST /api/jira/repos` body: a project key and at most ten paths, normalised and deduplicated AFTER normalisation. `[]` is valid — it removes the key. */
export function parseReposWrite(body: unknown, home: string): Parsed<{ project: string; paths: string[] }> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  if (typeof body.project !== 'string' || !JIRA_PROJECT_KEY_RE.test(body.project)) return { ok: false, error: 'project must be a Jira project key like PAY' };
  if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string')) return { ok: false, error: 'paths must be an array of strings' };
  const paths: string[] = [];
  for (const raw of body.paths as string[]) {
    const path = normaliseRepoPath(raw, home);
    if (path === null) return { ok: false, error: `path must be absolute and normalised: ${raw}` };
    if (!paths.includes(path)) paths.push(path);
  }
  if (paths.length > JIRA_REPO_PATHS_MAX) return { ok: false, error: `paths holds at most ${JIRA_REPO_PATHS_MAX} paths per project` };
  return { ok: true, value: { project: body.project, paths } };
}

/**
 * Validate a `POST /api/jira/repo-defaults` body: `{ path, base, namePattern }`, where `null` is "unset". The path is normalised as `parseReposWrite` does; the
 * 400 sentences are the field's name and the shared rule's own wording (`base <Table A problem>`, `namePattern <Table E problem>`), so the Setup row can put
 * them under the field. A missing value is refused like a wrong one (`base must be a string or null`): the body replaces the path's whole entry, and a client
 * that left a field out has not said whether to keep or clear it. Nothing is trimmed — Table A refuses a space, so a padded value is a refusal, not a silent
 * fix. Whether the path is MAPPED, and whether the base exists, are not decided here: the first needs the file (the route reads it), the second is deliberately
 * never checked (spec §5.1 — the branch may exist only on `origin`).
 *
 * A base is Table A plus one rule of its own (`defaultBaseProblem`, final review M1): `base is a branch name, without origin/`. The tool adds `origin/`
 * itself, so a stored prefix made every Start exit 4.
 */
export function parseRepoDefaultsWrite(body: unknown, home: string): Parsed<JiraRepoDefaultsWriteResult> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  if (typeof body.path !== 'string' || body.path.trim() === '') return { ok: false, error: 'path is required' };
  const path = normaliseRepoPath(body.path, home);
  if (path === null) return { ok: false, error: `path must be absolute and normalised: ${body.path}` };
  if (body.base !== null && typeof body.base !== 'string') return { ok: false, error: 'base must be a string or null' };
  if (body.namePattern !== null && typeof body.namePattern !== 'string') return { ok: false, error: 'namePattern must be a string or null' };
  if (body.base !== null) {
    const problem = defaultBaseProblem(body.base);
    if (problem !== null) return { ok: false, error: `base ${problem}` };
  }
  if (body.namePattern !== null) {
    const problem = patternProblem(body.namePattern);
    if (problem !== null) return { ok: false, error: `namePattern ${problem}` };
  }
  return { ok: true, value: { path, base: body.base, namePattern: body.namePattern } };
}

/** A fresh id of one kind: the prefix and eight lower-case hex digits from four random bytes. Uniqueness within a file is `mintUnique`'s job. */
export function mintJiraId(kind: 'b' | 'q' | 's'): string {
  return `${kind}_${randomBytes(4).toString('hex')}`;
}

function mintUnique(kind: 'b' | 'q' | 's', taken: Set<string>): string {
  let id = mintJiraId(kind);
  while (taken.has(id)) id = mintJiraId(kind);
  taken.add(id);
  return id;
}

/**
 * The raw parsed file for a writer, as an object it may spread from. A missing file is `{}`; a parsed non-object is `{}` too (nothing in it to keep); a file
 * that does not parse, or cannot be read for any reason but ENOENT, throws `JiraConfigUnreadableError` — we cannot know what is in a file we could not read, so
 * we must not replace it. See the header.
 */
function readRawForWrite(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn(`${file}: cannot be read (${(e as Error).message}) — refusing to overwrite it`);
    throw new JiraConfigUnreadableError(file, 'cannot be read');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(`${file}: exists but does not parse as JSON — refusing to overwrite it, so nothing in it is lost`);
    throw new JiraConfigUnreadableError(file, 'does not parse as JSON');
  }
  return isRecord(raw) ? raw : {};
}

/** Temp file in the same directory (same filesystem, so `rename` is atomic), then rename over the target; the temp file does not outlive a failed write. */
function writeRawAtomic(file: string, next: Record<string, unknown>): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.jira.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up: the failure was before the temp file existed
    }
    throw e;
  }
}

/** Every id the file already holds — boards, their queries and skills, malformed entries' ids included — so a minted id can never collide with one. */
function idsIn(current: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const take = (entry: unknown): void => {
    if (isRecord(entry) && typeof entry.id === 'string') ids.add(entry.id);
  };
  for (const board of Array.isArray(current.boards) ? current.boards : []) {
    take(board);
    if (isRecord(board) && Array.isArray(board.queries)) board.queries.forEach(take);
  }
  if (Array.isArray(current.skills)) current.skills.forEach(take);
  return ids;
}

/**
 * Create a board (`input.id === null`) or update the one holding `input.id`, and return it as stored. A create ignores every id the client sent and mints
 * fresh ones for the board and each query (no stored board holds them). An update keeps a query's id only when the STORED board holds it — once each; a
 * query's identity is never inferred from its label or JQL — and mints for every other query, so a client cannot choose an id. The board keeps its position in
 * `boards`; every other entry, malformed ones included, and every other top-level key survive untouched. An update whose id the file does not hold (or holds
 * only as an entry the reader would drop) throws `JiraUnknownIdError` before anything is written.
 */
export function writeBoard(input: JiraBoardWrite, file: string = jiraConfigFile()): JiraBoard {
  const current = readRawForWrite(file);
  const boards = Array.isArray(current.boards) ? [...current.boards] : [];
  const taken = idsIn(current);
  let index = -1;
  let held = new Set<string>();
  if (input.id !== null) {
    // Matched on the id first and read second, so a neighbouring malformed entry is not warned about on every update.
    index = boards.findIndex((entry) => isRecord(entry) && entry.id === input.id);
    const stored = index < 0 ? null : readBoard(boards[index], file, `board "${input.id}"`);
    if (stored === null) throw new JiraUnknownIdError(input.id);
    held = new Set(stored.queries.map((q) => q.id));
  }
  // What a client sent is reserved even when it is not kept, so the id minted for such a query is provably not the one it asked for.
  for (const q of input.queries) if (q.id !== null) taken.add(q.id);
  const kept = new Set<string>();
  const queries: JiraQuery[] = input.queries.map((q) => {
    const id = q.id !== null && held.has(q.id) && !kept.has(q.id) ? q.id : mintUnique('q', taken);
    kept.add(id);
    return { id, label: q.label, jql: q.jql };
  });
  const board: JiraBoard = {
    id: input.id !== null ? input.id : mintUnique('b', taken),
    name: input.name,
    roots: input.roots,
    queries,
    interval: input.interval
  };
  if (index >= 0) boards[index] = { ...(boards[index] as Record<string, unknown>), ...board };
  else boards.push(board);
  writeRawAtomic(file, { ...current, boards });
  return board;
}

/**
 * Remove every raw entry whose `id` is `id` (a board a hand-edit duplicated goes in one call), keeping the rest in order. An id the file does not hold throws
 * `JiraUnknownIdError`, nothing written. Matched on the raw entries, not on what the reader accepts: removing a half-broken entry by its id is harmless.
 */
export function deleteBoard(id: string, file: string = jiraConfigFile()): void {
  const current = readRawForWrite(file);
  const boards = Array.isArray(current.boards) ? current.boards : [];
  const rest = boards.filter((entry) => !(isRecord(entry) && entry.id === id));
  if (rest.length === boards.length) throw new JiraUnknownIdError(id);
  writeRawAtomic(file, { ...current, boards: rest });
}

/**
 * Set one path's defaults, or remove its entry when `value` holds neither. The entry is REPLACED whole — the route's body carries both fields, `null` meaning
 * unset — and every other path's entry survives, a hand-written invalid one included; a `repoDefaults` that is not an object (an array, say) is replaced by one
 * holding only this path. The key stays, as `{}`, when the last entry goes: `repos` does the same, and nothing reads a present-but-empty map differently.
 */
export function writeRepoDefaults(path: string, value: JiraRepoDefaults, file: string = jiraConfigFile()): void {
  const current = readRawForWrite(file);
  const repoDefaults: Record<string, unknown> = isRecord(current.repoDefaults) ? { ...current.repoDefaults } : {};
  if (value.base === undefined && value.namePattern === undefined) delete repoDefaults[path];
  else {
    const entry: JiraRepoDefaults = {};
    if (value.base !== undefined) entry.base = value.base;
    if (value.namePattern !== undefined) entry.namePattern = value.namePattern;
    repoDefaults[path] = entry;
  }
  writeRawAtomic(file, { ...current, repoDefaults });
}

/**
 * Set one project's repository list, or remove its key when `paths` is empty. `paths` arrive normalised and deduplicated (`parseReposWrite`). Every other key
 * of `repos` survives, a hand-written invalid one included; a `repos` that is not an object (an array, say) is replaced by one holding only this key.
 */
export function writeRepos(project: string, paths: string[], file: string = jiraConfigFile()): void {
  const current = readRawForWrite(file);
  const repos: Record<string, unknown> = isRecord(current.repos) ? { ...current.repos } : {};
  if (paths.length === 0) delete repos[project];
  else repos[project] = paths;
  writeRawAtomic(file, { ...current, repos });
}

/**
 * Create a skill (`input.id` absent) or update the one holding `input.id`, and return it as stored. `writeBoard`'s rule exactly: a create mints a fresh `s_` id
 * (unique across every id the file holds, so it can collide with no board, query or skill); an update keeps the id and the position and replaces `name` and
 * `prompt` (trimmed again here, so what is stored is trimmed whoever called); every other entry — malformed ones included — and every other top-level key survives untouched. An update whose id the file does not hold, or
 * holds only as an entry the reader would drop, throws `JiraUnknownIdError('skill')` before anything is written. A skill save never touches the poller.
 */
export function writeSkill(input: JiraSkillWrite, file: string = jiraConfigFile()): JiraSkill {
  const current = readRawForWrite(file);
  const skills = Array.isArray(current.skills) ? [...current.skills] : [];
  let index = -1;
  if (input.id !== undefined) {
    // Matched on the id first and read second, so a neighbouring malformed entry is not warned about on every update.
    index = skills.findIndex((entry) => isRecord(entry) && entry.id === input.id);
    if (index < 0 || readSkill(skills[index], file, `skill "${input.id}"`) === null) throw new JiraUnknownIdError(input.id, 'skill');
  }
  const skill: JiraSkill = { id: input.id !== undefined ? input.id : mintUnique('s', idsIn(current)), name: input.name.trim(), prompt: input.prompt.trim() };
  if (index >= 0) skills[index] = { ...(skills[index] as Record<string, unknown>), ...skill };
  else skills.push(skill);
  writeRawAtomic(file, { ...current, skills });
  return skill;
}

/**
 * Remove every raw entry whose `id` is `id`, keeping the rest in order — `deleteBoard`'s contract, for skills: matched on the raw entries, so a half-broken
 * entry can be removed by its id, and an id the file does not hold throws `JiraUnknownIdError('skill')` with nothing written.
 */
export function deleteSkill(id: string, file: string = jiraConfigFile()): void {
  const current = readRawForWrite(file);
  const skills = Array.isArray(current.skills) ? current.skills : [];
  const rest = skills.filter((entry) => !(isRecord(entry) && entry.id === id));
  if (rest.length === skills.length) throw new JiraUnknownIdError(id, 'skill');
  writeRawAtomic(file, { ...current, skills: rest });
}
