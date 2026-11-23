import {
  DELIVERY_FILTER_LABELS,
  bandDelivery,
  bandTotals,
  deliveryIndex,
  deliveryLook,
  deliveryNext,
  deliveryShown,
  deliveryTargets,
  effectiveDeliveryFilter,
  leadMr,
  matchesDelivery,
  mrRepo,
  olderMrsLine,
  ticketDelivery
} from '../../client/src/lib/delivery';
import type { DeliveryFilter, DeliveryLook, DeliveryNext, TicketDelivery, TrackStep } from '../../client/src/lib/delivery';
import type { IgnoreEntry } from '../../client/src/lib/ignored-steps';
import { reviewStepWord } from '../../client/src/lib/review-copy';
import { polledPhrase } from '../../client/src/lib/tracker';
import type { GitlabMr, GitlabPayload, GitlabReview, GitlabPipeline, GitlabProjectView, GitlabStatus, JiraIssue } from '../../shared/types';

/**
 * The delivery derivations (GitLab connection spec §7). Fixtures discriminate: every MR carries its own iid, branch, project and `updatedAt`, so a reading
 * that crossed an MR, a project or a ticket would not pass by coincidence. `.ts` suite: `now` is passed in explicitly, so the literal instants are fixed.
 */

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MS_PER_MINUTE = 60_000;
const minutesAgo = (m: number): string => new Date(NOW - m * MS_PER_MINUTE).toISOString();

function mr(over: Partial<GitlabMr> = {}): GitlabMr {
  const iid = over.iid ?? 412;
  return {
    project: 'development/backend/microservice',
    iid,
    title: `TIMIFY-123 | change ${iid}`,
    webUrl: `https://gitlab.example.test/development/backend/microservice/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: `timify-123-change-${iid}`,
    targetBranch: 'develop',
    createdAt: '2026-11-10T08:00:00Z',
    updatedAt: '2026-11-11T10:00:00Z',
    mergedAt: null,
    pipeline: 'success',
    keys: ['TIMIFY-123'],
    review: null,
    ...over
  };
}

function view(over: Partial<GitlabProjectView> = {}): GitlabProjectView {
  return { path: 'development/backend/microservice', repo: 'microservice', polledAt: minutesAgo(1), capped: false, failed: false, repos: [], ...over };
}

function status(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'connected',
    site: 'gitlab.example.test',
    malformedSite: false,
    user: { username: 'ada', name: 'Ada' },
    httpStatus: null,
    reason: null,
    armed: true,
    retryAt: null,
    mappedRepos: 1,
    foundHosts: [],
    problems: [],
    interval: '1m',
    ...over
  };
}

function payload(mrs: GitlabMr[], jiraProjects: Record<string, GitlabProjectView[]> = { TIMIFY: [view()] }, st: Partial<GitlabStatus> = {}): GitlabPayload {
  return { status: status(st), jiraProjects, mrs };
}

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  const key = over.key ?? 'TIMIFY-123';
  return {
    key,
    id: `id-${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `summary of ${key}`,
    project: { key: key.split('-')[0], name: 'Timify' },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: '2026-11-01T08:00:00Z',
    updated: '2026-11-11T08:00:00Z',
    resolved: null,
    ...over
  };
}

const subtaskOf = (key: string, parent: string, over: Partial<JiraIssue> = {}): JiraIssue =>
  issue({ key, type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: parent, summary: `summary of ${parent}`, type: null, status: null }, ...over });

const marks = (track: TrackStep[]): string[] => track.map((t) => `${t.step} ${t.mark}`);

describe('deliveryLook', () => {
  it.each<[string, Partial<GitlabMr>, string, string, string, string[]]>([
    ['opened draft, failed pipeline', { iid: 419, draft: true, pipeline: 'failed' }, '!419 · draft', 'draft', 'grey', ['pushed on', 'open grey', 'review off', 'pipeline off', 'merged off']],
    ['opened, success', { iid: 412, pipeline: 'success' }, '!412 · ✓ pipeline', 'pipeline passed', 'green', ['pushed on', 'open on', 'review off', 'pipeline green', 'merged off']],
    ['opened, failed', { iid: 415, pipeline: 'failed' }, '!415 · ✕ pipeline failed', 'pipeline failed', 'red', ['pushed on', 'open on', 'review off', 'pipeline red', 'merged off']],
    ['opened, running', { iid: 416, pipeline: 'running' }, '!416 · ◷ running', 'pipeline running', 'amber', ['pushed on', 'open on', 'review off', 'pipeline amber', 'merged off']],
    ['opened, canceled', { iid: 417, pipeline: 'canceled' }, '!417 · pipeline canceled', 'pipeline canceled', 'grey', ['pushed on', 'open on', 'review off', 'pipeline grey', 'merged off']],
    ['opened, no pipeline', { iid: 418, pipeline: 'none' }, '!418 · open', 'open, no pipeline', 'grey', ['pushed on', 'open on', 'review off', 'pipeline off', 'merged off']],
    ['merged', { iid: 398, state: 'merged', pipeline: null }, '!398 · merged', 'merged', 'magenta', ['pushed magenta', 'open magenta', 'review magenta', 'pipeline magenta', 'merged magenta']],
    ['closed', { iid: 390, state: 'closed', pipeline: null }, '!390 · closed', 'closed', 'grey', ['pushed on', 'open on', 'review off', 'pipeline off', 'closed grey']]
  ])('%s', (_name, over, chip, word, tone, track) => {
    const look = deliveryLook(mr(over), NOW);
    expect(look.chip).toBe(chip);
    expect(look.word).toBe(word);
    expect(look.tone).toBe(tone);
    expect(marks(look.track)).toEqual(track);
  });

  it('reads an open MR whose pipeline was never read (null) as having none, never as passing', () => {
    expect(deliveryLook(mr({ iid: 420, pipeline: null }), NOW).word).toBe('open, no pipeline');
  });
});

function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 0,
    resolved: 0,
    worst: null,
    bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 },
    triggeredAt: minutesAgo(600),
    landedAt: minutesAgo(590),
    commitsSince: 0,
    capped: false,
    readAt: minutesAgo(1),
    failed: false,
    ...over
  };
}
const twoOpen = (over: Partial<GitlabReview> = {}): GitlabReview =>
  review({ open: 2, worst: 'major', bySeverity: { critical: 0, major: 1, minor: 1, trivial: 0, other: 0 }, ...over });

