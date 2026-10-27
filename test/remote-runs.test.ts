import * as fs from 'node:fs';
import * as path from 'node:path';

import { runUsageTotals } from '../client/src/lib/run-stats';
import { ATTENTION_LINE, deriveRemoteRuns, parseAttention, readClaimState } from '../server/src/orchestrator/remote-runs.util';
import { renderClaim } from '../server/src/tracker/claim';
import type { GithubComment } from '../server/src/tracker/github.client';
import { CLAIM_MARKER } from '../shared/types';
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

  it('R-11: updatedAt is the latest of every heartbeat, non-stale released.at and finished.at', () => {
    const latest = ago(0.5);
    const runs = derive([
      claimComment(3, { heartbeat: ago(8), released: { at: ago(4), reason: 'merged', by: 'd' } }),
      claimComment(5, { heartbeat: ago(6), released: { at: ago(5), reason: 'skipped', by: 'd' }, finished: { at: latest, status: 'done' } })
    ]);
    expect(runs[0].updatedAt).toBe(latest);
  });

  it('R-11b: a stale release is the retirer\'s stamp, not the run\'s, and never moves updatedAt', () => {
    // The 2026-10-17 shape: a run on another machine died 19s after its claim,
    // and a day later this machine's driver retired that claim as stale. The
    // card read the retirement as the dead run's last heartbeat.
    const runs = derive([
      claimComment(3, { heartbeat: ago(1590), released: { at: ago(1), reason: 'stale', by: 'other-driver' }, state: { stage: 'dispatched' } })
    ]);
    expect(runs[0].updatedAt).toBe(ago(1590));
    expect(runs[0].status).toBe('running');
    expect(runs[0].fresh).toBe(false);
  });

  it('R-12: project is the local path passed in, never anything from a claim', () => {
    const runs = derive([claimComment(3, { state: { stage: 'reviewing', worktree: '/elsewhere/.worktrees/3' } })]);
    expect(runs[0].project).toBe(PROJECT);
    expect(runs[0].driver).toBeNull();
    expect(runs[0].mergeModeEffective).toBe(runs[0].mergeMode);
  });
});

/* #266: one forged claim-shaped comment used to throw inside `statusOf` (a `null` `finished`), and the route answered 500 on every poll while the comment
   sat in the cache — the Runs page froze for local runs too. The forged comment is now not a claim at all, and the real run beside it still derives. */
describe('deriveRemoteRuns and a forged claim (#266)', () => {
  it('derives the real run and ignores a claim-shaped comment with a null finished', () => {
    const forgedBody = `${CLAIM_MARKER}\n\n\`\`\`json\n${JSON.stringify({ v: 1, run: { runId: 'x' }, finished: null })}\n\`\`\`\n`;
    const runs = derive([claimComment(3), comment(4, forgedBody)]);
    expect(runs.map((r) => r.runId)).toEqual([RUN_ID]);
  });
});

describe('deriveRemoteRuns and the pr merge mode', () => {
  it('R-13: a derived run carries no PR fields — a claim has nowhere to record them — and a pr claim derives mergeMode pr', () => {
    const [plain] = derive([claimComment(3)]);
    expect(plain.prTarget).toBeNull();
    expect(plain.prUrl).toBeNull();

    const [pr] = derive([claimComment(3, { run: { ...RUN, mergeMode: 'pr' } })]);
    expect(pr.mergeMode).toBe('pr');
    expect(pr.mergeModeEffective).toBe('pr');
  });
});

/**
 * Multi-dashboard task 6 — which machine a remote run is on: the `host` its claims carry (the remote's `BM_MACHINE_NAME`), read off the NEWEST claim in the
 * run that carries one, so the orchestrate route can refuse a second launch to the machine already draining the repo.
 */
describe('deriveRemoteRuns and the host', () => {
  it('R-14: claims with hosts a@x then pro-mac — the newer claim’s host, pro-mac', () => {
    const [run] = derive([claimComment(3, { host: 'a@x' }, 2001), claimComment(5, { host: 'pro-mac' }, 2002)]);
    expect(run.host).toBe('pro-mac');
  });

  it('R-14: no claim in the run carries a host — null, never a guess', () => {
    const [run] = derive([claimComment(3), claimComment(5)]);
    expect(run.host).toBeNull();
  });
});

describe('readClaimState', () => {
  it('R-8: drops mis-shaped fields and never throws', () => {
    expect(readClaimState({ stage: 'reviewing', fixLoops: 'two', usage: 5, extra: {} })).toEqual({ stage: 'reviewing' });
    expect(readClaimState('garbage')).toEqual({});
    expect(readClaimState(undefined)).toEqual({});
    expect(readClaimState({ stage: 'teleporting', stageAt: { merged: 'x', bogus: 'y', fixing: 3 } })).toEqual({ stageAt: { merged: 'x' } });
  });

  /* #342 — array members are checked against the shape `orchestrate.mjs` writes, not merely "is an object": the Runs page renders `cmd` as a React child
   * and folds `costUsd`/`turns` as numbers, so `{cmd:{}}` blanked the run's detail sheet and an entry missing `costUsd` turned the run's cost into NaN. */
  const USAGE = {
    sessionId: 's-1',
    kind: 'execute',
    costUsd: 1.25,
    turns: 12,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheCreationTokens: 400,
    durationMs: 5000,
    model: 'claude-opus-5-5',
    peakContextTokens: 9000,
    endedAt: '2026-09-19T11:30:00.000Z'
  };

  it('#342: a verification member must carry a string cmd, a boolean ok and a string tail', () => {
    const good = { cmd: 'pnpm test', ok: true, tail: 'x' };
    const state = readClaimState({
      verification: [good, { cmd: {}, ok: true, tail: '' }, { cmd: 'a', ok: 'yes', tail: '' }, { cmd: 'b', ok: false }, 'str', null]
    });
    expect(state.verification).toEqual([good]);
  });

  it('#342: a usage member with a missing, string or NaN number, an unknown kind or a negative loop is dropped', () => {
    const { costUsd: _dropped, ...noCost } = USAGE;
    const state = readClaimState({
      usage: [USAGE, noCost, { ...USAGE, costUsd: 'NaN' }, { ...USAGE, turns: Number.NaN }, { ...USAGE, kind: 'other' }, { ...USAGE, loop: -1 }]
    });
    expect(state.usage).toEqual([USAGE]);
  });

  it('#342: every nullable usage field null, a loop and no peakContextTokens key — kept', () => {
    const { peakContextTokens: _absent, ...rest } = USAGE;
    const nulls = {
      ...rest,
      kind: 'fix',
      loop: 2,
      sessionId: null,
      costUsd: null,
      turns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      durationMs: null,
      model: null
    };
    expect(readClaimState({ usage: [nulls] }).usage).toEqual([nulls]);
  });

  it('#342: an unknown key on a member passes through, the forward-compatibility rule wellFormed follows', () => {
    const verify = { cmd: 'pnpm test', ok: true, tail: '', exitCode: 0 };
    const usage = { ...USAGE, futureField: 'x' };
    expect(readClaimState({ verification: [verify], usage: [usage] })).toEqual({ verification: [verify], usage: [usage] });
  });

  it('#342: through deriveRemoteRuns, malformed members leave empty arrays and the run cost is null, never NaN', () => {
    const runs = derive([claimComment(3, { state: { stage: 'verifying', verification: [{ cmd: {} }], usage: [{ kind: 'execute' }] } })]);
    const [item] = runs[0].queue;
    expect(item.verification).toEqual([]);
    expect(item.usage).toEqual([]);
    expect(runUsageTotals(runs[0])).toBeNull();
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
