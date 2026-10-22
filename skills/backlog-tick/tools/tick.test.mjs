// Cases for `tick.mjs` — `decide`, `record`, `status` and `forget`, each run as the real CLI in a child process against a throwaway git repository.
//
// Every case pins the four things the tool reads from outside the repo: `BM_TICK_HOME` and `BM_ORCH_HOME` (temp dirs, so nothing here touches a real
// `~/.backlog-manager`), `BM_API_PORT` (a local fake of the five routes the tool calls, or a port nothing listens on for "stack down"), and `PATH`, with a temp
// dir holding a fake `gh` in front of the real one — a test must never ask GitHub how many PRs a scratch repo has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './tick-state.mjs';

const SCRIPT = fileURLToPath(new URL('./tick.mjs', import.meta.url));
const MIN = 60_000;

// --- harness -------------------------------------------------------------

function git(cwd, ...args) {
  const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];
  const r = spawnSync('git', ['-C', cwd, ...identity, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function commitAll(root, message = 'items') {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
}

/** A temp base holding the project (a git repo on `main` with a committed `backlog/`), the two homes and the fake-`gh` dir. */
function project(t, { tracker = false, backlog = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tick-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  if (backlog) {
    fs.mkdirSync(path.join(root, 'backlog'));
    fs.writeFileSync(path.join(root, 'backlog', 'README.md'), 'the store\n');
  }
  if (tracker) fs.writeFileSync(path.join(root, 'backlog', 'source.json'), '{ "kind": "github", "repo": "futin/x" }\n');
  commitAll(root, 'init');
  const fx = { base, root, tickHome: path.join(base, 'tick'), orchHome: path.join(base, 'orch'), ghDir: path.join(base, 'bin') };
  fx.lockDir = path.join(fx.tickHome, encodeURIComponent(root));
  fx.lockFile = path.join(fx.lockDir, 'lock');
  fx.stateFile = path.join(fx.lockDir, 'state.json');
  fs.mkdirSync(fx.ghDir);
  setGh(fx, []);
  return fx;
}

/** The fake `gh`: prints `list` as JSON, or exits 1 when `list` is `'fail'`. */
function setGh(fx, list) {
  const script = path.join(fx.ghDir, 'gh');
  if (list === 'fail') {
    fs.writeFileSync(script, '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n');
  } else {
    const data = path.join(fx.ghDir, 'gh.json');
    fs.writeFileSync(data, JSON.stringify(list));
    fs.writeFileSync(script, `#!/bin/sh\ncat '${data}'\n`);
  }
  fs.chmodSync(script, 0o755);
}

const BUG_READY = '## Symptom\n\nx\n\n## Cause\n\na real cause\n\n## Fix\n\nthe real fix\n';
const BUG_RAW = '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n';
const TASK_READY = '## Goal\n\ng\n\n## Plan\n\nDo the work.\n';
const TASK_RAW = '## Goal\n\ng\n\n## Plan\n\n## Done when\n';
const ANY_BODY = '## What\n\nclean it up\n';
const SECTION = { bug: 'bugs', task: 'tasks', ref: 'refactors', idea: 'ideas' };

/** Writes `backlog/<section>/open/<id>-thing.md` in `tree` (the main checkout by default). Returns its path. */
function item(fx, id, body, fields = {}, tree = fx.root) {
  const dir = path.join(tree, 'backlog', SECTION[id.split('-')[0]], 'open');
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', `title: ${id}`, 'created: 2026-10-01', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
  const file = path.join(dir, `${id}-thing.md`);
  fs.writeFileSync(file, `${fm}\n${body}`);
  return file;
}

const rel = (fx, file) => path.relative(fx.root, file);

function tick(fx, args, { port, cwd = fx.root } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: {
        ...process.env,
        BM_TICK_HOME: fx.tickHome,
        BM_ORCH_HOME: fx.orchHome,
        BM_API_PORT: String(port ?? DEAD_PORT),
        PATH: `${fx.ghDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => {
      let v = null;
      try {
        v = JSON.parse(stdout);
      } catch {
        v = null;
      }
      resolve({ status, stdout, stderr, v });
    });
  });
}

/** `decide` that must answer one verdict line, exit 0. */
async function decide(fx, args = [], opts = {}) {
  const r = await tick(fx, ['decide', ...args], opts);
  assert.equal(r.status, 0, `decide exited ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim().split('\n').length, 1, `one line expected: ${r.stdout}`);
  assert.ok(r.v, `not JSON: ${r.stdout}`);
  return r.v;
}

// The fake API, shaped after orchestrate.test.mjs's: a route is a fixed `{ status?, body }` or a function of the request URL returning one; a string body is
// served `text/plain`, as the real `/api/items/body` serves Markdown.
async function withApi(routes, fn) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const answer = routes[url.pathname];
      const resolved = typeof answer === 'function' ? answer(url) : answer;
      if (resolved === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no fake route for ${url.pathname}` }));
        return;
      }
      const payload = resolved.body;
      res.writeHead(resolved.status ?? 200, { 'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function closedPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const DEAD_PORT = await closedPort();

const NO_RUNS = { runs: [], starting: [], remote: [] };

/** One issue as `GET /api/items` returns it — only the fields the tick reads. */
function apiItem(fx, number, over = {}) {
  const urn = `gh:futin/x#${number}`;
  const base = { id: `#${number}`, title: `issue ${number}`, section: 'bugs', status: 'open', projectPath: fx.root, groomed: true, path: urn };
  return { ...base, source: 'github', ...over };
}

function trackerRoutes(items, { bodies = {}, runs = NO_RUNS } = {}) {
  return {
    '/api/health': { body: { status: 'ok' } },
    '/api/items': { body: { items, errors: [] } },
    '/api/items/body': (url) => {
      const p = url.searchParams.get('path');
      return { body: bodies[p] ?? `## Body\n\nof ${p}\n` };
    },
    '/api/orchestrator/runs': { body: runs },
  };
}

function writeLockFile(fx, lock) {
  fs.mkdirSync(fx.lockDir, { recursive: true });
  fs.writeFileSync(fx.lockFile, typeof lock === 'string' ? lock : JSON.stringify(lock));
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const CAPS = { openPrs: null, maxPrs: 2, planReview: null, maxPlans: 3 };

// --- not a project -------------------------------------------------------

test('not a git repository, not a main checkout, no backlog store', async (t) => {
  const fx = project(t);
  const plain = path.join(fx.base, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await decide(fx, [], { cwd: plain }), { verdict: 'idle', reason: 'not a git repository', caps: CAPS, dryRun: false });

  git(fx.root, 'worktree', 'add', '-q', path.join(fx.base, 'linked'), '-b', 'linked');
  assert.equal((await decide(fx, [], { cwd: path.join(fx.base, 'linked') })).reason, 'not a main checkout');

  const bare = project(t, { backlog: false });
  assert.equal((await decide(bare)).reason, 'no backlog store');

  fs.writeFileSync(path.join(fx.root, 'backlog', 'source.json'), '{ "kind": "github", "repo": "not a repo" }\n');
  assert.equal((await decide(fx)).reason, 'unsupported backlog source');
});

test('a subdirectory of the project resolves to the project root', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const v = await decide(fx, ['--dry-run'], { cwd: path.join(fx.root, 'backlog') });
  assert.equal(v.verdict, 'execute');
  assert.equal(v.id, 'bug-1');
});

test('tracker project with the stack down is idle before any lock', async (t) => {
  const fx = project(t, { tracker: true });
  writeLockFile(fx, { host: 'h', verdict: { kind: 'groom', id: '#3' }, base: 'main', at: ago(10 * 60 * MIN) });
  assert.deepEqual(await decide(fx), { verdict: 'idle', reason: 'stack down', caps: CAPS, dryRun: false });
  // the stale lock was not even looked at
  assert.ok(fs.existsSync(fx.lockFile));
  fs.rmSync(fx.lockFile);
  await decide(fx);
  assert.equal(fs.existsSync(fx.lockFile), false);
});

test('files project decides with the stack down', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const v = await decide(fx);
  assert.deepEqual(v, {
    verdict: 'execute',
    reason: 'execute bug-1',
    id: 'bug-1',
    skill: 'backlog-execute',
    args: 'bug-1 --finish pr [backlog-tick]',
    caps: { openPrs: 0, maxPrs: 2, planReview: 0, maxPlans: 3 },
    dryRun: false,
  });
  const lock = readJson(fx.lockFile);
  assert.deepEqual(lock.verdict, { kind: 'execute', id: 'bug-1' });
  assert.equal(lock.base, git(fx.root, 'rev-parse', 'main').trim());
  assert.equal(lock.host, os.hostname());
});

test('bad flags are a usage error, exit 1', async (t) => {
  const fx = project(t);
  const bad = [['--max-prs', '-1'], ['--max-prs', '1.5'], ['--max-plans', 'x'], ['--max-prs'], ['--bogus'], ['--lock-ttl', '0'], ['extra'], ['--base', '-x']];
  for (const args of bad) {
    const r = await tick(fx, ['decide', ...args]);
    assert.equal(r.status, 1, `${args.join(' ')} → ${r.status}`);
    assert.match(r.stderr, /usage/i);
    assert.equal(r.stdout, '');
  }
  assert.equal((await tick(fx, ['nope'])).status, 1);
  assert.equal(fs.existsSync(fx.lockDir), false);
});

// --- the lock ------------------------------------------------------------

test('fresh lock → busy another tick', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const lock = { host: 'h', verdict: { kind: 'execute', id: 'bug-9' }, base: 'main', at: ago(MIN) };
  writeLockFile(fx, lock);
  assert.deepEqual(await decide(fx), { verdict: 'busy', reason: 'another tick', caps: CAPS, dryRun: false });
  assert.deepEqual(readJson(fx.lockFile), lock);
});

test('idle and busy verdicts leave no lock', async (t) => {
  const fx = project(t);
  assert.equal((await decide(fx)).verdict, 'idle');
  assert.equal(fs.existsSync(fx.lockFile), false);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-2', BUG_READY, { started: '2026-10-22T10:00:00Z' });
  commitAll(fx.root);
  assert.equal((await decide(fx)).verdict, 'busy');
  assert.equal(fs.existsSync(fx.lockFile), false);
});

test('dry-run leaves no lock', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const v = await decide(fx, ['--dry-run']);
  assert.equal(v.verdict, 'execute');
  assert.equal(v.dryRun, true);
  assert.equal(fs.existsSync(fx.lockFile), false);
});