describe('deliveryLook with a CodeRabbit review', () => {
  it('open findings: the chip, the word, amber, the Review step amber, and the pipeline word kept apart', () => {
    const look = deliveryLook(mr({ iid: 15958, pipeline: 'success', review: twoOpen() }), NOW);
    expect(look.chip).toBe('!15958 · 2 to fix');
    expect(look.word).toBe('2 to fix');
    expect(look.tone).toBe('amber');
    expect(look.pipelineWord).toBe('pipeline passed');
    expect(marks(look.track)).toEqual(['pushed on', 'open on', 'review amber', 'pipeline green', 'merged off']);
  });

  it('a failed pipeline beats the findings', () => {
    const look = deliveryLook(mr({ pipeline: 'failed', review: twoOpen() }), NOW);
    expect(look.word).toBe('pipeline failed');
    expect(look.tone).toBe('red');
    expect(look.pipelineWord).toBe('pipeline failed');
    expect(marks(look.track)).toEqual(['pushed on', 'open on', 'review amber', 'pipeline red', 'merged off']);
  });

  it('a draft stays a draft over its findings, and still draws the Review step', () => {
    const look = deliveryLook(mr({ iid: 419, draft: true, pipeline: 'success', review: twoOpen() }), NOW);
    expect(look.chip).toBe('!419 · draft');
    expect(look.word).toBe('draft');
    expect(look.tone).toBe('grey');
    expect(marks(look.track)).toEqual(['pushed on', 'open grey', 'review amber', 'pipeline off', 'merged off']);
  });

  it('a capped count reads n+', () => {
    const look = deliveryLook(mr({ iid: 7, review: review({ open: 5, capped: true }) }), NOW);
    expect(look.word).toBe('5+ to fix');
    expect(look.chip).toBe('!7 · 5+ to fix');
  });

  it('review null: the pipeline word and an off Review step', () => {
    const look = deliveryLook(mr({ pipeline: 'running', review: null }), NOW);
    expect(look.word).toBe('pipeline running');
    expect(look.pipelineWord).toBe('pipeline running');
    expect(marks(look.track)).toEqual(['pushed on', 'open on', 'review off', 'pipeline amber', 'merged off']);
  });

  it.each<[string, Partial<GitlabReview>, string]>([
    ['none', { triggeredAt: null, landedAt: null }, 'off'],
    ['unknown', { capped: true, open: 0 }, 'off'],
    ['reviewing', { triggeredAt: minutesAgo(4), landedAt: null }, 'grey'],
    ['stale', { commitsSince: 3 }, 'grey'],
    ['clean', { resolved: 25 }, 'green']
  ])('Review step mark for %s', (_n, over, mark) => {
    const look = deliveryLook(mr({ review: review(over) }), NOW);
    expect(look.track[2]).toEqual({ step: 'review', mark });
    expect(look.word).toBe('pipeline passed');
  });

  it('merged: five magenta steps; closed: Review off and ends on closed, whatever the review says', () => {
    expect(marks(deliveryLook(mr({ state: 'merged', pipeline: null, review: twoOpen() }), NOW).track)).toEqual([
      'pushed magenta', 'open magenta', 'review magenta', 'pipeline magenta', 'merged magenta'
    ]);
    expect(marks(deliveryLook(mr({ state: 'closed', pipeline: null, review: twoOpen() }), NOW).track)).toEqual([
      'pushed on', 'open on', 'review off', 'pipeline off', 'closed grey'
    ]);
  });
});

describe('leadMr', () => {
  it('an opened MR beats a merged one updated later', () => {
    const opened = mr({ iid: 1, updatedAt: '2026-11-11T10:00:00Z' });
    const merged = mr({ iid: 2, state: 'merged', pipeline: null, updatedAt: '2026-11-11T12:00:00Z' });
    expect(leadMr([merged, opened])).toEqual({ lead: opened, also: [merged] });
  });

  it('two opened at the same instant: the project path ascending wins', () => {
    const ax = mr({ iid: 5, project: 'a/x' });
    const by = mr({ iid: 6, project: 'b/y' });
    expect(leadMr([by, ax]).lead).toBe(ax);
    expect(leadMr([ax, by]).lead).toBe(ax);
  });

  it('same project, same instant: the higher iid wins', () => {
    const seven = mr({ iid: 7 });
    const nine = mr({ iid: 9 });
    expect(leadMr([seven, nine]).lead).toBe(nine);
    expect(leadMr([nine, seven]).lead).toBe(nine);
  });

  it('no opened: a merged MR beats a closed one updated later', () => {
    const merged = mr({ iid: 3, state: 'merged', pipeline: null, updatedAt: '2026-11-11T09:00:00Z' });
    const closed = mr({ iid: 4, state: 'closed', pipeline: null, updatedAt: '2026-11-11T11:00:00Z' });
    expect(leadMr([closed, merged])).toEqual({ lead: merged, also: [closed] });
  });

  it('the newest opened leads among several', () => {
    const older = mr({ iid: 10, updatedAt: '2026-11-11T08:00:00Z' });
    const newer = mr({ iid: 11, updatedAt: '2026-11-11T09:00:00Z' });
    expect(leadMr([older, newer]).lead).toBe(newer);
  });
});

