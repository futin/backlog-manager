// A tracker item's claim as this machine's state (P-1 … P-12), and the snapshot and sidecars (I-1 … I-3).
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STREAM_USAGE,
  STREAM_USAGE_NO_NUMBERS,
  claimRoutes,
  closedPort,
  orchFixture,
  posts,
  run,
  runApi,
  runFile,
  runsDir,
  seedReadyTask,
  trackerFixture,
  transcriptAs,
  withApi
} from './orchestrate-test-lib.mjs';

// --- P-1 … P-12: the claim as this machine's state --------------------------
//
// The driver owns a tracker item's claim for the whole item: it takes the
// issue at `stage <n> preflight`, publishes the queue item onto that claim
// from every command that changes it, and releases at the terminal stage. The
// dispatched session never touches the issue at all.
//
// Two asymmetries these cases exist to pin, because both are decisions that
// look like oversights from the code alone:
//
//   * **A failed heartbeat is never a failure of the command** (P-4). The run
//     file is the journal of record on this machine and the claim's `state` is
//     a published copy of it; failing a `stage` call over a copy would cost
//     this machine an item mid-flight for a write nothing local depends on.
//   * **A failed CLOSE is fatal** (P-8). That one is not a copy — it is the
//     only record anywhere that the item is done — so the stage is not written
//     and no release is sent, and the SKILL parks the item.

test('stage preflight claims the issue for this run and records the comment id', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'preflight');
    assert.equal(out.status, 0, out.stderr);
  });

  const claims = posts(requests, 'claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.phase, 'execute');
  assert.equal(claims[0].body.id, '#3');
  assert.equal(claims[0].body.session, 'sess-test');

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(claims[0].body.run.runId, written.runId);
  assert.deepEqual(Object.keys(claims[0].body.run).sort(), ['base', 'maxItems', 'mergeMode', 'questionMode', 'runId', 'startedAt']);
  assert.deepEqual(written.queue[0].claim, { commentId: 501 });
});

test('a claim held by another run skips the item and says whose it is, exit 0', async (t) => {
  const { home, project } = trackerFixture(t);
  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : { status: 409, body: { error: '#3 is already in progress', holder: { session: 'other-machine', heartbeat: '…', ageMs: 42_000, commentId: 7 } } },
  };

  const { requests } = await withApi(claimRoutes(project, held), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'preflight');
    // A refusal is information about the world, not a failure of this call.
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /"stage":"skipped"/);
  });

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.queue[0].stage, 'skipped');
  assert.match(written.queue[0].note, /^claimed elsewhere \(session other-machine, heartbeat 42s ago\)/);
  assert.equal(written.queue[0].claim, undefined);
  // No release for a claim this run never held.
  assert.equal(posts(requests, 'release').length, 0);
});

/* bug-46. The driver is a CLI like `backlog.mjs`, and it publishes claims other machines read: a session id names a transcript on exactly one host, so a
   claim carrying only that tells a reader elsewhere nothing they can check. The host rides beside it — sent by the CLI, never derived by the server, which
   may be in the compose stack where `os.hostname()` is a container id. */
test('the preflight claim carries the machine it was taken on, and a refusal names the holder-s', async (t) => {
  const { home, project } = trackerFixture(t);
  // `runApi` hands the child this process's environment, and a machine that has been given a claim-host nickname exports `BM_MACHINE_NAME` from
  // `~/.zshenv` — which the tool prefers, so the `<user>@<host>` default asserted below would never be computed. Unset here, restored after, the same way
  // the next case sets it.
  const before = process.env.BM_MACHINE_NAME;
  delete process.env.BM_MACHINE_NAME;
  t.after(() => {
    if (before !== undefined) process.env.BM_MACHINE_NAME = before;
  });

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  });
  assert.match(posts(requests, 'claim')[0].body.host, /^[^@\s]+@\S+$/);

  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : {
            status: 409,
            body: { error: '#3 is already in progress', holder: { session: 'other-machine', host: 'futin@mac', heartbeat: '…', ageMs: 42_000, commentId: 7 } },
          },
  };
  const { home: home2, project: project2 } = trackerFixture(t);
  await withApi(claimRoutes(project2, held), async (port) => {
    assert.equal((await runApi(project2, home2, port, 'init', '--project', project2)).status, 0);
    assert.equal((await runApi(project2, home2, port, 'stage', '3', 'preflight')).status, 0);
  });
  const written = JSON.parse(fs.readFileSync(runFile(home2, project2), 'utf8'));
  assert.match(written.queue[0].note, /^claimed elsewhere \(session other-machine on futin@mac, heartbeat 42s ago\)/);
});

