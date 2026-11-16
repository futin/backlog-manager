import type { PrRepoView, PullRequestRow } from '../../shared/types';

/**
 * pr-fixtures.ts — one PR row and one repo view with every field set, shared by the PRs layouts' lib suite and the rail counts' lib suite. They lived
 * file-local in `test/github/pr-layouts-lib.test.ts` until the rail needed the same payload shape; a copy would drift the moment `PullRequestRow` gains a
 * field, so both suites import this one. Every default is a plausible, distinct value, and each case overrides only the fields it asserts on.
 */

export function row(over: Partial<PullRequestRow> = {}): PullRequestRow {
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
    checkCounts: null,
    autoMerge: null,
    canUpdateBranch: false,
    ...over
  };
}

export function repo(over: Partial<PrRepoView> = {}): PrRepoView {
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
    checksDetail: null,
    ...over
  };
}
