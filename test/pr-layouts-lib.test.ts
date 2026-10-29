import {
  columnCounts,
  compactKeys,
  departedOutcomes,
  drawableLayout,
  isNoAccess,
  LEVEL_DOT,
  layoutOptions,
  levelCounts,
  MATRIX_COLUMNS,
  MATRIX_LABEL,
  matrixCells,
  newestPolledAt,
  parseLayout,
  prLevel,
  prProblems,
  prSeverity,
  prVerdict,
  quietFacts,
  rankPrs,
  splitReach,
  transientFailures
} from '../client/src/lib/pr-layouts';
import { mergeBlock, updateBlock, type PrOutcome } from '../client/src/lib/prs';
import type { PrRepoView, PullRequestRow } from '../shared/types';

/**
 * The PRs layouts' triage derivations (`docs/superpowers/specs/2026-10-29-prs-layouts-design.md`: Level of a PR, Rank, Layout key). Fixtures set every field
 * and discriminate (distinct repos, numbers, timestamps), so a reading that crossed a field or a row would not pass by coincidence.
 */

function row(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 17,
    title: 'Teach the board to merge',
    url: 'https://github.com/futin/x/pull/17',
    author: 'ada',
    draft: false,
    head: 'feature/merge-it',
    headSha: 'a'.repeat(40),
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T10:00:00Z',
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'none',
    autoMerge: null,
    canUpdateBranch: false,
    ...over
  };
}

function repo(over: Partial<PrRepoView> = {}): PrRepoView {
  return {
    repo: 'futin/x',
    polledAt: '2026-10-29T10:10:00Z',
    access: 'ok',
    detail: null,
    syncOff: null,
    methods: ['squash', 'merge'],
    autoMergeAllowed: true,
    prs: [],
    total: 0,
    truncated: false,
    ...over
  };
}

describe('reach', () => {
  it('isNoAccess is true for forbidden and not-found only', () => {
    expect(isNoAccess(repo({ access: 'forbidden' }))).toBe(true);
    expect(isNoAccess(repo({ access: 'not-found' }))).toBe(true);
    for (const access of ['ok', 'rate-limited', 'error'] as const) expect(isNoAccess(repo({ access }))).toBe(false);
  });

  it('splitReach keeps the payload order on both sides', () => {
    const repos = [repo({ repo: 'a/1' }), repo({ repo: 'a/2', access: 'forbidden' }), repo({ repo: 'a/3' }), repo({ repo: 'a/4', access: 'not-found' })];
    const { shown, hidden } = splitReach(repos);
    expect(shown.map((r) => r.repo)).toEqual(['a/1', 'a/3']);
    expect(hidden.map((r) => r.repo)).toEqual(['a/2', 'a/4']);
  });
});

describe('prLevel', () => {
  it.each([
    ['checks failure', { checks: 'failure' }, 'needs-you'],
    ['conflicting', { mergeable: 'conflicting' }, 'needs-you'],
    ['changes requested', { review: 'changes-requested' }, 'needs-you'],
    ['behind', { mergeState: 'behind' }, 'worth-a-look'],
    ['review required', { review: 'review-required' }, 'worth-a-look'],
    ['checks pending', { checks: 'pending' }, 'worth-a-look'],
    ['checks pending with auto-merge armed', { checks: 'pending', autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } }, 'quiet'],
    ['mergeable unknown', { mergeable: 'unknown' }, 'worth-a-look'],
    ['blocked with nothing to name it', { mergeState: 'blocked' }, 'worth-a-look'],
    ['unstable with nothing to name it', { mergeState: 'unstable' }, 'worth-a-look'],
    ['draft with failing checks', { draft: true, checks: 'failure' }, 'quiet'],
    ['draft with review required', { draft: true, review: 'review-required' }, 'quiet'],
    ['behind but approved', { mergeState: 'behind', review: 'approved' }, 'worth-a-look'],
    ['clean approved success', { review: 'approved', checks: 'success' }, 'quiet']
  ] as const)('%s', (_name, over, level) => {
    expect(prLevel(row(over as Partial<PullRequestRow>))).toBe(level);
  });

  it('a blocked state that checks pending already names is not an unnamed block', () => {
    // Armed auto-merge waiting on checks is the spec's Quiet example, and GitHub reports exactly that PR as `blocked`.
    const armed = { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } as const;
    expect(prLevel(row({ mergeState: 'blocked', checks: 'pending', autoMerge: armed }))).toBe('quiet');
  });
});