/* The driver publishes the same machine name `backlog.mjs` does, because the server's release clause compares the two strings for equality: a run that
   claimed as `<user>@<host>` while a hand `abort` on the same box claimed as the nickname could not release its own item. Set in the environment, read in
   both tools, and blank reads as unset in both. */
test('the preflight claim carries BM_MACHINE_NAME when the machine has been given a name', async (t) => {
  const { home, project } = trackerFixture(t);
  const before = process.env.BM_MACHINE_NAME;
  process.env.BM_MACHINE_NAME = 'linux-box';
  t.after(() => {
    if (before === undefined) delete process.env.BM_MACHINE_NAME;
    else process.env.BM_MACHINE_NAME = before;
  });

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  });

  assert.equal(posts(requests, 'claim')[0].body.host, 'linux-box');
});

test('every stage after preflight publishes the queue item onto the claim', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1')).status, 0);
  });

  const beats = posts(requests, 'heartbeat');
  assert.equal(beats.length, 2, 'one for preflight, one for dispatched');
  assert.equal(beats[1].body.commentId, 501);
  assert.equal(beats[1].body.state.stage, 'dispatched');
  assert.equal(beats[1].body.state.sessionId, 's1');
});

/* #250. Parking RELEASES the claim (`parked` is in `CLAIM_RELEASE_STAGES`), and a parked item is regularly carried forward by hand once its cause is fixed —
   `stage <n> inspecting` and on to `merged`, often after the run itself has finished. Before this, nothing on that path claimed: the preflight claim is
   behind its own transition and `--resume`'s re-claim skips a release stage, so the item ran review and verification on an issue whose only claim was
   released, every heartbeat refused, and another machine free to take it. Leaving `parked` for a stage that is not itself a release now re-claims. */
async function parkTracked(project, home, port) {
  assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
  assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  const wt = path.join(project, '.worktrees', '3');
  assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--worktree', wt, '--branch', 'backlog/3')).status, 0);
  assert.equal((await runApi(project, home, port, 'stage', '3', 'parked')).status, 0);
  assert.equal((await runApi(project, home, port, 'finish', '--status', 'done')).status, 0);
  return wt;
}

test('#250: leaving parked re-claims the issue once and the heartbeat lands on the new comment', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    await parkTracked(project, home, port);
    const out = await runApi(project, home, port, 'stage', '3', 'inspecting');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '', 'the heartbeat after the re-claim is accepted, not refused');
    // A stage the item moves on to from there is not a re-claim: the claim is live again.
    assert.equal((await runApi(project, home, port, 'stage', '3', 'reviewing')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'reviewing')).status, 0);
  });

  const claims = posts(requests, 'claim');
  assert.equal(claims.length, 2, 'the preflight claim, and exactly one re-claim on leaving parked');
  assert.equal(claims[1].body.phase, 'execute');
  assert.equal(claims[1].body.id, '#3');

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(written.queue[0].claim, { commentId: 502 });
  assert.equal(written.queue[0].stage, 'reviewing');
  const beats = posts(requests, 'heartbeat');
  assert.equal(beats.at(-1).body.commentId, 502);
  assert.equal(beats.at(-1).body.state.stage, 'reviewing');
});

test('#250: a stage that is not a transition out of parked posts no claim', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    for (const stage of ['preflight', 'dispatched', 'inspecting', 'inspecting', 'parked', 'parked']) {
      assert.equal((await runApi(project, home, port, 'stage', '3', stage)).status, 0);
    }
    // parked → skipped is a release stage to a release stage: still nothing to claim.
    assert.equal((await runApi(project, home, port, 'stage', '3', 'skipped')).status, 0);
  });

  assert.equal(posts(requests, 'claim').length, 1, 'only the preflight claim');
});