test('two decides racing for one lock', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const [a, b] = await Promise.all([tick(fx, ['decide']), tick(fx, ['decide'])]);
  const verdicts = [a.v, b.v].sort((x, y) => x.verdict.localeCompare(y.verdict));
  assert.equal(verdicts[0].verdict, 'busy');
  assert.equal(verdicts[0].reason, 'another tick');
  assert.equal(verdicts[1].verdict, 'execute');
  assert.equal(verdicts[1].id, 'bug-1');
  assert.deepEqual(fs.readdirSync(fx.lockDir), ['lock']);
});

// --- busy ----------------------------------------------------------------

function writeRun(fx, run) {
  const dir = path.join(fx.orchHome, encodeURIComponent(fx.root));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), typeof run === 'string' ? run : JSON.stringify(run));
}

test('an orchestrator run file running or paused is busy; done is not', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  writeRun(fx, { status: 'running', project: fx.root });
  assert.deepEqual(await decide(fx), { verdict: 'busy', reason: 'orchestrator run running', caps: CAPS, dryRun: false });
  writeRun(fx, { status: 'paused', project: fx.root });
  assert.equal((await decide(fx)).reason, 'orchestrator run paused');
  writeRun(fx, { status: 'done', project: fx.root });
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'execute');
  // a run file that cannot be read is a live run until proven otherwise
  writeRun(fx, '{ half');
  assert.equal((await decide(fx)).reason, 'orchestrator run file unreadable');
});

