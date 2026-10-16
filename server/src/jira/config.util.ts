import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_JIRA_INTERVAL, isJiraKey, isSyncInterval, type JiraBoard, type JiraQuery, type JiraSkill } from '../../../shared/types';

/**
 * config.util.ts — ~/.backlog-manager/settings/jira.json, the READER half (spec §2; phase 1 of the Jira plan).
 *
 * This is the fourth file the server writes, after `watchdog.json`, the pause-control files and `tracker-sync.json` — but the writers are phase 2's. This file
 * holds the reader only and no write path at all: a file that exists and cannot be read or parsed is REPORTED (`unreadable`, which becomes `configUnreadable`
 * on the status payload) and never replaced, so the Board page can say `jira.json cannot be read` rather than the false, and later destructive, `No boards
 * yet`.
 *
 * It restates `sync-config.util.ts`'s argument for a per-ENTRY fallback. The file holds hand-edited, user-authored data — boards, saved JQL, repo paths, skill
 * prompts — and one stray value must cost only its own entry, never its neighbours: a board with a mistyped id is not a reason to lose the next board, and a
 * `boards` key that is not an array is not a reason to lose `repos`. Spec §2 draws the line at the ENTRY (a board, a skill, one project's list). This reader
 * goes one level finer, by design and recorded here as the deviation it is: a bad ROOT costs the root and a bad QUERY costs the query, not the board they sit
 * in, because a board that loses its whole contents over one lower-case key is the more surprising failure of the two.
 *
 * Read fresh on every call and cached nowhere — the file is edited by hand and by phase 2's writers, and a cache would be a second copy that disagrees with
 * the disk for as long as it lives. A parsed non-object (`[1, 2]`, `null`, a bare string) folds into "nothing" and is NOT unreadable, exactly as
 * `sync-config.util.ts`'s `readRaw` does, so this reader and phase 2's writers (which replace a parsed non-object, as `writeSyncInterval` does) agree on what
 * such a file means. A MISSING file is also nothing, not unreadable: a fresh install has no `jira.json` and has done nothing wrong.
 *
 * One validating function per entry kind (`readBoard`, `readQuery`, `readRepos`, `readSkill`) so phase 2's writers validate with the same code and add spec
 * §5's stricter WRITE-time rules (lengths, counts) on top — the reader accepts whatever is well-formed, because refusing a long-but-valid entry on read would
 * make a hand-edit that the writers would also have accepted vanish from the board. Each dropped entry is warned about once, naming the file and the entry's
 * index or id, so a vanished entry leaves a trace in the server log.
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

export interface JiraConfig {
  boards: JiraBoard[];
  /** Project key → absolute repository paths, in file order, deduplicated. */
  repos: Record<string, string[]>;
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
  const empty = { boards: [], repos: {}, skills: [] };
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
    skills: readList(raw.skills, file, 'skill', readSkill),
    unreadable: null
  };
}
