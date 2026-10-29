// The harness the orchestrate*.test.mjs suites share: fixtures, the CLI runners, the fake tracker API and the helpers more than one suite calls. It is a
// plain module, not a suite — the name deliberately does not end in `.test.mjs`, so `test:skills`'s glob never runs it — and it has no `test()` calls and
// no top-level side effects. A helper only one suite uses lives in that suite instead, next to the tests that read it.
//
// It names no doc path: scripts/ci-scope.mjs picks the node suites a docs-only PR runs by scanning each SUITE's source for the changed path, so a path only
// this file spelled would let that PR skip the guard that reads it. SKILL.md, references/ and the like stay in the suites that read them (#390).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

export const SCRIPT = fileURLToPath(new URL('./orchestrate.mjs', import.meta.url));

// Task 5's own fixtures: a realistic `claude -p --output-format stream-json`
// transcript head that DOES carry the init event (and therefore the session
// id), and one that never does — see watch's own test cases 1 and 3.
export const STREAM_INIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-init.jsonl');

// Every test gets its own throwaway BM_ORCH_HOME (so nothing here ever
// touches a developer's real ~/.backlog-manager/) and its own throwaway
// project directory (a real, if empty, git repo — orchestrate.mjs resolves
// "which project" for every command but `init` by walking up from its own
// cwd looking for a .git entry, exactly the way skills/backlog/tools/
// backlog.mjs's resolveRoot does; see orchestrate.mjs's own comment on why
// that duplication is deliberate rather than an import). t.after cleans up
// both directories unconditionally, so a failed assertion mid-test still
// leaves no litter in the OS temp dir behind it.
export function orchFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-home-')));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-project-')));
  spawnSync('git', ['-C', project, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  // task-17: the pause-request directory, derived from `home` rather than
  // mkdtemp'd separately so `run()` below can pin it from the one argument
  // every existing call already passes — the alternative was a signature
  // change on every call site in this file, which would have made the
  // harness change visible to (and therefore capable of breaking) tests that
  // have nothing to do with pausing. Pinned for exactly the reason
  // BM_ORCH_HOME is: this directory is one the SERVER writes for real, under
  // a developer's `~/.backlog-manager/settings/`, and a test that reached it
  // could pause a real run.
  const control = `${home}-control`;
  fs.mkdirSync(control, { recursive: true });
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(control, { recursive: true, force: true });
  });
  return { home, project, control };
}

// Spawns the real CLI as a child process with BM_ORCH_HOME pinned to this
// test's own throwaway home — never the ambient environment's value, so a
// developer's real orchestrator state can never leak into, or be clobbered
// by, a test run.
//
// `maxBuffer` is raised off spawnSync's 1MB default because task-34 made the
// CLI's stdout arrive WHOLE: the entry guard used to `process.exit()`, which
// truncated every pipe write at 65,536 bytes, so no test could ever reach the
// default. The E2BIG case below echoes a deliberately 3MB-long command back in
// its human-readable output, and over the default spawnSync SIGTERMs the child
// and reports `status: null` — a killed process rather than the exit code the
// case is about. A shell, which is what really runs this tool, has no such
// limit; the ceiling here exists only so the harness stops being the narrower
// pipe of the two.
export const CLI_MAX_BUFFER = 64 * 1024 * 1024;

// #246: the session identity is pinned too, for the same reason BM_ORCH_HOME
// is — the ambient value must not decide what a test sees. The driver lease is
// keyed on CLAUDE_CODE_SESSION_ID, and inheriting it meant `run()` behaved as a
// leased session inside Claude Code and as a hand-run terminal everywhere else:
// `unpause`'s case asserted on `driver.at` and passed in a session, then read
// `driver: null` from a plain terminal and threw. Every `run()` caller is now one
// fixed session wherever the suite runs; a case that wants the terminal (or a
// second session) says so through `runAs` below.
export const TEST_SESSION_ID = 'sess-test';