test('#250: leaving parked when another run holds the issue skips the item and names the tree it left, exit 0', async (t) => {
  const { home, project } = trackerFixture(t);
  let claimsSeen = 0;
  const heldOnSecond = {
    '/api/items/claim': (body, _url, method) => {
      if (method === 'GET') return { body: null };
      claimsSeen += 1;
      return claimsSeen === 1
        ? { status: 201, body: { commentId: 501, record: { v: 1, session: body?.session } } }
        : {
            status: 409,
            body: { error: '#3 is already in progress', holder: { session: 'other-machine', host: 'futin@mac', heartbeat: '…', ageMs: 42_000, commentId: 9 } },
          };
    },
  };

  let wt;
  const { requests } = await withApi(claimRoutes(project, heldOnSecond), async (port) => {
    wt = await parkTracked(project, home, port);
    const out = await runApi(project, home, port, 'stage', '3', 'inspecting');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /"stage":"skipped"/);
  });

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  const item = written.queue[0];
  assert.equal(item.stage, 'skipped');
  assert.match(item.note, /^claimed elsewhere \(session other-machine on futin@mac, heartbeat 42s ago\)/);
  assert.ok(item.note.includes(wt), `the note names the worktree left in place: ${item.note}`);
  assert.ok(item.note.includes('backlog/3'), `the note names the branch left in place: ${item.note}`);
  assert.equal(item.worktree, wt);
  assert.equal(item.branch, 'backlog/3');
  // The park already released this run's claim; nothing is beaten or released on the other run's issue.
  assert.equal(posts(requests, 'release').length, 1, 'only the park-s own release');
  assert.equal(posts(requests, 'heartbeat').filter((b) => b.body.state?.stage === 'inspecting').length, 0);
});

test('#250: a re-claim the API cannot answer exits 9 and writes nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  let claimsSeen = 0;
  const downOnSecond = {
    '/api/items/claim': (body, _url, method) => {
      if (method === 'GET') return { body: null };
      claimsSeen += 1;
      return claimsSeen === 1 ? { status: 201, body: { commentId: 501, record: { v: 1 } } } : { status: 503, body: { error: 'no token' } };
    },
  };

  await withApi(claimRoutes(project, downOnSecond), async (port) => {
    await parkTracked(project, home, port);
    const before = fs.readFileSync(runFile(home, project), 'utf8');
    const out = await runApi(project, home, port, 'stage', '3', 'inspecting');
    assert.equal(out.status, 9, out.stderr);
    assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before, 'run.json is byte-identical');
  });
});

test('#250: a files run carries a parked item forward with no API request, port closed', async (t) => {
  const { home, project } = orchFixture(t);
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');
  assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
  for (const stage of ['preflight', 'dispatched', 'parked', 'inspecting', 'reviewing']) {
    const out = await runApi(project, home, port, 'stage', 'task-1', stage);
    assert.equal(out.status, 0, `${stage}: ${out.stderr}`);
    assert.equal(out.stderr, '');
  }
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(run.queue[0].stage, 'reviewing');
  assert.equal(run.queue[0].claim, undefined);
});

test('a heartbeat the API refuses is one stderr line and never fails the stage', async (t) => {
  const { home, project } = trackerFixture(t);
  const broken = { '/api/items/heartbeat': { status: 500, body: { error: 'boom' } } };

  const { out } = await withApi(claimRoutes(project, broken), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    return runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /heartbeat for 3 was refused/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'dispatched');
});

test('usage publishes the new entry onto the claim', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const out = await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'));
    assert.equal(out.status, 0, out.stderr);
  });

  const beats = posts(requests, 'heartbeat');
  const last = beats[beats.length - 1];
  assert.equal(last.body.state.usage.length, 1);
  assert.equal(last.body.state.usage[0].kind, 'execute');
  assert.equal(last.body.state.usage[0].outputTokens, 52893);
});

test('stage merged in a tracker project requires --outcome, and writes nothing without it', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests, out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    return runApi(project, home, port, 'stage', '3', 'merged');
  });

  assert.equal(out.status, 1);
  assert.match(out.stderr, /--outcome/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'preflight');
  assert.equal(posts(requests, 'state').length, 0);
  assert.equal(posts(requests, 'release').length, 0);
});

test('--outcome is refused for a files project, where the item file already carries the Outcome', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'stage', 'task-1', 'merged', '--outcome', '/tmp/whatever.md');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /--outcome is only for/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'pending');
});

