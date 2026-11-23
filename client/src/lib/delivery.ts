import type { StateTone } from './tones';
import { ignoreHolds } from './ignored-steps';
import type { IgnoreEntry } from './ignored-steps';
import { reviewStepWord } from './review-copy';
import { pollAge, polledPhrase } from './tracker';
import { projectLabel } from './project-label';
import { reviewState } from '../../../shared/review';
import type { GitlabMr, GitlabReview, GitlabPayload, GitlabProjectView, JiraIssue } from '../../../shared/types';

/**
 * What a Jira ticket's delivery is — its merge requests on GitLab, as the board, the List and Detail draw them (GitLab connection spec §7). Pure and
 * clock-free except where a caller hands `now` in. Every surface reads its lead MR, its words, its tone, its track, the band totals and the quick filters
 * from here, so a ticket can never show one MR on its card and another in its List cell, and "failing" can never mean one thing to the band and another to
 * the filter. The board's own rule (`.claude/rules/board.md`): every derivation has one home in `lib/`.
 */

/**
 * The payload re-keyed for per-ticket reads: MRs by the ticket key they carry (an MR with two keys sits under both), each GitLab project's view by path,
 * and the Jira-project map as the server sent it. Opaque to callers — built once per payload by `deliveryIndex` and handed to every derivation below, so a
 * board of hundreds of tickets scans the MR list once rather than once per ticket.
 */
export interface DeliveryIndex {
  readonly byKey: ReadonlyMap<string, readonly GitlabMr[]>;
  readonly byPath: ReadonlyMap<string, GitlabProjectView>;
  readonly jiraProjects: Readonly<Record<string, readonly GitlabProjectView[]>>;
}

/**
 * Build the index. Keys are compared upper-cased on both sides: the server already upper-cases them (`keysInBranch`), and Jira keys are upper-case, but a
 * lookup that silently missed on case would read as "no MR", which is a claim — so the fold costs nothing and closes the gap. The lookup is by EXACT key,
 * never a prefix or a substring: the key boundary (`TIMIFY-1234` is not `TIMIFY-123`) was decided by the server's matcher, and a second, looser match here
 * would undo it.
 */
export function deliveryIndex(payload: GitlabPayload): DeliveryIndex {
  const byKey = new Map<string, GitlabMr[]>();
  for (const mr of payload.mrs) {
    for (const key of new Set(mr.keys.map((k) => k.toUpperCase()))) {
      const list = byKey.get(key);
      if (list) list.push(mr);
      else byKey.set(key, [mr]);
    }
  }
  const byPath = new Map<string, GitlabProjectView>();
  for (const views of Object.values(payload.jiraProjects)) for (const v of views) byPath.set(v.path, v);
  return { byKey, byPath, jiraProjects: payload.jiraProjects };
}

/**
 * Whether the delivery surfaces exist at all — the band line, the List column, both filter controls and their stored value's effect (spec §7, "Which
 * tickets draw delivery at all"): configured and armed. A `rejected` or `unreachable` row that is still armed keeps them, because an unknown ticket must be
 * able to say `GitLab could not be read`; an unarmed or unconfigured one, or a payload the browser could not fetch (`null`), draws no delivery anywhere.
 */
export function deliveryShown(payload: GitlabPayload | null): boolean {
  return payload !== null && payload.status.state !== 'unconfigured' && payload.status.armed;
}

/**
 * The unknown lines (spec §7, "Known versus none") — an answer that is not yet trustworthy says so, and says where to look when it is a failure. Here
 * rather than in `DeliveryPane` since the Detail body's strip titles its grey `unknown` pill with the same sentence (Jira detail tabs spec §1.2), and one
 * reading of "why is this unknown" must not be worded twice.
 */
export const UNKNOWN_LINE = {
  'not-read': 'GitLab not read yet',
  failed: 'GitLab could not be read — Settings › Shared › Sources',
  capped: 'more merge requests than were read — some may be missing'
} as const;

/**
 * One ticket's delivery, every case a surface draws differently:
 * - `hidden` — its Jira project maps no GitLab project on the site, so no surface draws anything for it;
 * - `unknown` — no MR found, but the answer is not yet trustworthy: a mapped project never read (`not-read`, or `failed` when that first read failed) or
 *   one that hit the page cap (`capped`);
 * - `none` — known, and there is no MR; `repos` are the mapped repo basenames the no-MR sentence names;
 * - `mrs` — the lead MR and the rest. `via` is the parent key when the MRs are a sub-task's inherited ones; `notMerged` is §7.2's amber mark; `polledAt`
 *   is the lead MR's own project's, the age Detail's head prints beside it.
 */
