import { parseBranchChoice, resolveWorkspace } from '../server/src/jira/branch-choice.util';
import type { JiraBranchChoice } from '../server/src/jira/branch-choice.util';
import type { JiraAction, JiraRefBranch, JiraRepoRefs } from '../shared/types';

/**
 * branch-choice.test.ts — the branch choice both Jira Run routes take (Jira repo/branch, Task 6; spec §5.3). `parseBranchChoice` is shape only, so its cases
 * are pure; `resolveWorkspace` is handed the refs a git read would have produced, so no repository is needed either. The routes' own suites cover the wiring.
 */

const KEY = 'TIMIFY-123';
const REPO = '/work/pay';

const parse = (raw: Parameters<typeof parseBranchChoice>[0], action: JiraAction = 'execute') => parseBranchChoice(raw, KEY, action);
const error = (raw: Parameters<typeof parseBranchChoice>[0], action: JiraAction = 'execute') => {
  const r = parse(raw, action);
  return r.ok ? null : r.error;
};

describe('parseBranchChoice — the refusals, each from a minimal failing input, in the spec order', () => {
  it.each([
    ['no mode', {}, 'execute', 'mode must be new, continue or none'],
    ['an unknown mode', { mode: 'old' }, 'execute', 'mode must be new, continue or none'],
    ['a null mode', { mode: null }, 'context', 'mode must be new, continue or none'],
    ['a non-string mode', { mode: ['new', 'none'] }, 'context', 'mode must be new, continue or none'],
    ['none for execute', { mode: 'none' }, 'execute', 'execute needs a branch (mode new or continue)'],
    ['a branch with none', { mode: 'none', branch: 'x' }, 'context', 'branch is not for mode none'],
    ['no branch for new', { mode: 'new' }, 'execute', 'branch is required'],
    ['no branch for continue', { mode: 'continue' }, 'execute', 'branch is required'],
    ['a numeric branch', { mode: 'continue', branch: 7 }, 'execute', 'branch is required'],
    ['an empty branch', { mode: 'continue', branch: '' }, 'execute', 'branch is empty'],
    ['a branch with a space', { mode: 'continue', branch: 'a b' }, 'execute', 'branch may hold only A-Z a-z 0-9 . _ / -'],
    ['a branch starting with a dash', { mode: 'new', branch: '-x', base: 'develop' }, 'execute', 'branch may not start with -'],
    ['no base for new', { mode: 'new', branch: 'timify-123-x' }, 'execute', 'base is required for a new branch'],
    ['a numeric base for new', { mode: 'new', branch: 'timify-123-x', base: 1 }, 'execute', 'base is required for a new branch'],
    ['a base with continue', { mode: 'continue', branch: 'x', base: 'develop' }, 'execute', 'base is only for a new branch'],
    ['a base with none', { mode: 'none', base: 'develop' }, 'context', 'base is only for a new branch'],
    ['a base with ..', { mode: 'new', branch: 'timify-123-x', base: 'a..b' }, 'execute', 'base may not contain ..'],
    ['an empty base', { mode: 'new', branch: 'timify-123-x', base: '' }, 'execute', 'base is empty'],
    ['a new branch without the key', { mode: 'new', branch: 'feature/other-9', base: 'develop' }, 'execute', 'branch must carry TIMIFY-123'],
    ['a non-boolean openMr', { mode: 'continue', branch: 'x', openMr: 'yes' }, 'execute', 'openMr must be true or false'],
    ['openMr with context', { mode: 'continue', branch: 'x', openMr: true }, 'context', 'openMr is only for execute with a branch'],
    ['openMr with none', { mode: 'none', openMr: true }, 'context', 'openMr is only for execute with a branch'],
    ['a target without openMr', { mode: 'continue', branch: 'x', target: 'develop' }, 'execute', 'target is only for openMr with continue'],
    [
      'a target with a new branch',
      { mode: 'new', branch: 'timify-123-x', base: 'develop', openMr: true, target: 'develop' },
      'execute',
      'target is only for openMr with continue'
    ],
    ['a non-string target', { mode: 'continue', branch: 'x', openMr: true, target: 3 }, 'execute', 'target is required'],
    ['a target with a colon', { mode: 'continue', branch: 'x', openMr: true, target: 'a:b' }, 'execute', 'target may hold only A-Z a-z 0-9 . _ / -']
  ] as const)('400 for %s', (_label, raw, action, expected) => {
    expect(error(raw, action)).toBe(expected);
  });

  it('first hit wins: a request wrong in several ways says the earliest sentence', () => {
    expect(error({ mode: 'none', branch: 'a b', base: 'x', openMr: 'maybe', target: 'a:b' }, 'execute')).toBe('execute needs a branch (mode new or continue)');
    expect(error({ mode: 'new', branch: 'a b', base: 'a..b', openMr: 'maybe', target: 'a:b' })).toBe('branch may hold only A-Z a-z 0-9 . _ / -');
    expect(error({ mode: 'new', branch: 'timify-123-x', base: 'a..b', openMr: 'maybe' })).toBe('base may not contain ..');
    expect(error({ mode: 'new', branch: 'other-1', base: 'develop', openMr: 'maybe' })).toBe('branch must carry TIMIFY-123');
    expect(error({ mode: 'continue', branch: 'x', openMr: 'maybe', target: 'a:b' })).toBe('openMr must be true or false');
  });
});