test('a starting entry for this root is busy', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const routes = { '/api/orchestrator/runs': { body: { ...NO_RUNS, starting: [{ project: fx.root, requestedAt: ago(MIN) }] } } };
  const v = await withApi(routes, (port) => decide(fx, [], { port }));
  assert.equal(v.verdict, 'busy');
  assert.equal(v.reason, 'orchestrator run starting');
  // another project's starting entry is not this one's
  const other = { '/api/orchestrator/runs': { body: { ...NO_RUNS, starting: [{ project: `${fx.root}-other`, requestedAt: ago(MIN) }] } } };
  assert.equal((await withApi(other, (port) => decide(fx, ['--dry-run'], { port }))).verdict, 'execute');
});

test('tracker: a fresh remote run on this repo is busy, a stale one is not', async (t) => {
  const fx = project(t, { tracker: true });
  const remote = (fresh) => ({ status: 'running', fresh, remote: true, repo: 'futin/x', project: fx.root, queue: [] });
  const items = [apiItem(fx, 12)];
  let v = await withApi(trackerRoutes(items, { runs: { ...NO_RUNS, remote: [remote(true)] } }), (port) => decide(fx, [], { port }));
  assert.equal(v.verdict, 'busy');
  assert.equal(v.reason, 'remote run');
  v = await withApi(trackerRoutes(items, { runs: { ...NO_RUNS, remote: [remote(false)] } }), (port) => decide(fx, ['--dry-run'], { port }));
  assert.equal(v.verdict, 'execute');
  assert.equal(v.id, '#12');
  assert.equal(v.args, '#12 --finish pr [backlog-tick]');
});

test('files: a started marker in the main checkout is busy', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-2', BUG_RAW, { started: '2026-10-22T10:00:00Z' });
  commitAll(fx.root);
  assert.deepEqual(await decide(fx), { verdict: 'busy', reason: 'started marker on bug-2', caps: CAPS, dryRun: false });
});