export type TicketDelivery =
  | { kind: 'hidden' }
  | { kind: 'unknown'; why: 'not-read' | 'failed' | 'capped' }
  | { kind: 'none'; repos: string[] }
  | { kind: 'mrs'; lead: GitlabMr; also: GitlabMr[]; via: string | null; notMerged: boolean; polledAt: string | null };

const STATE_RANK: Record<GitlabMr['state'], number> = { opened: 0, merged: 1, closed: 2 };

/**
 * The order that picks a lead (spec §7): opened before merged before closed, then the newest `updatedAt`, then the project path ascending, then the higher
 * iid. The two tie-breaks exist so the pick is stable across sweeps — two MRs touched in the same second must not swap places on every poll and make the
 * chip flicker between them. `Date.parse` rather than a string compare, because an ISO string with an offset does not sort lexically by instant.
 */
function leadOrder(a: GitlabMr, b: GitlabMr): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (rank !== 0) return rank;
  const time = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (time !== 0 && !Number.isNaN(time)) return time;
  if (a.project !== b.project) return a.project < b.project ? -1 : 1;
  return b.iid - a.iid;
}

/**
 * The lead MR among `mrs` and the others ("also", in the same order). `mrs` must be non-empty — every caller has already asked whether there are any, and
 * a lead of nothing has no honest value to answer with.
 */
export function leadMr(mrs: readonly GitlabMr[]): { lead: GitlabMr; also: GitlabMr[] } {
  if (mrs.length === 0) throw new Error('leadMr: no merge requests to lead');
  const [lead, ...also] = [...mrs].sort(leadOrder);
  return { lead, also };
}

/**
 * One delivery target of a ticket: the MRs into one branch of one GitLab project (Jira detail tabs spec §4.1). `lead` is the target's representative —
 * `leadMr` over the group, so an open MR beats a merged one and the newest wins — and `older` is every other MR into that target, newest `updatedAt` first
 * (not `leadMr`'s state-ranked `also`: the older fold reads as a history, and a closed MR from yesterday sits above a merged one from last month).
 */
export interface DeliveryTarget {
  project: string;
  target: string;
  lead: GitlabMr;
  older: GitlabMr[];
}

/**
 * A ticket's MRs grouped by `(project, targetBranch)` — the same branch name in two projects is two targets, because a merge into `develop` of `pay-api` says
 * nothing about `pay-web`. Groups come out in `leadOrder` over their leads, so the first group's lead is `leadMr(mrs).lead` (the ticket's one lead, which the
 * card and the List still draw) and the tab's rows read in the same order as the strip's pills. `[]` for no MRs: unlike `leadMr`, a caller that has not yet
 * asked whether there are any gets an empty list, not a throw.
 */
export function deliveryTargets(mrs: readonly GitlabMr[]): DeliveryTarget[] {
  const groups = new Map<string, GitlabMr[]>();
  for (const mr of mrs) {
    // A NUL cannot occur in a GitLab path or a branch name, so the key cannot collide across the two parts.
    const key = `${mr.project}\0${mr.targetBranch}`;
    const list = groups.get(key);
    if (list) list.push(mr);
    else groups.set(key, [mr]);
  }
  const targets = [...groups.values()].map((group): DeliveryTarget => {
    const { lead, also } = leadMr(group);
    const older = [...also].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.iid - a.iid);
    return { project: lead.project, target: lead.targetBranch, lead, older };
  });
  return targets.sort((a, b) => leadOrder(a.lead, b.lead));
}

/**
 * A target's row id in the Delivery tab: `<project>\u0000<target>`. The strip's pill carries the same id (`stripDelivery`), so a pill click names the row it
 * opens, and the body's open-row set keys on it — the target, not the lead MR, because a poll that merges a lead and opens a new one is the same row.
 */
export const targetRowId = (t: Pick<DeliveryTarget, 'project' | 'target'>): string => `${t.project}\u0000${t.target}`;

/**
 * The summary on the older-MRs fold (spec §4.3): `4 earlier MRs into demo · 3 merged, 1 closed`, `<z open>` last when an older MR is still open, a zero part
 * dropped with its comma, `1 earlier MR` singular. `null` when the target has no older MR, so the caller draws no fold at all.
 */
