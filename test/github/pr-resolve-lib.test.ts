import { resolveBlock, resolveGateFor, resolveIndex, shownOutcome } from '../../client/src/lib/pr-resolve';
import { prKey } from '../../client/src/lib/prs';
import type { DispatchGate } from '../../shared/agent';
import type { AgentsStatus, PrRepoView, PrResolveOutcome, PrResolveState, ProjectSummary, PullRequestRow } from '../../shared/types';

/**
 * The Resolve row's derivations (spec 2026-11-17-pr-conflict-resolve-design.md, "The board"). Fixtures use distinct SHAs per role (the PR's head, the
 * outcome's `fromSha`, its `headSha`), so a comparison against the wrong field cannot pass by coincidence.
 */

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 17,
    title: 'Teach the board to merge',
    url: 'https://github.com/futin/x/pull/17',
    author: 'ada',
    draft: false,
    head: 'feature/merge-it',
    headSha: 'p0',
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T10:00:00Z',
    mergeable: 'conflicting',
    mergeState: 'dirty',
    review: null,
    checks: 'none',
    checkCounts: null,
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
    methods: ['squash'],
    autoMergeAllowed: true,
    prs: [],
    total: 0,
    truncated: false,
    checksDetail: null,
    ...over
  };
}

function outcome(over: Partial<PrResolveOutcome> = {}): PrResolveOutcome {
  return { outcome: 'stopped', reason: 'one hunk is a judgment call', fromSha: 'f1', headSha: 'h2', sessionId: 's-1', ...over };
}

function state(over: Partial<PrResolveState> = {}): PrResolveState {
  return { repo: 'futin/x', number: 17, live: null, outcome: null, ...over };
}

const ENABLED: DispatchGate = { control: 'enabled' };
const DISABLED: DispatchGate = { control: 'disabled', reason: 'the dashboard does not list /p/x' };

describe('shownOutcome', () => {
  it('returns null for no outcome', () => {
    expect(shownOutcome(pr(), null)).toBeNull();
  });

  it('shows a stopped outcome while the PR is at its head', () => {
    const o = outcome({ outcome: 'stopped', fromSha: 'f1', headSha: 'f1' });
    expect(shownOutcome(pr({ headSha: 'f1' }), o)).toBe(o);
  });

  it('hides a stopped outcome once the PR moved to another head', () => {
    expect(shownOutcome(pr({ headSha: 'x9' }), outcome({ outcome: 'stopped', fromSha: 'f1', headSha: 'f1' }))).toBeNull();
  });

  it('shows an up-to-date outcome at its head', () => {
    const o = outcome({ outcome: 'up-to-date', fromSha: 'f1', headSha: 'f1' });
    expect(shownOutcome(pr({ headSha: 'f1' }), o)).toBe(o);
  });

  it('shows a pushed outcome while the PR is still at fromSha', () => {
    const o = outcome({ outcome: 'pushed' });
    expect(shownOutcome(pr({ headSha: 'f1' }), o)).toBe(o);
  });

  it('shows a pushed outcome at its head while GitHub reads unknown', () => {
    const o = outcome({ outcome: 'pushed' });
    expect(shownOutcome(pr({ headSha: 'h2', mergeable: 'unknown' }), o)).toBe(o);
  });

  it('hides a pushed outcome at its head while GitHub reads conflicting: the base moved again', () => {
    expect(shownOutcome(pr({ headSha: 'h2', mergeable: 'conflicting' }), outcome({ outcome: 'pushed' }))).toBeNull();
  });

  it('hides a pushed outcome at its head once the PR reads mergeable', () => {
    expect(shownOutcome(pr({ headSha: 'h2', mergeable: 'mergeable' }), outcome({ outcome: 'pushed' }))).toBeNull();
  });

  it('hides a pushed outcome when the PR is at neither SHA', () => {
    expect(shownOutcome(pr({ headSha: 'x9' }), outcome({ outcome: 'pushed' }))).toBeNull();
  });
});