test('files: a started marker in a linked worktree is busy and names the tree', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-2', BUG_RAW);
  commitAll(fx.root);
  const other = path.join(fx.base, 'other');
  git(fx.root, 'worktree', 'add', '-q', other, '-b', 'other');
  item(fx, 'bug-2', BUG_RAW, { started: '2026-10-22T10:00:00Z' }, other);
  assert.equal((await decide(fx)).reason, `started marker on bug-2 in ${other}`);
});

test('files: the orchestrator and execute trees under .worktrees are skipped, any other tree there is not', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-2', BUG_READY);
  commitAll(fx.root);
  const trees = path.join(fx.root, '.worktrees');
  for (const name of ['execute-bug-2', 'bug-2']) {
    const tree = path.join(trees, name);
    git(fx.root, 'worktree', 'add', '-q', tree, '-b', `b-${name}`);
    item(fx, 'bug-2', BUG_READY, { started: '2026-10-22T10:00:00Z', phase: 'execute' }, tree);
    const v = await decide(fx, ['--dry-run']);
    assert.equal(v.verdict, 'execute', `${name}: ${v.reason}`);
    git(fx.root, 'worktree', 'remove', '--force', tree);
  }
  const tree = path.join(trees, 'other');
  git(fx.root, 'worktree', 'add', '-q', tree, '-b', 'b-other');
  item(fx, 'bug-2', BUG_READY, { started: '2026-10-22T10:00:00Z' }, tree);
  assert.equal((await decide(fx)).reason, `started marker on bug-2 in ${tree}`);
});

test('tracker: a live claim is busy, a stale one is not', async (t) => {
  const fx = project(t, { tracker: true });
  const claimed = (heartbeatAgo) => [apiItem(fx, 4, { section: 'tasks', holder: { session: 's', heartbeat: ago(heartbeatAgo) } }), apiItem(fx, 12)];
  let v = await withApi(trackerRoutes(claimed(5 * MIN)), (port) => decide(fx, [], { port }));
  assert.equal(v.verdict, 'busy');
  assert.equal(v.reason, 'live claim on #4');
  v = await withApi(trackerRoutes(claimed(20 * MIN)), (port) => decide(fx, ['--dry-run'], { port }));
  assert.equal(v.verdict, 'execute');
  assert.equal(v.id, '#12');
});

// --- execute candidate ---------------------------------------------------

test('runner-fix item is picked first', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'task-1', TASK_READY, { 'runner-fix': 'true' });
  commitAll(fx.root);
  assert.equal((await decide(fx, ['--dry-run'])).id, 'task-1');
});

test('uncommitted approval is not an approval', async (t) => {
  const fx = project(t);
  const file = item(fx, 'bug-1', BUG_READY, { 'plan-review': 'true' });
  commitAll(fx.root);
  // the approval: the line deleted, in the working tree only
  item(fx, 'bug-1', BUG_READY);
  assert.notEqual(fs.readFileSync(file, 'utf8'), git(fx.root, 'show', `main:${rel(fx, file)}`));
  const v = await decide(fx, ['--dry-run']);
  assert.equal(v.verdict, 'idle');
  assert.equal(v.reason, 'nothing to do: no ready bug or task; no ungroomed bug or refactor');
});

test('uncommitted item is not a candidate', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
});

// Review fix I1: candidates are LISTED off the working tree's `open/` and only READ at `<base>` — the shape of orchestrate.mjs's `listOpenItems`. A ready
// bug rejected or archived on disk but not yet committed is still open at `<base>`, and a listing taken there would execute what was just decided against.
test('a committed ready bug moved out of open/ in the working tree only is not a candidate', async (t) => {
  for (const dest of [['out-of-scope'], ['bugs', 'done']]) {
    const fx = project(t);
    const file = item(fx, 'bug-1', BUG_READY);
    commitAll(fx.root);
    const dir = path.join(fx.root, 'backlog', ...dest);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(file, path.join(dir, path.basename(file)));
    const v = await decide(fx, ['--dry-run']);
    assert.equal(v.verdict, 'idle', dest.join('/'));
    assert.equal(v.reason, 'nothing to do: no ready bug or task; no ungroomed bug or refactor');
  }
});

test('existing execute branch or worktree skips the item', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-2', BUG_READY);
  commitAll(fx.root);
  git(fx.root, 'branch', 'execute/bug-1');
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-2');
  git(fx.root, 'branch', '-D', 'execute/bug-1');
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-1');
  fs.mkdirSync(path.join(fx.root, '.worktrees', 'execute-bug-1'), { recursive: true });
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-2');
});

