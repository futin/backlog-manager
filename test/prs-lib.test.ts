import {
  defaultMethod,
  groupRepos,
  autoMergeBlock,
  mergeBlock,
  outcomeLine,
  prChips,
  PR_KEYS,
  REPO_REASONS,
  updateBlock,
  UPDATING_MS,
  whyLine
} from '../client/src/lib/prs';
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
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ syncOff: SYNC_OFF, methods: [] }))).toBe('sync off');
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('draft');
    expect(mergeBlock(pr({ mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('not mergeable');
    expect(mergeBlock(pr({ checks: 'failure' }), repo({ methods: [] }))).toBe('checks failing');
    expect(mergeBlock(pr(), repo({ methods: [] }))).toBe('no merge method allowed');
    expect(mergeBlock(pr({ mergeable: 'unknown', checks: 'pending' }), repo())).toBeNull();
  });

  it('updateBlock: sync off, then a fork that forbids edits, then up to date', () => {
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo({ syncOff: SYNC_OFF }), false)).toBe('sync off');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo(), false)).toBe('fork does not allow edits');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true, canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: a PR that cannot be updated reads up to date only when it is not behind its base', () => {
    expect(updateBlock(pr({ mergeState: 'behind', canUpdateBranch: false }), repo(), false)).toBe('no permission to update');
    expect(updateBlock(pr({ mergeState: 'clean', canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ mergeState: 'behind', canUpdateBranch: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: while an update is in flight the reason is updating…, whatever canUpdateBranch says (GitHub flips it false once the update lands)', () => {
    // Two PRs, two heads: the mark is the caller's business, so the block must answer from `updating` alone and never from the head it is looking at.
    const updatable = pr({ number: 31, headSha: 'd'.repeat(40), mergeState: 'behind', canUpdateBranch: true });
    const refused = pr({ number: 32, headSha: 'e'.repeat(40), mergeState: 'behind', canUpdateBranch: false });
    expect(updateBlock(updatable, repo(), true)).toBe('updating…');
    expect(updateBlock(refused, repo(), true)).toBe('updating…');
    // The same two rows with no update in flight keep their own answers, so `updating` is the only thing that moved.
    expect(updateBlock(updatable, repo(), false)).toBeNull();
    expect(updateBlock(refused, repo(), false)).toBe('no permission to update');
  });

  it('updateBlock: not behind, not updatable, not updating reads already up to date; up to date but updatable reads null', () => {
    expect(updateBlock(pr({ number: 33, headSha: 'f'.repeat(40), mergeState: 'clean', canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ number: 34, headSha: '1'.repeat(40), mergeState: 'clean', canUpdateBranch: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: sync off outranks updating…, and updating… outranks the fork rule', () => {
    expect(updateBlock(pr({ number: 35, headSha: '2'.repeat(40), mergeState: 'behind' }), repo({ syncOff: SYNC_OFF }), true)).toBe('sync off');
    // `updating…` sits right after `sync off` and before the fork rule: a mark exists only because an update was accepted, so the fork rule cannot have held.
    expect(updateBlock(pr({ number: 36, headSha: '3'.repeat(40), crossRepository: true, maintainerCanModify: false }), repo(), true)).toBe('updating…');
    expect(updateBlock(pr({ number: 36, headSha: '3'.repeat(40), crossRepository: true, maintainerCanModify: false }), repo(), false)).toBe(
      'fork does not allow edits'
    );
  });

  it('autoMergeBlock: enabling needs the repo setting; disabling an armed one never does', () => {
    const armed = pr({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } });
    expect(autoMergeBlock(pr(), repo({ autoMergeAllowed: false }))).toBe('auto-merge not enabled on the repo');
    expect(autoMergeBlock(armed, repo({ autoMergeAllowed: false }))).toBeNull();
    expect(autoMergeBlock(pr(), repo())).toBeNull();
    expect(autoMergeBlock(armed, repo({ syncOff: SYNC_OFF }))).toBe('sync off');
    expect(autoMergeBlock(pr(), repo({ syncOff: SYNC_OFF, autoMergeAllowed: false }))).toBe('sync off');
  });

  it('autoMergeBlock, unarmed: the same order as mergeBlock — sync off, draft, not mergeable, checks failing — then the repo setting', () => {
    // One fixture that is at once draft, conflicting and failing, on a repo with the setting off and under sync off; peel one condition per line.
    const everything = pr({ number: 41, headSha: '4'.repeat(40), draft: true, mergeable: 'conflicting', checks: 'failure' });
    const off = repo({ repo: 'futin/auto-a', syncOff: SYNC_OFF, autoMergeAllowed: false });
    expect(autoMergeBlock(everything, off)).toBe('sync off');
    expect(autoMergeBlock(everything, { ...off, syncOff: null })).toBe('draft');
    expect(autoMergeBlock({ ...everything, draft: false }, { ...off, syncOff: null })).toBe('not mergeable');
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable' }, { ...off, syncOff: null })).toBe('checks failing');
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable', checks: 'none' }, { ...off, syncOff: null })).toBe(
      'auto-merge not enabled on the repo'
    );
    const allowed = { ...off, syncOff: null, autoMergeAllowed: true };
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable', checks: 'none' }, allowed)).toBeNull();
  });

  it('autoMergeBlock, armed: only sync off blocks — a failing, conflicting draft on a repo with the setting off can still be disarmed', () => {
    const armed = pr({
      number: 42,
      headSha: '5'.repeat(40),
      draft: true,
      mergeable: 'conflicting',
      checks: 'failure',
      autoMerge: { method: 'rebase', enabledAt: '2026-10-29T09:30:00Z' }
    });
    expect(autoMergeBlock(armed, repo({ repo: 'futin/auto-b', autoMergeAllowed: false }))).toBeNull();
    expect(autoMergeBlock(armed, repo({ repo: 'futin/auto-b', autoMergeAllowed: false, syncOff: SYNC_OFF }))).toBe('sync off');
  });
});

describe('PR_KEYS', () => {
  it('is the strip in its order: merge, auto-merge, update, open', () => {
    expect([...PR_KEYS]).toEqual(['merge', 'auto-merge', 'update', 'open']);
  });
});

describe('REPO_REASONS', () => {
  it('holds exactly the six reasons that belong to the repo, and none of the row’s own facts', () => {
    const six = ['sync off', 'no merge method allowed', 'auto-merge not enabled on the repo', 'fork does not allow edits'];
    expect([...REPO_REASONS].sort()).toEqual([...six, 'no permission to update', 'updating…'].sort());
    for (const fact of ['draft', 'not mergeable', 'checks failing', 'already up to date']) expect(REPO_REASONS.has(fact)).toBe(false);
  });
});

describe('whyLine', () => {
  it('says sync off once, however many of the three blocks say it, and nothing else behind it', () => {
    const behind = pr({ number: 51, headSha: '6'.repeat(40), mergeState: 'behind', canUpdateBranch: false });
    const off = repo({ repo: 'futin/why-a', syncOff: SYNC_OFF, methods: [], autoMergeAllowed: false });
    expect(whyLine(behind, off, false, undefined)).toEqual(['sync off']);
  });

  it('a quiet clean PR on a repo with auto-merge off says only that', () => {
    expect(whyLine(pr({ number: 52, headSha: '7'.repeat(40) }), repo({ repo: 'futin/why-b', autoMergeAllowed: false }), false, undefined)).toEqual([
      'auto-merge not enabled on the repo'
    ]);
  });

  it('a repo with no merge method and no auto-merge says both, merge first', () => {
    const bare = repo({ repo: 'futin/why-c', methods: [], autoMergeAllowed: false });
    const line = whyLine(pr({ number: 53, headSha: '8'.repeat(40) }), bare, false, undefined);
    expect(line).toEqual(['no merge method allowed', 'auto-merge not enabled on the repo']);
  });

  it('keeps the three blocks in order — merge, auto-merge, update — across a repo that fails all of them', () => {
    const fork = pr({ number: 54, headSha: '9'.repeat(40), crossRepository: true, maintainerCanModify: false });
    expect(whyLine(fork, repo({ repo: 'futin/why-d', methods: [], autoMergeAllowed: false }), false, undefined)).toEqual([
      'no merge method allowed',
      'auto-merge not enabled on the repo',
      'fork does not allow edits'
    ]);
  });

  it('a fork whose maintainers cannot edit it says so', () => {
    const fork = pr({ number: 55, headSha: 'a1'.repeat(20), crossRepository: true, maintainerCanModify: false });
    expect(whyLine(fork, repo({ repo: 'futin/why-e' }), false, undefined)).toEqual(['fork does not allow edits']);
  });

  it('a behind PR this token may not update says no permission to update; a clean one that cannot be updated says nothing', () => {
    const own = repo({ repo: 'futin/why-f' });
    const behind = pr({ number: 56, headSha: 'b2'.repeat(20), mergeState: 'behind', canUpdateBranch: false });
    const clean = pr({ number: 57, headSha: 'c3'.repeat(20), mergeState: 'clean', canUpdateBranch: false });
    expect(whyLine(behind, own, false, undefined)).toEqual(['no permission to update']);
    expect(whyLine(clean, own, false, undefined)).toEqual([]);
  });

  it('the row’s own facts never reach the line: failing checks, a conflict and a draft say nothing here', () => {
    const repoOk = repo({ repo: 'futin/why-g' });
    expect(whyLine(pr({ number: 58, headSha: 'd4'.repeat(20), checks: 'failure' }), repoOk, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 59, headSha: 'e5'.repeat(20), mergeable: 'conflicting' }), repoOk, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 60, headSha: 'f6'.repeat(20), draft: true }), repoOk, false, undefined)).toEqual([]);
  });

  it('reads the blocks, not the repo: a draft PR on a repo with no merge method has draft on Merge and nothing on the line', () => {
    const noMethods = repo({ repo: 'futin/why-h', methods: [] });
    expect(whyLine(pr({ number: 61, headSha: '0a'.repeat(20), draft: true }), noMethods, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 62, headSha: '1b'.repeat(20), draft: false }), noMethods, false, undefined)).toEqual(['no merge method allowed']);
  });

  it('updating… is on the line while an update is in flight, unless the row’s outcome already says it', () => {
    const behind = pr({ number: 63, headSha: '2c'.repeat(20), mergeState: 'behind', canUpdateBranch: true });
    const repoOk = repo({ repo: 'futin/why-i' });
    expect(whyLine(behind, repoOk, true, 'updating')).toEqual([]);
    expect(whyLine(behind, repoOk, true, 'ok')).toEqual(['updating…']);
    expect(whyLine(behind, repoOk, true, 'error')).toEqual(['updating…']);
    expect(whyLine(behind, repoOk, true, undefined)).toEqual(['updating…']);
    // Not updating: nothing to say, whatever the outcome kind.
    expect(whyLine(behind, repoOk, false, 'updating')).toEqual([]);
  });

  it('dropping updating… for the outcome keeps the other reasons on the line', () => {
    const behind = pr({ number: 64, headSha: '3d'.repeat(20), mergeState: 'behind', canUpdateBranch: true });
    const line = whyLine(behind, repo({ repo: 'futin/why-j', methods: [] }), true, 'updating');
    expect(line).toEqual(['no merge method allowed']);
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

describe('UPDATING_MS', () => {
  it('is the 30 s the page waits before its one re-read of a marked PR', () => {
    expect(UPDATING_MS).toBe(30_000);
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