describe('prSeverity', () => {
  it.each([
    [{ checks: 'failure' }, 0],
    [{ mergeable: 'conflicting' }, 1],
    [{ review: 'changes-requested' }, 2],
    [{ mergeState: 'behind' }, 0],
    [{ review: 'review-required' }, 1],
    [{ checks: 'pending' }, 2],
    [{ mergeable: 'unknown' }, 3],
    [{ mergeState: 'blocked' }, 4],
    [{ review: 'approved', checks: 'success' }, null],
    [{ draft: true, checks: 'failure' }, null],
    [{ mergeable: 'conflicting', review: 'changes-requested' }, 1]
  ] as const)('%j is %s', (over, severity) => {
    expect(prSeverity(row(over as Partial<PullRequestRow>))).toBe(severity);
  });
});

describe('prProblems and prVerdict', () => {
  it('lists the level-driving fact first, then the warning and the calm facts, all but the first being steps', () => {
    const pr = row({ checks: 'failure', mergeState: 'behind', review: 'approved' });
    // Failing checks and `approved` cannot coexist with `checks passing`, so the calm list here is just `Approved.`.
    const { verdict, steps } = prVerdict(prProblems(pr, 'run 3 is working this branch'));
    expect(verdict).toBe('Checks are failing.');
    expect(steps.map((s) => s.text)).toEqual(['Behind its base.', 'run 3 is working this branch', 'Approved.']);
    expect(steps.map((s) => s.calm)).toEqual([false, true, true]);
  });

  it('names the base a conflict is with', () => {
    expect(prVerdict(prProblems(row({ mergeable: 'conflicting', base: 'release/2' }), null)).verdict).toBe('Conflicts with release/2.');
  });

  it('orders every level-driving sentence by severity across both levels', () => {
    const pr = row({ checks: 'failure', mergeable: 'conflicting', review: 'changes-requested', mergeState: 'behind' });
    expect(prProblems(pr, null).map((p) => p.text)).toEqual(['Checks are failing.', 'Conflicts with main.', 'Changes were requested.', 'Behind its base.']);
    const soft = row({ review: 'review-required', checks: 'pending', mergeable: 'unknown' });
    expect(prProblems(soft, null).map((p) => p.text)).toEqual([
      'Waiting for a review.',
      'Checks are still running.',
      'GitHub is still working out whether it can merge.'
    ]);
  });

  it('says what an unnamed block is, in GitHub\'s word', () => {
    expect(prProblems(row({ mergeState: 'blocked' }), null).map((p) => p.text)).toEqual(['GitHub reports it blocked.']);
    expect(prProblems(row({ mergeState: 'unstable' }), null).map((p) => p.text)).toEqual(['GitHub reports it unstable.']);
  });

  it('drops the pending sentence when auto-merge is armed, and adds `Checks are passing.` as a calm fact', () => {
    const armed = { method: 'merge', enabledAt: '2026-10-29T09:00:00Z' } as const;
    expect(prProblems(row({ checks: 'pending', autoMerge: armed }), null)).toEqual([]);
    expect(prProblems(row({ checks: 'success' }), null)).toEqual([{ text: 'Checks are passing.', calm: true }]);
  });

  it('a clean quiet PR has no verdict', () => {
    expect(prVerdict(prProblems(row(), null))).toEqual({ verdict: null, steps: [] });
  });

  it('a draft has no level-driving problem, only the calm ones', () => {
    expect(prProblems(row({ draft: true, checks: 'failure', review: 'review-required' }), null)).toEqual([]);
  });
});

describe('quietFacts', () => {
  it('is the chips vocabulary, joined', () => {
    expect(quietFacts(row({ draft: true, review: 'approved', checks: 'success' }))).toBe('draft · approved · checks passing');
  });
});

