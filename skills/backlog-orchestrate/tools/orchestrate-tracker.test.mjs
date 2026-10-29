// A tracker project's queue and gate, and what the rest of a tracker run publishes: claims given back, `orchestrator:queued`.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TRACKER_POLL_WINDOW_MS,
  trackerPollAgeText,
  trackerRetryDelayMs
} from './orchestrate.mjs';
import {
  GROOMED_BUG_BODY,
  GROOMED_TASK_BODY,
  TASK_9_BODY,
  TASK_9_REL,
  apiItem,
  claimRoutes,
  closedPort,
  commitEverything,
  gateRoutes,
  orchFixture,
  plan,
  planGitFixture,
  posts,
  run,
  runApi,
  runFile,
  seedReadyTask,
  trackerFixture,
  withApi
} from './orchestrate-test-lib.mjs';

// --- task-47: a tracker project's queue, claim and close ---------------------
//
// A project whose committed `backlog/source.json` says `github` has no item
// files: the queue comes from `GET /api/items`, and the claim that stops a
// second machine working an issue is a comment the API writes. Every case
// below spawns the REAL tool against a fake API on an ephemeral port, exactly
// as the cases above spawn it against a real store — the tool is the subject,
// and stubbing its transport would test the stub.

const API_CALL_SCRIPT = fileURLToPath(new URL('./api-call.mjs', import.meta.url));
const UNGROOMED_TASK_BODY = '## Goal\n\nSomething.\n\n## Plan\n\n## Done when\n';

// --- O-1: a files run never touches the API ---------------------------------

test('a files run makes no API request at any stage, with the port closed', async (t) => {
  // The whole point of the marker check: `projectSource` answers `files` for a
  // project with no `source.json`, and not one command may then spawn the
  // helper. Pinned by making the API UNREACHABLE rather than by counting
  // requests — a count can only see the calls a test happens to drive, while a
  // closed port fails every one of them.
  const { home, project } = orchFixture(t);
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');
  // A second item left `pending`, so `reconcile` has a row to report.
  seedReadyTask(project, 'task-2', 'another task');

  const init = await runApi(project, home, port, 'init', '--project', project);
  assert.equal(init.status, 0, init.stderr);

  for (const args of [
    ['stage', 'task-1', 'preflight'],
    ['stage', 'task-1', 'dispatched', '--session', 's1'],
    ['stage', 'task-1', 'inspecting'],
    ['stage', 'task-1', 'merged'],
    // task-48's four: each publishes to the issue in a tracker run, and none
    // may so much as try in a files one.
    ['attention', 'task-2', '--kind', 'parked', '--detail', 'x'],
    ['heartbeat'],
  ]) {
    const out = await runApi(project, home, port, ...args);
    assert.equal(out.status, 0, `${args.join(' ')}: ${out.stderr}`);
  }

  const reconcile = await runApi(project, home, port, 'reconcile', '--json');
  assert.equal(reconcile.status, 0, reconcile.stderr);
  const rows = JSON.parse(reconcile.stdout);
  assert.deepEqual(rows.map((r) => r.id), ['task-2']);
  assert.equal('claim' in rows[0], false, 'a files run reports no claim column at all');

  const finish = await runApi(project, home, port, 'finish', '--status', 'done');
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(finish.stderr, '');

  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(run.queue[0].stage, 'merged');
  assert.equal(run.status, 'done');
  // No claim was ever taken, which is the other half of "no request was made".
  assert.equal(run.queue[0].claim, undefined);
});

// --- O-2: projectSource, through `plan` -------------------------------------

test('an unsupported source marker refuses the plan by name, and never falls back to files', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'jira', repo: 'futin/x' });
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /source\.json/);
  assert.match(out.stderr, /jira/);
  // The load-bearing negative: the item on disk is NOT reported.
  assert.doesNotMatch(out.stdout, /task-1/);
});

test('an explicit files marker runs the files walk, with the port closed', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'files' });
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((row) => row.id),
    ['task-1'],
  );
});

test('a github marker with no usable repo is refused, never treated as files', async (t) => {
  const { home, project } = trackerFixture(t, { kind: 'github', repo: 'not a repo' });
  const port = await closedPort();

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /valid "repo"/);
});

// --- A-1: the helper's own exit codes ---------------------------------------

test('api-call.mjs exits 5 with both start commands named when nothing is listening', async () => {
  const port = await closedPort();
  const out = await new Promise((resolve) => {
    const proc = spawn('node', [API_CALL_SCRIPT, 'GET', '/api/items'], { env: { ...process.env, BM_API_PORT: String(port) } });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => resolve({ status, stderr }));
  });

  assert.equal(out.status, 5);
  assert.match(out.stderr, /pnpm run dev/);
  assert.match(out.stderr, /pnpm run docker:up/);
});

test('api-call.mjs exits 3 for a non-2xx and still writes the body to stdout', async () => {
  const { out } = await withApi({ '/api/items/claim': { status: 409, body: { error: 'held', holder: { session: 'B' } } } }, (port) =>
    new Promise((resolve) => {
      const proc = spawn('node', [API_CALL_SCRIPT, 'POST', '/api/items/claim', '{}'], { env: { ...process.env, BM_API_PORT: String(port) } });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    }),
  );

  assert.equal(out.status, 3);
  assert.deepEqual(JSON.parse(out.stdout), { error: 'held', holder: { session: 'B' } });
  assert.match(out.stderr, /409/);
});

// --- G-1 / G-2: the tracker gate --------------------------------------------

