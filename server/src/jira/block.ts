/**
 * block.ts — the ticket block: one Jira issue as a plain-text document (Jira phase 1; spec §3). Pure — no I/O, no module state, no clock — so every reader
 * gets byte-identical text for the same `JiraIssueDetail`.
 *
 * ONE renderer, and two readers: `GET /api/jira/issue/:key?format=text` and `jira.mjs show`, which prints that body verbatim — and is how a Jira Run session
 * reads its ticket, since the Run prompt carries no copy of it (`prompt.util.ts`). The modal does NOT use it — it draws the structured payload. The children
 * cap lives here so no reader grows a second list renderer with a second number.
 *
 * Four decisions carry the design.
 *
 * 1. The facts come first, in a fixed order and with a fixed separator (` · `), one line per kind of fact, and an absent fact is `—`, never an omitted
 *    segment. A reader that parses by position (`labels:` is always the last segment of line 4) must not have to know which facts a ticket happens to have.
 * 2. The status carries its category in words (`In Progress (in progress)`). A workflow's status names are the team's own (`In Review`, `Ready for QA`); the
 *    category is the one thing that says whether the work is waiting, moving or finished, and a session reading this text cannot look it up.
 * 3. A description that is empty says so (`(no description)`). Jira sends `null` for a ticket nobody described and the mapper turns that into `''`; rendering
 *    the empty string would leave a blank where the description is and read like a truncated block, and rendering the `null` itself would put the word in
 *    front of a session. Whitespace alone counts as empty for the same reason.
 * 4. Content the ADF converter could not carry is flagged, not hidden. A table, panel, expand or attachment became a one-line placeholder; when the
 *    description holds one, a trailing note carries the URL, so a reader knows the text is incomplete and where the whole is. The detector is
 *    `ADF_PLACEHOLDER_RE`, the same pattern that defines what a placeholder looks like, and it matches anywhere in a line (P7) — a placeholder inside a list
 *    item sits behind a `- ` the converter itself added.
 *
 * Dates are `YYYY-MM-DD` of the instant in UTC (`shortDate`), whatever offset Jira's string carries and whatever `TZ` the process runs under: the block is
 * compared and cached as text, and a ticket must not change its own `created:` line because the server moved to another zone.
 */
import type { JiraIssue, JiraIssueDetail, JiraStatusCategory } from '../../../shared/types';
import { ADF_PLACEHOLDER_RE } from './adf';

/** Subtasks listed before `+N more`. One home: `jira.mjs show` reads the block, it does not count children itself. */
export const JIRA_BLOCK_CHILDREN_CAP = 30;

const SEP = ' · ';
const ABSENT = '—';

/** Jira's own words for the three categories the mapper leaves (`undefined` is already `new`, P5). */
const CATEGORY_WORDS: Record<JiraStatusCategory, string> = { new: 'to do', indeterminate: 'in progress', done: 'done' };

/**
 * `YYYY-MM-DD` of an ISO instant in UTC. `Date` parses Jira's `+0200` offsets, and `toISOString` is UTC by definition, so the answer cannot depend on `TZ`.
 * A string `Date` cannot read is returned as it came: a malformed date from Jira should show as itself, not take the whole block down with a `RangeError`.
 */
export function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}

const orDash = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? ABSENT : value);

function childLine(child: JiraIssue): string {
  return `- ${child.key} ${child.summary}${SEP}${child.status.name}${SEP}${orDash(child.assignee?.name)}`;
}

/**
 * The description's own lines: `(no description)` for an empty one, else the text, and, when it holds an ADF placeholder, the omitted-content note — this
 * server's words, after the ticket's. `typeof` rather than a truthiness test: the type says `string`, but a `null` that slips past the mapper must still never
 * print as the word.
 */
function descriptionLines(detail: JiraIssueDetail): string[] {
  const description = typeof detail.description === 'string' ? detail.description : '';
  if (description.trim() === '') return ['(no description)'];
  const lines = [description];
  if (ADF_PLACEHOLDER_RE.test(description)) lines.push(`(something was omitted — open in Jira: ${detail.url})`);
  return lines;
}

export function renderTicketBlock(detail: JiraIssueDetail): string {
  const parent = detail.parent ? `${detail.parent.key} ${detail.parent.summary}` : ABSENT;
  const labels = detail.labels.length > 0 ? detail.labels.join(', ') : ABSENT;
  const lines = [
    `${detail.key}${SEP}${detail.summary}`,
    `type: ${detail.type.name}${SEP}status: ${detail.status.name} (${CATEGORY_WORDS[detail.status.category]})${SEP}priority: ${orDash(detail.priority)}`,
    `project: ${detail.project.key}${SEP}${detail.project.name}${SEP}parent: ${parent}${SEP}sprint: ${orDash(detail.sprint)}`,
    `assignee: ${orDash(detail.assignee?.name)}${SEP}reporter: ${orDash(detail.reporter)}${SEP}labels: ${labels}`,
    `created: ${shortDate(detail.created)}${SEP}updated: ${shortDate(detail.updated)}${SEP}resolved: ${detail.resolved ? shortDate(detail.resolved) : ABSENT}`,
    `url: ${detail.url}`
  ];

  lines.push('', ...descriptionLines(detail));

  if (detail.children.length > 0) {
    lines.push('', `Subtasks (${detail.children.length}):`);
    for (const child of detail.children.slice(0, JIRA_BLOCK_CHILDREN_CAP)) lines.push(childLine(child));
    if (detail.children.length > JIRA_BLOCK_CHILDREN_CAP) lines.push(`+${detail.children.length - JIRA_BLOCK_CHILDREN_CAP} more`);
  }

  return `${lines.join('\n')}\n`;
}