describe('rankPrs', () => {
  const x = repo({
    repo: 'a/x',
    prs: [
      row({ number: 1, review: 'changes-requested', updatedAt: '2026-10-29T12:00:00Z' }),
      row({ number: 2, mergeState: 'behind', updatedAt: '2026-10-29T08:00:00Z' }),
      row({ number: 7, review: 'approved', checks: 'success', updatedAt: '2026-10-29T07:00:00Z' })
    ]
  });
  const y = repo({
    repo: 'a/y',
    prs: [
      row({ number: 3, checks: 'failure', updatedAt: '2026-10-29T06:00:00Z' }),
      row({ number: 4, mergeState: 'behind', updatedAt: '2026-10-29T09:00:00Z' }),
      row({ number: 7, draft: true, updatedAt: '2026-10-29T11:00:00Z' })
    ]
  });

  it('orders by level, then severity (not age) within a level, then newest first among equals', () => {
    const keys = rankPrs([x, y]).map((r) => r.key);
    // Needs you: failure (a/y#3, older) before changes-requested (a/x#1, newer). Worth a look: both behind (severity 0), the newer a/y#4 first.
    // Quiet: a/y#7 (11:00) before a/x#7 (07:00).
    expect(keys).toEqual(['a/y#3', 'a/x#1', 'a/y#4', 'a/x#2', 'a/y#7', 'a/x#7']);
  });

  it('keeps the same number in two repos as two entries with their own keys, and carries level and severity', () => {
    const ranked = rankPrs([x, y]);
    const sevens = ranked.filter((r) => r.pr.number === 7);
    expect(sevens.map((r) => r.key).sort()).toEqual(['a/x#7', 'a/y#7']);
    expect(ranked[0]).toMatchObject({ key: 'a/y#3', level: 'needs-you', severity: 0 });
    expect(ranked[1]).toMatchObject({ key: 'a/x#1', level: 'needs-you', severity: 2 });
    expect(ranked[5].severity).toBeNull();
    expect(ranked[0].repo).toBe(y);
  });

  it('breaks a tie on level, severity and time by key, so the order is deterministic', () => {
    const t = '2026-10-29T10:00:00Z';
    const a = repo({ repo: 'a/b', prs: [row({ number: 9, updatedAt: t })] });
    const b = repo({ repo: 'a/a', prs: [row({ number: 9, updatedAt: t })] });
    expect(rankPrs([a, b]).map((r) => r.key)).toEqual(['a/a#9', 'a/b#9']);
  });

  it('levelCounts counts every level, zero included', () => {
    expect(levelCounts(rankPrs([x, y]))).toEqual({ 'needs-you': 2, 'worth-a-look': 2, quiet: 2 });
    expect(levelCounts([])).toEqual({ 'needs-you': 0, 'worth-a-look': 0, quiet: 0 });
  });
});

describe('layout key', () => {
  it('parseLayout reads a known value and falls back to inbox for anything else', () => {
    expect(parseLayout('cards')).toBe('cards');
    expect(parseLayout('matrix')).toBe('matrix');
    expect(parseLayout('inbox')).toBe('inbox');
    for (const v of ['bogus', null, 3, undefined, {}]) expect(parseLayout(v)).toBe('inbox');
  });

  it('drawableLayout draws a stored matrix as inbox when narrow, and nothing else changes', () => {
    expect(drawableLayout('matrix', true)).toBe('inbox');
    expect(drawableLayout('matrix', false)).toBe('matrix');
    expect(drawableLayout('cards', true)).toBe('cards');
    expect(drawableLayout('inbox', true)).toBe('inbox');
  });

  it('layoutOptions offers matrix only when wide', () => {
    expect(layoutOptions(true).map((o) => o.value)).toEqual(['inbox', 'cards']);
    expect(layoutOptions(false).map((o) => o.value)).toEqual(['inbox', 'matrix', 'cards']);
    expect(layoutOptions(false).map((o) => o.label)).toEqual(['Inbox', 'Matrix', 'Cards']);
  });
});