test('plan on a tracker project orders bugs then tasks, hoists the runner fix, and never mentions "not committed"', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [
    apiItem(project, 1),
    apiItem(project, 2),
    apiItem(project, 3, { section: 'bugs' }),
    apiItem(project, 5, { runnerFix: true }),
    // Two rows that must not reach the queue at all: another project's item,
    // and a closed one.
    apiItem('/somewhere/else', 9),
    apiItem(project, 10, { status: 'done' }),
  ];
  const bodies = { 1: GROOMED_TASK_BODY, 2: UNGROOMED_TASK_BODY, 3: GROOMED_BUG_BODY, 5: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['5', '3', '1', '2'],
  );
  assert.deepEqual(
    rows.map((r) => r.gate),
    ['ready', 'ready', 'ready', 'ungroomed'],
  );
  assert.deepEqual(
    rows.map((r) => r.hoisted),
    [true, false, false, false],
  );
  // There is no `<base>` read for a tracker project, so the skip that exists
  // for one has nothing to skip.
  assert.doesNotMatch(out.stdout, /not committed/);
});

test('--ids on a tracker project takes bare numbers only, and names the shape it wants', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY });

  const hashed = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '#3', '--json'));
  assert.equal(hashed.out.status, 1);
  assert.match(hashed.out.stderr, /tracker items are named by issue number inside a run — got #3/);

  const absent = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '99', '--json'));
  assert.equal(absent.out.status, 1);
  assert.match(absent.out.stderr, /unknown item id: 99/);
});

// --- the in-review guard (execute pr mode, spec decision 9) -----------------
//
// An issue labelled `in-review` has a pushed branch and an open PR, and is open and unclaimed while a reviewer reads it. Without the guard it reads `ready`
// to every gate and a run would execute it a second time. The gate turns it `ungroomed` with the shared sentence first, the shape a stale-plan mark takes,
// so no new verdict reaches `RunStage` or anything that reads one.

const IN_REVIEW_REASON = 'a PR is open for this item';

test('plan on a tracker project gates an in-review issue out of the ready queue, with the reason first', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { inReview: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.filter((r) => r.gate === 'ready').map((r) => r.id),
    ['4'],
  );
  const gated = rows.find((r) => r.id === '3');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], IN_REVIEW_REASON);
});

test('--ids naming an in-review issue gates it rather than dropping it', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { inReview: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '3', '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.map((r) => [r.id, r.gate, r.reasons[0]]),
    [['3', 'ungroomed', IN_REVIEW_REASON]],
  );
});

test('an in-review issue that is also ungroomed keeps both reasons, the in-review one first', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { inReview: true })];

  const { out } = await withApi(gateRoutes(items, { 3: UNGROOMED_TASK_BODY }), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout);
  assert.equal(row.gate, 'ungroomed');
  assert.equal(row.reasons[0], IN_REVIEW_REASON);
  assert.ok(row.reasons.length > 1, 'the groom reason is kept behind it');
});

// --- the plan-review guard (backlog-tick) -----------------------------------
//
// A plan the tick wrote unattended carries `plan-review` (a tracker label, a files `plan-review:` frontmatter line) until a person approves it by removing
// the mark. Without the guard a groomed item with an unreviewed plan reads `ready` here and a run would execute a plan nobody has read. The gate is the
// in-review one's twin: `ungroomed`, the shared sentence first, no new verdict. The files mark is read off the same bytes as `runner-fix:` — at `<base>`.

const PLAN_REVIEW_REASON = 'this plan awaits review';

// Same shape and same reason as `markRunnerFix`: what these cases vary is one frontmatter line, so it is written into a seeded item rather than owned by a
// seeder.
function markPlanReview(file, value = 'true') {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\n'), `expected a frontmatter fence in ${file}`);
  fs.writeFileSync(file, text.replace('---\n', `---\nplan-review: ${value}\n`));
}

const PLAN_REVIEW_TASK_1 = ['backlog', 'tasks', 'open', 'task-1-show-a-queue-preview-before-an-orchestrator-run-starts.md'];

test('plan on a files project gates a plan-review item out of the ready queue', (t) => {
  const { home, project } = planGitFixture(t);
  markPlanReview(path.join(project, ...PLAN_REVIEW_TASK_1));
  commitEverything(project, 'mark task-1 plan-review');

  const out = plan(project, home, '--json');

  assert.equal(out.status, 0, out.stderr);
  const queue = JSON.parse(out.stdout);
  const gated = queue.find((q) => q.id === 'task-1');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], PLAN_REVIEW_REASON);
  assert.deepEqual(gated.questions, []);
  assert.equal(queue.find((q) => q.id === 'bug-7').gate, 'ready', 'a sibling without the mark stays ready');
});

test('plan: plan-review: false does not gate, and any other value does', (t) => {
  const { home, project } = planGitFixture(t);
  markPlanReview(path.join(project, ...PLAN_REVIEW_TASK_1), 'False');
  commitEverything(project, 'plan-review: False on task-1');
  assert.equal(JSON.parse(plan(project, home, '--json').stdout).find((q) => q.id === 'task-1').gate, 'ready');

  fs.writeFileSync(path.join(project, ...PLAN_REVIEW_TASK_1), fs.readFileSync(path.join(project, ...PLAN_REVIEW_TASK_1), 'utf8').replace('plan-review: False', 'plan-review: yes'));
  commitEverything(project, 'plan-review: yes on task-1');
  const gated = JSON.parse(plan(project, home, '--json').stdout).find((q) => q.id === 'task-1');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], PLAN_REVIEW_REASON);
});