export function olderMrsLine(t: DeliveryTarget): string | null {
  if (t.older.length === 0) return null;
  const count = (state: GitlabMr['state']): number => t.older.filter((m) => m.state === state).length;
  const parts = ([['merged', count('merged')], ['closed', count('closed')], ['open', count('opened')]] as const)
    .filter(([, n]) => n > 0)
    .map(([word, n]) => `${n} ${word}`);
  return `${t.older.length} earlier ${t.older.length === 1 ? 'MR' : 'MRs'} into ${t.target} · ${parts.join(', ')}`;
}

/**
 * Resolve one ticket (spec §6.2, §7). A ticket's own MRs win; a SUB-TASK (`type.subtask` with `parent` set — a story under an epic has a parent too and
 * inherits nothing) with none of its own shows its parent's, one level only, never the grandparent's. With no MR at all, the ticket is `unknown` while any
 * project its Jira project maps has never been read or is capped — "no MR found" in a list that may be incomplete is not "no MR" — and `none` otherwise. A
 * project read once and failing now still counts as read: a failed sweep keeps the last good answer (§6.3), so a known ticket stays known.
 *
 * `notMerged` fires only for the ticket whose OWN key the lead carries: a done sub-task under a story whose MR is still open is the normal shape of the
 * user's team, not a mismatch (§7.2).
 */
export function ticketDelivery(issue: JiraIssue, index: DeliveryIndex): TicketDelivery {
  const mapped = index.jiraProjects[issue.project.key] ?? [];
  if (mapped.length === 0) return { kind: 'hidden' };

  let mrs = index.byKey.get(issue.key.toUpperCase()) ?? [];
  let via: string | null = null;
  if (mrs.length === 0 && issue.type.subtask && issue.parent) {
    mrs = index.byKey.get(issue.parent.key.toUpperCase()) ?? [];
    if (mrs.length > 0) via = issue.parent.key;
  }

  if (mrs.length === 0) {
    const unread = mapped.filter((v) => v.polledAt === null);
    // A never-read project that failed says `could not be read` rather than `not read yet`: one of them having failed is the more actionable sentence.
    if (unread.length > 0) return { kind: 'unknown', why: unread.some((v) => v.failed) ? 'failed' : 'not-read' };
    if (mapped.some((v) => v.capped)) return { kind: 'unknown', why: 'capped' };
    return { kind: 'none', repos: [...new Set(mapped.map((v) => v.repo))] };
  }

  const { lead, also } = leadMr(mrs);
  const notMerged = issue.status.category === 'done' && lead.state === 'opened' && via === null;
  return { kind: 'mrs', lead, also, via, notMerged, polledAt: index.byPath.get(lead.project)?.polledAt ?? null };
}

/**
 * The basename an MR's repository is called by everywhere a surface names it: the mapped repo's own (`GitlabProjectView.repo`, the name the user's checkout
 * goes by), else the GitLab project path's last segment — `group/sub/repo` reads `repo`, and a bare `repo` reads itself. Detail's head and `Also:` line read
 * it; it lives here rather than in the pane so a second surface naming an MR's repo cannot call it something else.
 */
export function mrRepo(mr: GitlabMr, index: DeliveryIndex): string {
  return index.byPath.get(mr.project)?.repo ?? projectLabel(mr.project);
}

/** The palette a delivery look draws from (spec §7, "Tones") — names, not colours: the surfaces map each to `shared/theme.css` tokens. */
export type DeliveryTone = 'green' | 'red' | 'amber' | 'magenta' | 'grey';

/**
 * One step of the delivery track: `on` reached, `off` not reached, or toned. The track is an ARRAY the surfaces map over rather than four named fields, so
 * project 2 could insert a `review` step without a surface changing (§7, "Delivery track"); it sits between MR open and Pipeline, because review comes first
 * and the pipeline runs once the review is clean. A closed MR ends on `closed`, which
 * takes the place of `merged`.
 */
export interface TrackStep {
  step: 'pushed' | 'open' | 'pipeline' | 'review' | 'merged' | 'closed';
  mark: 'on' | 'off' | DeliveryTone;
}