export function run(cwd, home, ...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    maxBuffer: CLI_MAX_BUFFER,
    env: { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control`, CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID }
  });
}

// Project keying is encodeURIComponent(<abs path>), reversible with
// decodeURIComponent — asserted directly against the CLI's own file layout
// here so every other test in this file can compute where run.json landed
// without re-deriving the encoding itself.
export function runFile(home, project) {
  return path.join(home, encodeURIComponent(project), 'run.json');
}

export function runsDir(home, project) {
  return path.join(home, encodeURIComponent(project), 'runs');
}

// The control file's own path, mirroring `runFile` above: one file per
// project, keyed the same encodeURIComponent way, but FLAT under the control
// root rather than inside a per-project directory — there is only ever one
// control fact per project, so there is nothing for a directory to hold.
export function controlFile(home, project) {
  return path.join(`${home}-control`, `${encodeURIComponent(project)}.json`);
}

// Writes a pause request exactly as the server's `writePauseRequest` does.
// Hand-written here rather than imported: the tool and the server keep two
// copies of this shape on purpose (a skill's tools/ may never import from
// the server), and a test that reached across for the server's writer would
// hide a drift between them instead of catching it.
export function writeControl(home, project, body) {
  fs.mkdirSync(`${home}-control`, { recursive: true });
  fs.writeFileSync(controlFile(home, project), typeof body === 'string' ? body : JSON.stringify(body));
}

// Writes one ready-gated task item straight into `project`'s own backlog/
// store. Task 4 replaced the old --queue-json escape hatch with the real
// gate, so every test below that just needs SOME item in the queue — and
// does not care about gating itself, that is what the "plan / gate" section
// further down is for — reaches for this instead of a synthetic queue file.
// A real, non-placeholder `## Plan` is what keeps these tests honest: an
// item built by this helper must never accidentally read as ungroomed or
// needs-answers, or every stage/heartbeat/attention/finish test that seeds
// one would start depending on gate behaviour it isn't testing.
export function seedReadyTask(project, id, title) {
  const dir = path.join(project, 'backlog', 'tasks', 'open');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-fixture.md`);
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-01\n---\n\n## Goal\n\nSomething worth doing.\n\n## Plan\n\nDo the actual work described here, in enough detail that it counts as groomed.\n\n## Test cases\n\n## Done when\n`
  );
  return file;
}

// `git worktree add <path> -b <branch> HEAD` needs an actual commit for HEAD
// to resolve to — orchFixture's repo is `git init -q` with no commits at
// all, which every OTHER test in this file is fine with (orchestrate.mjs
// only ever needs a `.git` entry to exist, never a commit). Only the abort/
// reconcile tests below exercise real worktree/branch plumbing, so only
// they call this. A throwaway local identity (`-c user.email=…`) keeps this
// independent of whatever global git config this machine happens to have.
// `core.autocrlf=false` for the same reason: a global `input` (or `true`)
// normalises CRLF to LF at `add`, so a fixture that commits CRLF bytes would
// store LF instead, and a later CRLF-to-LF rewrite would be an empty commit.
export function commitEverything(project, message) {
  spawnSync('git', ['-C', project, '-c', 'core.autocrlf=false', 'add', '-A'], { encoding: 'utf8' });
  const result = spawnSync('git', ['-C', project, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message], {
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
}

// The per-project state directory itself — the parent `runFile`/`runsDir`
// above both point into. Sidecar seeding needs the parent, not either child.
export function projStateDir(home, project) {
  return path.join(home, encodeURIComponent(project));
}

// Writes one sidecar file at `<dir>/<rel>`, creating its parents. `rel` is
// a POSIX-ish relative path ('logs/bug-1.jsonl'); joined a segment at a time
// so this reads the same on any platform the suite runs on.
export function seedSidecar(home, project, rel, body) {
  const target = path.join(projStateDir(home, project), ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

// Two runs in the same wall-clock second get the SAME runId (makeRunId is
// second-precision), and archiveStem then files the second one under
// `<runId>-2`. That collision is correct behaviour with its own unit case
// above — but a test that wants to talk about "run 1's archive" and "run 2's
// archive" BY RUN ID needs the two ids to actually differ, so it waits out
// the second rather than asserting against two names that turn out to be
// one. Only the cases that name both ids pay this second; nothing else does.
export function sleepPastRunIdSecond() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}
// `planFixture` copies the checked-in store into a disposable project per
// test rather than pointing `--project` at the checked-in path directly —
// `plan` is supposed to write nothing at all (case 8 below is exactly that
// promise), but a bug that broke it should never be able to corrupt the
// very fixtures this suite depends on to catch the bug in the first place.
export const FIXTURE_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store');

export function planFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-home-')));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-plan-project-'));
  const project = path.join(scratch, 'project');
  fs.cpSync(FIXTURE_STORE, project, { recursive: true });
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return { home, project: fs.realpathSync(project) };
}

export function plan(project, home, ...extra) {
  return run(project, home, 'plan', '--project', project, ...extra);
}
// `planGitFixture` is `planFixture` plus a real repository: the trunk is
// pinned to `main` with `symbolic-ref` rather than `init -b main` so the
// branch name is this suite's own choice and not whatever
// `init.defaultBranch` happens to be on the machine running it, and a
// README.md rides along in the first commit purely so case 7 has a tracked
// NON-item file it can dirty. Every non-git `planFixture` case above stays
// exactly as it is — those are the fallback's regression test.
export function planGitFixture(t) {
  const { home, project } = planFixture(t);
  spawnSync('git', ['-C', project, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  spawnSync('git', ['-C', project, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture store\n');
  commitEverything(project, 'fixture store');
  return { home, project };
}

// The one uncommitted item cases 2, 4 and 5 share. Its repo-relative path is
// a literal rather than something derived, because case 2 asserts the gate's
// reason names that exact path — a derived value on both sides could agree
// with itself while both were wrong.
export const TASK_9_REL = 'backlog/tasks/open/task-9-uncommitted-when-the-run-starts.md';
export const TASK_9_BODY = `---
id: task-9
title: Uncommitted when the run starts
created: 2026-09-01
---

## Plan

A real plan, groomed in the working copy and committed nowhere.
`;

export function git(project, ...args) {
  return spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' });
}

export const STREAM_DENIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-denial.jsonl');
export const STREAM_NO_RESULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-no-result.jsonl');

// A real linked worktree of `project`, on its own branch, with a real
// commit behind it (git worktree add needs HEAD to resolve).
export function addWorktree(project, name, branch) {
  commitEverything(project, 'seed');
  const worktreePath = path.join(project, '.worktrees', name);
  const added = spawnSync('git', ['-C', project, 'worktree', 'add', worktreePath, '-b', branch, 'HEAD'], { encoding: 'utf8' });
  if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  return worktreePath;
}

// `run()` with an explicit session identity, since the lease is keyed on
// CLAUDE_CODE_SESSION_ID. `null` unsets it — the hand-run terminal case, which
// must still work.
export function runAs(sessionId, cwd, home, ...args) {
  const env = { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control` };
  if (sessionId === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = sessionId;
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd, env });
}

// The stop counterpart of `effectiveControl` above: same run, same clock,
// `kind: 'stop'`.
export function effectiveStop(home, project, over = {}) {
  const run = JSON.parse(fs.readFileSync(runFile(home, project), 'utf8'));
  writeControl(home, project, { runId: run.runId, requestedAt: new Date().toISOString(), kind: 'stop', ...over });
  return run;
}

export const STREAM_USAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage.jsonl');

// The command reads which dispatch a transcript belongs to out of its FILE
// NAME, so every test here needs the fixture sitting under a name the real
// logs directory would have produced. Copied into a throwaway directory per
// call rather than renamed in place — the fixtures are shared and read-only.
export function transcriptAs(t, fixture, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-usage-'));
  const file = path.join(dir, name);
  fs.copyFileSync(fixture, file);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

export function queueItem(home, project, id) {
  return JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).queue.find((q) => q.id === id);
}
export const STREAM_USAGE_NO_NUMBERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-no-numbers.jsonl');
// `basedFixture` is `orchFixture` plus one commit, because a base check needs
// real refs to resolve against. Kept separate rather than folded into
// orchFixture: a commit there would give every OTHER test in this file a
// `blobReaderAt` that resolves, flipping the whole suite's gating from
// working-copy content to committed content.
export function basedFixture(t) {
  const fx = orchFixture(t);
  fs.writeFileSync(path.join(fx.project, 'README.md'), 'base fixture\n');
  commitEverything(fx.project, 'base fixture');
  return fx;
}
// Two shapes of the harness are load-bearing and neither is a preference:
//
//   * **The fake API runs in THIS process, so the tool must be spawned
//     ASYNCHRONOUSLY.** `spawnSync` blocks this process's event loop until the
//     child exits, and a child that connects to the fake would wait for an
//     accept that cannot happen until it has already exited — a five-minute
//     hang reported as exit `5`, which reads exactly like a stack that is not
//     running. `backlog.test.mjs`'s API-mode suite records the same deadlock.
//   * **`127.0.0.1`, never the wildcard**, for the reason `test/helpers/app.ts`
//     gives on the jest side: a bare `listen(0)` binds `::` and the kernel
//     picks a port against that address alone, so another process holding the
//     same number on IPv4 loopback answers instead.

/** The fake API: records every request and answers from a per-route table. */
export function fakeApi(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

      const answer = routes[url.pathname];
      const resolved = typeof answer === 'function' ? answer(body, url, req.method) : answer;
      if (resolved === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no fake route for ${url.pathname}` }));
        return;
      }
      const payload = resolved.body;
      // text/plain for the body route, which answers Markdown rather than
      // JSON — the same content type the real one uses.
      const type = typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      res.writeHead(resolved.status ?? 200, { 'content-type': type });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null));
    });
  });
  return { server, requests };
}