test('plan reads plan-review at base, not the working tree', (t) => {
  const { home, project } = planGitFixture(t);
  const file = path.join(project, ...PLAN_REVIEW_TASK_1);

  // Absent at base, added only in the working tree: the worktree a run cuts from base would not hold it, so the item is still ready.
  markPlanReview(file);
  assert.equal(JSON.parse(plan(project, home, '--json').stdout).find((q) => q.id === 'task-1').gate, 'ready');

  // Committed, then deleted only in the working tree: base still holds it, so the item is still gated.
  commitEverything(project, 'mark task-1 plan-review');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('plan-review: true\n', ''));
  const gated = JSON.parse(plan(project, home, '--json').stdout).find((q) => q.id === 'task-1');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], PLAN_REVIEW_REASON);
});

test('plan: an uncommitted plan-review item keeps the not-committed verdict', (t) => {
  const { home, project } = planGitFixture(t);
  fs.writeFileSync(path.join(project, TASK_9_REL), TASK_9_BODY.replace('---\nid: task-9', '---\nplan-review: true\nid: task-9'));

  const item = JSON.parse(plan(project, home, '--json').stdout).find((q) => q.id === 'task-9');

  assert.equal(item.gate, 'ungroomed');
  assert.ok(item.reasons[0].includes(TASK_9_REL), `reason should name ${TASK_9_REL}: ${item.reasons[0]}`);
  assert.ok(!item.reasons.includes(PLAN_REVIEW_REASON), 'a mark on bytes the run cannot see is not read');
});

test('plan on a tracker project gates a planReview issue', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { planReview: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.filter((r) => r.gate === 'ready').map((r) => r.id),
    ['4'],
  );
  const gated = rows.find((r) => r.id === '3');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], PLAN_REVIEW_REASON);
  assert.deepEqual(gated.questions, []);
});

test('--ids naming a planReview issue gates it rather than dropping it', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { planReview: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '3', '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => [r.id, r.gate, r.reasons[0]]),
    [['3', 'ungroomed', PLAN_REVIEW_REASON]],
  );
});

test('in-review and plan-review together list both reasons, in-review first', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { inReview: true, planReview: true })];

  const { out } = await withApi(gateRoutes(items, { 3: UNGROOMED_TASK_BODY }), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const [row] = JSON.parse(out.stdout);
  assert.equal(row.gate, 'ungroomed');
  assert.deepEqual(row.reasons.slice(0, 2), [IN_REVIEW_REASON, PLAN_REVIEW_REASON]);
  assert.ok(row.reasons.length > 2, 'the groom reason is kept behind both');
});

// --- the unvetted guard (#341) ------------------------------------------------
//
// A tracker issue filed from outside the repo whose body no trusted groom has pinned arrives with `unvetted: true` on the API item. Its plan is a stranger's
// text, and to `gateItem` a groomed one reads ready — so without the gate a run would hand it to a headless session. The gate is `planReviewGate`'s twin:
// `ungroomed`, the sentence first, `questions` emptied, membership untouched. A hand copy of the server's `UNVETTED_REASON`, em dash and all.

const UNVETTED_REASON = 'filed from outside the repo — groom it to vet the plan';

test('plan on a tracker project gates an unvetted issue', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { unvetted: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(
    rows.filter((r) => r.gate === 'ready').map((r) => r.id),
    ['4'],
  );
  const gated = rows.find((r) => r.id === '3');
  assert.equal(gated.gate, 'ungroomed');
  assert.equal(gated.reasons[0], UNVETTED_REASON);
  assert.deepEqual(gated.questions, []);
});

test('--ids naming an unvetted issue gates it rather than dropping it', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { unvetted: true }), apiItem(project, 4)];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '3', '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => [r.id, r.gate, r.reasons[0]]),
    [['3', 'ungroomed', UNVETTED_REASON]],
  );
});

test('in-review, unvetted and plan-review together read in that order', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [apiItem(project, 3, { inReview: true, unvetted: true, planReview: true }), apiItem(project, 4, { unvetted: true, planReview: true })];
  const bodies = { 3: GROOMED_TASK_BODY, 4: GROOMED_TASK_BODY };

  const { out } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout);
  assert.deepEqual(rows.find((r) => r.id === '3').reasons, [IN_REVIEW_REASON, UNVETTED_REASON, PLAN_REVIEW_REASON]);
  assert.deepEqual(rows.find((r) => r.id === '4').reasons, [UNVETTED_REASON, PLAN_REVIEW_REASON]);
});

// --- G-2a … G-2e: the cache a tracker queue is built from (bug-41) ----------
//
// `GET /api/items` is served from the poller's cache for a tracker project,
// by design — the hourly rate limit makes a per-request fetch impossible. So
// an issue GitHub accepted since the last tick is absent from the queue this
// tool builds, for at most one poll interval. Two failures followed from that
// silently: a named id read as `unknown item id: <n>`, which sounds permanent,
// and a whole-queue run simply left the newest issue out with no message at
// all. The fix is a bounded retry on the first and the cache's age printed on
// the second — never a fresh GET to GitHub, which is the groomer's explicitly
// rejected design.

test('the retry waits for the next poll to be due, and never longer than one window', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  // Never polled: there is nothing to time from, so wait one whole window.
  assert.equal(trackerRetryDelayMs(null, now), TRACKER_POLL_WINDOW_MS);
  // Polled this instant: the next tick is a whole window away.
  assert.equal(trackerRetryDelayMs(now, now), TRACKER_POLL_WINDOW_MS);
  // Mid-window: only the remainder is worth waiting for.
  assert.equal(trackerRetryDelayMs(now - 10_000, now), TRACKER_POLL_WINDOW_MS - 10_000);
  // Overdue: the tick this read is waiting for is already late, so re-read at
  // once — a poller that has stopped is not going to answer a longer wait.
  assert.equal(trackerRetryDelayMs(now - 60_000, now), 0);
  // A stamp in the future (clock skew between this process and the server's)
  // must not buy a wait longer than a fresh poll would.
  assert.equal(trackerRetryDelayMs(now + 60_000, now), TRACKER_POLL_WINDOW_MS);
});

