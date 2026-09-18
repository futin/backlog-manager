import { deriveGroomed } from '../items/parse.util';
import type { GithubIssue } from './github.client';
import type { BacklogItem, RegistryProject, Section } from '../../../shared/types';

/**
 * One GitHub issue → one `BacklogItem`, per the table in spec §5.3 (task-45).
 * A pure function over an issue, the repo it came from and the registry entry
 * that owns it: no cache, no client, no clock. That is what lets the mapping
 * table be tested row by row against fixture JSON, which is how the spec asks
 * for it (§12.2) and the only way the awkward rows — two type labels, a
 * `not_planned` close — get a case each.
 *
 * ## The two rows worth reading twice
 *
 * **Section comes from the one `type:*` label.** None is not an error: it is
 * an ordinary state (someone filed a blank issue in the web UI), so the item
 * lands in `ideas` and carries `untyped: true` for the badge. TWO is an error,
 * because the issue is claiming to be two things and picking one silently
 * would move an item between columns on a tie-break nobody can see; the item
 * is still produced — first label alphabetically — and an entry naming the
 * issue joins `ItemsIndex.errors`, exactly as a malformed FILE does. Producing
 * nothing would hide the issue from the board entirely, which is the one
 * outcome worse than showing it in the wrong column with a complaint attached.
 *
 * **A closed issue's section can change; its labels never do.** Closed with
 * `state_reason: 'completed'` (or none, which GitHub sends for an issue closed
 * before it had reasons) is `done` and keeps its section. Closed with any
 * other reason — `not_planned`, `duplicate` — is `terminal` and moves to
 * `out-of-scope`, which is what the file store does with a rejected item. The
 * `type:*` label STAYS on the issue, so the original type is recoverable: the
 * file store loses that (the file moves into a flat directory) and the tracker
 * does not have to.
 */

/** `gh:<owner>/<repo>#<n>` — the URN that stands in for a filesystem path on a
 *  tracker row. `/api/items/body` takes it, `ItemsService.body` dispatches on
 *  its shape, and from phase 3 the dispatch request carries it. */
export const URN_PREFIX = 'gh:';

export function issueUrn(repo: string, number: number): string {
  return `${URN_PREFIX}${repo}#${number}`;
}

/**
 * The parsed halves of a URN, or `null` for anything that is not one — which
 * includes every filesystem path, and that is the point: this function IS the
 * shape test `ItemsService.body` dispatches on.
 */
export function parseUrn(ref: string): { repo: string; number: number } | null {
  if (!ref.startsWith(URN_PREFIX)) return null;
  const rest = ref.slice(URN_PREFIX.length);
  const hash = rest.lastIndexOf('#');
  if (hash <= 0) return null;
  const repo = rest.slice(0, hash);
  const number = Number(rest.slice(hash + 1));
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo, number };
}

/**
 * The mapper's answer. `item` is what the board renders; the other two are
 * facts about the mapping itself that do not belong on `BacklogItem`:
 *
 * - `runnerFix` — the `runner-fix` label, which means what the file store's
 *   `runner-fix:` frontmatter key means (CLAUDE.md: presence hoists an item to
 *   the front of an orchestrator run's queue). It rides here rather than on
 *   `BacklogItem` because nothing on the READ side renders it and phase 2 has
 *   no dispatch against a tracker project at all — adding a field to the
 *   payload for a consumer that does not exist yet is how a field ends up with
 *   two meanings by the time one does. The label is still CONSUMED here, so it
 *   never shows up as a tag.
 * - `errors` — the per-issue complaints that belong in `ItemsIndex.errors`,
 *   collected rather than thrown for the reason `scanProject` gives: one bad
 *   row must not blind the board to the other nine.
 */
export interface MappedIssue {
  item: BacklogItem;
  runnerFix: boolean;
  errors: string[];
}

/** `type:bug` → `bugs`. The four labels the bootstrap creates, and nothing
 *  else: a repo may carry any other label and none of them is a section. */
const SECTION_BY_LABEL: Record<string, Section> = {
  'type:bug': 'bugs',
  'type:idea': 'ideas',
  'type:task': 'tasks',
  'type:refactor': 'refactors'
};

/**
 * `null` for a pull request, which the issues endpoint returns alongside real
 * issues. Dropped rather than rendered: a PR has no section, no plan and no
 * lifecycle this board knows, and one arriving as an untyped idea would put a
 * row on the board that nobody filed.
 */