test('tracker: in-review, plan-review and an execute/<n> branch skip the issue', async (t) => {
  const fx = project(t, { tracker: true });
  const items = (over) => [apiItem(fx, 12, over), apiItem(fx, 13, { section: 'tasks' })];
  const pick = (list) => withApi(trackerRoutes(list), (port) => decide(fx, ['--dry-run'], { port }));
  assert.equal((await pick(items({}))).id, '#12');
  assert.equal((await pick(items({ inReview: true }))).id, '#13');
  assert.equal((await pick(items({ planReview: true }))).id, '#13');
  assert.equal((await pick(items({ groomed: false }))).id, '#13');
  // another project's issue is never this one's
  assert.equal((await pick(items({ projectPath: `${fx.root}-other` }))).id, '#13');
  git(fx.root, 'branch', 'execute/#12');
  assert.equal((await pick(items({}))).id, '#12');
  git(fx.root, 'branch', 'execute/12');
  assert.equal((await pick(items({}))).id, '#13');
  git(fx.root, 'branch', '-D', 'execute/12');
  fs.mkdirSync(path.join(fx.root, '.worktrees', 'execute-12'), { recursive: true });
  assert.equal((await pick(items({}))).id, '#13');
});

test('failed record with the same hash skips; an edited item is eligible again', async (t) => {
  const fx = project(t);
  const file = item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  assert.equal((await decide(fx)).id, 'bug-1');
  assert.equal((await tick(fx, ['record', 'bug-1', 'failed', '--kind', 'execute', '--reason', 'tests red'])).status, 0);
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
  // a bookkeeping stamp is not an edit
  item(fx, 'bug-1', BUG_READY, { updated: '2026-10-22T11:00:00Z' });
  commitAll(fx.root);
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('the real fix', 'the better fix'));
  // edited in the working tree only: execute reads <base>, so still skipped
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
  commitAll(fx.root);
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-1');
});

/** main has bug-1 as `mainBody`, develop as `developBody`; the checkout is left on main. */
function twoBases(fx, mainBody, developBody) {
  item(fx, 'bug-1', mainBody);
  commitAll(fx.root);
  git(fx.root, 'checkout', '-q', '-b', 'develop');
  item(fx, 'bug-1', developBody);
  commitAll(fx.root, 'develop');
  git(fx.root, 'checkout', '-q', 'main');
}

test('--base develop reads the candidate from develop and passes the base on', async (t) => {
  const fx = project(t);
  twoBases(fx, BUG_RAW, BUG_READY);
  const v = await decide(fx, ['--base', 'develop', '--dry-run']);
  assert.equal(v.verdict, 'execute');
  assert.equal(v.args, 'bug-1 --finish pr --base develop [backlog-tick]');
  // without it, main's ungroomed copy is what execute would see — and the working tree's makes it a groom
  const plain = await decide(fx, ['--dry-run']);
  assert.equal(plain.verdict, 'groom');
  assert.equal(plain.args, 'bug-1, plan the fix [backlog-tick]');
});

test('origin/HEAD names the default base when there is one', async (t) => {
  const fx = project(t);
  twoBases(fx, BUG_RAW, BUG_READY);
  git(fx.root, 'update-ref', 'refs/remotes/origin/develop', 'develop');
  git(fx.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const v = await decide(fx, ['--dry-run']);
  assert.equal(v.verdict, 'execute');
  // the base was not given, so it is not passed on: execute resolves its own default
  assert.equal(v.args, 'bug-1 --finish pr [backlog-tick]');
});

test('record hashes at the lock\'s base', async (t) => {
  const fx = project(t);
  twoBases(fx, BUG_READY, BUG_READY.replace('the real fix', 'the develop fix'));
  assert.equal((await decide(fx, ['--base', 'develop'])).id, 'bug-1');
  const r = await tick(fx, ['record', 'bug-1', 'failed', '--kind', 'execute']);
  assert.equal(r.status, 0, r.stderr);
  const blob = git(fx.root, 'show', 'develop:backlog/bugs/open/bug-1-thing.md');
  assert.equal(readJson(fx.stateFile).items['bug-1'].hash, contentHash(blob));
  assert.equal((await decide(fx, ['--base', 'develop', '--dry-run'])).verdict, 'idle');
  // main's copy differs, so a decide against main is a different attempt
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-1');
});

// --- caps ----------------------------------------------------------------

test('open execute PRs cap execute, and groom still runs', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-4', BUG_RAW);
  commitAll(fx.root);
  setGh(fx, [{ headRefName: 'execute/bug-7' }, { headRefName: 'execute/12' }, { headRefName: 'feature/x' }]);
  const capped = await decide(fx, ['--dry-run']);
  assert.equal(capped.verdict, 'groom');
  assert.equal(capped.id, 'bug-4');
  assert.deepEqual(capped.caps, { openPrs: 2, maxPrs: 2, planReview: 0, maxPlans: 3 });
  const open = await decide(fx, ['--dry-run', '--max-prs', '3']);
  assert.equal(open.verdict, 'execute');
  assert.equal(open.id, 'bug-1');
  assert.equal(open.caps.maxPrs, 3);
});