describe('deliveryTargets', () => {
  const DAY = 24 * 60;
  const merged = (iid: number, target: string, days: number): GitlabMr =>
    mr({ iid, state: 'merged', pipeline: null, targetBranch: target, updatedAt: minutesAgo(days * DAY) });
  const closed = (iid: number, target: string, days: number): GitlabMr =>
    mr({ iid, state: 'closed', pipeline: null, targetBranch: target, updatedAt: minutesAgo(days * DAY) });
  const open = (iid: number, target: string, days: number, over: Partial<GitlabMr> = {}): GitlabMr =>
    mr({ iid, targetBranch: target, updatedAt: minutesAgo(days * DAY), ...over });
  const targetsOf = (mrs: GitlabMr[]): string[] => deliveryTargets(mrs).map((t) => t.target);

  it('T1: one MR is one group with no older MRs and no line', () => {
    const only = mr({ iid: 1 });
    const groups = deliveryTargets([only]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ project: only.project, target: 'develop', lead: only, older: [] });
    expect(olderMrsLine(groups[0])).toBeNull();
  });

  it('no MRs is no groups, and does not throw', () => {
    expect(deliveryTargets([])).toEqual([]);
  });

  it('T2: two open MRs into develop and demo are ordered by their leads, newest update first', () => {
    expect(targetsOf([open(1, 'develop', 1), open(2, 'demo', 2)])).toEqual(['develop', 'demo']);
    expect(targetsOf([open(1, 'develop', 2), open(2, 'demo', 1)])).toEqual(['demo', 'develop']);
    expect(targetsOf([open(2, 'demo', 1), open(1, 'develop', 2)])).toEqual(['demo', 'develop']);
  });

  it('T2b: an open lead outranks a merged one whatever the stamps', () => {
    expect(targetsOf([merged(1, 'develop', 1), open(2, 'demo', 5)])).toEqual(['demo', 'develop']);
  });

  it('T3: older MRs are counted and summarised per target', () => {
    const mrs = [
      open(1, 'develop', 1),
      merged(2, 'develop', 3),
      merged(3, 'develop', 4),
      open(4, 'demo', 2),
      merged(5, 'demo', 5),
      merged(6, 'demo', 6),
      merged(7, 'demo', 7),
      closed(8, 'demo', 8)
    ];
    const groups = deliveryTargets(mrs);
    const develop = groups.find((t) => t.target === 'develop')!;
    const demo = groups.find((t) => t.target === 'demo')!;
    expect(demo.older).toHaveLength(4);
    expect(olderMrsLine(demo)).toBe('4 earlier MRs into demo · 3 merged, 1 closed');
    expect(develop.older).toHaveLength(2);
    expect(olderMrsLine(develop)).toBe('2 earlier MRs into develop · 2 merged');
  });

  it('an older open MR: the newer open one leads and the open part goes last in the line', () => {
    const newer = open(1, 'demo', 1);
    const older = open(2, 'demo', 3);
    const gone = merged(3, 'demo', 2);
    const [t] = deliveryTargets([older, gone, newer]);
    expect(t.lead).toBe(newer);
    expect(t.older).toEqual([gone, older]);
    expect(olderMrsLine(t)).toBe('2 earlier MRs into demo · 1 merged, 1 open');
  });

  it('the older parts: a zero part drops with its comma, and a single older MR is singular', () => {
    const [a] = deliveryTargets([open(1, 'demo', 1), closed(2, 'demo', 2), open(3, 'demo', 3)]);
    expect(olderMrsLine(a)).toBe('2 earlier MRs into demo · 1 closed, 1 open');
    const [b] = deliveryTargets([open(1, 'demo', 1), merged(2, 'demo', 2)]);
    expect(olderMrsLine(b)).toBe('1 earlier MR into demo · 1 merged');
  });

  it('T4: the same target branch in two projects is two groups', () => {
    const api = open(1, 'develop', 1, { project: 'acme/pay-api' });
    const web = open(2, 'develop', 2, { project: 'acme/pay-web' });
    const groups = deliveryTargets([web, api]);
    expect(groups.map((g) => [g.project, g.target, g.lead.iid])).toEqual([
      ['acme/pay-api', 'develop', 1],
      ['acme/pay-web', 'develop', 2]
    ]);
    expect(groups.every((g) => g.older.length === 0)).toBe(true);
  });

  it('T5: a target with only merged MRs leads with the newest', () => {
    const [t] = deliveryTargets([merged(1, 'demo', 3), merged(2, 'demo', 1), merged(3, 'demo', 2)]);
    expect(t.lead.iid).toBe(2);
    expect(t.older.map((m) => m.iid)).toEqual([3, 1]);
  });

  it('older is newest updatedAt first, not leadMr state order', () => {
    const mrs = [open(10, 'demo', 0.5), merged(13, 'demo', 3), closed(12, 'demo', 2), merged(11, 'demo', 1)];
    const [t] = deliveryTargets(mrs);
    expect(t.older.map((m) => m.iid)).toEqual([11, 12, 13]);
    // The contrast: leadMr's own `also` ranks merged before closed, which is the order the older fold must NOT take.
    expect(leadMr(mrs).also.map((m) => m.iid)).toEqual([11, 13, 12]);
  });

  it('T6: the first group leads with leadMr over the whole list', () => {
    const fixtures: GitlabMr[][] = [
      [mr({ iid: 1 })],
      [open(1, 'develop', 1), open(2, 'demo', 2)],
      [open(1, 'develop', 2), open(2, 'demo', 1)],
      [merged(1, 'develop', 1), merged(2, 'develop', 2), closed(3, 'demo', 1)],
      [merged(1, 'demo', 3), merged(2, 'demo', 1), merged(3, 'demo', 2)],
      [open(1, 'develop', 1, { project: 'acme/pay-api' }), open(2, 'develop', 1, { project: 'acme/pay-web' })]
    ];
    for (const mrs of fixtures) expect(deliveryTargets(mrs)[0].lead).toBe(leadMr(mrs).lead);
  });
});