test('the poll age reads as whole seconds, and says so when there has never been a poll', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(trackerPollAgeText(null, now), 'never polled');
  assert.equal(trackerPollAgeText(now - 12_000, now), 'polled 12 s ago');
  // Skew again: an age is never negative on the page that reads it.
  assert.equal(trackerPollAgeText(now + 5_000, now), 'polled 0 s ago');
});

test('a named tracker id the cache has not polled yet gets one retry and then runs', async (t) => {
  const { home, project } = trackerFixture(t);
  const item = apiItem(project, 7, { section: 'bugs' });
  let reads = 0;
  const routes = {
    ...gateRoutes([item], { 7: GROOMED_BUG_BODY }, { projectPath: project }),
    // The issue exists at GitHub throughout; the cache only learns about it on
    // the tick between these two reads.
    '/api/items': () => {
      reads++;
      return { body: { items: reads === 1 ? [] : [item], errors: [] } };
    },
  };

  const { out } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '7', '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(reads, 2, 'a first miss must re-read the index exactly once');
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.id),
    ['7'],
  );
});

test('a tracker id missing from both reads is refused, and the refusal names the cache and its age', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }, { projectPath: project, polledAt: new Date(Date.now() - 42_000).toISOString() });

  const { out, requests } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--ids', '99', '--json'));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /unknown item id: 99/);
  assert.match(out.stderr, /tracker cache/);
  assert.match(out.stderr, /polled \d+ s ago/);
  assert.equal(requests.filter((r) => r.path === '/api/items').length, 2, 'two reads a poll apart, then the refusal');
});

test('a tracker queue preview says how old the cache it was built from is', async (t) => {
  const { home, project } = trackerFixture(t);
  const routes = gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }, { projectPath: project, polledAt: new Date(Date.now() - 12_000).toISOString() });

  const { out } = await withApi(routes, (port) => runApi(project, home, port, 'plan', '--project', project, '--json'));

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /tracker cache \(polled \d+ s ago\)/);
  // The line is stderr, so `--json` stdout stays exactly as parseable as it was.
  assert.deepEqual(
    JSON.parse(out.stdout).map((r) => r.id),
    ['3'],
  );
});

test('a files queue preview says nothing about a tracker cache', async (t) => {
  // The files branch of buildGatedQueue never reaches trackerCandidates, so
  // bug-41's two changes must be invisible here — with the API unreachable, as
  // O-1 pins it.
  const { home, project } = orchFixture(t);
  const port = await closedPort();
  seedReadyTask(project, 'task-1', 'a task');

  const out = await runApi(project, home, port, 'plan', '--project', project, '--json');

  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /tracker cache/);
});

// --- G-3 / G-4: init's pull, and the API being down -------------------------

test('init refuses when the base cannot fast-forward onto origin, and writes nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  // A real diverged remote: a bare repo with one commit the project does not
  // have, and a project with one commit of its own.
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-remote-')));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });

  const seed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-seed-')));
  t.after(() => fs.rmSync(seed, { recursive: true, force: true }));
  spawnSync('git', ['clone', '-q', remote, seed], { encoding: 'utf8' });
  fs.writeFileSync(path.join(seed, 'theirs.txt'), 'theirs\n');
  commitEverything(seed, 'theirs');
  spawnSync('git', ['-C', seed, 'push', '-q', 'origin', 'main'], { encoding: 'utf8' });

  fs.writeFileSync(path.join(project, 'mine.txt'), 'mine\n');
  commitEverything(project, 'mine');
  spawnSync('git', ['-C', project, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });

  const { out } = await withApi(gateRoutes([], {}), (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stderr, /cannot fast-forward/);
  assert.equal(fs.existsSync(runFile(home, project)), false);
});

test('init and stage exit 8 with nothing written when the API is down', async (t) => {
  const { home, project } = trackerFixture(t);
  const port = await closedPort();

  const init = await runApi(project, home, port, 'init', '--project', project);
  assert.equal(init.status, 8);
  assert.match(init.stderr, /pnpm run dev/);
  assert.equal(fs.existsSync(runFile(home, project)), false);

  // Now with a run file on disk, so `stage` reaches its own request.
  const seeded = await withApi(gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }), (p) =>
    runApi(project, home, p, 'init', '--project', project),
  );
  assert.equal(seeded.out.status, 0, seeded.out.stderr);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const staged = await runApi(project, home, port, 'stage', '3', 'preflight');
  assert.equal(staged.status, 8);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// --- C-1 … C-5: task-48, what the rest of the run publishes -----------------
//
// Phase 4b makes a run VISIBLE from other machines, and the only thing another
// machine can read is the issue. So three more commands publish there —
// `finish` stamps the outcome on the last-touched claim, `attention` posts a
// comment, and `heartbeat` keeps every held claim alive — and `reconcile`
// reads who holds each item before it suggests anything. Every publish is
// best-effort for the reason P-4 gives: `run.json` is the journal of record.

/** A tracker run whose queue is rewritten to `items` after `init` — each
 *  `{ id, stage, at, claim }` — so a case states exactly the stages and claims
 *  it is about without driving a merge to get there. */
