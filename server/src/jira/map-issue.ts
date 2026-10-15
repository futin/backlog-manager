/**
 * map-issue.ts — raw Jira issue JSON → `JiraIssue`, the sprint-field pick and the Done window (Jira phase 1; spec §3 and §4, with §14 P3/P4/P5 as the
 * authority on what Jira actually sends). Pure: no I/O, no module state, and the clock arrives as `ctx.now`, so the poller (Task 6) and the search route call
 * it on whatever Jira handed back and a suite can pin the instant.
 *
 * Four decisions carry the design.
 *
 * 1. The Done window lives HERE and only here (§3). A root's done children would otherwise pile up on the board forever, and a query author has JQL for the
 *    rest; dropping at map time means the cache, the board payload and the client never see an expired issue and none of them has a second copy of the 14. The
 *    boundary is inclusive (exactly 14 days old is kept) and it applies to the `done` category alone — a stale `resolutiondate` left by an earlier close must
 *    never drop an issue that has since been reopened. The window falls back to `updated` when Jira recorded no resolution (an issue moved into a done status
 *    by a workflow that sets none). `ctx.now: null` turns it off: the search route is asked for a specific issue and must get it however old it is.
 * 2. The sprint is the ACTIVE one, else the last by id (§3). A carried-over issue sits in several sprints at once (the field is an array — P4), and the one a
 *    person means is the one running now; with none running, the most recently created is the nearest to "where this is headed". `pickSprintField` is the same
 *    rule one level up, for the field itself: `gh-sprint` schema, the one NAMED `Sprint` if several, else the lowest numeric id — numeric, because as text
 *    `customfield_9` would sort after `customfield_10`.
 * 3. `undefined` maps to `new` (P5). Jira has a fourth status-category key, "No Category", whose key is the string `undefined`; a status with no category is
 *    not a finished one, and `new` is the column that holds work not yet started. Anything unrecognised — a missing key, a fifth category some future Jira
 *    adds — lands in the same place rather than inventing a column the board has no lane for.
 * 4. `level`, never the type's NAME, decides hierarchy (P3). Real sites carry subtask types called `Project`, `Testing` and `Story Bug`; the name says
 *    nothing, `issuetype.hierarchyLevel` is on every type (epic 1, standard 0, subtask −1). When it is absent — an older payload — the `subtask` flag stands
 *    in for it.
 *
 * Every malformed shape folds into the empty value the shape allows (a non-string summary is `''`, a non-array `labels` is `[]`), and only an object with
 * neither a key nor `fields` is not an issue at all: one odd issue costs its own fields, never the sweep.
 */
import type { JiraIssue, JiraStatusCategory } from '../../../shared/types';

/** The sweep's field list, exactly (§4). The discovered sprint field is appended by the caller, because only the caller knows it. */
export const JIRA_ISSUE_FIELDS: readonly string[] = [
  'summary',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'parent',
  'subtasks',
  'labels',
  'created',
  'updated',
  'resolutiondate',
  'project'
];

/** How long a done issue stays on the board, counted from its resolution (or last update). Spec §3: this file's constant, nobody else's. */
export const JIRA_DONE_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;
const GH_SPRINT = 'com.pyxis.greenhopper.jira:gh-sprint';

/** `now: null` turns the Done window off. `sprintField` is `null` until the boot discovery has answered (or when the site has no Sprint field). */
export interface MapContext {
  site: string;
  sprintField: string | null;
  now: number | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A status-category key as the board's column; anything but `indeterminate` and `done` is `new` (P5 — including the literal `undefined`). */
export function categoryOf(key: unknown): JiraStatusCategory {
  return key === 'indeterminate' || key === 'done' ? key : 'new';
}

/** The numeric tail of `customfield_10020`; a non-conforming id sorts last rather than throwing. */
const fieldNumber = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/** The id of the sprint custom field in a `GET field` answer (P4), or `null`. See the header for the tie-break. */
export function pickSprintField(fields: { id: string; name: string; schema?: { custom?: string } }[]): string | null {
  const candidates = fields.filter((f) => f.schema?.custom === GH_SPRINT);
  if (candidates.length === 0) return null;
  const named = candidates.filter((f) => f.name === 'Sprint');
  const pool = named.length > 0 ? named : candidates;
  return pool.reduce((best, f) => (fieldNumber(f.id) < fieldNumber(best.id) ? f : best)).id;
}

/** The name of the active sprint, else of the highest-id one, from the sprint field's array; `null` for anything but a non-empty array of named sprints. */
function sprintName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sprints = value.filter((s): s is Obj => isObj(s) && typeof s.name === 'string');
  const byId = (a: Obj, b: Obj) => (Number(b.id) || 0) - (Number(a.id) || 0);
  const pool = sprints.filter((s) => s.state === 'active');
  const [pick] = (pool.length > 0 ? pool : sprints).sort(byId);
  return pick ? (pick.name as string) : null;
}

/** Milliseconds for an ISO-ish stamp (Jira writes `+0000`, no colon, which V8 parses), or `NaN`. */
const stamp = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

/** True when a done issue is older than the window. An issue with no readable resolution or update date is kept: one we cannot date is not provably stale. */
function expired(done: boolean, resolutiondate: unknown, updated: unknown, now: number | null): boolean {
  if (!done || now === null) return false;
  const at = typeof resolutiondate === 'string' && !Number.isNaN(stamp(resolutiondate)) ? stamp(resolutiondate) : stamp(updated);
  return !Number.isNaN(at) && now - at > JIRA_DONE_WINDOW_DAYS * DAY_MS;
}

/** One raw Jira issue as a `JiraIssue`, or `null` when it is not an issue or the Done window drops it. */
export function mapJiraIssue(raw: unknown, ctx: MapContext): JiraIssue | null {
  if (!isObj(raw) || typeof raw.key !== 'string' || !isObj(raw.fields)) return null;
  const key = raw.key;
  const f = raw.fields;

  const status = isObj(f.status) ? f.status : {};
  const category = categoryOf(isObj(status.statusCategory) ? status.statusCategory.key : undefined);
  if (expired(category === 'done', f.resolutiondate, f.updated, ctx.now)) return null;

  const type = isObj(f.issuetype) ? f.issuetype : {};
  const subtask = type.subtask === true;
  const level = typeof type.hierarchyLevel === 'number' ? type.hierarchyLevel : subtask ? -1 : 0;

  const prefix = key.split('-')[0];
  const project = isObj(f.project) ? f.project : {};
  const parent =
    isObj(f.parent) && typeof f.parent.key === 'string' ? { key: f.parent.key, summary: str(isObj(f.parent.fields) ? f.parent.fields.summary : '') } : null;
  const assignee =
    isObj(f.assignee) && typeof f.assignee.accountId === 'string' ? { accountId: f.assignee.accountId, name: str(f.assignee.displayName) } : null;

  return {
    key,
    id: str(raw.id),
    url: `https://${ctx.site}/browse/${key}`,
    summary: str(f.summary),
    project: { key: str(project.key) || prefix, name: str(project.name) || str(project.key) || prefix },
    type: { name: str(type.name), level, subtask },
    status: { name: str(status.name), category },
    priority: isObj(f.priority) ? strOrNull(f.priority.name) : null,
    assignee,
    reporter: isObj(f.reporter) ? strOrNull(f.reporter.displayName) : null,
    parent,
    subtasks: Array.isArray(f.subtasks) ? f.subtasks.length : 0,
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [],
    sprint: ctx.sprintField === null ? null : sprintName(f[ctx.sprintField]),
    created: str(f.created),
    updated: str(f.updated),
    resolved: strOrNull(f.resolutiondate)
  };
}