describe('ticketDelivery', () => {
  it('a ticket with its own MRs shows them, the lead first and the polledAt of its project', () => {
    const own = mr({ iid: 412 });
    const other = mr({ iid: 398, state: 'merged', pipeline: null, sourceBranch: 'hotfix/timify-123' });
    const d = ticketDelivery(issue(), deliveryIndex(payload([own, other])));
    expect(d).toEqual({ kind: 'mrs', lead: own, also: [other], via: null, notMerged: false, polledAt: minutesAgo(1) });
  });

  it('a sub-task with none of its own inherits its parent’s, via the parent key', () => {
    const parents = mr({ iid: 500, keys: ['TIMIFY-100'], sourceBranch: 'timify-100-story' });
    const d = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), deliveryIndex(payload([parents])));
    expect(d).toMatchObject({ kind: 'mrs', lead: parents, via: 'TIMIFY-100' });
  });

  it('a sub-task with MRs of its own shows those and not the parent’s', () => {
    const parents = mr({ iid: 500, keys: ['TIMIFY-100'], sourceBranch: 'timify-100-story' });
    const own = mr({ iid: 501, keys: ['TIMIFY-101'], sourceBranch: 'timify-101-sub', updatedAt: '2026-11-01T00:00:00Z' });
    const d = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), deliveryIndex(payload([parents, own])));
    expect(d).toMatchObject({ kind: 'mrs', lead: own, also: [], via: null });
  });

  it('a story under an epic inherits nothing — it is `none`, not the epic’s', () => {
    const epics = mr({ iid: 600, keys: ['TIMIFY-1'], sourceBranch: 'timify-1-epic' });
    const story = issue({ key: 'TIMIFY-50', parent: { key: 'TIMIFY-1', summary: 'the epic', type: null, status: null } });
    expect(ticketDelivery(story, deliveryIndex(payload([epics])))).toEqual({ kind: 'none', repos: ['microservice'] });
  });

  it('inheritance is one level: a sub-task whose parent has none never reaches the grandparent', () => {
    const grand = mr({ iid: 700, keys: ['TIMIFY-1'], sourceBranch: 'timify-1-epic' });
    expect(ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), deliveryIndex(payload([grand])))).toEqual({ kind: 'none', repos: ['microservice'] });
  });

  it('a ticket whose Jira project maps no GitLab project is hidden', () => {
    const d = ticketDelivery(issue({ key: 'PAY-7' }), deliveryIndex(payload([mr({ keys: ['PAY-7'] })])));
    expect(d).toEqual({ kind: 'hidden' });
  });

  it('a project mapped to an empty list is hidden too', () => {
    expect(ticketDelivery(issue(), deliveryIndex(payload([], { TIMIFY: [] })))).toEqual({ kind: 'hidden' });
  });

  it('no MR and a mapped project never read: unknown, not-read', () => {
    const idx = deliveryIndex(payload([], { TIMIFY: [view(), view({ path: 'b/other', repo: 'other', polledAt: null })] }));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'unknown', why: 'not-read' });
  });

  it('no MR and a mapped project never read and failing: unknown, failed', () => {
    const idx = deliveryIndex(payload([], { TIMIFY: [view({ polledAt: null, failed: true })] }));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'unknown', why: 'failed' });
  });

  it('no MR and a capped project: unknown, capped', () => {
    const idx = deliveryIndex(payload([], { TIMIFY: [view({ capped: true })] }));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'unknown', why: 'capped' });
  });

  it('read once and failing now: a known ticket stays known — `none`, not unknown', () => {
    const idx = deliveryIndex(payload([], { TIMIFY: [view({ failed: true })] }));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'none', repos: ['microservice'] });
  });

  it('read and none: the mapped repo basenames', () => {
    const idx = deliveryIndex(payload([mr({ keys: ['TIMIFY-999'] })]));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'none', repos: ['microservice'] });
  });

  it('an MR found in a never-read project still shows: the MR is known even if the rest is not', () => {
    const idx = deliveryIndex(payload([mr()], { TIMIFY: [view(), view({ path: 'b/other', repo: 'other', polledAt: null })] }));
    expect(ticketDelivery(issue(), idx).kind).toBe('mrs');
  });

  it('done with its own opened lead: notMerged', () => {
    const d = ticketDelivery(issue({ status: { name: 'Done', category: 'done' } }), deliveryIndex(payload([mr()])));
    expect(d).toMatchObject({ kind: 'mrs', notMerged: true });
  });

  it('done with an inherited opened lead: never notMerged', () => {
    const parents = mr({ iid: 500, keys: ['TIMIFY-100'] });
    const sub = subtaskOf('TIMIFY-101', 'TIMIFY-100', { status: { name: 'Done', category: 'done' } });
    expect(ticketDelivery(sub, deliveryIndex(payload([parents])))).toMatchObject({ kind: 'mrs', via: 'TIMIFY-100', notMerged: false });
  });

  it('done with its own merged lead: not notMerged', () => {
    const d = ticketDelivery(issue({ status: { name: 'Done', category: 'done' } }), deliveryIndex(payload([mr({ state: 'merged', pipeline: null })])));
    expect(d).toMatchObject({ kind: 'mrs', notMerged: false });
  });

  it('polledAt is the lead MR’s own project’s, not another mapped project’s', () => {
    const other = mr({ project: 'b/other', iid: 77 });
    const idx = deliveryIndex(payload([other], { TIMIFY: [view(), view({ path: 'b/other', repo: 'other', polledAt: minutesAgo(9) })] }));
    expect(ticketDelivery(issue(), idx)).toMatchObject({ kind: 'mrs', polledAt: minutesAgo(9) });
  });

  it('key boundary: an MR keyed TIMIFY-1234 never shows on TIMIFY-123', () => {
    const idx = deliveryIndex(payload([mr({ iid: 1234, keys: ['TIMIFY-1234'], sourceBranch: 'timify-1234-x', title: 'TIMIFY-1234 | x' })]));
    expect(ticketDelivery(issue(), idx)).toEqual({ kind: 'none', repos: ['microservice'] });
    expect(ticketDelivery(issue({ key: 'TIMIFY-1234' }), idx).kind).toBe('mrs');
  });

  it('an MR carrying two keys shows on each', () => {
    const both = mr({ keys: ['TIMIFY-123', 'TIMIFY-124'] });
    const idx = deliveryIndex(payload([both]));
    expect(ticketDelivery(issue(), idx)).toMatchObject({ kind: 'mrs', lead: both });
    expect(ticketDelivery(issue({ key: 'TIMIFY-124' }), idx)).toMatchObject({ kind: 'mrs', lead: both });
  });
});

describe('bandTotals', () => {
  // One top per lead; each top's own key carries exactly the one MR named.
  const top = (n: number, over: Partial<JiraIssue> = {}): JiraIssue => issue({ key: `TIMIFY-${n}`, ...over });
  const leading = (n: number, over: Partial<GitlabMr>): GitlabMr => mr({ keys: [`TIMIFY-${n}`], sourceBranch: `timify-${n}-x`, ...over });

  it('counts each top’s lead once, a draft in open and not failing, closed uncounted', () => {
    const merged398 = mr({ iid: 398, state: 'merged', pipeline: null, keys: ['TIMIFY-4', 'TIMIFY-6'], sourceBranch: 'timify-4-timify-6' });
    const idx = deliveryIndex(
      payload([
        leading(1, { iid: 412, pipeline: 'success' }),
        leading(2, { iid: 415, pipeline: 'failed' }),
        leading(3, { iid: 419, draft: true, pipeline: 'failed' }),
        merged398,
        leading(5, { iid: 390, state: 'closed', pipeline: null })
      ])
    );
    const tops = [1, 2, 3, 4, 5, 6].map((n) => top(n));
    expect(bandTotals(tops, idx, NOW)).toBe(`GitLab: 3 open · 1 failing · 1 merged · ${polledPhrase(minutesAgo(1), NOW)}`);
  });

  it('every lead closed: no merge requests', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 390, state: 'closed', pipeline: null })]));
    expect(bandTotals([top(1), top(2)], idx, NOW)).toBe(`GitLab: no merge requests · ${polledPhrase(minutesAgo(1), NOW)}`);
  });

  it('a zero part is omitted', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 398, state: 'merged', pipeline: null })]));
    expect(bandTotals([top(1)], idx, NOW)).toBe(`GitLab: 1 merged · ${polledPhrase(minutesAgo(1), NOW)}`);
  });

  it('a top whose project was never read: not read yet', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 412 })], { TIMIFY: [view(), view({ path: 'b/other', repo: 'other', polledAt: null })] }));
    expect(bandTotals([top(1)], idx, NOW)).toBe('GitLab: not read yet');
  });

  it('the age is the OLDEST polledAt among the tops’ projects', () => {
    const idx = deliveryIndex(
      payload([leading(1, { iid: 412 }), mr({ iid: 9, keys: ['PAY-1'], project: 'pay/api' })], {
        TIMIFY: [view({ polledAt: minutesAgo(1) })],
        PAY: [view({ path: 'pay/api', repo: 'api', polledAt: minutesAgo(5) })]
      })
    );
    expect(bandTotals([top(1), issue({ key: 'PAY-1' })], idx, NOW)).toBe(`GitLab: 2 open · ${polledPhrase(minutesAgo(5), NOW)}`);
    expect(polledPhrase(minutesAgo(5), NOW)).not.toBe(polledPhrase(minutesAgo(1), NOW));
  });

  it('null when no top draws delivery', () => {
    const idx = deliveryIndex(payload([]));
    expect(bandTotals([issue({ key: 'PAY-1' })], idx, NOW)).toBeNull();
    expect(bandTotals([], idx, NOW)).toBeNull();
  });

  // Controller ruling: the band derives each lead through ticketDelivery/leadMr, never a second derivation. Each fixture below is one a derivation of its
  // own would get wrong: "the newest MR" picks the merged one; "the top's own MRs" misses the inherited one.
  it('leads by the leadMr order rule — an older opened beats a newer merged on the same top', () => {
    const idx = deliveryIndex(
      payload([
        leading(1, { iid: 412, pipeline: 'failed', updatedAt: '2026-11-11T08:00:00Z' }),
        leading(1, { iid: 398, state: 'merged', pipeline: null, updatedAt: '2026-11-11T12:00:00Z' })
      ])
    );
    expect(bandTotals([top(1)], idx, NOW)).toBe(`GitLab: 1 open · 1 failing · ${polledPhrase(minutesAgo(1), NOW)}`);
  });

  it('a sub-task top counts its inherited lead', () => {
    const idx = deliveryIndex(payload([mr({ iid: 500, keys: ['TIMIFY-100'], state: 'merged', pipeline: null })]));
    expect(bandTotals([subtaskOf('TIMIFY-101', 'TIMIFY-100')], idx, NOW)).toBe(`GitLab: 1 merged · ${polledPhrase(minutesAgo(1), NOW)}`);
  });
});