async function seededTrackerRun(t, items) {
  const fixture = trackerFixture(t);
  const { home, project } = fixture;
  const gate = gateRoutes(
    items.map((i) => apiItem(project, Number(i.id), { section: 'bugs' })),
    Object.fromEntries(items.map((i) => [i.id, GROOMED_BUG_BODY])),
  );
  const { out } = await withApi(gate, (port) => runApi(project, home, port, 'init', '--project', project));
  assert.equal(out.status, 0, out.stderr);
  const file = runFile(home, project);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.queue = run.queue.map((q) => {
    const want = items.find((i) => i.id === q.id);
    // `pending` pinned before every case's stamps: `init` stamped it with the
    // real clock, which would otherwise be every item's newest arrival.
    const next = { ...q, stage: want.stage, stageAt: { pending: '2026-09-19T09:00:00.000Z', [want.stage]: want.at ?? '2026-09-19T10:00:00.000Z' } };
    if (want.claim !== undefined) next.claim = { commentId: want.claim };
    return next;
  });
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  return { ...fixture, runId: run.runId };
}

const TRACKERS = (login) => ({ body: { platforms: [{ kind: 'github', hasToken: true, login }], projects: [] } });

test('C-1: finish stamps finished on the last-touched claimed item, and only that one', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '3', stage: 'merged', at: '2026-09-19T10:00:00.000Z', claim: 503 },
    { id: '5', stage: 'skipped', at: '2026-09-19T10:05:00.000Z', claim: 505 },
  ]);

  const { out, requests } = await withApi({ '/api/items/heartbeat': { status: 201, body: { commentId: 505, record: { v: 1 } } } }, (port) =>
    runApi(project, home, port, 'finish', '--status', 'done'),
  );

  assert.equal(out.status, 0, out.stderr);
  const beats = posts(requests, 'heartbeat');
  assert.equal(beats.length, 1);
  assert.equal(beats[0].body.commentId, 505);
  assert.equal(beats[0].body.id, '#5');
  assert.equal(beats[0].body.finished.status, 'done');
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  /* bug-45: the route refuses a heartbeat from anyone but the holder, and `finish` normally runs in a DIFFERENT session from the one that took the claim —
     a resumed driver, or the abort session a force stop spawns. `runId` is what makes it the same RUN, exactly as it is on `release`. */
  assert.equal(beats[0].body.session, 'sess-test');
  assert.equal(beats[0].body.runId, run.runId);
  assert.equal(beats[0].body.finished.at, run.updatedAt, 'the stamp and the journal name one instant');
});

test('C-2: finish with the API down exits 0, says so once, and the run file still reads done', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '3', stage: 'merged', claim: 503 }]);
  const port = await closedPort();

  const out = await runApi(project, home, port, 'finish', '--status', 'done');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr.trim().split('\n').length, 1, out.stderr);
  assert.match(out.stderr, /finished stamp on 3 could not be sent/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'done');
});

test('C-3: attention posts one marker comment mentioning the token-s user, and still records the entry', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [{ id: '5', stage: 'parked', claim: 505 }]);
  const routes = (login) => ({
    '/api/trackers': TRACKERS(login),
    '/api/items/comment': { status: 201, body: { commentId: 900, url: 'https://example.invalid/5#c900' } },
  });

  const withLogin = await withApi(routes('futin'), (port) => runApi(project, home, port, 'attention', '5', '--kind', 'parked', '--detail', 'x'));
  assert.equal(withLogin.out.status, 0, withLogin.out.stderr);
  const comments = posts(withLogin.requests, 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body.id, '#5');
  const lines = comments[0].body.body.split('\n');
  assert.equal(lines[0], `<!-- bm:attention kind=parked run=${runId} -->`);
  assert.match(comments[0].body.body, /@futin x/);
  assert.deepEqual(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).attention, [{ id: '5', kind: 'parked', detail: 'x' }]);

  const noLogin = await withApi(routes(null), (port) => runApi(project, home, port, 'attention', '5', '--kind', 'parked', '--detail', 'y'));
  assert.equal(noLogin.out.status, 0, noLogin.out.stderr);
  const bare = posts(noLogin.requests, 'comment');
  assert.equal(bare.length, 1);
  assert.doesNotMatch(bare[0].body.body, /@/);
});

test('C-4: heartbeat keeps every claim the run still holds alive, and none it released', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'merged', claim: 507 },
  ]);

  const { out, requests } = await withApi({ '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } } }, (port) =>
    runApi(project, home, port, 'heartbeat'),
  );

  assert.equal(out.status, 0, out.stderr);
  const beats = posts(requests, 'heartbeat');
  assert.deepEqual(
    beats.map((r) => r.body.commentId).sort(),
    [503, 505],
  );
  // Every beat names its author and its run (bug-45) — see C-1 for why the run is the load-bearing half.
  const runId = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).runId;
  for (const beat of beats) {
    assert.equal(beat.body.session, 'sess-test');
    assert.equal(beat.body.runId, runId);
  }
});

// --- bug-40: abort gives every claim it still holds back ---------------------
//
// Before this, `trackerRelease` had exactly one caller — the `stage` path's
// `CLAIM_RELEASE_STAGES` check — so a run torn down by `abort` never passed
// through a terminal stage and never gave its issues back. The cost is not
// bounded by `CLAIM_STALE_MS` the way the claim protocol's own contest rule
// is: the mapper reads `started`/`phase` off any UNRELEASED claim, fresh or
// stale, and `progressBlock` gates on the presence of `started` rather than
// its age, so the item's dispatch control stayed disabled on every machine's
// board until a person ran `backlog.mjs stop <id> --abandon` by hand.
//
// The two halves this case pins are the release set ("still holds", the same
// predicate `heartbeat` uses) and the ORDER: the releases must land before
// `cmdFinish`'s own `finished` stamp, which `GithubSource.heartbeat` accepts
// on an already-released claim and which would otherwise be stamping a claim
// this run was about to hand back.

