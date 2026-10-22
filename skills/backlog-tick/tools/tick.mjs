#!/usr/bin/env node
// tick: pick at most ONE unit of backlog work per scheduled tick — an execute of a ready bug or task, or a groom of an ungroomed bug or a refactor —
// when nothing else is in this project's pipeline, and remember what each tick did so a failure is not retried until the item changes.
//
//   tick.mjs decide [--max-prs M] [--max-plans N] [--base <ref>] [--lock-ttl <minutes>] [--dry-run]
//   tick.mjs record <id> ok|failed --kind groom|execute [--reason <text>]
//   tick.mjs status [--json]
//   tick.mjs forget <id>
//
// `decide` prints ONE JSON line and exits 0 for every verdict — `execute`, `groom`, `recover`, `busy`, `idle` — because a verdict is an answer, not a
// failure: the `backlog-tick` skill reads it and acts. Exit 1 is a usage error; exit 2 is the tool itself failing (an unreadable `state.json`, say), which
// the skill must stop on rather than read as "nothing to do"; exit 3 is `record` finding the lock held under another id — the outcome written, the lock left
// (see `cmdRecord`). The design is docs/superpowers/specs/2026-10-22-backlog-tick-design.md; this header keeps only what the code needs.
//
// What this file never does, each for a reason worth keeping:
//   - **It never writes git.** Every git call is a read (`rev-parse`, `show`, `ls-tree`, `show-ref`, `symbolic-ref`, `worktree list`). The tick's
//     units do their own git — execute's `pr` finish owns its branch and worktree — and a scheduler that also wrote git would be a second hand on the
//     same refs.
//   - **It imports nothing from another skill's `tools/`, nor from `server/` or `shared/`**, and shells out to neither `orchestrate.mjs` nor `backlog.mjs`: an
//     install is a copy of whatever shipped, and a prune of one skill must never break another (CLAUDE.md Invariants). Every borrowed rule is a TWIN with a
//     comment naming its original, in `tick-lib.mjs` or below.
//   - **It never writes outside `tickHome()`.** The lock and `state.json` are `tick-state.mjs`'s, and only there.
//
// Async on purpose, and safe to end with `process.exitCode = await main(...)` for the reason `backlog.mjs` and `jira.mjs` give (the skill-CLI exit invariant):
// every `fetch` is awaited to completion with `connection: close`, its timeout is an `AbortSignal.timeout` (an unref'd timer), and every child is `spawnSync`,
// so nothing holds the event loop open once `main` returns.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiBase, deriveGroomed, isMarked, orchHome, orderExecute, orderGroom, projectDir, projectSource, readFrontmatter, tickHome } from './tick-lib.mjs';
import {
  claimStaleLock,
  contentHash,
  dropClaim,
  forgetItem,
  isSkipped,
  lockSnapshot,
  readState,
  recordOutcome,
  releaseLock,
  restoreClaim,
  writeLock,
} from './tick-state.mjs';

const USAGE = `usage:
  tick.mjs decide [--max-prs M] [--max-plans N] [--base <ref>] [--lock-ttl <minutes>] [--dry-run]
  tick.mjs record <id> ok|failed --kind groom|execute [--reason <text>]
  tick.mjs status [--json]
  tick.mjs forget <id>`;

const DEFAULT_MAX_PRS = 2;
const DEFAULT_MAX_PLANS = 3;
// Three hours: comfortably above any sane job `timeout:`, so a lock this old belongs to a tick the dashboard killed (spec, "A tick the dashboard killed").
const DEFAULT_LOCK_TTL_MIN = 180;
const DEFAULT_BASE = 'main';

// The stack check is the one request with a deadline of its own: a tracker tick with the stack down must say `idle: stack down` promptly, not hang a
// scheduled step. Every other request gets a longer one only so a wedged server cannot hold a tick forever.
const HEALTH_TIMEOUT_MS = 2_000;
const API_TIMEOUT_MS = 15_000;

// Twin: `CLAIM_LIVE_MS` in shared/types.ts (`isLive`). A claim whose heartbeat is younger than this is a session at work; older, and the claim protocol retires
// it at the next claimant's `start`, so a tick may go ahead.
const CLAIM_LIVE_MS = 15 * 60 * 1000;

// `gh pr list`'s ceiling, asked for explicitly because gh's default is 30. A result that REACHES it may have been cut, so it cannot be a count.
const GH_PR_LIMIT = 500;

const MARKER = '[backlog-tick]';

// Twin: `SECTIONS` in skills/backlog/tools/backlog.mjs — the directory under `backlog/` and the id prefix its files carry.
const SECTION_PREFIX = { bugs: 'bug', ideas: 'idea', tasks: 'task', refactors: 'ref', 'out-of-scope': 'oos' };
const PREFIX_SECTION = Object.fromEntries(Object.entries(SECTION_PREFIX).map(([s, p]) => [p, s]));
const ALL_SECTIONS = Object.keys(SECTION_PREFIX);