test('gh failure caps execute but not groom', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-4', BUG_RAW);
  commitAll(fx.root);
  for (const list of ['fail', Array.from({ length: 500 }, (_, n) => ({ headRefName: `feature/${n}` }))]) {
    setGh(fx, list);
    const v = await decide(fx, ['--dry-run']);
    assert.equal(v.verdict, 'groom');
    assert.equal(v.id, 'bug-4');
    assert.match(v.reason, /cannot count open PRs/);
    assert.equal(v.caps.openPrs, null);
  }
});

// --- groom ---------------------------------------------------------------

test('ungroomed bug before refactor; a refactor alone is promoted', async (t) => {
  const fx = project(t);
  item(fx, 'ref-2', ANY_BODY);
  item(fx, 'bug-4', BUG_RAW);
  const v = await decide(fx);
  assert.equal(v.verdict, 'groom');
  assert.equal(v.id, 'bug-4');
  assert.equal(v.skill, 'backlog-groom');
  assert.equal(v.args, 'bug-4, plan the fix [backlog-tick]');
  assert.deepEqual(readJson(fx.lockFile).verdict, { kind: 'groom', id: 'bug-4' });
  fs.rmSync(fx.lockFile);
  fs.rmSync(path.join(fx.root, 'backlog', 'bugs'), { recursive: true });
  const ref = await decide(fx, ['--dry-run']);
  assert.equal(ref.id, 'ref-2');
  assert.equal(ref.args, 'ref-2, promote it to a task [backlog-tick]');
});

test('ideas and ungroomed tasks are never groomed, nor a started or failed item', async (t) => {
  const fx = project(t);
  item(fx, 'idea-1', ANY_BODY);
  item(fx, 'task-3', TASK_RAW);
  commitAll(fx.root);
  const v = await decide(fx, ['--dry-run']);
  assert.equal(v.verdict, 'idle');
  assert.equal(v.reason, 'nothing to do: no ready bug or task; no ungroomed bug or refactor');
  // a failed groom with the same working-tree hash is skipped, and an edit makes it eligible again
  const file = item(fx, 'bug-4', BUG_RAW);
  assert.equal((await decide(fx)).id, 'bug-4');
  assert.equal((await tick(fx, ['record', 'bug-4', 'failed', '--kind', 'groom', '--reason', 'no cause'])).status, 0);
  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
  fs.appendFileSync(file, '\nmore symptom\n');
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-4');
});

test('the plan-review count reads the working tree', async (t) => {
  const fx = project(t);
  item(fx, 'bug-4', BUG_RAW);
  commitAll(fx.root);
  for (const n of [5, 6, 7]) item(fx, `task-${n}`, TASK_READY, { 'plan-review': 'true' });
  const capped = await decide(fx, ['--dry-run']);
  assert.equal(capped.verdict, 'idle');
  assert.equal(capped.reason, 'nothing to do: no ready bug or task; 3 plans awaiting review (cap 3)');
  assert.equal(capped.caps.planReview, 3);
  const open = await decide(fx, ['--dry-run', '--max-plans', '4']);
  assert.equal(open.verdict, 'groom');
  assert.equal(open.id, 'bug-4');
});

test('nothing to do when both caps are full', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  item(fx, 'bug-4', BUG_RAW);
  commitAll(fx.root);
  for (const n of [5, 6, 7]) item(fx, `task-${n}`, TASK_READY, { 'plan-review': 'yes' });
  setGh(fx, [{ headRefName: 'execute/bug-7' }, { headRefName: 'execute/bug-8' }]);
  const v = await decide(fx);
  assert.deepEqual(v, {
    verdict: 'idle',
    reason: 'nothing to do: 2 open execute PRs (cap 2); 3 plans awaiting review (cap 3)',
    caps: { openPrs: 2, maxPrs: 2, planReview: 3, maxPlans: 3 },
    dryRun: false,
  });
  assert.equal(fs.existsSync(fx.lockFile), false);
});