test('bug-40: abort releases every claim the run still holds, reason aborted, before it finishes the run', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'merged', claim: 507 },
    { id: '9', stage: 'pending' },
  ]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': {
        body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 } } },
      },
      '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"status":"aborted"/);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');

  const released = posts(requests, 'release');
  assert.deepEqual(
    released.map((r) => r.body.commentId).sort(),
    [503, 505],
    'abort released the wrong set of claims — "still holds" is claim set and the stage not one that already released it',
  );
  for (const r of released) {
    // NOT a `RunStage`: `remote-runs.util.ts` reads a release reason as the
    // item's stage when it happens to be one, and otherwise leaves the last
    // reported stage alone. `aborted` is deliberately not a stage name.
    assert.equal(r.body.reason, 'aborted');
    assert.equal(r.body.id, `#${r.body.commentId === 503 ? 3 : 5}`);
    // Billed the ordinary way, through `claimCountersFor` — an abort is not
    // `backlog.mjs stop --abandon`'s dead-interval case.
    assert.deepEqual(r.body.counters, { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 });
    // bug-42: the assertion that makes the release AUTHORISED. This session is not the claim's holder — the driver that posted the comment is, and on
    // the path this exists for it is dead — so without a `runId` naming the run whose lease `takeOverRun` just took, the server refuses every one of
    // these and the item keeps its unreleased claim, its `in-progress` label and its disabled dispatch control on every machine.
    assert.equal(r.body.runId, runId);
    // …and it claims run authority WITHOUT impersonating the holder: `session` stays this session's, so `released.by` records who actually did it.
    assert.equal(r.body.session, 'sess-test');
  }

  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/heartbeat'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/release', '/api/items/heartbeat'], 'the finished stamp must land after every release');
});

test('bug-40: a refused release is one stderr line and abort still exits 0 with the run aborted', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '3', stage: 'reviewing', claim: 503 }]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
      '/api/items/release': { status: 502, body: { error: 'github said no' } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"status":"aborted"/);
  assert.match(out.stderr, /release of 3 was refused/);
  assert.equal(posts(requests, 'release').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');
});

// --- #240: finish gives back what a finished run still holds ---------------
//
// `needs-answers` stays out of `CLAIM_RELEASE_STAGES` because a LIVE run comes
// back to the item. A run that finishes `done` or `failed` never does, so
// before #240 a parked question's claim outlived its run — and with it the
// disabled dispatch control on every board, which going stale does not clear
// (bug-40). `paused` is the one status that keeps them: a resume returns.

const FINISH_ROUTES = {
  '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
  '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
  '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
  '/api/items/queue': (body) => ({ body: { id: body?.id } }),
};

test('#240: finish --status done releases a needs-answers claim, reason finished, before the finished stamp', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'merged', claim: 503 },
    { id: '5', stage: 'needs-answers', claim: 505 },
  ]);

  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'done'));

  assert.equal(out.status, 0, out.stderr);
  const released = posts(requests, 'release');
  assert.deepEqual(released.map((r) => r.body.commentId), [505], 'exactly the claim the run still holds — the merged one was released at its stage');
  assert.equal(released[0].body.id, '#5');
  // Not a `RunStage`, so the item's last reported stage stays `needs-answers` on every other machine's Runs page.
  assert.equal(released[0].body.reason, 'finished');
  assert.equal(released[0].body.runId, runId);
  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/heartbeat'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/heartbeat'], 'the finished stamp must land after the release');
});

test('#240: finish --status failed releases too', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '5', stage: 'needs-answers', claim: 505 }]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'failed'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(posts(requests, 'release').map((r) => [r.body.commentId, r.body.reason]), [[505, 'finished']]);
});

test('#240: finish --status paused keeps every claim, because a resume returns to them', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '5', stage: 'needs-answers', claim: 505 },
    { id: '7', stage: 'reviewing', claim: 507 },
  ]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'finish', '--status', 'paused'));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(posts(requests, 'release').length, 0);
});

test('#240: abort releases each held claim once, not once in abort and again in the finish it ends with', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '5', stage: 'needs-answers', claim: 505 }]);
  const { out, requests } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'abort'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(posts(requests, 'release').map((r) => [r.body.commentId, r.body.reason]), [[505, 'aborted']]);
});

