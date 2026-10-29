import { prRunWarning, type PrRunContext } from '../client/src/lib/pr-run';
import type { BacklogItem, OrchestratorRun, ProjectSummary, PullRequestRow, RemoteRun, RemoteStarting, RunQueueItem, RunStage } from '../shared/types';

/**
 * The PRs page's run-in-progress warning. Two repos, each with one project; every fixture below names its repo through the project path the same way the
 * server does, so a derivation that matched on a bare number would warn on the wrong repo and fail a case here.
 */

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const X = 'futin/x';
const Y = 'futin/y';

const projects = [
  { name: 'x', path: '/p/x', repo: X },
  { name: 'y', path: '/p/y', repo: Y },
  { name: 'plain', path: '/p/plain', repo: null }
] as unknown as ProjectSummary[];

function pr(head: string, over: Partial<PullRequestRow> = {}): PullRequestRow {
  return { number: 9, head, crossRepository: false, base: 'main', ...over } as PullRequestRow;
}

const entry = (id: string, stage: RunStage = 'pending'): RunQueueItem => ({ id, title: `item ${id}`, stage }) as RunQueueItem;

function run(over: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return { runId: 'r1', project: '/p/x', status: 'running', base: 'main', queue: [], updatedAt: ago(5_000), ...over } as OrchestratorRun;
}

function remoteRun(over: Partial<RemoteRun> = {}): RemoteRun {
  return { ...run({ runId: 'rr1', project: '/remote/y' }), fresh: true, remote: true, repo: Y, host: 'studio', ...over } as RemoteRun;
}

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return { id, source: 'github', projectPath: '/p/x', ...over } as BacklogItem;
}

function ctx(over: Partial<PrRunContext> = {}): PrRunContext {
  return { projects, items: [], runs: [], remote: [], remoteStarting: [], ...over };
}

const warn = (p: PullRequestRow, repo: string, c: PrRunContext) => prRunWarning(p, repo, c, NOW);

describe('prRunWarning', () => {
  it('scopes ids to the repo', () => {
    const c = ctx({ runs: [run({ queue: [entry('42')] })] });
    expect(warn(pr('backlog/42'), X, c)).toBe('run in progress on this machine');
    expect(warn(pr('backlog/42'), Y, c)).toBeNull();
    expect(warn(pr('execute/42'), X, c)).toBe('run in progress on this machine');
  });

  it('holds for running and paused runs only, and ignores freshness', () => {
    const q = [entry('42')];
    expect(warn(pr('backlog/42'), X, ctx({ runs: [run({ status: 'paused', queue: q })] }))).not.toBeNull();
    for (const status of ['done', 'aborted', 'failed'] as const) {
      expect(warn(pr('backlog/42'), X, ctx({ runs: [run({ status, queue: q })] }))).toBeNull();
    }
    // a crashed `running` run: the heartbeat is long gone, the branch is still held
    expect(warn(pr('backlog/42'), X, ctx({ runs: [run({ updatedAt: ago(3_600_000), queue: q })] }))).not.toBeNull();
  });

  it('counts a queue entry only at a held stage (R5): a merged entry no longer holds its branch', () => {
    const at = (stage: RunStage) => warn(pr('backlog/42'), X, ctx({ runs: [run({ queue: [entry('42', stage)] })] }));
    expect(at('merged')).toBeNull();
    for (const stage of ['branched', 'failed', 'skipped', 'ungroomed'] as const) expect(at(stage)).toBeNull();
    expect(at('pending')).not.toBeNull();
    expect(at('parked')).not.toBeNull();
  });

  it('reads a remote run by its repo, and names its host', () => {
    const c = ctx({ remote: [remoteRun({ queue: [entry('42')] })] });
    expect(warn(pr('backlog/42'), Y, c)).toBe('run in progress on studio');
    expect(warn(pr('backlog/42'), X, c)).toBeNull();
    expect(warn(pr('backlog/42'), Y, ctx({ remote: [remoteRun({ queue: [entry('42')], host: null })] }))).toBe('run in progress on another machine');
    expect(warn(pr('backlog/42'), Y, ctx({ remote: [remoteRun({ queue: [entry('42')], status: 'done' })] }))).toBeNull();
  });

  it('warns on a live claim, not a stale one, and never on a files item', () => {
    const held = (heartbeat: string, over: Partial<BacklogItem> = {}) =>
      warn(pr('backlog/42'), X, ctx({ items: [item('#42', { holder: { session: 's1', heartbeat }, ...over })] }));
    expect(held(ago(10_000))).toBe('claimed by a live session');
    expect(held(ago(3_600_000))).toBeNull();
    expect(
      warn(pr('backlog/42'), X, ctx({ items: [item('42', { source: 'files', projectPath: '/p/plain', holder: { session: 's1', heartbeat: ago(1_000) } })] }))
    ).toBeNull();
    // the same live claim on another repo's project does not leak across
    expect(warn(pr('backlog/42'), Y, ctx({ items: [item('#42', { holder: { session: 's1', heartbeat: ago(1_000) } })] }))).toBeNull();
  });

  it('warns on a pending dispatch to another machine, keyed by the item, and not on an orchestrate launch', () => {
    const start = (over: Partial<RemoteStarting>): RemoteStarting => ({
      kind: 'dispatch',
      project: '/p/y',
      machine: 'studio',
      itemId: '#42',
      requestedAt: ago(1_000),
      ...over
    });
    expect(warn(pr('backlog/42'), Y, ctx({ remoteStarting: [start({})] }))).toBe('launch pending');
    expect(warn(pr('backlog/42'), X, ctx({ remoteStarting: [start({})] }))).toBeNull();
    expect(warn(pr('backlog/42'), Y, ctx({ remoteStarting: [start({ kind: 'orchestrate', itemId: null })] }))).toBeNull();
  });

  it('warns on a run branch only when it is exactly the live base of a running or paused run on the repo', () => {
    const c = ctx({
      runs: [run({ runId: 'a', status: 'done', base: 'backlog/run-a' }), run({ runId: 'b', status: 'running', base: 'backlog/run-b' })]
    });
    expect(warn(pr('backlog/run-b'), X, c)).toBe('run in progress on this machine');
    expect(warn(pr('backlog/run-a'), X, c)).toBeNull();
    expect(warn(pr('backlog/run-b'), Y, c)).toBeNull();
    expect(warn(pr('backlog/run-b'), Y, ctx({ remote: [remoteRun({ base: 'backlog/run-b', status: 'paused' })] }))).toBe('run in progress on studio');
  });

  it('never warns for other heads, or for a fork whose head looks like ours', () => {
    const c = ctx({
      runs: [run({ queue: [entry('42'), entry('3')], base: 'feature/42' })],
      items: [item('#42', { holder: { session: 's', heartbeat: ago(1_000) } })]
    });
    expect(warn(pr('backlog/bug-3'), X, c)).toBeNull();
    expect(warn(pr('feature/42'), X, c)).toBeNull();
    expect(warn(pr('backlog/42x'), X, c)).toBeNull();
    expect(warn(pr('backlog/42', { crossRepository: true }), X, c)).toBeNull();
  });
});