describe('page-level readings', () => {
  it('transientFailures keeps rate-limited and error repos, and drops ok ones', () => {
    const shown = [repo({ repo: 'a/1' }), repo({ repo: 'a/2', access: 'rate-limited' }), repo({ repo: 'a/3', access: 'error' })];
    expect(transientFailures(shown).map((r) => r.repo)).toEqual(['a/2', 'a/3']);
  });

  it('newestPolledAt ignores nulls and is null when there is nothing to read', () => {
    const shown = [repo({ polledAt: null }), repo({ polledAt: '2026-10-29T10:10:00Z' }), repo({ polledAt: '2026-10-29T10:30:00Z' }), repo({ polledAt: '2026-10-29T10:20:00Z' })];
    expect(newestPolledAt(shown)).toBe('2026-10-29T10:30:00Z');
    expect(newestPolledAt([repo({ polledAt: null })])).toBeNull();
    expect(newestPolledAt([])).toBeNull();
  });

  it('departedOutcomes keeps a finished outcome for an unlisted PR on a shown repo, and nothing else', () => {
    const shown = [repo({ repo: 'a/x', prs: [row({ number: 1 })] })];
    const outcomes: Record<string, PrOutcome> = {
      'a/x#1': { text: 'merged', kind: 'ok' },
      'a/x#2': { text: 'merged', kind: 'ok' },
      'a/x#3': { text: 'updating…', kind: 'updating' },
      'a/x#4': { text: 'GitHub said no', kind: 'error' },
      'a/hidden#5': { text: 'merged', kind: 'ok' }
    };
    expect(departedOutcomes(outcomes, shown)).toEqual([
      { key: 'a/x#2', outcome: outcomes['a/x#2'] },
      { key: 'a/x#4', outcome: outcomes['a/x#4'] }
    ]);
  });

  it('departedOutcomes does not match a repo whose name is a prefix of another', () => {
    const shown = [repo({ repo: 'a/x' })];
    expect(departedOutcomes({ 'a/xy#1': { text: 'merged', kind: 'ok' } }, shown)).toEqual([]);
  });
});