// The band's GitLab half as pills (mock A): `bandTotals`' counts as parts, the oldest age, and a tone for its dot. `text` is `bandTotals`' sentence, which
// the row keeps as its `title` — `bandTotals` itself is now `bandDelivery(...)?.text`, so the two cannot count differently.
describe('bandDelivery', () => {
  const top = (n: number): JiraIssue => issue({ key: `TIMIFY-${n}` });
  const leading = (n: number, over: Partial<GitlabMr>): GitlabMr => mr({ keys: [`TIMIFY-${n}`], sourceBranch: `timify-${n}-x`, ...over });

  it('names each non-zero count as a part, in open · failing · merged order, with the oldest age and a green dot', () => {
    const idx = deliveryIndex(
      payload([leading(1, { iid: 412, pipeline: 'success' }), leading(2, { iid: 415, pipeline: 'failed' }), leading(3, { iid: 398, state: 'merged', pipeline: null })])
    );
    const d = bandDelivery([top(1), top(2), top(3)], idx, NOW);
    expect(d).toMatchObject({
      parts: [
        { n: 2, word: 'open' },
        { n: 1, word: 'failing' },
        { n: 1, word: 'merged' }
      ],
      polled: polledPhrase(minutesAgo(1), NOW),
      tone: 'green'
    });
    expect(d?.age).toMatch(/ ago$/);
    expect(d?.text).toBe(bandTotals([top(1), top(2), top(3)], idx, NOW));
  });

  it('has no parts when every lead is closed', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 390, state: 'closed', pipeline: null })]));
    expect(bandDelivery([top(1)], idx, NOW)?.parts).toEqual([]);
  });

  it('is grey with no age while a project was never read', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 412 })], { TIMIFY: [view({ polledAt: null })] }));
    expect(bandDelivery([top(1)], idx, NOW)).toMatchObject({ parts: [], age: null, polled: 'not read yet', tone: 'grey' });
  });

  it('is red when the last read of a project failed', () => {
    const idx = deliveryIndex(payload([leading(1, { iid: 412 })], { TIMIFY: [view({ failed: true })] }));
    expect(bandDelivery([top(1)], idx, NOW)?.tone).toBe('red');
  });

  it('is null when no issue draws delivery', () => {
    expect(bandDelivery([issue({ key: 'PAY-1' })], deliveryIndex(payload([])), NOW)).toBeNull();
  });
});

describe('matchesDelivery', () => {
  const idx = (mrs: GitlabMr[], jiraProjects?: Record<string, GitlabProjectView[]>) => deliveryIndex(payload(mrs, jiraProjects));
  const ownOpened = ticketDelivery(issue(), idx([mr({ pipeline: 'success' })]));
  const ownFailed = ticketDelivery(issue(), idx([mr({ pipeline: 'failed' })]));
  const draftFailed = ticketDelivery(issue(), idx([mr({ draft: true, pipeline: 'failed' })]));
  const inheritedMerged = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), idx([mr({ keys: ['TIMIFY-100'], state: 'merged', pipeline: null })]));
  const inheritedFailed = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), idx([mr({ keys: ['TIMIFY-100'], pipeline: 'failed' })]));
  const closedOnly = ticketDelivery(issue(), idx([mr({ state: 'closed', pipeline: null })]));
  const none = ticketDelivery(issue(), idx([]));
  const unknown = ticketDelivery(issue(), idx([], { TIMIFY: [view({ polledAt: null })] }));
  const hidden = ticketDelivery(issue({ key: 'PAY-1' }), idx([]));
  const doneOwn = ticketDelivery(issue({ status: { name: 'Done', category: 'done' } }), idx([mr()]));
  const doneInherited = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100', { status: { name: 'Done', category: 'done' } }), idx([mr({ keys: ['TIMIFY-100'] })]));

  it('fixtures are the kinds they claim', () => {
    expect([unknown.kind, hidden.kind, none.kind]).toEqual(['unknown', 'hidden', 'none']);
  });

  it('all matches everything', () => {
    for (const d of [ownOpened, closedOnly, none, unknown, hidden]) expect(matchesDelivery('all', d, NOW)).toBe(true);
  });

  it('has-mr: own opened and inherited merged; not closed-only, none or unknown', () => {
    expect(matchesDelivery('has-mr', ownOpened, NOW)).toBe(true);
    expect(matchesDelivery('has-mr', inheritedMerged, NOW)).toBe(true);
    expect(matchesDelivery('has-mr', closedOnly, NOW)).toBe(false);
    expect(matchesDelivery('has-mr', none, NOW)).toBe(false);
    expect(matchesDelivery('has-mr', unknown, NOW)).toBe(false);
  });

  it('failing: an opened non-draft failed lead, own or inherited; never a draft', () => {
    expect(matchesDelivery('failing', ownFailed, NOW)).toBe(true);
    expect(matchesDelivery('failing', inheritedFailed, NOW)).toBe(true);
    expect(matchesDelivery('failing', draftFailed, NOW)).toBe(false);
    expect(matchesDelivery('failing', ownOpened, NOW)).toBe(false);
  });

  it('done-not-merged mirrors notMerged', () => {
    expect(matchesDelivery('done-not-merged', doneOwn, NOW)).toBe(true);
    expect(matchesDelivery('done-not-merged', doneInherited, NOW)).toBe(false);
    expect(matchesDelivery('done-not-merged', ownOpened, NOW)).toBe(false);
  });

  it('hidden and unknown match no value but all', () => {
    const values = Object.keys(DELIVERY_FILTER_LABELS).filter((v) => v !== 'all') as DeliveryFilter[];
    expect(values).toHaveLength(4);
    for (const v of values) for (const d of [hidden, unknown] as TicketDelivery[]) expect(matchesDelivery(v, d, NOW)).toBe(false);
  });

  it('labels are the spec’s', () => {
    expect(DELIVERY_FILTER_LABELS).toEqual({ all: 'All', 'has-mr': 'Has MR', failing: 'Pipeline failing', 'done-not-merged': 'Done, not merged', 'review-open': 'Review open' });
  });
});

