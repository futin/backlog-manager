import { deriveGroomed } from '../items/parse.util';
import { newestClaim, type ParsedClaim } from './claim';
import type { GithubIssue } from './github.client';
import type { BacklogItem, ClaimCounters, RegistryProject, Section } from '../../../shared/types';

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
 *  its shape, and since task-46 the dispatch request carries it. */
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
 * The issue number a write route's `id` names, or `null` (task-46).
 *
 * Three spellings mean one issue, because three different callers reach these
 * routes with three different handles: a person types `31`, a skill's prose
 * says `#31`, and the board posts `BacklogItem.path`, which is the URN. One
 * function rather than each route being tolerant in its own way — that is how
 * two routes end up disagreeing about whether `31` is an id.
 *
 * A URN for ANOTHER repo is `null`, not the number inside it, and that is the
 * load-bearing case: the route has already resolved which project (and so which
 * repo) it is writing to from the registry, so a URN naming a different repo is
 * a caller asking this project's credential to write somewhere else. Refusing
 * it here means no route has to remember to compare.
 */
export function issueNumberFor(id: string, repo: string): number | null {
  if (id.startsWith(URN_PREFIX)) {
    const parsed = parseUrn(id);
    return parsed === null || parsed.repo !== repo ? null : parsed.number;
  }
  const digits = id.startsWith('#') ? id.slice(1) : id;
  if (!/^\d+$/.test(digits)) return null;
  const number = Number(digits);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * The mapper's answer. `item` is what the board renders; the other two are
 * facts about the mapping itself that do not belong on `BacklogItem`:
 *
 * - `runnerFix` — the `runner-fix` label, which means what the file store's
 *   `runner-fix:` frontmatter key means (CLAUDE.md: presence hoists an item to
 *   the front of an orchestrator run's queue). It rode here and ONLY here
 *   until task-47, when the consumer arrived: `orchestrate.mjs`'s gate builds
 *   a tracker queue out of `GET /api/items` and has no file to read the
 *   marker off, so the item now carries `runnerFix: true` as well. This field
 *   stays — it is a `boolean` where the item's is `true | absent`, and it is
 *   what `list`'s own error/count bookkeeping reads — but the two are set from
 *   the same `names.includes('runner-fix')` one line apart, so they cannot
 *   disagree. The label is still CONSUMED here, so it never shows up as a tag.
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
export function mapIssue(issue: GithubIssue, repo: string, project: RegistryProject, claims: readonly ParsedClaim[]): MappedIssue | null {
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

  // Every label that is not a type, a kind, the runner-fix marker or the
  // in-progress flag. All four are CONSUMED — they are structure, and leaving
  // one in `tags` would draw it twice on a card, once as the thing it means and
  // once as a word.
  //
  // `in-progress` joined them in task-46 and only then. In phase 2 nothing read
  // it, so hiding it would have been hiding a label this build had no other way
  // to show; now the claim protocol sets it and `started`/`phase` below render
  // it as the in-progress bar every other item gets.
  const tags = names.filter((n) => !(n in SECTION_BY_LABEL) && !n.startsWith('kind:') && n !== 'runner-fix' && n !== 'in-progress');

  const closed = issue.state === 'closed';
  const reason = typeof issue.state_reason === 'string' ? issue.state_reason : null;
  // `completed` and no reason at all are both `done`: GitHub only started
  // sending reasons in 2022, and an issue closed before that carries none.
  // Treating "no reason" as `not_planned` would retroactively reject every
  // issue closed in the repo's first years.
  const status = !closed ? 'open' : reason === null || reason === 'completed' ? 'done' : 'terminal';
  if (status === 'terminal') section = 'out-of-scope';

  // The newest claim on this issue — the one with the highest comment id,
  // released or not. It answers two independent questions, and keeping them
  // apart is the rule (task-46):
  //
  //   * **Is somebody holding this right now?** Only an UNRELEASED claim fills
  //     `started`/`phase`. Its heartbeat age is deliberately NOT consulted: the
  //     board's rule for a files item is "ANY stamp, fresh or stale" (see
  //     `progressBlock`), and the thing that retires a stale claim is the
  //     protocol, at the moment another session contests the issue. A mapper
  //     that expired claims on its own would show an item as free while the
  //     next `claim` call still had to fight for it.
  //   * **What has this item accumulated?** The counters come off the newest
  //     claim whether or not it is released, because they are the item's running
  //     totals — the tracker's answer to the four frontmatter counters, which a
  //     files item keeps after a `stop` too.
  const newest = newestClaim(claims);
  const held = newest !== null && newest.record.released === undefined;
  const counters: ClaimCounters = newest?.record.counters ?? { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 };

  const item: BacklogItem = {
    id: `#${issue.number}`,
    title: issue.title,
    // The DATE part only, matching what `backlog.mjs new` writes into
    // frontmatter — `created` is a `YYYY-MM-DD` on every other row and the
    // client's age arithmetic parses it as one.
    created: issue.created_at.slice(0, 10),
    // Filled from the claim since task-46 — see `newest` above for which
    // question each of these answers. An issue nobody has ever claimed reads
    // exactly as it did in phase 2: `''`, `''`, four zeros.
    started: held ? newest.record.at : '',
    updated: issue.updated_at,
    // Always `''`. There is no commit behind an issue, so the client's
    // `lastTouched` precedence (`updated ?? lastCommit ?? created`) falls
    // through this middle rung — which is exactly why the rung reads `''`
    // rather than, say, `created_at`: a value here would be a git date that
    // no git ever produced.
    lastCommit: '',
    phase: held ? newest.record.phase : '',
    groomElapsed: counters.groomElapsed,
    executeElapsed: counters.executeElapsed,
    groomTokens: counters.groomTokens,
    executeTokens: counters.executeTokens,
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
    untyped,
    // Spread rather than assigned, so an unmarked issue carries NO KEY at all
    // (task-47). `BacklogItem.runnerFix` is `true | absent` and never `false`
    // — see its own declaration for why — and `runnerFix: undefined` would
    // still put the key on the object, which `'runnerFix' in item` sees and
    // `JSON.stringify` does not. One of those two readings would be wrong
    // wherever the payload is compared as a whole, and the mapper is the one
    // writer of this field, so the absence is arranged here rather than
    // cleaned up later.
    ...(runnerFix ? { runnerFix: true as const } : {})
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