describe('resolveBlock', () => {
  const pushed = outcome({ outcome: 'pushed' });

  it('says sync off first, over a disabled gate', () => {
    expect(resolveBlock(pr({ crossRepository: true }), repo({ syncOff: 'sync is off for futin/x' }), DISABLED, undefined, 'warn')).toBe('sync off');
  });

  it("says the gate's own reason when disabled, over a fork", () => {
    expect(resolveBlock(pr({ crossRepository: true }), repo(), DISABLED, undefined, null)).toBe(DISABLED.control === 'disabled' ? DISABLED.reason : '');
  });

  it('says fork over a mergeable PR', () => {
    expect(resolveBlock(pr({ crossRepository: true, mergeable: 'mergeable' }), repo(), ENABLED, undefined, null)).toBe('fork — cannot push');
  });

  it('says mergeability pending over a live entry', () => {
    expect(resolveBlock(pr({ mergeable: 'unknown' }), repo(), ENABLED, state({ live: { sessionId: null } }), null)).toBe('mergeability pending');
  });

  it('says no conflicts over a live entry', () => {
    expect(resolveBlock(pr({ mergeable: 'mergeable' }), repo(), ENABLED, state({ live: { sessionId: 's' } }), null)).toBe('no conflicts');
  });

  it('says resolving… over a shown pushed outcome', () => {
    const s = state({ live: { sessionId: null }, outcome: pushed });
    expect(resolveBlock(pr({ headSha: 'f1' }), repo(), ENABLED, s, null)).toBe('resolving…');
  });

  it('leaves the row enabled when a pushed outcome is at its head and GitHub reads conflicting', () => {
    expect(resolveBlock(pr({ headSha: 'h2', mergeable: 'conflicting' }), repo(), ENABLED, state({ outcome: pushed }), null)).toBeNull();
  });

  it('says resolved — waiting for GitHub over a warning', () => {
    expect(resolveBlock(pr({ headSha: 'f1' }), repo(), ENABLED, state({ outcome: pushed }), 'a run holds it')).toBe('resolved — waiting for GitHub');
  });

  it('returns the warning verbatim when all else is clear', () => {
    expect(resolveBlock(pr(), repo(), ENABLED, undefined, 'a run holds it')).toBe('a run holds it');
  });

  it('returns null when everything is clear', () => {
    expect(resolveBlock(pr(), repo(), ENABLED, undefined, null)).toBeNull();
  });

  it('returns null after a shown stopped outcome: the row is enabled again', () => {
    const s = state({ outcome: outcome({ outcome: 'stopped', fromSha: 'f1', headSha: 'f1' }) });
    expect(resolveBlock(pr({ headSha: 'f1' }), repo(), ENABLED, s, null)).toBeNull();
  });

  it('ignores a pushed outcome that no longer shows', () => {
    expect(resolveBlock(pr({ headSha: 'x9' }), repo(), ENABLED, state({ outcome: pushed }), null)).toBeNull();
  });
});

describe('resolveGateFor', () => {
  const status = (over: Partial<AgentsStatus> = {}): AgentsStatus => ({
    enabled: true,
    reachable: true,
    remoteAnswer: true,
    spawnAvailable: true,
    spawnMaxPermission: null,
    projectPaths: ['/p/b'],
    ...over
  });
  const project = (path: string, repoName: string | null): ProjectSummary => ({ name: path, path, repo: repoName }) as unknown as ProjectSummary;

  it('is null while the status is unknown', () => {
    expect(resolveGateFor(null, 'futin/x', [project('/p/a', 'futin/x')])).toBeNull();
  });

  it('is hidden when agents are off', () => {
    expect(resolveGateFor(status({ enabled: false }), 'futin/x', [project('/p/b', 'futin/x')])?.control).toBe('hidden');
  });

  it('is enabled when the repo project is listed', () => {
    expect(resolveGateFor(status(), 'futin/x', [project('/p/b', 'futin/x')])).toEqual({ control: 'enabled' });
  });

  it('asks about the FIRST project on the repo: two projects, only the second listed, is disabled', () => {
    const gate = resolveGateFor(status(), 'futin/x', [project('/p/a', 'futin/x'), project('/p/b', 'futin/x')]);
    expect(gate?.control).toBe('disabled');
  });

  it('is hidden when no project is on the repo', () => {
    expect(resolveGateFor(status(), 'futin/other', [project('/p/b', 'futin/x')])).toEqual({ control: 'hidden', reason: '' });
  });
});

describe('resolveIndex', () => {
  it('keys each state by prKey, including a PR no repo shows', () => {
    const a = state({ repo: 'futin/x', number: 17 });
    const b = state({ repo: 'futin/gone', number: 3 });
    const index = resolveIndex([a, b]);
    expect(index.get(prKey('futin/x', 17))).toBe(a);
    expect(index.get(prKey('futin/gone', 3))).toBe(b);
    expect(index.size).toBe(2);
  });
});