export async function withApi(routes, fn) {
  const { server, requests } = fakeApi(routes);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return { out: await fn(port), requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** `runAsync` plus a `BM_API_PORT` and the control home every `run()` pins. */
export function runApi(cwd, home, port, ...args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, BM_ORCH_HOME: home, BM_ORCH_CONTROL_HOME: `${home}-control`, BM_API_PORT: String(port), CLAUDE_CODE_SESSION_ID: TEST_SESSION_ID },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A port nothing is listening on — a closed one, for the two cases that are
 *  about the API being absent. Opened and immediately closed so the number is
 *  real and free rather than guessed. */
export async function closedPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** `orchFixture` plus a committed tracker marker. */
export function trackerFixture(t, marker = { kind: 'github', repo: 'futin/x' }) {
  const fixture = orchFixture(t);
  fs.mkdirSync(path.join(fixture.project, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(fixture.project, 'backlog', 'source.json'), `${JSON.stringify(marker, null, 2)}\n`);
  return fixture;
}

export const GROOMED_TASK_BODY = '## Goal\n\nSomething.\n\n## Plan\n\nDo the real work, described in enough detail to count as groomed.\n\n## Done when\n';
export const GROOMED_BUG_BODY = '## Symptom\n\nx\n\n## Cause\n\na real diagnosed cause\n\n## Fix\n\nthe real fix\n';

/** One issue as `GET /api/items` returns it. Only the fields the gate reads
 *  are spelled out; a `BacklogItem` carries more, and none of the rest reaches
 *  `trackerCandidates`. */
export function apiItem(projectPath, number, over = {}) {
  return {
    id: `#${number}`,
    title: `issue ${number}`,
    section: 'tasks',
    status: 'open',
    projectPath,
    path: `gh:futin/x#${number}`,
    source: 'github',
    ...over,
  };
}

/** The three read routes a tracker gate makes, as a route table. `bodies` is
 *  keyed by issue number.
 *
 *  `/api/trackers` is here because bug-41's retry times itself off this
 *  project's `polledAt`: the default is OLDER than one poll window, so the
 *  next tick reads as already due and a miss re-reads immediately rather than
 *  blocking this suite for fifteen seconds. A case that wants the wait itself
 *  measured drives `trackerRetryDelayMs` directly instead — a real sleep in a
 *  spawned child proves nothing a pure function does not. */
export function gateRoutes(items, bodies, { projectPath = items.find((i) => i && i.projectPath)?.projectPath ?? '', polledAt = new Date(Date.now() - 60_000).toISOString() } = {}) {
  return {
    '/api/items': { body: { items, errors: [] } },
    // `init` on a tracker project marks its queue `orchestrator:queued`, and a
    // case that is not about the label wants those writes answered rather than
    // filling stderr with the fake's 404.
    '/api/items/queue': (body) => ({ body: { id: body?.id, queued: body?.queued } }),
    '/api/items/body': (_body, url) => {
      const number = String(url.searchParams.get('path') ?? '').replace(/^.*#/, '');
      return { body: bodies[number] ?? '' };
    },
    '/api/trackers': {
      body: {
        platforms: [{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4999, reset: null }],
        projects: [{ name: 'x', path: projectPath, source: 'github', repo: 'futin/x', polledAt, access: 'ok', detail: null, connect: null }],
      },
    },
  };
}

/** A tracker run whose queue holds one bug, `3`, claimed at `preflight`.
 *  Returns the route table (so a case can rewrite one answer) alongside it. */
export function claimRoutes(project, over = {}) {
  let nextComment = 500;
  return {
    ...gateRoutes([apiItem(project, 3, { section: 'bugs' })], { 3: GROOMED_BUG_BODY }),
    '/api/items/claim': (body, _url, method) =>
      method === 'GET'
        ? { body: { commentId: 500, record: { v: 1, counters: { groomElapsed: 1, executeElapsed: 2, groomTokens: 3, executeTokens: 4 } } } }
        : { status: 201, body: { commentId: (nextComment += 1), record: { v: 1, session: body?.session, run: body?.run } } },
    '/api/items/heartbeat': { status: 201, body: { commentId: 500, record: { v: 1 } } },
    '/api/items/release': { status: 201, body: { commentId: 500, record: { v: 1 } } },
    '/api/items/state': { status: 201, body: { id: '#3', status: 'done', url: 'https://example.invalid/3' } },
    ...over,
  };
}

export const posts = (requests, route) => requests.filter((r) => r.method === 'POST' && r.path === `/api/items/${route}`);

export const MC_ID = 'task-1';

/** Runs `git -C <cwd> <args>` and throws on failure, so a fixture that cannot be built says so rather than testing nothing. */
export function gitOk(cwd, ...args) {
  const out = spawnSync('git', ['-C', cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${out.stderr}`);
  return out.stdout;
}

/**
 * A committed project with `src/a.ts`, `README.md` and one groomed task per id in `ids`, each with a `backlog/<id>`
 * worktree whose branch changes `src/a.ts`; a run initialised on `base` (a branch name that is created off `main` when
 * it is not `main`). The project root stays on `main` unless the case moves it.
 */
export function mergeCheckFixture(t, { base = 'main', ids = [MC_ID], branchTouches = ['src/a.ts'] } = {}) {
  const fx = basedFixture(t);
  fs.mkdirSync(path.join(fx.project, 'src'));
  fs.writeFileSync(path.join(fx.project, 'src', 'a.ts'), 'one\n');
  for (const id of ids) seedReadyTask(fx.project, id, `Item ${id}`);
  commitEverything(fx.project, 'seed src and tasks');
  if (base !== 'main') gitOk(fx.project, 'branch', base);
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project, '--base', base).status, 0);
  for (const id of ids) {
    const worktree = path.join(fx.project, '.worktrees', id);
    gitOk(fx.project, 'worktree', 'add', worktree, '-b', `backlog/${id}`, 'main');
    for (const rel of branchTouches) fs.writeFileSync(path.join(worktree, rel), `${id} changed ${rel}\n`);
    gitOk(worktree, 'add', '-A');
    gitOk(worktree, 'commit', '-q', '-m', `${id} work`);
  }
  return fx;
}

export function mergeCheck(fx, ...args) {
  return run(fx.project, fx.home, 'merge-check', ...args);
}

export function readRunJson(fx) {
  return JSON.parse(fs.readFileSync(runFile(fx.home, fx.project), 'utf8'));
}

export function stageOf(fx, id = MC_ID) {
  return readRunJson(fx).queue.find((q) => q.id === id).stage;
}

export function treeListing(project) {
  return gitOk(project, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function leftover(fx, ...args) {
  return run(fx.project, fx.home, 'leftover', ...args);
}

export function branchList(project) {
  return gitOk(project, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
}

export const INSPECT_ID = 'task-5';

export function inspectLogs(fx) {
  return path.join(fx.home, encodeURIComponent(fx.project), 'logs');
}

// A files-project run with a real linked worktree for `task-5`, a transcript at `<dir>/logs/task-5.jsonl`, and the item file in
// the worktree in the requested shape. The MAIN tree's copy is always put in the opposite shape, so reading it gives the wrong answer.
export function inspectFixture(t, { state, outcome, transcript = STREAM_USAGE }) {
  const fx = orchFixture(t);
  seedReadyTask(fx.project, INSPECT_ID, 'Some task');
  assert.equal(run(fx.project, fx.home, 'init', '--project', fx.project).status, 0);
  fx.worktree = addWorktree(fx.project, INSPECT_ID, `backlog/${INSPECT_ID}`);
  fx.logs = inspectLogs(fx);
  fs.mkdirSync(fx.logs, { recursive: true });
  if (transcript !== null) fs.copyFileSync(transcript, path.join(fx.logs, `${INSPECT_ID}.jsonl`));

  const shape = (tree, wantState, wantOutcome) => {
    const open = path.join(tree, 'backlog', 'tasks', 'open', `${INSPECT_ID}-fixture.md`);
    const done = path.join(tree, 'backlog', 'tasks', 'done', `${INSPECT_ID}-fixture.md`);
    if (wantState === 'done') {
      fs.mkdirSync(path.dirname(done), { recursive: true });
      fs.renameSync(open, done);
    }
    if (wantOutcome) fs.appendFileSync(wantState === 'done' ? done : open, '\n## Outcome\n\nVerification: pnpm test — 12 passed\n');
  };
  shape(fx.worktree, state, outcome);
  // The opposite shape in the main tree, so a read of the wrong tree is caught.
  shape(fx.project, state === 'done' ? 'open' : 'done', !outcome);
  return fx;
}

export function inspectCmd(fx, ...args) {
  return run(fx.project, fx.home, 'inspect', ...args);
}

export function inspectOut(out) {
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  return JSON.parse(out.stdout.trim());
}

export async function trackerInspect(t, outcomeText) {
  const { home, project } = trackerFixture(t);
  const dir = path.join(home, encodeURIComponent(project));
  const { out } = await withApi(claimRoutes(project), async (port) => {
    assert.equal((await runApi(project, home, port, 'init', '--project', project)).status, 0);
    fs.mkdirSync(path.join(dir, 'outcomes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.copyFileSync(STREAM_USAGE, path.join(dir, 'logs', '3.jsonl'));
    if (outcomeText !== null) fs.writeFileSync(path.join(dir, 'outcomes', '3.md'), outcomeText);
    return runApi(project, home, port, 'inspect', '3');
  });
  return { out, dir, home, project };
}