/** What one MR looks like on every surface: the card chip, the List/Detail word, the tone, and the track. */
export interface DeliveryLook {
  chip: string;
  word: string;
  /**
   * The pipeline's word alone, never `<n> to fix`: Detail's Pipeline step reads it, so `pipeline passed` stays on that step while the Review step before it
   * says `2 open · 1 major` (spec §5.3). For a merged or closed MR it is the same as `word`.
   */
  pipelineWord: string;
  tone: DeliveryTone;
  track: TrackStep[];
}

/**
 * The Review step's mark from the review's state (spec §5.1): nothing to say (`none`, `unknown`, or not read) is `off`, a round in flight or a stale review is
 * `grey`, findings to fix are `amber`, a clean review is `green`.
 */
function reviewMark(review: GitlabReview | null, now: number): TrackStep['mark'] {
  if (review === null) return 'off';
  switch (reviewState(review, now)) {
    case 'open':
      return 'amber';
    case 'clean':
      return 'green';
    case 'reviewing':
    case 'stale':
      return 'grey';
    default:
      return 'off';
  }
}

const openTrack = (open: TrackStep['mark'], pipeline: TrackStep['mark'], review: TrackStep['mark']): TrackStep[] => [
  { step: 'pushed', mark: 'on' },
  { step: 'open', mark: open },
  { step: 'review', mark: review },
  { step: 'pipeline', mark: pipeline },
  { step: 'merged', mark: 'off' }
];

/**
 * Spec §7's one table, row for row, with CodeRabbit's findings folded in (CodeRabbit spec §5.3). A draft is grey `draft` whatever its pipeline or findings — a
 * draft's red pipeline is work in progress, not a signal — but it still draws the Review step. An open MR whose pipeline is `null` (not read) reads as `none`:
 * an unknown pipeline must read as absent, never as passing. Word precedence for an open MR, worst first: draft, failed pipeline, findings open (`<n> to fix`,
 * `<n>+` when capped, amber), then the pipeline's own word; `pipelineWord` is that last one always. Merged and closed MRs carry no pipeline (§6.3 reads it only
 * for open ones) and no review: merged draws every step in magenta, closed draws Review and Pipeline `off` and ends on `closed`. `now` is a parameter because
 * the review's state depends on the clock (a stuck round stops reading `reviewing` by itself).
 */
export function deliveryLook(mr: GitlabMr, now: number): DeliveryLook {
  const iid = `!${mr.iid}`;
  if (mr.state === 'merged') {
    return {
      chip: `${iid} · merged`,
      word: 'merged',
      pipelineWord: 'merged',
      tone: 'magenta',
      track: (['pushed', 'open', 'review', 'pipeline', 'merged'] as const).map((step) => ({ step, mark: 'magenta' }))
    };
  }
  if (mr.state === 'closed') {
    return {
      chip: `${iid} · closed`,
      word: 'closed',
      pipelineWord: 'closed',
      tone: 'grey',
      track: [
        { step: 'pushed', mark: 'on' },
        { step: 'open', mark: 'on' },
        { step: 'review', mark: 'off' },
        { step: 'pipeline', mark: 'off' },
        { step: 'closed', mark: 'grey' }
      ]
    };
  }
  const review = reviewMark(mr.review, now);
  if (mr.draft) {
    return { chip: `${iid} · draft`, word: 'draft', pipelineWord: 'draft', tone: 'grey', track: openTrack('grey', 'off', review) };
  }
  const p = pipelineLook(mr.pipeline);
  const track = openTrack('on', p.mark, review);
  if (p.failed || mr.review === null || reviewState(mr.review, now) !== 'open') {
    return { chip: `${iid} · ${p.chip}`, word: p.word, pipelineWord: p.word, tone: p.tone, track };
  }
  const toFix = `${mr.review.open}${mr.review.capped ? '+' : ''} to fix`;
  return { chip: `${iid} · ${toFix}`, word: toFix, pipelineWord: p.word, tone: 'amber', track };
}

/** The pipeline half of an open MR's look, so the findings branch above can lay its own word over it without a second table. */
function pipelineLook(pipeline: GitlabMr['pipeline']): { chip: string; word: string; tone: DeliveryTone; mark: TrackStep['mark']; failed: boolean } {
  switch (pipeline) {
    case 'success':
      return { chip: '✓ pipeline', word: 'pipeline passed', tone: 'green', mark: 'green', failed: false };
    case 'failed':
      return { chip: '✕ pipeline failed', word: 'pipeline failed', tone: 'red', mark: 'red', failed: true };
    case 'running':
      return { chip: '◷ running', word: 'pipeline running', tone: 'amber', mark: 'amber', failed: false };
    case 'canceled':
      return { chip: 'pipeline canceled', word: 'pipeline canceled', tone: 'grey', mark: 'grey', failed: false };
    default:
      return { chip: 'open', word: 'open, no pipeline', tone: 'grey', mark: 'off', failed: false };
  }
}