describe('parseBranchChoice — what is accepted', () => {
  it('none for context and for a skill', () => {
    expect(parse({ mode: 'none' }, 'context')).toEqual({ ok: true, value: { mode: 'none' } });
    expect(parse({ mode: 'none' }, { skill: 's_0123abcd' })).toEqual({ ok: true, value: { mode: 'none' } });
  });

  it('new for execute, with and without openMr; a branch that carries the key in any case and position', () => {
    expect(parse({ mode: 'new', branch: 'timify-123-x', base: 'develop' })).toEqual({
      ok: true,
      value: { mode: 'new', branch: 'timify-123-x', base: 'develop', openMr: false }
    });
    expect(parse({ mode: 'new', branch: 'feature/TIMIFY-123_x', base: 'origin/develop', openMr: true })).toEqual({
      ok: true,
      value: { mode: 'new', branch: 'feature/TIMIFY-123_x', base: 'origin/develop', openMr: true }
    });
  });

  it('new and continue for context and for a skill: a branch, never an MR', () => {
    expect(parse({ mode: 'new', branch: 'timify-123-x', base: 'develop' }, 'context').ok).toBe(true);
    expect(parse({ mode: 'continue', branch: 'anything' }, { skill: 's_0123abcd' })).toEqual({
      ok: true,
      value: { mode: 'continue', branch: 'anything', openMr: false, target: null }
    });
  });

  it('continue needs no key in its name — the branch already exists', () => {
    expect(parse({ mode: 'continue', branch: 'develop' })).toEqual({ ok: true, value: { mode: 'continue', branch: 'develop', openMr: false, target: null } });
  });

  it('continue with openMr and a target, and openMr as the query spells it', () => {
    expect(parse({ mode: 'continue', branch: 'x', openMr: true, target: 'release/1.2' })).toEqual({
      ok: true,
      value: { mode: 'continue', branch: 'x', openMr: true, target: 'release/1.2' }
    });
    expect(parse({ mode: 'continue', branch: 'x', openMr: 'true' })).toEqual({ ok: true, value: { mode: 'continue', branch: 'x', openMr: true, target: null } });
    expect(parse({ mode: 'continue', branch: 'x', openMr: 'false' })).toEqual({ ok: true, value: { mode: 'continue', branch: 'x', openMr: false, target: null } });
  });

  it('null counts as absent, so a client that serialises its unused fields as null is not refused for them', () => {
    expect(parse({ mode: 'none', branch: null, base: null, openMr: null, target: null }, 'context')).toEqual({ ok: true, value: { mode: 'none' } });
    expect(parse({ mode: 'new', branch: 'timify-123-x', base: 'develop', openMr: false, target: null })).toEqual({
      ok: true,
      value: { mode: 'new', branch: 'timify-123-x', base: 'develop', openMr: false }
    });
  });
});