describe('matchesDelivery review-open', () => {
  const idx = (mrs: GitlabMr[], jiraProjects?: Record<string, GitlabProjectView[]>) => deliveryIndex(payload(mrs, jiraProjects));
  it('matches a lead with open findings, own or inherited; not a clean one, a null one, a merged one or a hidden ticket', () => {
    const own = ticketDelivery(issue(), idx([mr({ review: twoOpen() })]));
    const inherited = ticketDelivery(subtaskOf('TIMIFY-101', 'TIMIFY-100'), idx([mr({ keys: ['TIMIFY-100'], review: twoOpen() })]));
    const clean = ticketDelivery(issue(), idx([mr({ review: review({ resolved: 3 }) })]));
    const unread = ticketDelivery(issue(), idx([mr({ review: null })]));
    const merged = ticketDelivery(issue(), idx([mr({ state: 'merged', pipeline: null, review: twoOpen() })]));
    const hidden = ticketDelivery(issue({ key: 'PAY-1' }), idx([]));
    expect(matchesDelivery('review-open', own, NOW)).toBe(true);
    expect(matchesDelivery('review-open', inherited, NOW)).toBe(true);
    expect(matchesDelivery('review-open', clean, NOW)).toBe(false);
    expect(matchesDelivery('review-open', unread, NOW)).toBe(false);
    expect(matchesDelivery('review-open', merged, NOW)).toBe(false);
    expect(matchesDelivery('review-open', hidden, NOW)).toBe(false);
  });

  it('a stored review-open with delivery hidden applies as all', () => {
    expect(effectiveDeliveryFilter('review-open', false)).toBe('all');
    expect(effectiveDeliveryFilter('review-open', true)).toBe('review-open');
  });
});

describe('mrRepo', () => {
  it("names the mapped repo by its own basename, which may differ from the GitLab path's tail", () => {
    const index = deliveryIndex(payload([], { TIMIFY: [view({ path: 'development/backend/microservice', repo: 'ms-checkout' })] }));
    expect(mrRepo(mr({ project: 'development/backend/microservice' }), index)).toBe('ms-checkout');
  });

  it("falls back to the project path's last segment for a nested path no Jira project maps", () => {
    const index = deliveryIndex(payload([], { TIMIFY: [view()] }));
    expect(mrRepo(mr({ project: 'group/sub/repo' }), index)).toBe('repo');
  });

  it('reads a bare, unmapped project path as itself', () => {
    const index = deliveryIndex(payload([], { TIMIFY: [view()] }));
    expect(mrRepo(mr({ project: 'repo' }), index)).toBe('repo');
  });
});

describe('deliveryShown', () => {
  it.each<[string, GitlabPayload | null, boolean]>([
    ['connected and armed', payload([], undefined, { state: 'connected', armed: true }), true],
    ['rejected and still armed', payload([], undefined, { state: 'rejected', armed: true }), true],
    ['unconfigured', payload([], undefined, { state: 'unconfigured', armed: false }), false],
    ['idle (unarmed)', payload([], undefined, { state: 'idle', armed: false }), false],
    ['connected and unarmed', payload([], undefined, { state: 'connected', armed: false }), false],
    ['no payload', null, false]
  ])('%s', (_name, p, shown) => {
    expect(deliveryShown(p)).toBe(shown);
  });
});

// Keeps `GitlabPipeline` honest as a fixture type: every value the server folds to has a row in deliveryLook's table.
it.each<GitlabPipeline>(['success', 'failed', 'running', 'canceled', 'none'])('deliveryLook has a word for pipeline %s', (p) => {
  expect(deliveryLook(mr({ pipeline: p }), NOW).word).not.toBe('');
});

/**
 * Jira detail tabs spec §4.5 and §4.5.1: `deliveryNext`, one MR's next delivery step, and the proof that `deliveryLook` did not move while it was added.
 * Every fixture is `acme/pay-api` with its own iid, so a row read off the wrong MR would not pass by coincidence; the MR was last touched two hours ago.
 */
const mrNext = (over: Partial<GitlabMr>): GitlabMr =>
  mr({
    project: 'acme/pay-api',
    title: 'PAY-7 | change',
    webUrl: 'https://gitlab.example.test/acme/pay-api/-/merge_requests/41',
    sourceBranch: 'pay-7-change',
    updatedAt: minutesAgo(120),
    keys: ['PAY-7'],
    ...over
  });
const unlanded = (): GitlabReview => review({ triggeredAt: null, landedAt: null });

/** Every row of §4.5's table, plus the cases the table does not give a row (clean draft, unknown, capped). One MR each, one iid each. */
const fx = {
  draftNone: mrNext({ iid: 51, draft: true, pipeline: 'failed', review: unlanded() }),
  unread: mrNext({ iid: 52, review: null }),
  none: mrNext({ iid: 53, review: unlanded() }),
  reviewing: mrNext({ iid: 54, review: review({ triggeredAt: minutesAgo(4), landedAt: null }) }),
  open: mrNext({ iid: 55, pipeline: 'failed', review: twoOpen() }),
  stale: mrNext({ iid: 56, review: review({ commitsSince: 3 }) }),
  cleanRunning: mrNext({ iid: 57, pipeline: 'running', review: review() }),
  cleanFailed: mrNext({ iid: 58, pipeline: 'failed', review: review() }),
  cleanSuccess: mrNext({ iid: 59, review: review() }),
  cleanNone: mrNext({ iid: 60, pipeline: 'none', review: review() }),
  cleanNull: mrNext({ iid: 61, pipeline: null, review: review() }),
  noneSuccess: mrNext({ iid: 62, review: unlanded() }),
  cleanCanceled: mrNext({ iid: 63, pipeline: 'canceled', review: review() }),
  merged: mrNext({ iid: 64, state: 'merged', pipeline: null, mergedAt: minutesAgo(60) }),
  closed: mrNext({ iid: 65, state: 'closed', pipeline: null }),
  cleanDraft: mrNext({ iid: 66, draft: true, review: review() }),
  unknown: mrNext({ iid: 67, review: review({ capped: true, open: 0 }) }),
  cappedOpen: mrNext({ iid: 68, review: twoOpen({ open: 3, capped: true }) })
};