/** Which button a Delivery row draws under its sentence; the caller maps it to a control (Jira detail tabs spec §4.5) and turns `fix` into `Open session` when a live review link is on the key. */
export type NextButton = 'request' | 'fix' | 'run' | 'merge' | 'gitlab' | null;

/**
 * What is next for one MR (Jira detail tabs spec §4.5). `step` names the `TrackStep.step` the track rings (`null`: nothing is ringed — a waiting or a done row);
 * `word` is that step's Next word and `pill` the compact row's state pill (`next: <word>` whenever `step` is set, otherwise the waiting or done word the table
 * gives); `sentence` is the row's line, `null` on every Review row (the caller draws `reviewRowText` there); `ignore` is the step an `Ignore` click would store
 * (`null`: no Ignore offered); `ignored` is which steps draw `ignored` now, from the entry that still holds.
 */
export interface DeliveryNext {
  step: 'review' | 'pipeline' | 'merged' | null;
  word: string | null;
  pill: string;
  sentence: string | null;
  button: NextButton;
  ignore: 'review' | 'pipeline' | null;
  ignored: { review: boolean; pipeline: boolean };
}

const NEXT_SENTENCES = {
  unread: 'The review has not been read yet.',
  failed: 'The pipeline failed — fix it in a Run session.',
  canceled: 'The pipeline was canceled — re-run it in GitLab.',
  draft: 'Still a draft — mark it ready in GitLab.',
  green: 'Reviewed and green — merge happens in GitLab.',
  noPipeline: 'Reviewed, no pipeline — merge happens in GitLab.'
} as const;

/** The states `Ignore` is offered for (§4.5.1); an entry stored for any other state — only a hand-edited one can be — never draws `ignored`. */
const IGNORABLE_REVIEW: ReadonlySet<string> = new Set(['unread', 'none', 'open', 'stale', 'unknown']);

/**
 * The §4.5 table as one precedence, because the table alone does not fix it: Review before Pipeline before Merge, and the first unfinished one wins, so a
 * failed pipeline under open findings is the review's row (the fix half fixes both). A step counts as finished when it is clean — or ignored, by an entry that
 * still holds (`ignoreHolds`: the state and its stamp are as they were) — and the marker moves on to the next. The review's state comes from `reviewState`, never
 * re-derived here; `reviewing` and `unknown` WAIT instead of ringing a step (nothing the reader can do), and `running` waits the same way; `unknown` still offers
 * `Ignore`, since rule 0 of `reviewState` never clears it on its own and such an MR could otherwise never reach `merge`. A draft's pipeline is `off` in
 * `deliveryLook`, so it never blocks, rings or draws `ignored`: a clean draft is next to be marked ready. A `null` or `'none'` pipeline does not block either
 * (spec decision 4: the worst case is Merge offered a poll early); an ignored failed or canceled one reads as finished, so the merge row is the green row's.
 *
 * Detail only: `deliveryLook` is untouched and keeps drawing the card, the List, the band, the filters and the strip's pill, so a failed pipeline stays red
 * there however many times it was ignored here. The waiting and done rows' pill is `deliveryLook(mr).word`, never `.chip`, which repeats the `!<iid>` the row
 * already prints.
 */