test('tracker: groom counts planReview off the API and hashes the body', async (t) => {
  const fx = project(t, { tracker: true });
  const items = [
    apiItem(fx, 4, { groomed: false }),
    apiItem(fx, 2, { section: 'refactors', groomed: null }),
    apiItem(fx, 9, { section: 'tasks', planReview: true }),
  ];
  let v = await withApi(trackerRoutes(items), (port) => decide(fx, ['--dry-run'], { port }));
  assert.equal(v.verdict, 'groom');
  assert.equal(v.args, '#4, plan the fix [backlog-tick]');
  assert.equal(v.caps.planReview, 1);
  v = await withApi(trackerRoutes(items), (port) => decide(fx, ['--dry-run', '--max-plans', '1'], { port }));
  assert.equal(v.verdict, 'idle');
  assert.equal(v.reason, 'nothing to do: no ready bug or task; 1 plans awaiting review (cap 1)');
});

// --- recover -------------------------------------------------------------

const staleLock = (kind, id, at = ago(4 * 60 * MIN)) => ({ host: 'h', verdict: { kind, id }, base: 'main', at });

test('recover a killed groom: recorded failed, lock gone, stop when the marker is the groom\'s', async (t) => {
  const fx = project(t);
  const file = item(fx, 'bug-3', BUG_RAW, { started: '2026-10-22T10:00:00Z', phase: 'groom' });
  writeLockFile(fx, staleLock('groom', 'bug-3'));
  const v = await decide(fx);
  assert.deepEqual(v, { verdict: 'recover', reason: 'recovered a killed groom on bug-3', id: 'bug-3', stop: true, caps: CAPS, dryRun: false });
  const rec = readJson(fx.stateFile).items['bug-3'];
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.kind, 'groom');
  assert.equal(rec.reason, 'killed at timeout');
  assert.equal(rec.hash, contentHash(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(fs.readdirSync(fx.lockDir), ['state.json']);
});

test('recover: stop only for a files groom whose marker says phase groom', async (t) => {
  const fx = project(t);
  item(fx, 'bug-3', BUG_RAW, { started: '2026-10-22T10:00:00Z', phase: 'execute' });
  writeLockFile(fx, staleLock('groom', 'bug-3'));
  assert.equal((await decide(fx)).stop, false);
  item(fx, 'bug-3', BUG_READY, { started: '2026-10-22T10:00:00Z', phase: 'groom' });
  commitAll(fx.root);
  writeLockFile(fx, staleLock('execute', 'bug-3'));
  const v = await decide(fx);
  assert.equal(v.reason, 'recovered a killed execute on bug-3');
  assert.equal(v.stop, false);
  // an execute recovery hashes the <base> blob, at the lock's base
  assert.equal(readJson(fx.stateFile).items['bug-3'].hash, contentHash(git(fx.root, 'show', 'main:backlog/bugs/open/bug-3-thing.md')));
});

test('recover: a tracker groom never stops, and hashes the issue body', async (t) => {
  const fx = project(t, { tracker: true });
  writeLockFile(fx, staleLock('groom', '#3'));
  const bodies = { 'gh:futin/x#3': '## Symptom\n\nthe body\n' };
  const v = await withApi(trackerRoutes([apiItem(fx, 3, { groomed: false })], { bodies }), (port) => decide(fx, [], { port }));
  assert.equal(v.verdict, 'recover');
  assert.equal(v.id, '#3');
  assert.equal(v.stop, false);
  assert.equal(readJson(fx.stateFile).items['#3'].hash, contentHash(bodies['gh:futin/x#3']));
});

test('recover honours --lock-ttl', async (t) => {
  const fx = project(t);
  item(fx, 'bug-3', BUG_RAW);
  writeLockFile(fx, staleLock('groom', 'bug-3', ago(2 * MIN)));
  assert.equal((await decide(fx)).verdict, 'busy');
  assert.equal((await decide(fx, ['--lock-ttl', '1'])).verdict, 'recover');
});

test('dry-run recover writes nothing', async (t) => {
  const fx = project(t);
  item(fx, 'bug-3', BUG_RAW, { started: '2026-10-22T10:00:00Z', phase: 'groom' });
  const lock = staleLock('groom', 'bug-3');
  writeLockFile(fx, lock);
  const v = await decide(fx, ['--dry-run']);
  assert.deepEqual(v, { verdict: 'recover', reason: 'recovered a killed groom on bug-3', id: 'bug-3', stop: true, caps: CAPS, dryRun: true });
  assert.deepEqual(readJson(fx.lockFile), lock);
  assert.deepEqual(fs.readdirSync(fx.lockDir), ['lock']);
});

test('an unreadable lock is removed and nothing is recorded', async (t) => {
  const fx = project(t);
  writeLockFile(fx, 'not json');
  assert.deepEqual(await decide(fx), { verdict: 'recover', reason: 'removed an unreadable lock', stop: false, caps: CAPS, dryRun: false });
  assert.deepEqual(fs.readdirSync(fx.lockDir), []);
  // parseable JSON with no usable verdict is the same case
  writeLockFile(fx, { host: 'h', verdict: { kind: 'merge', id: 'bug-1' }, at: ago(4 * 60 * MIN) });
  assert.equal((await decide(fx)).reason, 'removed an unreadable lock');
  assert.deepEqual(fs.readdirSync(fx.lockDir), []);
});

// --- record --------------------------------------------------------------

test('record failed stores the <base> blob hash and releases its own lock', async (t) => {
  const fx = project(t);
  const file = item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  // the working copy differs from main: the hash must be main's
  fs.appendFileSync(file, '\nlocal note\n');
  assert.equal((await decide(fx)).id, 'bug-1');
  const r = await tick(fx, ['record', 'bug-1', 'failed', '--kind', 'execute', '--reason', 'tests red']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const rec = readJson(fx.stateFile).items['bug-1'];
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.kind, 'execute');
  assert.equal(rec.reason, 'tests red');
  assert.equal(rec.hash, contentHash(git(fx.root, 'show', 'main:backlog/bugs/open/bug-1-thing.md')));
  assert.equal(fs.existsSync(fx.lockFile), false);
});

test('record leaves another id\'s lock in place and says so', async (t) => {
  const fx = project(t);
  item(fx, 'bug-2', BUG_RAW);
  const lock = staleLock('execute', 'bug-1', ago(MIN));
  writeLockFile(fx, lock);
  const r = await tick(fx, ['record', 'bug-2', 'ok', '--kind', 'groom']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bug-1/);
  assert.deepEqual(readJson(fx.lockFile), lock);
  const rec = readJson(fx.stateFile).items['bug-2'];
  assert.equal(rec.outcome, 'ok');
  assert.equal(rec.hash, undefined);
});

test('record with no lock hashes at the default base and says so', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  const r = await tick(fx, ['record', 'bug-1', 'failed', '--kind', 'execute']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\bmain\b/);
  assert.equal(readJson(fx.stateFile).items['bug-1'].hash, contentHash(git(fx.root, 'show', 'main:backlog/bugs/open/bug-1-thing.md')));
});