export function mapIssue(issue: GithubIssue, repo: string, project: RegistryProject): MappedIssue | null {
  if (issue.pull_request !== undefined && issue.pull_request !== null) return null;

  const errors: string[] = [];
  const names = labelNames(issue);

  // Sorted so "the first alphabetically" is a fact about the label set rather
  // than about the order GitHub happened to return it in.
  const types = names.filter((n) => n in SECTION_BY_LABEL).sort();
  const untyped = types.length === 0;
  if (types.length > 1) {
    errors.push(`${issueUrn(repo, issue.number)}: ${types.length} type labels (${types.join(', ')}) — using ${types[0]}`);
  }
  // No type label at all is `ideas` AND `untyped`, which is the one place the
  // two differ: an item can be in `ideas` because someone said so.
  let section: Section = untyped ? 'ideas' : SECTION_BY_LABEL[types[0]];

  const kindLabel = names.filter((n) => n.startsWith('kind:')).sort()[0];
  const kind = kindLabel === undefined ? '' : kindLabel.slice('kind:'.length);
  const runnerFix = names.includes('runner-fix');

  // Every label that is not a type, a kind or the runner-fix marker. Those
  // three are CONSUMED — they are structure, and leaving them in `tags` would
  // draw them twice on a card, once as the thing they mean and once as a word.
  // `in-progress` is deliberately NOT consumed here: nothing in phase 2 reads
  // it (the claim protocol is phase 3), so hiding it would be hiding a label
  // this build has no other way to show.
  const tags = names.filter((n) => !(n in SECTION_BY_LABEL) && !n.startsWith('kind:') && n !== 'runner-fix');

  const closed = issue.state === 'closed';
  const reason = typeof issue.state_reason === 'string' ? issue.state_reason : null;
  // `completed` and no reason at all are both `done`: GitHub only started
  // sending reasons in 2022, and an issue closed before that carries none.
  // Treating "no reason" as `not_planned` would retroactively reject every
  // issue closed in the repo's first years.
  const status = !closed ? 'open' : reason === null || reason === 'completed' ? 'done' : 'terminal';
  if (status === 'terminal') section = 'out-of-scope';

  const item: BacklogItem = {
    id: `#${issue.number}`,
    title: issue.title,
    // The DATE part only, matching what `backlog.mjs new` writes into
    // frontmatter — `created` is a `YYYY-MM-DD` on every other row and the
    // client's age arithmetic parses it as one.
    created: issue.created_at.slice(0, 10),
    // Phase 2 has no claim protocol, so nobody holds a tracker item: `started`
    // and `phase` are empty and the four counters are zero. Asserted in the
    // tests precisely so phase 3 has a red case the day it fills them.
    started: '',
    updated: issue.updated_at,
    // Always `''`. There is no commit behind an issue, so the client's
    // `lastTouched` precedence (`updated ?? lastCommit ?? created`) falls
    // through this middle rung — which is exactly why the rung reads `''`
    // rather than, say, `created_at`: a value here would be a git date that
    // no git ever produced.
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind,
    tags,
    section,
    status,
    project: project.name,
    projectPath: project.path,
    // Unchanged from the file store's rule, over the issue body instead of the
    // file body: a bug needs Cause and Fix filled, a task a non-empty Plan,
    // and everything else derives null. That is why `connect` writes issue
    // forms carrying those headings — so an issue filed in the web UI has the
    // skeleton this reads.
    groomed: deriveGroomed(section, issue.body ?? ''),
    path: issueUrn(repo, issue.number),
    source: 'github',
    url: issue.html_url,
    // The FIRST assignee, and `null` for none — see BacklogItem.assignee for
    // why one name rather than a joined list, and why this is not a claim.
    assignee: issue.assignees?.[0]?.login ?? null,
    untyped
  };

  return { item, runnerFix, errors };
}

/** GitHub sends labels as objects; older payloads and some fixtures send bare
 *  strings. Both are accepted because neither is wrong, and a mapper that
 *  threw on the string form would fail a whole repo over a shape nobody
 *  controls. */
function labelNames(issue: GithubIssue): string[] {
  const out: string[] = [];
  for (const label of issue.labels ?? []) {
    if (typeof label === 'string') out.push(label);
    else if (label !== null && typeof label.name === 'string') out.push(label.name);
  }
  return out;
}
