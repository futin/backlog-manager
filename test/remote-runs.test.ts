import * as fs from 'node:fs';
import * as path from 'node:path';

import { ATTENTION_LINE, deriveRemoteRuns, parseAttention, readClaimState } from '../server/src/orchestrator/remote-runs.util';
import { renderClaim } from '../server/src/tracker/claim';
import type { GithubComment } from '../server/src/tracker/github.client';
import type { ClaimRecord, ClaimRun } from '../shared/types';

/**
 * remote-runs.util.ts (task-48) — a run another machine drove, rebuilt from the
 * claim comments of one repo. Pure over fixture comments with `nowMs` fixed, so
 * every row below is a hand-checked verdict rather than a sequence of network
 * calls.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const REPO = 'futin/x';
const PROJECT = '/abs/tracker-here';
const RUN_ID = 'run-20260919-110000';

const RUN: ClaimRun = {
  runId: RUN_ID,
  startedAt: '2026-09-19T11:00:00.000Z',
  mergeMode: 'merge',
  questionMode: 'park',
  maxItems: null,
  base: 'main'
};

let nextId = 1000;

function claimComment(issue: number, over: Partial<ClaimRecord> = {}, id = nextId++): GithubComment {
  const record: ClaimRecord = {
    v: 1,
    session: 'driver-session',
    phase: 'execute',
    at: ago(30),
    heartbeat: ago(1),
    counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
    run: RUN,
    ...over
  };
  return comment(issue, renderClaim(record), id);
}

function comment(issue: number, body: string, id = nextId++): GithubComment {
  return {
    id,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}`,
    body,
    html_url: `https://github.com/${REPO}/issues/${issue}#issuecomment-${id}`,
    created_at: ago(5),
    updated_at: ago(5)
  };
}

function derive(comments: GithubComment[], localRunIds: string[] = []) {
  return deriveRemoteRuns({
    repo: REPO,
    project: PROJECT,
    comments,
    issueTitle: (n) => (n === 3 ? 'Three' : null),
    localRunIds: new Set(localRunIds),
    nowMs: NOW
  });
}

describe('deriveRemoteRuns', () => {
  it('R-1: two fresh claims of one run are one running, fresh run, queued in claim-at order', () => {
    const runs = derive([claimComment(5, { at: ago(20), state: { stage: 'reviewing' } }), claimComment(3, { at: ago(40), state: { stage: 'merging' } })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: RUN_ID, status: 'running', fresh: true, remote: true, repo: REPO });
    expect(runs[0].queue.map((q) => q.id)).toEqual(['3', '5']);
    expect(runs[0].queue.map((q) => q.title)).toEqual(['Three', '#5']);
    expect(runs[0].queue.map((q) => q.stage)).toEqual(['merging', 'reviewing']);
  });

  it('R-2: the same claims 20 minutes silent are running and NOT fresh — crashed, never done', () => {
    const runs = derive([claimComment(3, { heartbeat: ago(20) }), claimComment(5, { heartbeat: ago(20) })]);
    expect(runs[0]).toMatchObject({ status: 'running', fresh: false });
  });

  it('R-3: a finished stamp with no heartbeat after it is the run status', () => {
    const T = ago(2);
    const runs = derive([
      claimComment(3, { heartbeat: ago(10), released: { at: ago(3), reason: 'merged', by: 'driver-session' }, finished: { at: T, status: 'done' } })
    ]);
    expect(runs[0].status).toBe('done');
    // A terminal release is read as the item's stage: the driver releases
    // WITHOUT a final state heartbeat, so `state.stage` is the stage before.
    expect(runs[0].queue[0].stage).toBe('merged');
  });

  it('R-3: the finished claim’s OWN heartbeat, moved by the stamp itself, does not un-finish the run', () => {
    // `finish` on an unreleased (needs-answers) claim moves its heartbeat to
    // the server clock, just after the CLI's `finished.at`.
    const T = ago(2);
    const runs = derive([claimComment(3, { heartbeat: ago(1.99), state: { stage: 'needs-answers' }, finished: { at: T, status: 'paused' } })]);
    expect(runs[0].status).toBe('paused');
  });

  it('R-4: a paused stamp followed by a later heartbeat reads as running again', () => {
    const T = ago(10);
    const runs = derive([
      claimComment(3, { heartbeat: ago(12), released: { at: ago(11), reason: 'parked', by: 'd' }, finished: { at: T, status: 'paused' } }),
      claimComment(5, { at: ago(6), heartbeat: ago(1) })
    ]);
    expect(runs[0]).toMatchObject({ status: 'running', fresh: true });
  });

  it('R-5: two claims on one issue in one run are one queue item, from the newer claim', () => {
    const runs = derive([
      claimComment(3, { released: { at: ago(9), reason: 'resumed', by: 'd' }, state: { stage: 'dispatched' } }, 2001),
      claimComment(3, { state: { stage: 'verifying' } }, 2002)
    ]);
    expect(runs[0].queue).toHaveLength(1);
    expect(runs[0].queue[0]).toMatchObject({ id: '3', stage: 'verifying', claim: { commentId: 2002 } });
  });

  it('R-6: a hand claim (no run) contributes no run', () => {
    expect(derive([claimComment(3, { run: undefined })])).toEqual([]);
  });

  it('R-7: a run this machine holds a run file for is dropped', () => {
    expect(derive([claimComment(3)], [RUN_ID])).toEqual([]);
  });

  it('R-8: a malformed state keeps what it can read, never throws', () => {
    const runs = derive([
      claimComment(3, { state: { stage: 'reviewing', fixLoops: 'two', usage: 5, extra: {} } }),
      claimComment(5, { state: 'garbage' }),
      claimComment(7, {})
    ]);
    const [three, five, seven] = runs[0].queue;
    expect(three).toMatchObject({ stage: 'reviewing', fixLoops: 0 });
    expect(three.usage).toBeUndefined();
    expect(five.stage).toBe('preflight');
    expect(seven.stage).toBe('preflight');
  });

  it('R-10: an attention comment whose run matches is on the run, one for another run is not', () => {
    const runs = derive([
      claimComment(5),
      comment(5, `<!-- bm:attention kind=parked run=${RUN_ID} -->\n\n@futin merge conflict in a.ts`),
      comment(5, '<!-- bm:attention kind=parked run=run-20260101-000000 -->\n\nnot ours')
    ]);
    expect(runs[0].attention).toEqual([{ id: '5', kind: 'parked', detail: 'merge conflict in a.ts' }]);
  });

  it('R-11: updatedAt is the latest of every heartbeat, released.at and finished.at', () => {
    const latest = ago(0.5);
    const runs = derive([
      claimComment(3, { heartbeat: ago(8), released: { at: ago(4), reason: 'merged', by: 'd' } }),
      claimComment(5, { heartbeat: ago(6), released: { at: ago(5), reason: 'skipped', by: 'd' }, finished: { at: latest, status: 'done' } })
    ]);
    expect(runs[0].updatedAt).toBe(latest);
  });

  it('R-12: project is the local path passed in, never anything from a claim', () => {
    const runs = derive([claimComment(3, { state: { stage: 'reviewing', worktree: '/elsewhere/.worktrees/3' } })]);
    expect(runs[0].project).toBe(PROJECT);
    expect(runs[0].driver).toBeNull();
    expect(runs[0].mergeModeEffective).toBe(runs[0].mergeMode);
  });
});

describe('readClaimState', () => {
  it('R-8: drops mis-shaped fields and never throws', () => {
    expect(readClaimState({ stage: 'reviewing', fixLoops: 'two', usage: 5, extra: {} })).toEqual({ stage: 'reviewing' });
    expect(readClaimState('garbage')).toEqual({});
    expect(readClaimState(undefined)).toEqual({});
    expect(readClaimState({ stage: 'teleporting', stageAt: { merged: 'x', bogus: 'y', fixing: 3 } })).toEqual({ stageAt: { merged: 'x' } });
  });
});

describe('parseAttention', () => {
  it('R-9: accepts the marker on line 1 and strips the mention', () => {
    expect(parseAttention({ body: '<!-- bm:attention kind=parked run=run-20260919-120000 -->\n\n@futin detail text' })).toEqual({
      kind: 'parked',
      runId: 'run-20260919-120000',
      detail: 'detail text'
    });
  });

  it.each([
    ['an unknown kind', '<!-- bm:attention kind=bogus run=run-20260919-120000 -->\n\nx'],
    ['a run id of the wrong shape', '<!-- bm:attention kind=parked run=run-2026 -->\n\nx'],
    ['the marker anywhere but line 1', 'hello\n<!-- bm:attention kind=parked run=run-20260919-120000 -->\n\nx']
  ])('R-9: refuses %s', (_label, body) => {
    expect(parseAttention({ body })).toBeNull();
  });
});

/* G-1: `orchestrate.mjs attention` writes the marker and this file parses it,
 * and neither can import the other — a plugin skill's `tools/` stands alone.
 * They agree by reading the tool's SOURCE, the way `tracker-labels.test.ts`
 * holds `labels.ts` and `connect`'s issue forms together. */
describe('the attention marker, CLI and server', () => {
  it('G-1: the marker orchestrate.mjs composes is one ATTENTION_LINE accepts', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'skills', 'backlog-orchestrate', 'tools', 'orchestrate.mjs'), 'utf8');
    const decl = /const ATTENTION_MARKER = \(kind, runId\) => `([^`]*)`;/.exec(source);
    expect(decl).not.toBeNull();
    for (const kind of ['needs-answers', 'parked', 'fix-exhausted']) {
      const line = decl![1].replace('${kind}', kind).replace('${runId}', 'run-20260919-120000');
      expect(ATTENTION_LINE.test(line)).toBe(true);
    }
    // …and the CLI's kind list is exactly the regex's.
    const kinds = /const ATTENTION_KINDS = \[([^\]]*)\];/.exec(source);
    expect(kinds).not.toBeNull();
    const cliKinds = kinds![1].split(',').map((k) => k.trim().replace(/'/g, ''));
    expect(ATTENTION_LINE.source).toContain(`(${cliKinds.join('|')})`);
  });
});