// #265: a tracker item has no file, and execute under the run marker runs no `start`, so the `phase:` marker abort used to protect live work could never be
// found — a Stop mid-execute force-removed the worktree and deleted the branch, uncommitted edits included. In a tracker project the stage is the marker:
// a `dispatched` item keeps its worktree and branch untouched, and a later stage with nothing uncommitted is still torn down as before.
test('#265: a tracker abort keeps a dispatched item-s dirty worktree and branch, and still tears down a later-stage item', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '5', stage: 'dispatched', claim: 505 },
    { id: '7', stage: 'reviewing', claim: 507 },
  ]);
  commitEverything(project, 'seed');
  const trees = {};
  for (const id of ['5', '7']) {
    trees[id] = path.join(project, '.worktrees', id);
    assert.equal(spawnSync('git', ['-C', project, 'worktree', 'add', trees[id], '-b', `backlog/${id}`, 'HEAD'], { encoding: 'utf8' }).status, 0);
  }
  // The live execute session's work: written, never committed — the exact thing `worktree remove --force` destroyed.
  fs.writeFileSync(path.join(trees['5'], 'work.txt'), 'uncommitted work\n');
  const file = runFile(home, project);
  const seeded = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const q of seeded.queue) Object.assign(q, { worktree: trees[q.id], branch: `backlog/${q.id}` });
  fs.writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`);

  const { out } = await withApi(FINISH_ROUTES, (port) => runApi(project, home, port, 'abort'));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(trees['5'], 'work.txt'), 'utf8'), 'uncommitted work\n');
  assert.match(spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/5'], { encoding: 'utf8' }).stdout, /backlog\/5/);
  assert.equal(fs.existsSync(trees['7']), false, 'a reviewing item has nothing uncommitted and is torn down as before');
  assert.equal(spawnSync('git', ['-C', project, 'branch', '--list', 'backlog/7'], { encoding: 'utf8' }).stdout.trim(), '');

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.status, 'aborted');
  assert.deepEqual(after.attention.map((a) => a.id), ['5']);
  assert.match(after.attention[0].detail, new RegExp(trees['5'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // There is no marker to clear in a tracker project, so the files-project recovery command would be an instruction nobody can follow.
  assert.doesNotMatch(after.attention[0].detail, /backlog\.mjs stop/);
  assert.match(out.stdout, /removed 1 item\(s\) \(7\)/);
  assert.match(out.stdout, /left 1 in place with an in-progress marker \(5/);
});

test('bug-40: a files run-s abort makes no API request on any path', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-26', 'Some task');
  commitEverything(project, 'seed');

  const { out, requests } = await withApi({}, async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    return runApi(project, home, port, 'abort');
  });

  assert.equal(out.status, 0, out.stderr);
  assert.equal(requests.length, 0, `a files run reached the API: ${requests.map((r) => r.path).join(', ')}`);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'aborted');
});

test('C-5: reconcile reads who holds each item, and another run-s live claim means skip', async (t) => {
  const { home, project, runId } = await seededTrackerRun(t, [
    { id: '3', stage: 'reviewing', claim: 503 },
    { id: '5', stage: 'reviewing', claim: 505 },
  ]);
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 20 * 60_000).toISOString();
  const claimRoute = (_body, url) =>
    url.searchParams.get('id') === '#5'
      ? { body: { commentId: 9, record: { v: 1, session: 'B', heartbeat: fresh, run: { runId: 'run-20260101-000000' } } } }
      : { body: { commentId: 503, record: { v: 1, session: 'sess-test', heartbeat: stale, run: { runId } } } };

  const { out } = await withApi({ '/api/items/claim': claimRoute }, (port) => runApi(project, home, port, 'reconcile', '--json'));
  assert.equal(out.status, 0, out.stderr);
  const rows = Object.fromEntries(JSON.parse(out.stdout).map((r) => [r.id, r]));
  assert.equal(rows['5'].claim, 'other');
  assert.equal(rows['5'].suggestion, 'skip');
  assert.equal(rows['3'].claim, 'this-run');
  // Unchanged from before task-48: no worktree and no branch is `park`.
  assert.equal(rows['3'].suggestion, 'park');

  const down = await runApi(project, home, await closedPort(), 'reconcile', '--json');
  assert.equal(down.status, 0, down.stderr);
  assert.deepEqual(JSON.parse(down.stdout).map((r) => r.claim), ['unknown', 'unknown']);
});

// --- Q-1 … Q-7: `orchestrator:queued`, the driver's half (task-55) -----------
//
// The label is the run's PLAN, published: `init` adds it to every item the run
// will attempt, and the driver takes it off each item that leaves the plan
// without being claimed — a skip at `preflight`, and `finish`'s sweep. A WON
// claim sends nothing, because the server's claim swap already removed it.
// Every write is advisory: a refusal is a stderr line and never an exit code.

const queueBodies = (requests) => posts(requests, 'queue').map((r) => ({ id: r.body.id, queued: r.body.queued }));

test('Q-1: init on a tracker project marks exactly the queue --max builds, in queue order', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [31, 32, 33].map((n) => apiItem(project, n));
  const bodies = { 31: GROOMED_TASK_BODY, 32: GROOMED_TASK_BODY, 33: GROOMED_TASK_BODY };

  const { out, requests } = await withApi(gateRoutes(items, bodies), (port) => runApi(project, home, port, 'init', '--project', project, '--max', '2'));

  assert.equal(out.status, 0, out.stderr);
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  assert.equal(run.queue.length, 2);
  assert.deepEqual(
    queueBodies(requests),
    run.queue.map((q) => ({ id: `#${q.id}`, queued: true })),
  );
  // The issue numbers that reached the fake, not only the count: queue ids are bare, the route takes `#n` (Review Focus 5).
  assert.deepEqual(queueBodies(requests).map((b) => b.id).sort(), ['#31', '#32']);
  for (const r of posts(requests, 'queue')) assert.equal(r.body.project, project);
});