describe('compactKeys', () => {
  it('a behind PR on an auto-merge repo offers update first, then merge and auto-merge', () => {
    const pr = row({ mergeState: 'behind', canUpdateBranch: true });
    expect(compactKeys(pr, repo({ autoMergeAllowed: true }))).toEqual({ keys: ['update', 'merge', 'auto-merge'], primary: 'update' });
  });

  it('a ready quiet PR on a repo without auto-merge offers merge alone, as the primary', () => {
    expect(compactKeys(row({ review: 'approved', checks: 'success' }), repo({ autoMergeAllowed: false }))).toEqual({ keys: ['merge'], primary: 'merge' });
  });

  it('a PR merge would refuse has no primary, and the refusal is the one the action strip already says', () => {
    const failing = row({ checks: 'failure' });
    const r = repo();
    expect(mergeBlock(failing, r)).toBe('checks failing');
    expect(compactKeys(failing, r).primary).toBeNull();
    expect(compactKeys(failing, r).keys).toEqual(['merge', 'auto-merge']);
  });

  it('a draft has no primary', () => {
    expect(compactKeys(row({ draft: true }), repo()).primary).toBeNull();
  });

  it('a quiet PR that is not ready for a person (worth a look) has no primary either, unless it is behind', () => {
    expect(compactKeys(row({ review: 'review-required' }), repo()).primary).toBeNull();
  });

  it('armed auto-merge still offers auto-merge on a repo whose setting is now off, so it can be disarmed', () => {
    const armed = row({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } });
    expect(compactKeys(armed, repo({ autoMergeAllowed: false })).keys).toContain('auto-merge');
  });

  it('a behind PR whose update the strip would refuse has no primary — a filled key that is disabled would be the opposite of the merge rule', () => {
    const behind = row({ mergeState: 'behind', canUpdateBranch: false });
    expect(updateBlock(behind, repo())).toBe('no permission to update');
    expect(compactKeys(behind, repo()).primary).toBeNull();
    expect(compactKeys(behind, repo()).keys).toEqual(['merge', 'update', 'auto-merge']);
    const synced = repo({ syncOff: 'sync is off for futin/x — turn it on in GitHub › Settings' });
    expect(compactKeys(row({ mergeState: 'behind', canUpdateBranch: true }), synced).primary).toBeNull();
  });

  it('a draft that is behind still makes update the primary, because updateBlock does not refuse a draft', () => {
    const draftBehind = row({ draft: true, mergeState: 'behind', canUpdateBranch: true });
    expect(updateBlock(draftBehind, repo())).toBeNull();
    expect(compactKeys(draftBehind, repo()).primary).toBe('update');
  });

  it('a quiet PR whose auto-merge is armed and whose checks are pending has no merge primary: GitHub will merge it itself', () => {
    const armed = row({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' }, checks: 'pending', mergeState: 'blocked' });
    expect(prLevel(armed)).toBe('quiet');
    expect(compactKeys(armed, repo({ autoMergeAllowed: true })).primary).toBeNull();
  });

  it('a repo with no allowed method has no merge primary', () => {
    expect(compactKeys(row({ review: 'approved', checks: 'success' }), repo({ methods: [] })).primary).toBeNull();
  });
});

describe('matrixCells', () => {
  it('names the columns and their labels', () => {
    expect(MATRIX_COLUMNS).toEqual(['checks', 'review', 'mergeable', 'base', 'autoMerge']);
    expect(MATRIX_LABEL).toEqual({ checks: 'Checks', review: 'Review', mergeable: 'Mergeable', base: 'Base', autoMerge: 'Auto-merge' });
  });

  it('reads checks and review from their own facts', () => {
    expect(matrixCells(row({ checks: 'success' }), false).checks).toEqual({ text: 'passing', tone: 'ok' });
    expect(matrixCells(row({ checks: 'pending' }), false).checks).toEqual({ text: 'running', tone: 'live' });
    expect(matrixCells(row({ checks: 'none' }), false).checks).toEqual({ text: '—', tone: 'na' });
    expect(matrixCells(row({ review: 'approved' }), false).review).toEqual({ text: 'approved', tone: 'ok' });
    expect(matrixCells(row({ review: 'changes-requested' }), false).review).toEqual({ text: 'changes', tone: 'bad' });
    expect(matrixCells(row({ review: 'review-required' }), false).review).toEqual({ text: 'required', tone: 'meh' });
    expect(matrixCells(row({ review: null }), false).review).toEqual({ text: '—', tone: 'na' });
  });

  it('a cell ignores draft: failing checks on a draft are a red Checks cell', () => {
    expect(matrixCells(row({ draft: true, checks: 'failure' }), false).checks).toEqual({ text: 'failing', tone: 'bad' });
  });

  it('mergeable: conflicts, computing, an unnamed block, and otherwise mergeable', () => {
    expect(matrixCells(row({ mergeable: 'conflicting' }), false).mergeable).toEqual({ text: 'conflicts', tone: 'bad' });
    expect(matrixCells(row({ mergeable: 'unknown' }), false).mergeable).toEqual({ text: 'computing', tone: 'live' });
    expect(matrixCells(row({ mergeState: 'blocked' }), false).mergeable).toEqual({ text: 'blocked', tone: 'meh' });
    expect(matrixCells(row({ mergeState: 'unstable' }), false).mergeable).toEqual({ text: 'unstable', tone: 'meh' });
    expect(matrixCells(row(), false).mergeable).toEqual({ text: 'mergeable', tone: 'ok' });
  });

  it('a block with a name (a review is required) is not shown as blocked in Mergeable', () => {
    expect(matrixCells(row({ mergeState: 'blocked', review: 'review-required' }), false).mergeable).toEqual({ text: 'mergeable', tone: 'ok' });
  });

  it('base: updating wins over behind, behind is meh, otherwise up to date', () => {
    expect(matrixCells(row({ mergeState: 'behind' }), true).base).toEqual({ text: 'updating…', tone: 'live' });
    expect(matrixCells(row({ mergeState: 'behind' }), false).base).toEqual({ text: 'behind', tone: 'meh' });
    expect(matrixCells(row(), false).base).toEqual({ text: 'up to date', tone: 'ok' });
  });

  it('autoMerge: the armed method, else not applicable', () => {
    expect(matrixCells(row({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } }), false).autoMerge).toEqual({ text: 'squash', tone: 'live' });
    expect(matrixCells(row(), false).autoMerge).toEqual({ text: '—', tone: 'na' });
  });
});

describe('columnCounts', () => {
  it('counts the rows whose cell is bad or meh, per column', () => {
    const r = repo({ prs: [row({ number: 1, checks: 'failure' }), row({ number: 2, review: 'review-required' }), row({ number: 3, review: 'approved', checks: 'success' })] });
    expect(columnCounts(rankPrs([r]), () => false)).toEqual({ checks: 1, review: 1, mergeable: 0, base: 0, autoMerge: 0 });
  });

  it('reads the updating mark by key: an updating behind row is in motion, not behind', () => {
    const r = repo({ prs: [row({ number: 1, mergeState: 'behind' }), row({ number: 2, mergeState: 'behind' })] });
    expect(columnCounts(rankPrs([r]), (key) => key === 'futin/x#1').base).toBe(1);
  });
});

describe('LEVEL_DOT', () => {
  it('maps the two loud levels to Dot tones and leaves Quiet toneless', () => {
    expect(LEVEL_DOT).toEqual({ 'needs-you': 'crashed', 'worth-a-look': 'paused', quiet: undefined });
  });
});