test('stage merged reads the counters, closes the issue, then releases — in that order', async (t) => {
  const { home, project } = trackerFixture(t);
  const outcomeText = '## Outcome\n\n2026-09-19. It worked.\n';

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'))).status, 0);

    const file = path.join(project, 'outcome.md');
    fs.writeFileSync(file, outcomeText);
    const out = await runApi(project, home, port, 'stage', '3', 'merged', '--outcome', file);
    assert.equal(out.status, 0, out.stderr);
  });

  // The three requests this path makes, in order and with nothing between.
  const tail = requests.filter((r) => ['/api/items/claim', '/api/items/state', '/api/items/release'].includes(r.path)).slice(-3);
  assert.deepEqual(
    tail.map((r) => `${r.method} ${r.path}`),
    ['GET /api/items/claim', 'POST /api/items/state', 'POST /api/items/release'],
  );
  assert.equal(tail[1].body.status, 'done');
  assert.equal(tail[1].body.outcome, outcomeText);
  assert.equal(tail[2].body.reason, 'merged');
  // bug-42: EVERY release this run sends asserts the run that owns the claim, not only abort's. `trackerRelease` adds the key unconditionally, because a
  // conditional would leave the resumed-driver case — an item released at a terminal stage whose claim comment was posted by the session that crashed —
  // quietly on the path the server refuses.
  assert.equal(tail[2].body.runId, JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId);
  // Read counters (1/2/3/4) plus this run's bill: 812345 ms floors to 812 s,
  // and 208 + 52893 + 204362 tokens are billed while the 15,155,855 CACHE
  // READS are not — the same set `backlog.mjs stop` bills for a files item.
  assert.deepEqual(tail[2].body.counters, { groomElapsed: 1, executeElapsed: 2 + 812, groomTokens: 3, executeTokens: 4 + 257_463 });
});

test('a refused close exits 9, writes no stage and sends no release', async (t) => {
  const { home, project } = trackerFixture(t);
  const broken = { '/api/items/state': { status: 502, body: { error: 'github said no' } } };

  const { requests, out } = await withApi(claimRoutes(project, broken), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const file = path.join(project, 'outcome.md');
    fs.writeFileSync(file, 'x\n');
    return runApi(project, home, port, 'stage', '3', 'merged', '--outcome', file);
  });

  assert.equal(out.status, 9);
  assert.match(out.stderr, /github said no/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'preflight');
  assert.equal(posts(requests, 'release').length, 0);
});

test('stage branched releases the claim and never closes the issue', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project, '--merge-mode', 'branch')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    const out = await runApi(project, home, port, 'stage', '3', 'branched', '--branch', 'backlog/3');
    assert.equal(out.status, 0, out.stderr);
  });

  const released = posts(requests, 'release');
  assert.equal(released.length, 1);
  assert.equal(released[0].body.reason, 'branched');
  // The issue stays open under branch mode: nothing has landed on the base.
  assert.equal(posts(requests, 'state').length, 0);
});

test('usage entries with no numbers at all bill nothing, and the read counters go back unchanged', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE_NO_NUMBERS, '3.jsonl'))).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'failed')).status, 0);
  });

  const released = posts(requests, 'release');
  assert.equal(released.length, 1);
  // Not zeros: "nothing was recorded" is not "it cost zero", and zeros would
  // erase every earlier session's work on the item.
  assert.deepEqual(released[0].body.counters, { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 });
});

/* #267. Parking RELEASES the claim with this run's bill so far, and leaving `parked` re-claims (#250) — and the server seeds that new claim from the newest
   claim's counters, which are the ones the park just wrote. The release at the end then read that seed as its base and added EVERY usage entry the item
   carries, so the pre-park spend was billed twice: `base0 + 2·U1 + U2`. These routes behave like the server on the one point that matters — a claim is seeded
   from what the last release wrote, and the GET answers it — so the final counters are the sum the issue's permanent record actually ends up with. */
function billingRoutes(project) {
  let counters = { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 };
  let nextComment = 500;
  return claimRoutes(project, {
    '/api/items/claim': (body, _url, method) =>
      method === 'GET'
        ? { body: { commentId: nextComment, record: { v: 1, counters } } }
        : { status: 201, body: { commentId: (nextComment += 1), record: { v: 1, session: body?.session, run: body?.run, counters } } },
    '/api/items/release': (body) => {
      if (body?.counters !== undefined) counters = body.counters;
      return { status: 201, body: { commentId: nextComment, record: { v: 1, counters } } };
    },
  });
}