describe('resolveWorkspace', () => {
  const branch = (name: string, worktree: string | null = null): JiraRefBranch => ({
    name,
    local: true,
    remote: true,
    sync: 'same',
    committedAt: '2026-01-01T00:00:00.000Z',
    worktree,
    ticket: false
  });
  const refs = (branches: JiraRefBranch[], mainBranch: string | null = 'develop'): JiraRepoRefs => ({
    repo: REPO,
    available: true,
    fetchedAt: null,
    mainBranch,
    defaultBase: 'develop',
    branches
  });
  const down: JiraRepoRefs = { repo: REPO, available: false, reason: 'not mounted into the board' };
  const resolve = (choice: JiraBranchChoice, r: JiraRepoRefs) => resolveWorkspace(choice, KEY, REPO, r);

  const newChoice: JiraBranchChoice = { mode: 'new', branch: 'timify-123-x', base: 'develop', openMr: false };
  const contChoice: JiraBranchChoice = { mode: 'continue', branch: 'timify-123-x', openMr: false, target: null };

  it('none is no workspace, whatever the refs say', () => {
    expect(resolve({ mode: 'none' }, refs([]))).toEqual({ ok: true, workspace: null });
    expect(resolve({ mode: 'none' }, down)).toEqual({ ok: true, workspace: null });
  });

  it('a new branch whose name is already listed is a 409 naming the way out', () => {
    expect(resolve(newChoice, refs([branch('develop', REPO), branch('timify-123-x')]))).toEqual({
      ok: false,
      status: 409,
      error: 'timify-123-x exists — switch to Continue'
    });
  });

  it('a new branch nobody lists gets the conventional worktree and carries base and the MR flag; target is never set', () => {
    expect(resolve({ ...newChoice, branch: 'feature/timify-123-x', openMr: true }, refs([branch('develop', REPO)]))).toEqual({
      ok: true,
      workspace: { mode: 'new', branch: 'feature/timify-123-x', base: 'develop', worktree: `${REPO}/.worktrees/feature-timify-123-x`, openMr: true, target: null }
    });
  });

  it('a continued branch the mapped checkout holds is a 409 naming the checkout', () => {
    expect(resolve({ ...contChoice, branch: 'develop' }, refs([branch('develop', REPO)]))).toEqual({
      ok: false,
      status: 409,
      error: `develop is checked out in the mapped checkout ${REPO}`
    });
  });

  it('a continued branch a linked worktree holds is that worktree, not a refusal', () => {
    expect(resolve({ ...contChoice, openMr: true, target: 'develop' }, refs([branch('develop', REPO), branch('timify-123-x', '/elsewhere/hand-made')]))).toEqual({
      ok: true,
      workspace: { mode: 'continue', branch: 'timify-123-x', base: null, worktree: '/elsewhere/hand-made', openMr: true, target: 'develop' }
    });
  });

  it('a continued branch no tree holds gets the conventional path', () => {
    expect(resolve(contChoice, refs([branch('develop', REPO), branch('timify-123-x')]))).toEqual({
      ok: true,
      workspace: { mode: 'continue', branch: 'timify-123-x', base: null, worktree: `${REPO}/.worktrees/timify-123-x`, openMr: false, target: null }
    });
  });

  it('a continued branch that is not listed at all (typed by hand) gets the conventional path too', () => {
    expect(resolve(contChoice, refs([branch('develop', REPO)])).ok).toBe(true);
  });

  it('a detached main checkout holds no branch, so nothing is refused for it', () => {
    expect(resolve({ ...contChoice, branch: 'develop' }, refs([branch('develop')], null)).ok).toBe(true);
  });

  it('a branch whose recorded tree is the mapped repo itself is never taken as a linked tree', () => {
    const r = resolve(contChoice, refs([branch('timify-123-x', REPO)], null));
    expect(r).toEqual({ ok: true, workspace: expect.objectContaining({ worktree: `${REPO}/.worktrees/timify-123-x` }) });
  });

  it('unavailable refs: the conventional path, and neither refusal can be made', () => {
    expect(resolve(newChoice, down)).toEqual({
      ok: true,
      workspace: { mode: 'new', branch: 'timify-123-x', base: 'develop', worktree: `${REPO}/.worktrees/timify-123-x`, openMr: false, target: null }
    });
    expect(resolve({ ...contChoice, branch: 'develop' }, down)).toEqual({
      ok: true,
      workspace: { mode: 'continue', branch: 'develop', base: null, worktree: `${REPO}/.worktrees/develop`, openMr: false, target: null }
    });
  });
});