test('record usage errors exit 1 and write nothing', async (t) => {
  const fx = project(t);
  const bad = [
    ['bug-1', 'maybe', '--kind', 'groom'],
    ['bug-1', 'ok'],
    ['bug-1', 'ok', '--kind', 'merge'],
    ['bug-1'],
    [],
    ['bug-1', 'ok', '--kind', 'groom', '--what'],
  ];
  for (const args of bad) {
    const r = await tick(fx, ['record', ...args]);
    assert.equal(r.status, 1, `${args.join(' ')} → ${r.status}`);
    assert.match(r.stderr, /usage/i);
  }
  assert.equal(fs.existsSync(fx.stateFile), false);
});

// --- status and forget ---------------------------------------------------

// `decide` keys a tracker item as `#12`, so a bare `12` from a hand-typed `record` or `forget` must land on the same key, or the record skips nothing.
test('tracker: record and forget take a bare issue number as #<n>', async (t) => {
  const fx = project(t, { tracker: true });
  assert.equal((await tick(fx, ['record', '12', 'ok', '--kind', 'groom'])).status, 0);
  assert.deepEqual(Object.keys(readJson(fx.stateFile).items), ['#12']);
  assert.equal((await tick(fx, ['forget', '12'])).status, 0);
  assert.deepEqual(Object.keys(readJson(fx.stateFile).items), []);
});

test('status --json lists newest first; forget lets the next decide pick the item again', async (t) => {
  const fx = project(t);
  item(fx, 'bug-1', BUG_READY);
  commitAll(fx.root);
  assert.equal((await tick(fx, ['record', 'bug-2', 'ok', '--kind', 'groom'])).status, 0);
  assert.equal((await tick(fx, ['record', 'bug-1', 'failed', '--kind', 'execute', '--reason', 'flaky env'])).status, 0);
  const s = await tick(fx, ['status', '--json']);
  assert.equal(s.status, 0);
  assert.equal(s.v.lock, null);
  assert.deepEqual(s.v.recent.map((e) => [e.id, e.outcome]), [['bug-1', 'failed'], ['bug-2', 'ok']]);
  const text = await tick(fx, ['status']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /no lock/);
  assert.ok(text.stdout.indexOf('bug-1') < text.stdout.indexOf('bug-2'));

  assert.equal((await decide(fx, ['--dry-run'])).verdict, 'idle');
  assert.equal((await tick(fx, ['forget', 'bug-1'])).status, 0);
  assert.equal((await decide(fx, ['--dry-run'])).id, 'bug-1');
  const again = await tick(fx, ['forget', 'bug-1']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /bug-1/);
  assert.equal((await tick(fx, ['forget', 'bug-99'])).status, 1);
});