async function parkResumeMerge(t, project, home, port, afterReclaim) {
  assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
  assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
  assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'))).status, 0);
  assert.equal((await runApi(project, home, port, 'stage', '3', 'parked')).status, 0);
  assert.equal((await runApi(project, home, port, 'stage', '3', 'inspecting')).status, 0);
  await afterReclaim();
  const file = path.join(project, 'outcome.md');
  fs.writeFileSync(file, '## Outcome\n\nmerged after a park.\n');
  const out = await runApi(project, home, port, 'stage', '3', 'merged', '--outcome', file);
  assert.equal(out.status, 0, out.stderr);
}

test('#267: park, re-claim, merge bills the pre-park session once — base + U1 + U2, not base + 2·U1 + U2', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(billingRoutes(project), async (port) => {
    await parkResumeMerge(t, project, home, port, async () => {
      assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3-retry-1.jsonl'))).status, 0);
    });
  });

  const released = posts(requests, 'release');
  assert.deepEqual(released.map((r) => r.body.reason), ['parked', 'merged']);
  // The park bills U1 (812 s, 257,463 tokens) onto the base; the merge bills only U2, the retry, on top of that.
  assert.deepEqual(released[0].body.counters, { groomElapsed: 1, executeElapsed: 2 + 812, groomTokens: 3, executeTokens: 4 + 257_463 });
  assert.deepEqual(released[1].body.counters, { groomElapsed: 1, executeElapsed: 2 + 812 * 2, groomTokens: 3, executeTokens: 4 + 257_463 * 2 });
});

test('#267: re-recording a pre-park transcript after the re-claim bills nothing a second time', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(billingRoutes(project), async (port) => {
    await parkResumeMerge(t, project, home, port, async () => {
      // Same slot, same numbers: `usage` replaces the entry in place (a resumed driver re-running inspect), so the item's total is unchanged — and so
      // is what is left to bill.
      assert.equal((await runApi(project, home, port, 'usage', '3', '--jsonl', transcriptAs(t, STREAM_USAGE, '3.jsonl'))).status, 0);
    });
  });

  const released = posts(requests, 'release');
  assert.deepEqual(released.at(-1).body.counters, { groomElapsed: 1, executeElapsed: 2 + 812, groomTokens: 3, executeTokens: 4 + 257_463 });
});

test('a resumed driver re-claims its own run-s in-flight items under the same runId', async (t) => {
  const { home, project } = trackerFixture(t);

  const { requests } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1')).status, 0);
    const out = await runApi(project, home, port, 'claim');
    assert.equal(out.status, 0, out.stderr);
  });

  const claims = posts(requests, 'claim');
  assert.equal(claims.length, 2, 'the preflight claim, and the resume re-claim');
  assert.equal(claims[1].body.run.runId, claims[0].body.run.runId, 'the same run takes its own item back');

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.deepEqual(written.queue[0].claim, { commentId: 502 }, 'the new comment id replaces the old one');
  assert.equal(written.queue[0].stage, 'dispatched');
});

test('a resumed driver skips an item another run now holds, and leaves its worktree alone', async (t) => {
  const { home, project } = trackerFixture(t);
  const worktree = path.join(project, '.worktrees', '3');
  fs.mkdirSync(worktree, { recursive: true });
  let calls = 0;

  // The FIRST claim wins (the preflight), the second is refused — the shape a
  // resume meets when another machine picked the item up meanwhile.
  const contested = {
    '/api/items/claim': (body, _url, method) => {
      if (method === 'GET') return { body: null };
      calls += 1;
      return calls === 1
        ? { status: 201, body: { commentId: 501, record: { v: 1, session: body?.session, run: body?.run } } }
        : { status: 409, body: { error: 'held', holder: { session: 'other-machine', heartbeat: '…', ageMs: 30_000, commentId: 9 } } };
    },
  };

  await withApi(claimRoutes(project, contested), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'dispatched', '--session', 's1', '--worktree', worktree)).status, 0);
    const out = await runApi(project, home, port, 'claim');
    assert.equal(out.status, 0, out.stderr);
  });

  const written = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(written.queue[0].stage, 'skipped');
  assert.match(written.queue[0].note, /claimed elsewhere/);
  assert.match(written.queue[0].note, /worktree .* left in place/);
  // The run lost the item, not the work: nothing on disk is removed.
  assert.equal(fs.existsSync(worktree), true);
});