// `deliveryLook` as it was before `deliveryNext` existed, taken from that code's own output for the fixtures above, so a change to it fails here.
const LOOK_SNAPSHOT: Record<keyof typeof fx, DeliveryLook> = {
  draftNone: {
    chip: '!51 · draft',
    word: 'draft',
    pipelineWord: 'draft',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'grey' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'off' }, { step: 'merged', mark: 'off' }
    ]
  },
  unread: {
    chip: '!52 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  none: {
    chip: '!53 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  reviewing: {
    chip: '!54 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'grey' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  open: {
    chip: '!55 · ✕ pipeline failed',
    word: 'pipeline failed',
    pipelineWord: 'pipeline failed',
    tone: 'red',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'amber' },
      { step: 'pipeline', mark: 'red' }, { step: 'merged', mark: 'off' }
    ]
  },
  stale: {
    chip: '!56 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'grey' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanRunning: {
    chip: '!57 · ◷ running',
    word: 'pipeline running',
    pipelineWord: 'pipeline running',
    tone: 'amber',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'amber' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanFailed: {
    chip: '!58 · ✕ pipeline failed',
    word: 'pipeline failed',
    pipelineWord: 'pipeline failed',
    tone: 'red',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'red' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanSuccess: {
    chip: '!59 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanNone: {
    chip: '!60 · open',
    word: 'open, no pipeline',
    pipelineWord: 'open, no pipeline',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'off' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanNull: {
    chip: '!61 · open',
    word: 'open, no pipeline',
    pipelineWord: 'open, no pipeline',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'off' }, { step: 'merged', mark: 'off' }
    ]
  },
  noneSuccess: {
    chip: '!62 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  cleanCanceled: {
    chip: '!63 · pipeline canceled',
    word: 'pipeline canceled',
    pipelineWord: 'pipeline canceled',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'grey' }, { step: 'merged', mark: 'off' }
    ]
  },
  merged: {
    chip: '!64 · merged',
    word: 'merged',
    pipelineWord: 'merged',
    tone: 'magenta',
    track: [
      { step: 'pushed', mark: 'magenta' }, { step: 'open', mark: 'magenta' }, { step: 'review', mark: 'magenta' },
      { step: 'pipeline', mark: 'magenta' }, { step: 'merged', mark: 'magenta' }
    ]
  },
  closed: {
    chip: '!65 · closed',
    word: 'closed',
    pipelineWord: 'closed',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'off' }, { step: 'closed', mark: 'grey' }
    ]
  },
  cleanDraft: {
    chip: '!66 · draft',
    word: 'draft',
    pipelineWord: 'draft',
    tone: 'grey',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'grey' }, { step: 'review', mark: 'green' },
      { step: 'pipeline', mark: 'off' }, { step: 'merged', mark: 'off' }
    ]
  },
  unknown: {
    chip: '!67 · ✓ pipeline',
    word: 'pipeline passed',
    pipelineWord: 'pipeline passed',
    tone: 'green',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'off' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  },
  cappedOpen: {
    chip: '!68 · 3+ to fix',
    word: '3+ to fix',
    pipelineWord: 'pipeline passed',
    tone: 'amber',
    track: [
      { step: 'pushed', mark: 'on' }, { step: 'open', mark: 'on' }, { step: 'review', mark: 'amber' },
      { step: 'pipeline', mark: 'green' }, { step: 'merged', mark: 'off' }
    ]
  }
};

describe('deliveryLook is unchanged by deliveryNext (spec T7)', () => {
  it.each(Object.keys(fx) as (keyof typeof fx)[])('%s', (name) => {
    expect(deliveryLook(fx[name], NOW)).toEqual(LOOK_SNAPSHOT[name]);
  });
});

const noIgnore = { review: false, pipeline: false };
const next = (over: Partial<DeliveryNext>): DeliveryNext => ({
  step: null,
  word: null,
  pill: '',
  sentence: null,
  button: null,
  ignore: null,
  ignored: noIgnore,
  ...over
});
const REVIEW_UNREAD = 'The review has not been read yet.';

describe('deliveryNext, spec §4.5 row by row', () => {
  it.each<[string, keyof typeof fx, DeliveryNext]>([
    ['1  open draft, review none', 'draftNone', next({ step: 'review', word: 'review', pill: 'next: review', button: 'request', ignore: 'review' })],
    ['2  open, review null (never read)', 'unread', next({ pill: 'pipeline passed', sentence: REVIEW_UNREAD, ignore: 'review' })],
    ['3  open, review none', 'none', next({ step: 'review', word: 'review', pill: 'next: review', button: 'request', ignore: 'review' })],
    ['4  open, review reviewing', 'reviewing', next({ pill: reviewStepWord(fx.reviewing.review, NOW) ?? '' })],
    ['5  open, review open (findings), failed pipeline', 'open', next({ step: 'review', word: 'fix 2', pill: 'next: fix 2', button: 'fix', ignore: 'review' })],
    ['6  open, review stale', 'stale', next({ step: 'review', word: 're-review', pill: 'next: re-review', button: 'request', ignore: 'review' })],
    ['7  clean, pipeline running', 'cleanRunning', next({ pill: 'pipeline running' })],
    [
      '8  clean, pipeline failed',
      'cleanFailed',
      next({ step: 'pipeline', word: 'fix pipeline', pill: 'next: fix pipeline', sentence: 'The pipeline failed — fix it in a Run session.', button: 'run', ignore: 'pipeline' })
    ],
    [
      '9  clean, pipeline success',
      'cleanSuccess',
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed and green — merge happens in GitLab.', button: 'merge' })
    ],
    [
      '10 clean, pipeline none',
      'cleanNone',
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed, no pipeline — merge happens in GitLab.', button: 'merge' })
    ],
    [
      '10 clean, pipeline null',
      'cleanNull',
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed, no pipeline — merge happens in GitLab.', button: 'merge' })
    ],
    ['11 review none, pipeline success', 'noneSuccess', next({ step: 'review', word: 'review', pill: 'next: review', button: 'request', ignore: 'review' })],
    [
      '12 clean, pipeline canceled',
      'cleanCanceled',
      next({ step: 'pipeline', word: 're-run', pill: 'next: re-run', sentence: 'The pipeline was canceled — re-run it in GitLab.', button: 'gitlab', ignore: 'pipeline' })
    ],
    ['13 merged', 'merged', next({ pill: 'merged' })],
    ['14 closed', 'closed', next({ pill: 'closed' })]
  ])('%s', (_row, name, expected) => {
    expect(deliveryNext(fx[name], NOW, undefined)).toEqual(expected);
  });

  it('row 4 reads the live round, not the pipeline word', () => {
    expect(deliveryNext(fx.reviewing, NOW, undefined).pill).toMatch(/^reviewing… /);
  });

  it('a capped review with 3 open reads fix 3+', () => {
    expect(deliveryNext(fx.cappedOpen, NOW, undefined)).toEqual(next({ step: 'review', word: 'fix 3+', pill: 'next: fix 3+', button: 'fix', ignore: 'review' }));
  });

  it('a clean draft is next to be marked ready, in GitLab, and offers no Ignore', () => {
    expect(deliveryNext(fx.cleanDraft, NOW, undefined)).toEqual(
      next({ step: 'merged', word: 'mark ready', pill: 'next: mark ready', sentence: 'Still a draft — mark it ready in GitLab.', button: 'gitlab' })
    );
  });

  it('an unknown review waits on the review word and offers Ignore alone, with no sentence and no button', () => {
    const n = deliveryNext(fx.unknown, NOW, undefined);
    expect(n).toEqual(next({ pill: 'too long to read', ignore: 'review' }));
    expect(n.pill).toBe(reviewStepWord(fx.unknown.review, NOW));
  });

  it('a pipeline that is not read on a draft with a review owed is still the review that is next (a draft pipeline is off)', () => {
    expect(deliveryNext(fx.draftNone, NOW, undefined).step).toBe('review');
  });
});