test('Q-2: init on a files project makes no queue request', async (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-1', 'a task');
  commitEverything(project, 'seed');

  const { out, requests } = await withApi({}, (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(posts(requests, 'queue').length, 0);
});

test('Q-3: a refused add at init is one stderr line naming the item, and init still exits 0 with the run written', async (t) => {
  const { home, project } = trackerFixture(t);
  const items = [31, 32].map((n) => apiItem(project, n));
  const routes = {
    ...gateRoutes(items, { 31: GROOMED_TASK_BODY, 32: GROOMED_TASK_BODY }),
    '/api/items/queue': (body) => (body?.id === '#32' ? { status: 502, body: { error: 'github said no' } } : { body: { id: body?.id, queued: true } }),
  };

  const { out, requests } = await withApi(routes, (port) => runApi(project, home, port, 'init', '--project', project));

  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(runFile(home, project)));
  assert.match(out.stderr, /orchestrator:queued: add failed for 32 — github said no/);
  assert.doesNotMatch(out.stderr, /failed for 31/);
  // A refusal is per item: the loop went on past it rather than stopping.
  assert.equal(posts(requests, 'queue').length, 2);
});

test('Q-4: a claim lost at preflight skips the item and takes its label off; a won claim sends nothing', async (t) => {
  const { home, project } = trackerFixture(t);
  const held = {
    '/api/items/claim': (_body, _url, method) =>
      method === 'GET'
        ? { body: null }
        : { status: 409, body: { error: '#3 is already in progress', holder: { session: 'other-machine', heartbeat: '…', ageMs: 42_000, commentId: 7 } } },
  };

  const lost = await withApi(claimRoutes(project, held), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    return runApi(project, home, port, 'stage', '3', 'preflight');
  });
  assert.equal(lost.out.status, 0, lost.out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue[0].stage, 'skipped');
  // The add from `init`, then the removal the skip makes — and the fake's 200 for it prints nothing.
  assert.deepEqual(queueBodies(lost.requests), [
    { id: '#3', queued: true },
    { id: '#3', queued: false },
  ]);
  assert.doesNotMatch(lost.out.stderr, /orchestrator:queued/);

  const { home: home2, project: project2 } = trackerFixture(t);
  const won = await withApi(claimRoutes(project2), async (port) => {
    assert.equal((await runApi(project2, home2, port, 'init', '--project', project2)).status, 0);
    return runApi(project2, home2, port, 'stage', '3', 'preflight');
  });
  assert.equal(won.out.status, 0, won.out.stderr);
  // Only `init`'s add: the server's claim swap owns the removal on a won claim.
  assert.deepEqual(queueBodies(won.requests), [{ id: '#3', queued: true }]);
});

test('Q-4b: an item staged skipped before it was ever claimed takes its label off then, not at finish', async (t) => {
  const { home, project } = await seededTrackerRun(t, [{ id: '33', stage: 'pending' }]);

  const { out, requests } = await withApi({ '/api/items/queue': (body) => ({ body: { id: body?.id } }) }, (port) =>
    runApi(project, home, port, 'stage', '33', 'skipped', '--note', 'gate failed'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [{ id: '#33', queued: false }]);
});

test('Q-5: finish sweeps the label off every item the run never claimed, and paused sweeps nothing', async (t) => {
  const seed = () =>
    seededTrackerRun(t, [
      { id: '31', stage: 'merged', claim: 531 },
      { id: '32', stage: 'skipped' },
      { id: '33', stage: 'pending' },
    ]);
  const routes = { '/api/items/heartbeat': { status: 201, body: { commentId: 531, record: { v: 1 } } }, '/api/items/queue': (body) => ({ body: { id: body?.id } }) };

  const done = await seed();
  const { out, requests } = await withApi(routes, (port) => runApi(done.project, done.home, port, 'finish', '--status', 'done'));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [
    { id: '#32', queued: false },
    { id: '#33', queued: false },
  ]);

  // A paused run still means to reach those items, and a resume re-adds nothing — so the pause must not take them off.
  const paused = await seed();
  const p = await withApi(routes, (port) => runApi(paused.project, paused.home, port, 'finish', '--status', 'paused'));
  assert.equal(p.out.status, 0, p.out.stderr);
  assert.equal(posts(p.requests, 'queue').length, 0);
});

test('Q-6: abort makes the same sweep, once, after its claim releases', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '31', stage: 'reviewing', claim: 531 },
    { id: '32', stage: 'skipped' },
    { id: '33', stage: 'pending' },
  ]);

  const { out, requests } = await withApi(
    {
      '/api/items/claim': { body: { commentId: 0, record: { v: 1, counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 } } } },
      '/api/items/release': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/heartbeat': { status: 201, body: { commentId: 0, record: { v: 1 } } },
      '/api/items/queue': (body) => ({ body: { id: body?.id } }),
    },
    (port) => runApi(project, home, port, 'abort'),
  );

  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(queueBodies(requests), [
    { id: '#32', queued: false },
    { id: '#33', queued: false },
  ]);
  const order = requests.filter((r) => r.method === 'POST' && ['/api/items/release', '/api/items/queue'].includes(r.path)).map((r) => r.path);
  assert.deepEqual(order, ['/api/items/release', '/api/items/queue', '/api/items/queue'], 'the sweep must follow the in-flight release');
});

test('Q-7: finish with the API down warns once for the whole sweep and exits as a files finish does', async (t) => {
  const { home, project } = await seededTrackerRun(t, [
    { id: '32', stage: 'skipped' },
    { id: '33', stage: 'pending' },
    { id: '34', stage: 'pending' },
  ]);

  const out = await runApi(project, home, await closedPort(), 'finish', '--status', 'done');

  const files = orchFixture(t);
  seedReadyTask(files.project, 'task-1', 'a task');
  commitEverything(files.project, 'seed');
  assert.equal(run(files.project, files.home, 'init', '--project', files.project).status, 0);
  const filesFinish = run(files.project, files.home, 'finish', '--status', 'done');

  assert.equal(out.status, filesFinish.status, out.stderr);
  const down = out.stderr.split('\n').filter((line) => /API down/.test(line));
  assert.deepEqual(down, ['orchestrator:queued: API down — label not removed on 3 item(s)']);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).status, 'done');
});