// A files item id, as a NAME under `.worktrees/` — the orchestrator's `<root>/.worktrees/<id>` and execute's `<root>/.worktrees/execute-<id>` are the two
// tree kinds the busy scan skips, and nothing else under `.worktrees/` is.
const FILE_ITEM_ID = /^(?:bug|idea|task|ref|oos)-\d+$/;

// A ref the tool will put after `git show` and into the skill's args. Shaped narrowly on purpose: a leading `-` would be read by git as an option.
const REF_SHAPE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

class UsageError extends Error {}

const shown = (value) => (value === undefined ? 'nothing' : JSON.stringify(value));

// --- git (read-only) -----------------------------------------------------

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

// Twin: `resolveProjectRoot` in skills/backlog-orchestrate/tools/orchestrate.mjs — the nearest directory at or above the (resolved, NEVER realpath'd) cwd that
// holds a `.git` entry. Not `git rev-parse --show-toplevel`, which realpaths (`/var` → `/private/var` on macOS): the registry's `projectPath` and the run-state
// key are compared as raw strings everywhere in this app, and a realpath'd root would match neither. `null` where orchestrate throws — here "not a project" is
// a verdict, not an error.
function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The four ways a cwd is not a project a tick may work, in the brief's order, or `{ root, source }`. For `decide` a linked worktree is refused rather than
// resolved to its main tree: a tick's state, lock and run-state key are the MAIN checkout's, and a tick fired inside a linked worktree is a misconfigured job,
// not a request to work somewhere else.
//
// `followLinked` is the other three verbs' answer (C1 of the final review). `record` runs at the end of a tick whose execute ran `--finish pr`, and that skill
// runs every command as `cd <tree> && …` — in a main session the Bash tool's cwd persists, so the session comes back sitting in `.worktrees/execute-<id>`.
// Refused there, `record` exited 2, the lock stayed held for the whole `--lock-ttl` and the recovery then recorded the PR it opened as `killed at timeout`.
// The refusal's reason is about where a tick is FIRED, not where it is recorded, so `record`, `status` and `forget` follow a linked worktree to its main
// tree: the parent of the common git dir, which is what orchestrate.mjs's `linkedWorktreeInfo` names as `projectRoot` — and, like it, only when that
// common dir is a `.git` directory, since a bare main repo's parent is not a checkout of anything. The main tree is then resolved from scratch, without
// `followLinked`, so every other refusal still applies to it and a chain of pointers cannot loop. The path is git's own, not realpath'd here; `findRoot`'s
// root comes from `process.cwd()`, which is already the physical path, so the two agree on the key `decide` wrote the lock under.
function resolveProject(cwd, { followLinked = false } = {}) {
  const root = findRoot(cwd);
  if (root === null) return { idle: 'not a git repository' };
  const r = git(root, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (!r.ok) return { idle: 'not a git repository' };
  const [gitDir, commonDir] = r.stdout.trim().split('\n');
  if (path.resolve(root, gitDir) !== path.resolve(root, commonDir)) {
    const common = path.resolve(root, commonDir);
    if (!followLinked || path.basename(common) !== '.git') return { idle: 'not a main checkout' };
    return resolveProject(path.dirname(common));
  }
  const backlog = path.join(root, 'backlog');
  if (!fs.existsSync(backlog) || !fs.statSync(backlog).isDirectory()) return { idle: 'no backlog store' };
  const source = projectSource(root);
  if (source === 'unsupported') return { idle: 'unsupported backlog source' };
  return { root, source };
}

// `--base`, else the branch `origin/HEAD` points at, else `main`. The branch NAME, not `origin/<name>`: execute's worktree is cut from the local base, and
// that is what a candidate must be committed on.
function defaultBase(root) {
  const r = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const prefix = 'refs/remotes/origin/';
  const ref = r.stdout.trim();
  if (r.ok && ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
  return DEFAULT_BASE;
}

function commitOf(root, ref) {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() : null;
}

function branchExists(root, name) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok;
}

// The blob at `<ref>:<rel>`, or `null` when the ref or the path is absent there.
function blobAt(root, ref, rel) {
  const r = git(root, ['show', `${ref}:${rel}`]);
  return r.ok ? r.stdout : null;
}

// Every open item of `sections` as committed at `ref`: `{ id, section, rel }`. Used only to FIND a files item's blob at a recorded base when hashing a
// failure — `record` and a recovery have an id and a base, and the item may have moved on disk since. Never a candidate listing: `decide` lists off the
// working tree (`filesExecuteCandidate`), so an item rejected or archived on disk is not executed just because the move is not committed yet.
function itemsAtRef(root, ref, sections) {
  const dirs = sections.map((s) => `backlog/${s}/open`);
  const r = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...dirs]);
  if (!r.ok) return [];
  const out = [];
  for (const rel of r.stdout.split('\0')) {
    const parts = rel.split('/');
    if (parts.length !== 4) continue;
    const section = parts[1];
    const id = itemIdOf(section, parts[3]);
    if (id !== null) out.push({ id, section, rel });
  }
  return out;
}

