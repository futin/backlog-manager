import { defaultMethod, groupRepos, isUpdating, autoMergeBlock, mergeBlock, outcomeLine, prChips, updateBlock, UPDATING_MS } from '../client/src/lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../shared/types';

/**
 * The PRs page's derivations. Fixtures discriminate: two repos, a distinct number, title, head, SHA, author and timestamp per PR, so a reading that crossed
 * a field or a row would not pass by coincidence.
 */

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
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
    canUpdateBranch: true,
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

const SYNC_OFF = 'sync is off for futin/x — turn it on in GitHub › Settings';

describe('prChips', () => {
  it('draws one chip per fact, in reading order, with the tone each means', () => {
    const chips = prChips(
      pr({
        draft: true,
        review: 'changes-requested',
        checks: 'failure',
        mergeable: 'conflicting',
        mergeState: 'behind',
        autoMerge: { method: 'rebase', enabledAt: '2026-10-29T09:00:00Z' }
      })
    );
    expect(chips).toEqual([
      { label: 'draft', tone: 'neutral' },
      { label: 'changes requested', tone: 'bad' },
      { label: 'checks failing', tone: 'bad' },
      { label: 'conflicts', tone: 'bad' },
      { label: 'behind base', tone: 'warn' },
      { label: 'auto-merge · rebase', tone: 'live' }
    ]);
  });

  it('maps the other review and check values', () => {
    expect(prChips(pr({ review: 'approved', checks: 'success' }))).toEqual([
      { label: 'approved', tone: 'done' },
      { label: 'checks passing', tone: 'done' }
    ]);
    expect(prChips(pr({ review: 'review-required', checks: 'pending' }))).toEqual([
      { label: 'review required', tone: 'warn' },
      { label: 'checks pending', tone: 'warn' }
    ]);
  });

  it('draws no checks chip for checks: none, and nothing for a clean PR with no review', () => {
    expect(prChips(pr({ checks: 'none', review: null }))).toEqual([]);
  });
});

describe('the write blocks', () => {
  it('mergeBlock: first match wins, in order', () => {
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ syncOff: SYNC_OFF, methods: [] }))).toBe(SYNC_OFF);
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('draft');
    expect(mergeBlock(pr({ mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('not mergeable');
    expect(mergeBlock(pr({ checks: 'failure' }), repo({ methods: [] }))).toBe('checks failing');
    expect(mergeBlock(pr(), repo({ methods: [] }))).toBe('no merge method allowed');
    expect(mergeBlock(pr({ mergeable: 'unknown', checks: 'pending' }), repo())).toBeNull();
  });

  it('updateBlock: sync off, then a fork that forbids edits, then up to date', () => {
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo({ syncOff: SYNC_OFF }))).toBe(SYNC_OFF);
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo())).toBe('fork does not allow edits');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true, canUpdateBranch: false }), repo())).toBe('already up to date');
    expect(updateBlock(pr({ canUpdateBranch: false }), repo())).toBe('already up to date');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true }), repo())).toBeNull();
  });

  it('autoMergeBlock: enabling needs the repo setting; disabling an armed one never does', () => {
    const armed = pr({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } });
    expect(autoMergeBlock(pr(), repo({ autoMergeAllowed: false }))).toBe('auto-merge not enabled on the repo');
    expect(autoMergeBlock(armed, repo({ autoMergeAllowed: false }))).toBeNull();
    expect(autoMergeBlock(pr(), repo())).toBeNull();
    expect(autoMergeBlock(armed, repo({ syncOff: SYNC_OFF }))).toBe(SYNC_OFF);
    expect(autoMergeBlock(pr(), repo({ syncOff: SYNC_OFF, autoMergeAllowed: false }))).toBe(SYNC_OFF);
  });
});

describe('defaultMethod', () => {
  it('is the first of squash, merge, rebase that the repo allows', () => {
    expect(defaultMethod(['rebase', 'merge'])).toBe('merge');
    expect(defaultMethod(['rebase'])).toBe('rebase');
    expect(defaultMethod(['merge', 'squash', 'rebase'])).toBe('squash');
    expect(defaultMethod([])).toBeNull();
  });
});

describe('isUpdating', () => {
  const row = pr({ headSha: 'b'.repeat(40) });
  const mark = { sha: 'b'.repeat(40), until: 1_000_000 };

  it('holds while the head is the one the update was asked at and the window is open', () => {
    expect(UPDATING_MS).toBe(30_000);
    expect(isUpdating(mark, row, mark.until - 1)).toBe(true);
    expect(isUpdating(mark, row, mark.until)).toBe(false);
    expect(isUpdating(mark, pr({ headSha: 'c'.repeat(40) }), mark.until - 1)).toBe(false);
    expect(isUpdating(undefined, row, 0)).toBe(false);
  });
});

describe('groupRepos', () => {
  const prAt = (number: number, updatedAt: string) => pr({ number, updatedAt, title: `PR ${number}` });

  it('puts repos with PRs first by newest update, then empty repos by name, and orders each repo newest first', () => {
    const x = repo({ repo: 'futin/x', prs: [prAt(1, '2026-10-29T10:01:00Z'), prAt(2, '2026-10-29T10:05:00Z'), prAt(3, '2026-10-29T10:03:00Z')] });
    const y = repo({ repo: 'futin/y', prs: [prAt(4, '2026-10-29T10:09:00Z')] });
    const a = repo({ repo: 'futin/a' });
    const b = repo({ repo: 'futin/b' });
    const out = groupRepos([b, x, a, y]);
    expect(out.map((r) => r.repo)).toEqual(['futin/y', 'futin/x', 'futin/a', 'futin/b']);
    expect(out[1].prs.map((p) => p.number)).toEqual([2, 3, 1]);
    // copies: the payload's own order is untouched
    expect(x.prs.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

describe('outcomeLine', () => {
  it('says each outcome in one short line', () => {
    const line = (outcome: PrWriteResult['outcome']) => outcomeLine({ ok: true, outcome, pr: null, reread: false });
    expect(line('merged')).toBe('merged');
    expect(line('already-merged')).toBe('already merged');
    expect(line('auto-merge-enabled')).toBe('auto-merge armed');
    expect(line('auto-merge-disabled')).toBe('auto-merge off');
    expect(line('noop')).toBe('no auto-merge was armed');
    expect(line('update-requested')).toBe('updating…');
  });
});