// --- I-1 … I-3: the snapshot, and the sidecars ------------------------------

test('snapshot writes the issue body and the session-s Outcome to one file', async (t) => {
  const { home, project } = trackerFixture(t);

  const { out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    const dir = path.join(home, encodeURIComponent(project));
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), 'Contract sweep: none found\nRed proof: 1 test went red\n');
    return runApi(project, home, port, 'snapshot', '3');
  });

  assert.equal(out.status, 0, out.stderr);
  const written = fs.readFileSync(path.join(home, encodeURIComponent(project), 'items', '3.md'), 'utf8');
  assert.match(written, /## Cause/);
  assert.match(written, /## Outcome\n\nContract sweep: none found/);
});

test('snapshot is refused for a files project', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  const out = run(project, home, 'snapshot', 'task-1');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /snapshot is for a tracker project/);
});

test('verify reads a tracker item-s Done when out of the snapshot, not out of any backlog file', async (t) => {
  const { home, project } = trackerFixture(t);
  const marker = path.join(project, 'verify-ran.txt');
  const cmd = `node -e "require('fs').writeFileSync('${marker}','ran')"`;
  const body = `## Symptom\n\nx\n\n## Cause\n\nreal\n\n## Fix\n\nreal\n\n## Done when\n\n\`\`\`\n${cmd}\n\`\`\`\n`;
  // bug-253: the command has to be one the gate's allowlist approves, and that
  // allowlist is the PROJECT ROOT's verify.json. The commands run in a separate
  // directory with no verify.json of its own, so the only way this command can
  // reach a spawn is through the snapshot's `## Done when`.
  fs.writeFileSync(path.join(project, 'backlog', 'verify.json'), JSON.stringify({ commands: [cmd] }));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-verify-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const { out } = await withApi({ ...claimRoutes(project), '/api/items/body': { body } }, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    return runApi(project, home, port, 'verify', '3', '--cwd', worktree, '--json');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.deepEqual(
    JSON.parse(out.stdout).map((row) => row.ok),
    [true],
  );
});

// bug-253: the snapshot is re-fetched from the live issue after every fix loop,
// so whoever can edit the issue can change what `verify` spawns. The gate's
// allowlist is re-applied to the snapshot right before anything runs.
test('verify refuses with exit 11 a tracker Done when command the gate allowlist does not approve, and spawns and writes nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  const approved = path.join(project, 'approved-ran.txt');
  const injected = path.join(project, 'injected-ran.txt');
  const approvedCmd = `node -e "require('fs').writeFileSync('${approved}','ran')"`;
  const injectedCmd = `node -e "require('fs').writeFileSync('${injected}','ran')"`;
  const body = `## Symptom\n\nx\n\n## Cause\n\nreal\n\n## Fix\n\nreal\n\n## Done when\n\n\`\`\`\n${approvedCmd}\n${injectedCmd}\n\`\`\`\n`;
  fs.writeFileSync(path.join(project, 'backlog', 'verify.json'), JSON.stringify({ commands: [approvedCmd] }));
  // The worktree's own verify.json approving the injected line must not count:
  // the executor session can write that file, and the gate never read it.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-verify-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, 'backlog'));
  fs.writeFileSync(path.join(worktree, 'backlog', 'verify.json'), JSON.stringify({ commands: [injectedCmd] }));

  const { out: { out, before, after } } = await withApi({ ...claimRoutes(project), '/api/items/body': { body } }, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    const before = fs.readFileSync(runFile(home, project), 'utf8');
    const out = await runApi(project, home, port, 'verify', '3', '--cwd', worktree, '--json');
    return { out, before, after: fs.readFileSync(runFile(home, project), 'utf8') };
  });

  assert.equal(out.status, 11, out.stderr);
  assert.match(out.stderr, /neither approved/);
  // No `stage 3 preflight` ran, so there is no record of what the gate saw and
  // the allowlist alone decides — failing closed, and saying why.
  assert.match(out.stderr, /no pre-flight record exists/);
  assert.ok(out.stderr.includes(injectedCmd), out.stderr);
  assert.ok(!out.stderr.includes(`\`${approvedCmd}\``), out.stderr);
  // Refused before the FIRST spawn, not just before the bad one: a verify that
  // ran half its rows would hand the merge gate a partial answer.
  assert.equal(fs.existsSync(approved), false);
  assert.equal(fs.existsSync(injected), false);
  assert.equal(after, before);
});