// Twin: the `^<prefix>-<n>-` filename convention of `listOpenItems` in orchestrate.mjs and `openEntries` in backlog.mjs.
function itemIdOf(section, name) {
  const prefix = SECTION_PREFIX[section];
  if (prefix === undefined) return null;
  const m = new RegExp(`^(${prefix}-\\d+)-.*\\.md$`).exec(name);
  return m === null ? null : m[1];
}

// Every item in `<tree>/backlog/<section>/<state>/` for each section, off the working tree: `{ id, section, file }`.
function itemsOnDisk(tree, sections, state = 'open') {
  const out = [];
  for (const section of sections) {
    const dir = path.join(tree, 'backlog', section, state);
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const id = itemIdOf(section, name);
      if (id !== null) out.push({ id, section, file: path.join(dir, name) });
    }
  }
  return out;
}

// One files item in the working tree by id: its open copy, else its done copy, else `null`.
function fileOnDisk(root, id) {
  const section = PREFIX_SECTION[id.split('-')[0]];
  if (section === undefined) return null;
  for (const state of ['open', 'done']) {
    const hit = itemsOnDisk(root, [section], state).find((it) => it.id === id);
    if (hit) return hit.file;
  }
  return null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Execute's own id for a branch and a tree name: a files id as is (`bug-1`), a tracker id as the bare issue number (`#12` → `12`), because `#` opens a comment
// in every shell execute's commands are pasted into (skills/backlog-execute/references/pr-mode.md).
const executeId = (id) => id.replace(/^#/, '');

// --- the API -------------------------------------------------------------

// One GET. `{ ok, status, text }`, with every transport failure — refused, timed out, malformed base — as `ok: false, status: 0`: for a tick they all mean the
// same thing, that there is no answer to act on.
async function apiGet(route, timeoutMs = API_TIMEOUT_MS) {
  try {
    const res = await fetch(`${apiBase()}${route}`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

async function apiJson(route, timeoutMs) {
  const r = await apiGet(route, timeoutMs);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

// Twin: the tracker URN `gh:<owner/repo>#<n>` the server's GithubSource gives a tracker item's `path`, and that `orchestrate.mjs`'s `writeSnapshot` builds the
// same way. Used where only an id is in hand (`record`, a recovery); `decide` has the item and reads its `path`.
const trackerUrn = (repo, id) => `gh:${repo}#${executeId(id)}`;

async function issueBody(urn) {
  const r = await apiGet(`/api/items/body?path=${encodeURIComponent(urn)}`);
  return r.ok ? r.text : null;
}

// The marker's repo. `projectSource` has already validated it, so this read cannot fail on shape.
function markerRepo(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'backlog', 'source.json'), 'utf8')).repo;
}

// --- open execute PRs ----------------------------------------------------

// Every open PR whose head starts with `execute/` — hand-run `--finish pr` PRs included, because the cap is about the review pile, not who made it. `null` for
// every way the count cannot be trusted: no `gh`, a non-zero exit, output that is not a JSON list, or a list that reached the limit and may have been cut.
// The repo squash-merges, so a branch's merged state cannot be read from git alone, and no count is safer than a wrong one: execute is capped.
function openExecutePrs(root) {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', String(GH_PR_LIMIT), '--json', 'headRefName'], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length >= GH_PR_LIMIT) return null;
  return list.filter((pr) => pr && typeof pr.headRefName === 'string' && pr.headRefName.startsWith('execute/')).length;
}

// --- hashing -------------------------------------------------------------

// The text a hash is taken over, read at the moment it is called — never carried over from `decide` (controller ruling (a)): a tracker groom rewrites the issue
// body, and a later `decide` hashes the body as it is THEN, so `record` has to hash it after the session returned for the two to compare like with like.
//
//   files execute → the item's blob at `base` (absent → the empty string);
//   files groom   → the working-tree file (absent → the empty string);
//   tracker       → the issue body from `GET /api/items/body`; `undefined` when it cannot be read, so the record carries no hash and skips nothing — a
//                   failure the tool cannot fingerprint must not keep an item off the queue forever.
async function hashFor({ root, tracker, repo }, kind, id, base) {
  if (tracker) {
    const body = await issueBody(trackerUrn(repo, id));
    if (body === null) {
      process.stderr.write(`tick.mjs: could not read the body of ${id}; recorded without a hash\n`);
      return undefined;
    }
    return contentHash(body);
  }
  if (kind === 'execute') {
    const section = PREFIX_SECTION[id.split('-')[0]];
    const hit = section === undefined ? undefined : itemsAtRef(root, base, [section]).find((it) => it.id === id);
    return contentHash(hit === undefined ? '' : (blobAt(root, base, hit.rel) ?? ''));
  }
  const file = fileOnDisk(root, id);
  return contentHash(file === null ? '' : (readText(file) ?? ''));
}

// --- decide --------------------------------------------------------------

function intFlag(name, value, min) {
  if (value === undefined || !/^\d+$/.test(value)) throw new UsageError(`${name} needs a non-negative integer, got ${shown(value)}`);
  const n = Number(value);
  if (n < min) throw new UsageError(`${name} must be at least ${min}`);
  return n;
}

function parseDecide(argv) {
  const opts = { maxPrs: DEFAULT_MAX_PRS, maxPlans: DEFAULT_MAX_PLANS, base: null, lockTtl: DEFAULT_LOCK_TTL_MIN, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--max-prs') opts.maxPrs = intFlag(a, argv[++i], 0);
    else if (a === '--max-plans') opts.maxPlans = intFlag(a, argv[++i], 0);
    else if (a === '--lock-ttl') opts.lockTtl = intFlag(a, argv[++i], 1);
    else if (a === '--base') {
      const v = argv[++i];
      if (v === undefined || !REF_SHAPE.test(v)) throw new UsageError(`--base needs a ref, got ${shown(v)}`);
      opts.base = v;
    } else throw new UsageError(`decide: unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

async function cmdDecide(argv) {
  const opts = parseDecide(argv);
  const caps = { openPrs: null, maxPrs: opts.maxPrs, planReview: null, maxPlans: opts.maxPlans };
  // `root` rides every verdict — the main checkout this tick resolved, `null` before there is one — because the skill runs `record` and its `show` read-back
  // as `cd '<root>' && …`: an execute's `--finish pr` leaves the session's cwd inside `.worktrees/execute-<id>`, and a path printed here is the one place that
  // cwd can be undone from without the session reasoning about git.
  let root = null;
  const say = (verdict, reason, extra = {}) => {
    process.stdout.write(`${JSON.stringify({ verdict, reason, ...extra, root, caps, dryRun: opts.dryRun })}\n`);
    return 0;
  };

  // 1. Not a project.
  const proj = resolveProject(process.cwd());
  if (proj.idle) return say('idle', proj.idle);
  root = proj.root;
  const tracker = proj.source === 'github';
  const ctx = { root, tracker, repo: tracker ? markerRepo(root) : null };

  // 2. Stack check, tracker only — before the lock and before anything else, because every read and every unit the tick would start needs the API.
  if (tracker && !(await apiGet('/api/health', HEALTH_TIMEOUT_MS)).ok) return say('idle', 'stack down');

  // 3. The lock.
  const dir = projectDir(tickHome(), root);
  const now = Date.now();
  const snap = lockSnapshot(dir, now, opts.lockTtl * 60_000);
  if (snap.state === 'held') return say('busy', 'another tick');
  if (snap.state === 'stale') {
    const r = await recover(ctx, dir, snap, opts.dryRun);
    return say(r.verdict, r.reason, r.extra);
  }

  // The tracker's two reads, taken once: the runs (busy) and the items (busy, execute, groom). Either failing after a healthy `/api/health` is the stack
  // going away mid-tick, and reads the same as it being down. A files project asks for the runs only to see a board-started run, and only if the API answers
  // — with the stack down there is no board to have started one.
  const runs = await apiJson('/api/orchestrator/runs', tracker ? API_TIMEOUT_MS : HEALTH_TIMEOUT_MS);
  let mine = [];
  if (tracker) {
    const index = await apiJson('/api/items');
    if (runs === null || index === null || !Array.isArray(index.items)) return say('idle', 'stack down');
    // `projectPath`, never the display name: two checkouts of one repo share a name but never a path.
    mine = index.items.filter((it) => it && it.projectPath === root);
  }

  // 4. Busy.
  const busy = busyReason(ctx, runs, mine, now);
  if (busy !== null) return say('busy', busy);

  const state = readState(dir);
  const base = opts.base ?? defaultBase(root);

  // The plan-review count, always taken so `caps` reports it whichever way the tick goes.
  caps.planReview = tracker
    ? mine.filter((it) => it.status === 'open' && it.planReview === true).length
    : itemsOnDisk(root, ALL_SECTIONS).filter((it) => isMarked(readFrontmatter(readText(it.file) ?? '').fields['plan-review'])).length;

  // 5. Execute, when the review pile has room.
  caps.openPrs = openExecutePrs(root);
  let executeWhy;
  let pick = null;
  if (caps.openPrs === null) executeWhy = 'cannot count open PRs';
  else if (caps.openPrs >= opts.maxPrs) executeWhy = `${caps.openPrs} open execute PRs (cap ${opts.maxPrs})`;
  else {
    pick = tracker ? await trackerExecuteCandidate(ctx, mine, state) : filesExecuteCandidate(ctx, base, state);
    if (pick === null) executeWhy = 'no ready bug or task';
  }
  if (pick !== null) {
    const args = `${pick.id} --finish pr${opts.base === null ? '' : ` --base ${opts.base}`} ${MARKER}`;
    return act(dir, ctx, base, now, opts, say, { kind: 'execute', id: pick.id, reason: `execute ${pick.id}`, skill: 'backlog-execute', args });
  }

  // 6. Groom, when the plan-review pile has room.
  let groomWhy;
  let groom = null;
  if (caps.planReview >= opts.maxPlans) groomWhy = `${caps.planReview} plans awaiting review (cap ${opts.maxPlans})`;
  else {
    groom = tracker ? await trackerGroomCandidate(mine, state) : filesGroomCandidate(ctx, state);
    if (groom === null) groomWhy = 'no ungroomed bug or refactor';
  }
  if (groom !== null) {
    const args = groom.section === 'bugs' ? `${groom.id}, plan the fix ${MARKER}` : `${groom.id}, promote it to a task ${MARKER}`;
    const reason = `groom ${groom.id} (execute: ${executeWhy})`;
    return act(dir, ctx, base, now, opts, say, { kind: 'groom', id: groom.id, reason, skill: 'backlog-groom', args });
  }

  // 7. Nothing.
  return say('idle', `nothing to do: ${executeWhy}; ${groomWhy}`);
}

// 8. Take the lock and hand out the unit. A dry run takes nothing. `false` from `writeLock` is a second tick that got there between this one's read and its
// write: it holds the lock now, and this tick stands down.
function act(dir, ctx, base, now, opts, say, unit) {
  if (!opts.dryRun) {
    // The base COMMIT, not its name (tick-state.mjs's `Lock`): `record` and a recovery hash the blob at the commit `decide` read, so an item committed between
    // the two cannot make a failure look like one on the new text.
    const lock = { host: os.hostname(), verdict: { kind: unit.kind, id: unit.id }, base: commitOf(ctx.root, base) ?? base, at: new Date(now).toISOString() };
    if (!writeLock(dir, lock)) return say('busy', 'another tick');
  }
  return say(unit.kind, unit.reason, { id: unit.id, skill: unit.skill, args: unit.args });
}

// Step 4, each signal with its own reason, first match wins. `null` when nothing is in the pipeline.
function busyReason({ root, tracker, repo }, runs, mine, now) {
  // Twin: `runFilePath` in orchestrate.mjs — `<orchHome>/<project-key>/run.json`. A file that cannot be read is a run until proven otherwise: a tick that
  // read it as absent could start work under a live run, and the run file is written atomically, so unreadable means something is wrong there to look at.
  const runFile = path.join(projectDir(orchHome(), root), 'run.json');
  if (fs.existsSync(runFile)) {
    let run;
    try {
      run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch {
      return 'orchestrator run file unreadable';
    }
    if (run && (run.status === 'running' || run.status === 'paused')) return `orchestrator run ${run.status}`;
  }
  if (runs !== null && Array.isArray(runs.starting) && runs.starting.some((s) => s && s.project === root)) return 'orchestrator run starting';
  if (tracker && runs !== null && Array.isArray(runs.remote)) {
    const live = runs.remote.some((r) => r && r.fresh === true && r.repo === repo && (r.status === 'running' || r.status === 'paused'));
    if (live) return 'remote run';
  }
  if (!tracker) return startedMarker(root);
  for (const it of mine) {
    const beat = it.holder && typeof it.holder.heartbeat === 'string' ? Date.parse(it.holder.heartbeat) : Number.NaN;
    if (!Number.isNaN(beat) && now - beat < CLAIM_LIVE_MS) return `live claim on ${it.id}`;
  }
  return null;
}

// Any open item with a non-empty `started:`, in the main checkout or in a linked worktree — an in-place groom or execute in a linked worktree writes its marker
// there. Two kinds of tree are skipped: the orchestrator's `<root>/.worktrees/<id>` (its run file speaks for it) and execute's `<root>/.worktrees/execute-<id>`
// (the candidate exclusion and the lock speak for it, and a killed execute there would otherwise block the project for good).
function startedMarker(root) {
  const inTree = (tree) => itemsOnDisk(tree, ALL_SECTIONS).find((it) => readFrontmatter(readText(it.file) ?? '').fields.started);
  const main = inTree(root);
  if (main) return `started marker on ${main.id}`;
  const r = git(root, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return null;
  const trees = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
  // The first entry is the main checkout, scanned above. Its path is compared under both spellings of the root: git may print the path it was given or the
  // one it resolved, and on macOS those differ by `/private`.
  const roots = [root];
  try {
    roots.push(fs.realpathSync(root));
  } catch {
    // the root exists — it was just found — so this is belt and braces
  }
  for (const tree of trees.slice(1)) {
    if (roots.some((r0) => isSkippedTree(r0, tree))) continue;
    const hit = inTree(tree);
    if (hit) return `started marker on ${hit.id} in ${tree}`;
  }
  return null;
}

function isSkippedTree(root, tree) {
  const rel = path.relative(root, tree).split(path.sep);
  if (rel.length !== 2 || rel[0] !== '.worktrees') return false;
  const name = rel[1].startsWith('execute-') ? rel[1].slice('execute-'.length) : rel[1];
  return FILE_ITEM_ID.test(name);
}

const executeTaken = (root, id) => branchExists(root, `execute/${executeId(id)}`) || fs.existsSync(path.join(root, '.worktrees', `execute-${executeId(id)}`));

// Files: LISTED off the working tree's `open/`, READ at `<base>` — the shape of orchestrate.mjs's `listOpenItems` plus its `<base>` read. Both halves are a
// veto. The listing is the working tree's because a groom's rejection or archive is uncommitted by design: an item moved out of `open/` on disk is decided
// against, and listing at `<base>` would execute it anyway. The bytes are `<base>`'s because they are what execute's worktree will hold — `groomed`,
// `runner-fix`, `plan-review` and the hash all come off that blob, so a `plan-review:` line deleted only on disk is not an approval yet, and an item with no
// blob at `<base>` (never committed there) is not a candidate. There is no files `in-review` marker; that guard is a tracker label.
function filesExecuteCandidate({ root }, base, state) {
  const items = [];
  for (const it of itemsOnDisk(root, ['bugs', 'tasks'])) {
    const rel = path.relative(root, it.file).split(path.sep).join('/');
    const text = blobAt(root, base, rel);
    if (text === null) continue;
    const { fields, body } = readFrontmatter(text);
    const groomed = deriveGroomed(it.section, body);
    items.push({ ...it, text, groomed, runnerFix: isMarked(fields['runner-fix']), planReview: isMarked(fields['plan-review']) });
  }
  for (const it of orderExecute(items)) {
    if (it.groomed !== true || it.planReview) continue;
    if (executeTaken(root, it.id)) continue;
    if (isSkipped(state.items[it.id], contentHash(it.text), 'execute')) continue;
    return it;
  }
  return null;
}

// Tracker: the API's own rows for this project. The body is fetched only for an issue that passed every other check, and one whose body cannot be read is
// passed over this tick — its failure record cannot be checked against it.
async function trackerExecuteCandidate({ root }, mine, state) {
  const items = mine
    .filter((it) => it.status === 'open' && (it.section === 'bugs' || it.section === 'tasks'))
    .map((it) => ({ ...it, runnerFix: it.runnerFix === true }));
  for (const it of orderExecute(items)) {
    if (it.groomed !== true || it.planReview === true || it.inReview === true) continue;
    if (executeTaken(root, it.id)) continue;
    const body = await issueBody(it.path);
    if (body === null) continue;
    if (isSkipped(state.items[it.id], contentHash(body), 'execute')) continue;
    return it;
  }
  return null;
}

// Files: the WORKING TREE, where step 5 read `<base>` — a tick's groom is uncommitted by design, so a `<base>` read would still see last night's bug as
// ungroomed and groom it again.
function filesGroomCandidate({ root }, state) {
  const items = [];
  for (const it of itemsOnDisk(root, ['bugs', 'refactors'])) {
    const text = readText(it.file);
    if (text === null) continue;
    const { fields, body } = readFrontmatter(text);
    if (fields.started) continue;
    if (it.section === 'bugs' && deriveGroomed('bugs', body) !== false) continue;
    items.push({ ...it, text });
  }
  for (const it of orderGroom(items)) {
    if (isSkipped(state.items[it.id], contentHash(it.text), 'groom')) continue;
    return it;
  }
  return null;
}

async function trackerGroomCandidate(mine, state) {
  const items = mine.filter((it) => it.status === 'open' && ((it.section === 'bugs' && it.groomed === false) || it.section === 'refactors'));
  for (const it of orderGroom(items)) {
    const body = await issueBody(it.path);
    if (body === null) continue;
    if (isSkipped(state.items[it.id], contentHash(body), 'groom')) continue;
    return it;
  }
  return null;
}

// --- recover -------------------------------------------------------------

// A stale lock is a tick the dashboard killed (or a step that ran out of turns). Its verdict is recorded `failed`, `killed at timeout`, and the lock released
// — and nothing else this tick: one unit per tick, and the recovery is this one's.
//
// The lock is CLAIMED, not removed (controller ruling (b) on Task 7): `claimStaleLock` renames it aside atomically and owns it only if the bytes it got are
// the bytes judged stale, so two ticks racing to recover one lock — or one recovering while another has just written a fresh lock — cannot both act. Losing
// that race is `busy: another tick`. A dry run claims nothing.
//
// `stop` asks the skill to run `backlog.mjs stop <id> --abandon`, and is true only where the marker is provably the dead tick's own: a files project, a groom
// verdict, and the item in the main checkout carrying `started:` with `phase: groom`. An execute's marker lives in its own `.worktrees/execute-<id>`, which
// the busy scan skips; a tracker claim goes stale on its own and the next `start` retires it.
async function recover(ctx, dir, snap, dryRun) {
  const v = snap.lock && snap.lock.verdict;
  const usable = v && typeof v.id === 'string' && v.id !== '' && (v.kind === 'execute' || v.kind === 'groom');
  if (!usable) {
    if (!dryRun) {
      const claimed = claimStaleLock(dir, snap.raw);
      if (claimed === null) return { verdict: 'busy', reason: 'another tick' };
      dropClaim(claimed);
    }
    return { verdict: 'recover', reason: 'removed an unreadable lock', extra: { stop: false } };
  }
  const { id, kind } = v;
  let stop = false;
  if (!ctx.tracker && kind === 'groom') {
    const file = fileOnDisk(ctx.root, id);
    const fields = file === null ? {} : readFrontmatter(readText(file) ?? '').fields;
    stop = Boolean(fields.started) && fields.phase === 'groom';
  }
  if (!dryRun) {
    const claimed = claimStaleLock(dir, snap.raw);
    if (claimed === null) return { verdict: 'busy', reason: 'another tick' };
    try {
      const base = typeof snap.lock.base === 'string' && snap.lock.base !== '' ? snap.lock.base : defaultBase(ctx.root);
      const hash = await hashFor(ctx, kind, id, base);
      recordOutcome(dir, id, { outcome: 'failed', kind, reason: 'killed at timeout', at: new Date().toISOString(), ...(hash === undefined ? {} : { hash }) });
    } catch (e) {
      // Nothing was recorded: put the lock back, so the next tick tries the recovery again rather than losing it.
      restoreClaim(dir, claimed);
      throw e;
    }
    dropClaim(claimed);
  }
  return { verdict: 'recover', reason: `recovered a killed ${kind} on ${id}`, extra: { id, stop } };
}

// --- record --------------------------------------------------------------

function parseRecord(argv) {
  const [id, outcome, ...rest] = argv;
  if (!id || id.startsWith('--')) throw new UsageError('record needs an item id');
  if (outcome !== 'ok' && outcome !== 'failed') throw new UsageError(`record: the outcome is ok or failed, got ${shown(outcome)}`);
  let kind = null;
  let reason = '';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--kind') kind = rest[++i];
    else if (a === '--reason') {
      reason = rest[++i];
      if (reason === undefined) throw new UsageError('--reason needs a text');
    } else throw new UsageError(`record: unknown argument ${JSON.stringify(a)}`);
  }
  if (kind !== 'groom' && kind !== 'execute') throw new UsageError('record needs --kind groom|execute');
  return { id, outcome, kind, reason };
}

// The key `decide` reads an item's record under: its API id, `#12`, for a tracker issue. A hand-typed `record 12` or `forget 12` would otherwise write or look
// for `12`, a key no `decide` ever reads — a failure recorded there would skip nothing, and a `forget` would find nothing to forget.
const stateKey = ({ tracker }, id) => (tracker && /^\d+$/.test(id) ? `#${id}` : id);

// `record`, `status` and `forget`: a linked worktree resolves to its main checkout (`followLinked`, above); only `decide` refuses one.
function requireProject() {
  const proj = resolveProject(process.cwd(), { followLinked: true });
  if (proj.idle) throw new Error(`${proj.idle} — run this from the project's main checkout`);
  const tracker = proj.source === 'github';
  return { root: proj.root, tracker, repo: tracker ? markerRepo(proj.root) : null };
}

// Writes the outcome — with the hash, for `failed`, taken NOW — and releases the lock if it is this id's. The `<base>` a files execute is hashed at is the one
// the lock recorded; with no lock for this id (another tick already recovered it), it is resolved as `decide` resolves it without `--base`, and stderr says so.
async function cmdRecord(argv) {
  const parsed = parseRecord(argv);
  const ctx = requireProject();
  const { outcome, kind, reason } = parsed;
  const id = stateKey(ctx, parsed.id);
  const dir = projectDir(tickHome(), ctx.root);
  const lock = lockSnapshot(dir, Date.now(), Number.POSITIVE_INFINITY).lock;
  const ours = Boolean(lock && lock.verdict && lock.verdict.id === id);

  let hash;
  if (outcome === 'failed') {
    let base = ours && typeof lock.base === 'string' && lock.base !== '' ? lock.base : null;
    if (base === null && !ctx.tracker && kind === 'execute') {
      base = defaultBase(ctx.root);
      process.stderr.write(`tick.mjs: no lock for ${id}; hashing ${id} at the default base ${base}\n`);
    }
    hash = await hashFor(ctx, kind, id, base ?? defaultBase(ctx.root));
  }
  recordOutcome(dir, id, { outcome, kind, reason, at: new Date().toISOString(), ...(hash === undefined ? {} : { hash }) });

  const released = releaseLock(dir, id);
  process.stdout.write(`recorded ${id} ${outcome} (${kind})${released ? '; lock released' : ''}\n`);
  // Exit 3 when the lock names ANOTHER id (I3 of the final review). The record above stands — it is the outcome the caller saw — and the lock stays, because
  // it may be a live tick's. But the usual way here is the skill recording the wrong id: a promote prints a new task id, and recording that one left the
  // refactor's lock held for the whole `--lock-ttl` with exit 0, so the skill's "non-zero means stop" rule never fired and nothing reached the run log. No lock
  // at all (another tick already recovered it) and an unreadable one name no id, and stay 0.
  if (!released && lock && lock.verdict && typeof lock.verdict.id === 'string') {
    process.stderr.write(`tick.mjs: the lock is ${lock.verdict.id}'s, not ${id}'s; left in place\n`);
    return 3;
  }
  return 0;
}

// --- status and forget ---------------------------------------------------

function cmdStatus(argv) {
  const json = argv.length === 1 && argv[0] === '--json';
  if (!json && argv.length > 0) throw new UsageError(`status: unknown argument ${JSON.stringify(argv[0])}`);
  const { root } = requireProject();
  const dir = projectDir(tickHome(), root);
  const snap = lockSnapshot(dir, Date.now(), Number.POSITIVE_INFINITY);
  const lock = snap.state === 'free' ? null : Object.keys(snap.lock).length === 0 ? { unreadable: true } : snap.lock;
  const recent = [...readState(dir).recent].reverse();
  if (json) {
    process.stdout.write(`${JSON.stringify({ lock, recent })}\n`);
    return 0;
  }
  const lines = [];
  if (lock === null) lines.push('no lock');
  else if (lock.unreadable) lines.push('lock: unreadable');
  else lines.push(`lock: ${lock.verdict?.kind ?? '?'} ${lock.verdict?.id ?? '?'} on ${lock.host ?? '?'} since ${lock.at ?? '?'}`);
  if (recent.length === 0) lines.push('no outcomes recorded');
  for (const e of recent) lines.push(`${e.at}  ${e.outcome.padEnd(6)}  ${e.kind.padEnd(7)}  ${e.id}${e.reason ? `  ${e.reason}` : ''}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// The escape hatch for a failure that was the environment's fault: the item's record goes, so the next tick may pick it again. History stays.
function cmdForget(argv) {
  if (argv.length !== 1 || argv[0].startsWith('--')) throw new UsageError('forget needs exactly one item id');
  const ctx = requireProject();
  const id = stateKey(ctx, argv[0]);
  if (!forgetItem(projectDir(tickHome(), ctx.root), id)) {
    process.stderr.write(`tick.mjs: nothing recorded for ${id}\n`);
    return 1;
  }
  process.stdout.write(`forgot ${id}\n`);
  return 0;
}

// --- main ----------------------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'decide') return await cmdDecide(rest);
    if (cmd === 'record') return await cmdRecord(rest);
    if (cmd === 'status') return cmdStatus(rest);
    if (cmd === 'forget') return cmdForget(rest);
    throw new UsageError(cmd === undefined ? 'no command' : `unknown command ${JSON.stringify(cmd)}`);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`tick.mjs: ${e.message}\n${USAGE}\n`);
      return 1;
    }
    process.stderr.write(`tick.mjs: ${e.message}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