export function deliveryNext(mr: GitlabMr, now: number, ignored: IgnoreEntry | undefined): DeliveryNext {
  const look = deliveryLook(mr, now);
  const noneIgnored = { review: false, pipeline: false };
  // Merged and closed: done (rows 13 and 14). Nothing is next, and an entry for a finished MR is stale by definition — the prune drops it on the next write.
  if (mr.state !== 'opened') {
    return { step: null, word: null, pill: look.word, sentence: null, button: null, ignore: null, ignored: noneIgnored };
  }
  const reviewKind = mr.review === null ? 'unread' : reviewState(mr.review, now);
  const holds = ignoreHolds(ignored, mr, now);
  const reviewIgnored = holds.review && IGNORABLE_REVIEW.has(reviewKind);
  const pipelineIgnored = holds.pipeline && !mr.draft && (mr.pipeline === 'failed' || mr.pipeline === 'canceled');
  const flags = { review: reviewIgnored, pipeline: pipelineIgnored };

  /** A waiting row: nothing is ringed, the pill is the given word. */
  const waiting = (pill: string, over: Partial<DeliveryNext> = {}): DeliveryNext => ({
    step: null,
    word: null,
    pill,
    sentence: null,
    button: null,
    ignore: null,
    ignored: flags,
    ...over
  });
  const ring = (step: 'review' | 'pipeline' | 'merged', word: string, button: NextButton, ignore: DeliveryNext['ignore'], sentence: string | null): DeliveryNext => ({
    step,
    word,
    pill: `next: ${word}`,
    sentence,
    button,
    ignore,
    ignored: flags
  });

  if (!reviewIgnored) {
    switch (reviewKind) {
      case 'unread':
        return waiting(look.word, { sentence: NEXT_SENTENCES.unread, ignore: 'review' });
      case 'none':
        return ring('review', 'review', 'request', 'review', null);
      case 'stale':
        return ring('review', 're-review', 'request', 'review', null);
      case 'open':
        // `reviewKind` is `open` only for a read review; `capped` means the count is a floor, so `<n>+`.
        return ring('review', `fix ${mr.review?.open ?? 0}${mr.review?.capped ? '+' : ''}`, 'fix', 'review', null);
      case 'reviewing':
        return waiting(reviewStepWord(mr.review, now) ?? look.word);
      case 'unknown':
        return waiting(reviewStepWord(mr.review, now) ?? look.word, { ignore: 'review' });
    }
  }
  if (mr.draft) return ring('merged', 'mark ready', 'gitlab', null, NEXT_SENTENCES.draft);
  if (!pipelineIgnored) {
    if (mr.pipeline === 'failed') return ring('pipeline', 'fix pipeline', 'run', 'pipeline', NEXT_SENTENCES.failed);
    if (mr.pipeline === 'canceled') return ring('pipeline', 're-run', 'gitlab', 'pipeline', NEXT_SENTENCES.canceled);
    if (mr.pipeline === 'running') return waiting(look.word);
  }
  const noPipeline = mr.pipeline === null || mr.pipeline === 'none';
  return ring('merged', 'merge', 'merge', null, noPipeline ? NEXT_SENTENCES.noPipeline : NEXT_SENTENCES.green);
}

/** The one definition of "failing" the band and the `Pipeline failing` filter share: opened, not a draft, head pipeline failed. */
function isFailing(mr: GitlabMr): boolean {
  return mr.state === 'opened' && !mr.draft && mr.pipeline === 'failed';
}

/**
 * The Board band's GitLab line (spec §7.2): `GitLab: 3 open · 1 failing · 1 merged · polled 2 m ago`, over the issues that match the board's filters, each
 * issue's lead MR as `ticketDelivery` resolves it — inherited ones included, and never a second derivation of its own, so the band cannot count an MR the card
 * does not show. Each distinct MR counts once however many issues lead with it (an MR carrying two keys). `failing` is a subset of `open`, drafts count in
 * `open` only, and closed MRs are not counted. A zero part is omitted; all three zero reads `no merge requests`.
 *
 * The age is the OLDEST `polledAt` among the projects those issues map, so the line never claims fresher data than its stalest part; while any of them has
 * never been read the line reads `GitLab: not read yet` instead. `null` when no matching issue draws delivery — the band then has no GitLab line at all.
 * The sentence is `bandDelivery`'s `text`, so the band's pills and this line cannot count two ways.
 */
export function bandTotals(issues: readonly JiraIssue[], index: DeliveryIndex, now: number): string | null {
  return bandDelivery(issues, index, now)?.text ?? null;
}

/** One count pill of the band's GitLab half: `2 open`, `1 failing`, `1 merged`. */
export interface BandDeliveryPart {
  n: number;
  word: 'open' | 'failing' | 'merged';
}

/**
 * `bandTotals` taken apart for the band's pills (mock A, 2026-11-18; DESIGN.md §8.9.1): `parts`, each NON-zero count in open · failing · merged order (empty
 * when every lead is closed, which the band reads as `no merge requests`); `age` (`2m ago`, or `null` while a project was never read); `polled`, the age's
 * whole phrase (`polled 2m ago` / `not read yet`) for the dot's title; `tone` for the dot; and `text`, `bandTotals`' sentence, the row's title.
 *
 * `tone` is grey while a project was never read, red when the last read of any of them failed (`GitlabProjectView.failed`), and green otherwise. There is
 * no amber: a GitLab project view carries no interval of its own to be late against, and inventing one here would be a second meaning of "late".
 */