describe('deliveryNext with an ignore (spec §4.5.1)', () => {
  const stamp = (m: GitlabMr): string => m.updatedAt;

  it('an ignored failed pipeline under a clean review is row 9, and says the pipeline is ignored', () => {
    const m = fx.cleanFailed;
    const entry: IgnoreEntry = { pipeline: { status: 'failed', updatedAt: stamp(m) } };
    expect(deliveryNext(m, NOW, entry)).toEqual(
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed and green — merge happens in GitLab.', button: 'merge', ignored: { review: false, pipeline: true } })
    );
  });

  it('an ignored canceled pipeline under a clean review reads as finished too: the merge row, with the green sentence', () => {
    const m = fx.cleanCanceled;
    const n = deliveryNext(m, NOW, { pipeline: { status: 'canceled', updatedAt: stamp(m) } });
    expect(n).toEqual(
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed and green — merge happens in GitLab.', button: 'merge', ignored: { review: false, pipeline: true } })
    );
  });

  it('an ignored none review over a success pipeline is row 9', () => {
    const m = fx.noneSuccess;
    const n = deliveryNext(m, NOW, { review: { state: 'none', landedAt: null } });
    expect(n).toEqual(
      next({ step: 'merged', word: 'merge', pill: 'next: merge', sentence: 'Reviewed and green — merge happens in GitLab.', button: 'merge', ignored: { review: true, pipeline: false } })
    );
  });

  it('an ignored none review over a failed pipeline moves the marker to the pipeline (row 8)', () => {
    const m = mrNext({ iid: 71, pipeline: 'failed', review: unlanded() });
    const n = deliveryNext(m, NOW, { review: { state: 'none', landedAt: null } });
    expect(n.step).toBe('pipeline');
    expect(n.button).toBe('run');
    expect(n.ignore).toBe('pipeline');
    expect(n.ignored).toEqual({ review: true, pipeline: false });
  });

  it('an entry for failed while the pipeline now runs is not ignored: row 7', () => {
    const m = fx.cleanRunning;
    const n = deliveryNext(m, NOW, { pipeline: { status: 'failed', updatedAt: stamp(m) } });
    expect(n).toEqual(next({ pill: 'pipeline running' }));
  });

  it('an entry for failed with an older updatedAt (a push since) is not ignored: row 8', () => {
    const m = fx.cleanFailed;
    const n = deliveryNext(m, NOW, { pipeline: { status: 'failed', updatedAt: minutesAgo(300) } });
    expect(n.step).toBe('pipeline');
    expect(n.word).toBe('fix pipeline');
    expect(n.ignored).toEqual(noIgnore);
  });

  it('an unread entry over a null review falls through to the pipeline rows (here row 9)', () => {
    const n = deliveryNext(fx.unread, NOW, { review: { state: 'unread', landedAt: null } });
    expect(n.step).toBe('merged');
    expect(n.word).toBe('merge');
    expect(n.ignored).toEqual({ review: true, pipeline: false });
  });

  it('an unread entry over a review that has since been read does not hold', () => {
    const n = deliveryNext(fx.none, NOW, { review: { state: 'unread', landedAt: null } });
    expect(n.step).toBe('review');
    expect(n.ignored.review).toBe(false);
  });

  it('an ignored unknown review falls through to the pipeline', () => {
    const n = deliveryNext(fx.unknown, NOW, { review: { state: 'unknown', landedAt: fx.unknown.review?.landedAt ?? null } });
    expect(n.step).toBe('merged');
    expect(n.ignored.review).toBe(true);
  });

  it('a review entry for open with the landing now different does not hold: row 5, not ignored', () => {
    const m = fx.open;
    const n = deliveryNext(m, NOW, { review: { state: 'open', landedAt: minutesAgo(900) } });
    expect(n.word).toBe('fix 2');
    expect(n.ignored.review).toBe(false);
  });

  it('a review entry for open with the same landing holds, and the failed pipeline under it is next', () => {
    const m = fx.open;
    const n = deliveryNext(m, NOW, { review: { state: 'open', landedAt: m.review?.landedAt ?? null } });
    expect(n.step).toBe('pipeline');
    expect(n.ignored).toEqual({ review: true, pipeline: false });
  });

  it('a review entry for none with the review now open does not hold: row 5', () => {
    const n = deliveryNext(fx.open, NOW, { review: { state: 'none', landedAt: null } });
    expect(n.word).toBe('fix 2');
    expect(n.ignored.review).toBe(false);
  });

  it('an entry never makes a merged MR draw ignored, and never changes its row', () => {
    const n = deliveryNext(fx.merged, NOW, { review: { state: 'none', landedAt: null }, pipeline: { status: 'failed', updatedAt: fx.merged.updatedAt } });
    expect(n).toEqual(next({ pill: 'merged' }));
  });

  it('a stored state the table offers no Ignore for (clean) never draws ignored', () => {
    const m = fx.cleanSuccess;
    const n = deliveryNext(m, NOW, { review: { state: 'clean', landedAt: m.review?.landedAt ?? null } });
    expect(n.ignored.review).toBe(false);
  });

  it('a pipeline ignore on a draft never draws ignored: the draft pipeline is off', () => {
    const m = fx.draftNone;
    const n = deliveryNext(m, NOW, { review: { state: 'none', landedAt: null }, pipeline: { status: 'failed', updatedAt: m.updatedAt } });
    expect(n.step).toBe('merged');
    expect(n.word).toBe('mark ready');
    expect(n.ignored).toEqual({ review: true, pipeline: false });
  });
});