// bug-253, fix loop 1: at the gate an unresolved Done-when command is only a
// question, which a human answer or `questionMode: decide` clears. Such an item
// must still verify — the refusal is for commands ADDED after the gate saw the
// issue, which is what `stage <id> preflight`'s record of the body pins.
test('verify runs a Done when command the gate saw at pre-flight even when no allowlist approves it', async (t) => {
  const { home, project } = trackerFixture(t);
  const marker = path.join(project, 'seen-ran.txt');
  const cmd = `node -e "require('fs').writeFileSync('${marker}','ran')"`;
  const body = `## Symptom\n\nx\n\n## Cause\n\nreal\n\n## Fix\n\nreal\n\n## Done when\n\n\`\`\`\n${cmd}\n\`\`\`\n`;
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-verify-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const { out } = await withApi({ ...claimRoutes(project), '/api/items/body': { body } }, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    return runApi(project, home, port, 'verify', '3', '--cwd', worktree, '--json');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  const record = JSON.parse(fs.readFileSync(path.join(home, encodeURIComponent(project), 'items', '3.gate.json'), 'utf8'));
  assert.deepEqual(record, { commands: [cmd] });
});

test('verify refuses with exit 11 a Done when command added to the issue after pre-flight, and runs neither command', async (t) => {
  const { home, project } = trackerFixture(t);
  const seenMarker = path.join(project, 'seen-ran.txt');
  const addedMarker = path.join(project, 'added-ran.txt');
  const seenCmd = `node -e "require('fs').writeFileSync('${seenMarker}','ran')"`;
  const addedCmd = `node -e "require('fs').writeFileSync('${addedMarker}','ran')"`;
  const bodyWith = (lines) => `## Symptom\n\nx\n\n## Cause\n\nreal\n\n## Fix\n\nreal\n\n## Done when\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
  let current = bodyWith([seenCmd]);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-verify-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));

  const { out } = await withApi({ ...claimRoutes(project), '/api/items/body': () => ({ body: current }) }, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    assert.equal((await runApi(project, home, port, 'stage', '3', 'preflight')).status, 0);
    // The issue is edited while the run holds it; the next snapshot — a fix
    // loop's — fetches the edited body.
    current = bodyWith([seenCmd, addedCmd]);
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    return runApi(project, home, port, 'verify', '3', '--cwd', worktree, '--json');
  });

  assert.equal(out.status, 11, out.stderr);
  assert.match(out.stderr, /added since/);
  assert.ok(out.stderr.includes(addedCmd), out.stderr);
  assert.ok(!out.stderr.includes(`\`${seenCmd}\``), out.stderr);
  assert.equal(fs.existsSync(seenMarker), false);
  assert.equal(fs.existsSync(addedMarker), false);
});

test('a tracker run-s outcomes/ and items/ are archived beside its run file by the next init', async (t) => {
  const { home, project } = trackerFixture(t);
  const dir = path.join(home, encodeURIComponent(project));

  await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), 'outcome\n');
    assert.equal((await runApi(project, home, port, 'snapshot', '3')).status, 0);
    assert.equal((await runApi(project, home, port, 'finish', '--status', 'done')).status, 0);
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
  });

  // The mover is a denylist of three (`run.json`, `runs/`, `stale-plans.json`), so a new sidecar
  // directory needs no change to it at all — which is exactly what this
  // asserts.
  const stems = fs.readdirSync(runsDir(home, project)).filter((name) => !name.endsWith('.json'));
  assert.equal(stems.length, 1);
  assert.equal(fs.readFileSync(path.join(runsDir(home, project), stems[0], 'outcomes', '3.md'), 'utf8'), 'outcome\n');
  assert.ok(fs.existsSync(path.join(runsDir(home, project), stems[0], 'items', '3.md')));
  assert.equal(fs.existsSync(path.join(dir, 'outcomes')), false);
});