export function bandDelivery(
  issues: readonly JiraIssue[],
  index: DeliveryIndex,
  now: number
): { parts: BandDeliveryPart[]; age: string | null; polled: string; tone: StateTone; text: string } | null {
  const projects = new Map<string, GitlabProjectView>();
  const leads = new Map<string, GitlabMr>();
  for (const issue of issues) {
    const d = ticketDelivery(issue, index);
    if (d.kind === 'hidden') continue;
    for (const v of index.jiraProjects[issue.project.key] ?? []) projects.set(v.path, v);
    if (d.kind === 'mrs') leads.set(`${d.lead.project}!${d.lead.iid}`, d.lead);
  }
  if (projects.size === 0) return null;

  const views = [...projects.values()];
  if (views.some((v) => v.polledAt === null)) return { parts: [], age: null, polled: 'not read yet', tone: 'grey', text: 'GitLab: not read yet' };
  let oldest = views[0].polledAt as string;
  for (const v of views) if (Date.parse(v.polledAt as string) < Date.parse(oldest)) oldest = v.polledAt as string;

  const all = [...leads.values()];
  const counts: BandDeliveryPart[] = [
    { n: all.filter((m) => m.state === 'opened').length, word: 'open' },
    { n: all.filter(isFailing).length, word: 'failing' },
    { n: all.filter((m) => m.state === 'merged').length, word: 'merged' }
  ];
  const parts = counts.filter((p) => p.n > 0);
  const polled = polledPhrase(oldest, now);
  const body = parts.length > 0 ? parts.map((p) => `${p.n} ${p.word}`).join(' · ') : 'no merge requests';
  const age = pollAge(oldest, now);
  return {
    parts,
    age: age === null ? null : `${age} ago`,
    polled,
    tone: views.some((v) => v.failed) ? 'red' : 'green',
    text: `GitLab: ${body} · ${polled}`
  };
}

/** The quick filter's one value (spec §7.4), persisted with the panel filters. */
export type DeliveryFilter = 'all' | 'has-mr' | 'failing' | 'done-not-merged' | 'review-open';

/** The words both controls draw for each value, in the order they draw them. */
export const DELIVERY_FILTER_LABELS: Record<DeliveryFilter, string> = {
  all: 'All',
  'has-mr': 'Has MR',
  failing: 'Pipeline failing',
  'done-not-merged': 'Done, not merged',
  'review-open': 'Review open'
};

/**
 * The stored filter as it applies: `all` whenever delivery is not shown (`deliveryShown`), so a `Pipeline failing` stored before GitLab was unconfigured or
 * unarmed neither empties the board nor lights the filter badge — the user has no control to see or clear it (spec §7.4, Review Focus 5).
 */
export function effectiveDeliveryFilter(stored: DeliveryFilter, shown: boolean): DeliveryFilter {
  return shown ? stored : 'all';
}

/**
 * Does a ticket's delivery match a filter value (spec §7.4)? `all` always does. A `hidden` or `unknown` ticket matches no other value — an unknown one may
 * well have an MR the list did not reach, and a filter that claimed otherwise would be guessing. `has-mr` is any opened or merged MR, own or inherited —
 * since the lead is the newest opened, else merged, else closed, that is "the lead is not closed". `failing` reads the lead only, own or inherited, through
 * the band's `isFailing`; `done-not-merged` is `notMerged` exactly, so inherited never matches. `review-open` reads the lead only, own or inherited, and
 * needs the clock because the review's state does (CodeRabbit spec §5.4).
 */
export function matchesDelivery(filter: DeliveryFilter, d: TicketDelivery, now: number): boolean {
  if (filter === 'all') return true;
  if (d.kind !== 'mrs') return false;
  switch (filter) {
    case 'has-mr':
      return d.lead.state !== 'closed';
    case 'failing':
      return isFailing(d.lead);
    case 'done-not-merged':
      return d.notMerged;
    case 'review-open':
      return d.lead.state === 'opened' && d.lead.review !== null && reviewState(d.lead.review, now) === 'open';
  }
}
