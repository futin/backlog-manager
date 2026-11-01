// `usage` and `fix-mode`, worktree removal, a --json payload past the pipe buffer, and the run-scoped base.
// orchestrate.mjs's suite is split across the orchestrate*.test.mjs files beside it, because `node --test` runs files in parallel and the tests inside one
// file one after another (#390). The shared harness is orchestrate-test-lib.mjs. A new case goes into the file for its topic; a file that grows past ~60 s
// on an idle run is split again rather than grown — docs/subsystems/invariants.md, "Where a test file sits decides which runner executes it".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readSessionUsage
} from './orchestrate.mjs';
import {
  SCRIPT,
  STREAM_NO_RESULT,
  STREAM_USAGE,
  STREAM_USAGE_NO_NUMBERS,
  basedFixture,
  commitEverything,
  git,
  orchFixture,
  queueItem,
  run,
  runAs,
  runFile,
  seedReadyTask,
  transcriptAs
} from './orchestrate-test-lib.mjs';

// A copy, not an import from orchestrate-test-lib.mjs: scripts/ci-scope.mjs picks the suites a docs-only PR runs by the doc paths each
// SUITE names, so a doc path only the lib spelled would let a docs PR skip the guards in this file that read it.
const SKILL_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');

// --- task-27: `usage`, the one writer of RunQueueItem.usage ---------------
//
// Every dispatched session's own `result` event already carries what the run
// cost; nothing copied it anywhere, so "what did this run cost" meant parsing
// 43MB of transcripts with a purpose-written script. These tests pin the copy.
const STREAM_USAGE_FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-fix.jsonl');
const STREAM_MALFORMED_THEN_USAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-malformed-then-usage.jsonl');
const STREAM_USAGE_TWO_MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-two-models.jsonl');

function usageRun(t, id = 'task-5', title = 'Some task') {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, id, title);
  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  return { home, project };
}

test('usage copies the result event onto the queue item and echoes the entry', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 1);
  const [entry] = entries;
  // The exact key set, not a spot-check: this shape is written into an
  // archive read months later, and a field silently dropped by a future edit
  // is invisible in every other assertion here. `loop` is the thirteenth
  // field and is deliberately ABSENT on an `execute` entry — there is no loop
  // to count — which is why this list has twelve names; the fix-loop test
  // below is where the thirteenth appears.
  assert.deepEqual(Object.keys(entry).sort(), [
    'cacheCreationTokens',
    'cacheReadTokens',
    'costUsd',
    'durationMs',
    'endedAt',
    'inputTokens',
    'kind',
    'model',
    'outputTokens',
    'peakContextTokens',
    'sessionId',
    'turns'
  ]);
  assert.equal(entry.kind, 'execute');
  assert.equal(entry.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
  assert.equal(entry.costUsd, 2.641441);
  assert.equal(entry.turns, 34);
  assert.equal(entry.inputTokens, 208);
  assert.equal(entry.outputTokens, 52893);
  assert.equal(entry.cacheReadTokens, 15_155_855);
  assert.equal(entry.cacheCreationTokens, 204_362);
  assert.equal(entry.durationMs, 812_345);
  assert.equal(entry.model, 'claude-opus-5[1m]');
  assert.ok(Date.parse(entry.endedAt) > 0, 'endedAt is a parseable stamp');
  // The echo is what SKILL.md §5 reads back on the same Bash invocation.
  assert.deepEqual(JSON.parse(out.stdout), { id: 'task-5', usage: entry });
});

// The case the plan's own "idempotent by sessionId" rule would have got
// wrong: `claude -p --resume` keeps the session id it was handed, so a fix
// loop's transcript reports the SAME session as the first dispatch (verified
// against this machine's task-22/task-22-fix-1 pair). Keying on the session
// would have made this second call overwrite the first entry instead of
// sitting beside it — identity is the transcript slot, `kind` + `loop`.
test('a fix loop adds a second entry beside the first, same session id and all', (t) => {
  const { home, project } = usageRun(t);
  assert.equal(run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE, 'task-5.jsonl')).status, 0);
  const first = queueItem(home, project, 'task-5').usage[0];

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_FIX, 'task-5-fix-1.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], first, 'the execute entry was rewritten by the fix loop');
  assert.equal(entries[1].kind, 'fix');
  assert.equal(entries[1].loop, 1);
  assert.equal(entries[1].costUsd, 1.612241);
  assert.equal(entries[1].sessionId, entries[0].sessionId, 'the fixture pins the real shape: a resumed session keeps its id');
});

test('a retry transcript records its own kind and loop number', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_FIX, 'task-5-retry-2.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const [entry] = queueItem(home, project, 'task-5').usage;
  assert.equal(entry.kind, 'retry');
  assert.equal(entry.loop, 2);
});

// recovery.md tells a resumed driver to re-run this for any transcript whose
// entry is absent, and "absent" is a judgement it makes from a run file it
// did not write. Running it over one already recorded has to be harmless.
test('the same transcript twice leaves exactly one entry for that slot', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');
  assert.equal(run(project, home, 'usage', 'task-5', '--jsonl', file).status, 0);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  const entries = queueItem(home, project, 'task-5').usage;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].costUsd, 2.641441);
});

// A killed session. An absent entry is the honest record; a zero-valued one
// would claim the session was free, which is the reading a cost rollup would
// then print as fact.
test('a transcript with no result event writes nothing, says so, and exits 0', (t) => {
  const { home, project } = usageRun(t);
  const file = transcriptAs(t, STREAM_NO_RESULT, 'task-5.jsonl');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /task-5\.jsonl/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
  assert.equal(queueItem(home, project, 'task-5').usage, undefined);
});

test('usage on an unreadable transcript exits 1 and writes nothing', (t) => {
  const { home, project } = usageRun(t);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', path.join(project, 'task-5.jsonl'));

  assert.equal(out.status, 1);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

test('a line that is not JSON at all, ahead of the result event, is skipped rather than fatal', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_MALFORMED_THEN_USAGE, 'task-5.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  assert.equal(queueItem(home, project, 'task-5').usage[0].costUsd, 2.641441);
});

test('two models in one session join into one label, and the init event supplies a missing session id', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE_TWO_MODELS, 'task-5.jsonl'));

  assert.equal(out.status, 0, out.stderr);
  const [entry] = queueItem(home, project, 'task-5').usage;
  assert.equal(entry.model, 'claude-opus-5[1m], claude-haiku-4-5-20251001');
  assert.equal(entry.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
});

// The realistic way to name a file wrong is to hand this command ANOTHER
// item's transcript, which a silent default to `execute` would file against
// this item forever.
test('a transcript whose name matches none of the three shapes exits 1 and names the shapes', (t) => {
  const { home, project } = usageRun(t);
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = run(project, home, 'usage', 'task-5', '--jsonl', transcriptAs(t, STREAM_USAGE, 'task-6.jsonl'));

  assert.equal(out.status, 1);
  assert.match(out.stderr, /task-5-fix-<n>\.jsonl/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

test('usage with no --jsonl exits 1 and prints the usage line', (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'task-5');

  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage: orchestrate\.mjs usage/);
});

test("usage for an id that is not in this run's queue exits 1", (t) => {
  const { home, project } = usageRun(t);

  const out = run(project, home, 'usage', 'nope-9', '--jsonl', transcriptAs(t, STREAM_USAGE, 'nope-9.jsonl'));

  assert.equal(out.status, 1);
});

// It writes the run file, so it is bound by the lease exactly as `stage` is —
// unlike `denials`, which is deliberately run-independent because it writes
// nothing at all.
test('usage is refused with exit 7 when another session holds the driver lease', (t) => {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs('sess-a', project, home, 'init', '--project', project).status, 0);
  const file = transcriptAs(t, STREAM_USAGE, 'task-5.jsonl');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = runAs('sess-b', project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 7);
  assert.match(out.stderr, /sess-a/);
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// The structural half of task-27, and the same shape as the denials check
// above for the same reason: the two paths that run a headless session are
// step 5 and step 7's fix loop, and a call added to the first and forgotten
// on the second loses exactly the number this feature exists to keep — a fix
// loop is routinely the more expensive half of an item.
test('every step that runs a headless session records what it cost', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  for (const title of ['5. Inspect what the session left behind', '7. Review']) {
    assert.ok(sections.has(title), `section not found (renamed?): ${title}`);
    const body = sections.get(title).join('\n');
    assert.ok(
      body.includes('orchestrate.mjs" usage <id> --jsonl') || (title.startsWith('5.') && body.includes('orchestrate.mjs" inspect <id>')),
      `section "${title}" runs a headless session but never records what it cost`
    );
  }
});

// recovery.md, not SKILL.md: a resumed driver inherits a run file it did not
// write, and the usage entries the crashed one never got to are the one piece
// of a crashed run that decays on its own — the transcripts are pruned long
// before the run history is.
test('recovery.md tells a resumed driver to pick up the usage the crashed one missed', () => {
  const text = fs.readFileSync(path.join(path.dirname(SKILL_MD), 'references', 'recovery.md'), 'utf8');
  assert.ok(text.includes('orchestrate.mjs" usage <id> --jsonl'), 'recovery.md never re-runs `usage`');
});

// The reader on its own, the way readPermissionDenials is tested beside its
// own command: these two cases are about the transcript, not about the run
// file, and driving them through the CLI would make every assertion depend
// on a run existing first.
const STREAM_USAGE_TWO_RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stream-usage-two-results.jsonl');

test('readSessionUsage reads the LAST result event, so a resumed segment is not read as the whole session', () => {
  // readPermissionDenials' own reason restated: a `--resume` can append a
  // second result to the same transcript, and the first describes a segment
  // that already ended.
  const usage = readSessionUsage(STREAM_USAGE_TWO_RESULTS);
  assert.equal(usage.costUsd, 9.5);
  assert.equal(usage.turns, 40);
});

test('readSessionUsage returns null for a transcript with no result event, and holes for one with no numbers', () => {
  // The two shapes cmdUsage branches on. `null` means "write nothing" —
  // a killed session was not free. A result event whose fields a future CLI
  // renamed still earns an entry, with `null` in every slot it could not
  // fill: the session demonstrably ran, and a `0` would price it.
  assert.equal(readSessionUsage(STREAM_NO_RESULT), null);

  const holes = readSessionUsage(STREAM_USAGE_NO_NUMBERS);
  assert.equal(holes.sessionId, '7c3d9a10-2b48-4e6f-9a01-5d8e3f2c7b64');
  for (const field of ['costUsd', 'turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'durationMs', 'model']) {
    assert.equal(holes[field], null, `${field} was filled with something rather than left a hole`);
  }
});

// --- #226: each session's peak context, the number `fix-mode` gates on ------
//
// Defined exactly as the retro defines a session's `context.peak`
// (skills/backlog-retro/tools/lib/sessions.mjs): the largest input + cache
// read + cache creation over every assistant event carrying usage. One
// definition, so the runner and the retro can never disagree about which
// sessions were long.

// A transcript written line by line, so each case states its own numbers
// rather than leaning on a shared fixture nobody reads. `turns` are
// [input, cacheRead, cacheCreation] triples; `undefined` leaves a key out.
function peakTranscript(t, turns, name = 'task-5.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-peak-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [{ type: 'system', subtype: 'init', session_id: 'peak-sess' }];
  for (const [input, cacheRead, cacheCreation] of turns) {
    const usage = { output_tokens: 1 };
    if (input !== undefined) usage.input_tokens = input;
    if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
    if (cacheCreation !== undefined) usage.cache_creation_input_tokens = cacheCreation;
    lines.push({ type: 'assistant', message: { content: [], usage } });
  }
  lines.push({ type: 'result', subtype: 'success', session_id: 'peak-sess', total_cost_usd: 1, num_turns: turns.length, usage: {} });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('usage records the peak context over every assistant turn, not the last one', (t) => {
  const { home, project } = usageRun(t);
  const file = peakTranscript(t, [
    [10, 1000, 200],
    [5, 90000, 100],
    [3, 50000, 0]
  ]);

  const out = run(project, home, 'usage', 'task-5', '--jsonl', file);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(queueItem(home, project, 'task-5').usage[0].peakContextTokens, 90105);
  assert.equal(JSON.parse(out.stdout).usage.peakContextTokens, 90105, 'the echo line carries it too');
});

test('readSessionUsage counts a missing cache_creation_input_tokens as 0', (t) => {
  assert.equal(readSessionUsage(peakTranscript(t, [[7, 100, undefined]])).peakContextTokens, 107);
});

test('readSessionUsage leaves peakContextTokens null when no assistant event carries usage', () => {
  // The shared fixture's one assistant event has no `usage` at all — the
  // shape every transcript written before the CLI reported per-turn usage has.
  const usage = readSessionUsage(STREAM_USAGE);
  assert.equal(usage.peakContextTokens, null);
  assert.equal(usage.costUsd, 2.641441, 'every other field reads as it always did');
});

// --- #226: `fix-mode`, resume the last session or start a fresh fixer ----
//
// The decision SKILL.md §7 copies rather than computes. Every case here seeds
// the queue item's `usage` by hand, because what is under test is the choice
// over whatever `usage` recorded, not the recording (which the block above pins).

function fixModeRun(t, { usage, sessionId } = {}, sessionAs = 'sess-a') {
  const { home, project } = orchFixture(t);
  seedReadyTask(project, 'task-5', 'Some task');
  assert.equal(runAs(sessionAs, project, home, 'init', '--project', project).status, 0);
  const file = runFile(home, project);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = body.queue.find((q) => q.id === 'task-5');
  if (usage !== undefined) item.usage = usage;
  if (sessionId !== undefined) item.sessionId = sessionId;
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return { home, project };
}

function usageEntry(kind, sessionId, peak, loop) {
  const entry = {
    sessionId,
    kind,
    costUsd: 1,
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheCreationTokens: 1,
    durationMs: 1,
    model: null,
    endedAt: '2026-09-25T00:00:00.000Z'
  };
  if (peak !== undefined) entry.peakContextTokens = peak;
  if (loop !== undefined) entry.loop = loop;
  return entry;
}

function fixMode(t, seed) {
  const { home, project } = fixModeRun(t, seed);
  const out = run(project, home, 'fix-mode', 'task-5');
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('fix-mode resumes an execute session that peaked below the threshold', (t) => {
  assert.deepEqual(fixMode(t, { usage: [usageEntry('execute', 's1', 120000)] }), {
    id: 'task-5',
    mode: 'resume',
    from: 'execute',
    loop: null,
    sessionId: 's1',
    peak: 120000,
    threshold: 150000
  });
});

test('fix-mode starts fresh at exactly the threshold, and still echoes the session it declined', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1', 150000)] });
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, 's1');
  assert.equal(answer.peak, 150000);
});

// Review focus 2: after a fresh first loop the thing to resume is the first
// fixer, whose context is small — not the long execute session behind it.
test('fix-mode picks the last recorded entry, so a second loop resumes a fresh first fixer', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1', 240000), usageEntry('fix', 's2', 40000, 1)] });
  assert.equal(answer.mode, 'resume');
  assert.equal(answer.sessionId, 's2');
  assert.equal(answer.from, 'fix');
  assert.equal(answer.loop, 1);
});

// Review focus 1, assumption A2: an entry written before #226 has no peak,
// and the answer must be today's behaviour rather than a guess in the
// expensive direction.
test('fix-mode resumes when the entry predates peakContextTokens', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', 's1')] });
  assert.equal(answer.mode, 'resume');
  assert.equal(answer.peak, null);
  assert.equal(answer.sessionId, 's1');
});

test('fix-mode starts fresh when the entry has no session id to resume', (t) => {
  const answer = fixMode(t, { usage: [usageEntry('execute', null, 90000)] });
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, null);
});

test("fix-mode with no usage entries falls back to the item's own session id", (t) => {
  assert.deepEqual(fixMode(t, { sessionId: 's9' }), {
    id: 'task-5',
    mode: 'resume',
    from: 'execute',
    loop: null,
    sessionId: 's9',
    peak: null,
    threshold: 150000
  });
});

test('fix-mode with no usage and no session id starts fresh', (t) => {
  const answer = fixMode(t, {});
  assert.equal(answer.mode, 'fresh');
  assert.equal(answer.sessionId, null);
});

test('fix-mode refuses an unknown id, a missing id and a missing run', (t) => {
  const { home, project } = fixModeRun(t, {});

  const unknown = run(project, home, 'fix-mode', 'nope-9');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nope-9/);

  const bare = run(project, home, 'fix-mode');
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: orchestrate\.mjs fix-mode/);

  const empty = orchFixture(t);
  assert.equal(run(empty.project, empty.home, 'fix-mode', 'task-5').status, 3);
});

// Read-only, so no lease: a driver must be able to ask on a run another
// session leads (review focus 3 — a resumed driver gets the crashed one's answer).
test('fix-mode writes nothing and is not refused by another session holding the lease', (t) => {
  const { home, project } = fixModeRun(t, { usage: [usageEntry('execute', 's1', 200000)] }, 'sess-a');
  const before = fs.readFileSync(runFile(home, project), 'utf8');

  const out = runAs('sess-b', project, home, 'fix-mode', 'task-5');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).mode, 'fresh');
  assert.equal(fs.readFileSync(runFile(home, project), 'utf8'), before);
});

// --- bug-32: `git worktree remove` fails in two ways, not one -----------
//
// Two runs of this repo (run-20260903-112622 bug-14, run-20260905-213627
// task-19) paged a human over build output: the item merged green, the
// worktree removal printed `error: failed to delete '<path>': Directory not
// empty`, and §9's single refusal response recorded `attention … --kind
// parked`. That message is NOT git's clean check. Measured on git 2.50.1
// (Apple Git-155), and pinned by the last test in this block: the clean check
// refuses with `fatal: … contains modified or untracked files` and exit 128,
// having deleted nothing and unregistered nothing; a failed recursive delete
// exits 255 AFTER the clean check passed and AFTER the admin entry is gone,
// so the leftover directory is no longer a worktree at all. The two states
// need opposite responses — park the first, finish the second — and these
// cases exist to stop them collapsing back into one.

// Every line inside a ``` fence, trimmed: what a session actually runs, as
// opposed to prose that mentions a command in order to forbid it.
function fencedLinesOf(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line.trim());
  }
  return out;
}

// RETIRED with `cleanup` (see its block at the end of this file): the three pinned-text tests that stated the removal split in §9 and its one `rm -rf`.
// Their failure is now a behaviour test: cleanup 2, 3a, 3b and 3c.

test('`worktree remove --force` never enters a fenced block in any skill', () => {
  // §10's `--abort` mention is prose explaining why marker order matters,
  // and the forced form is legal there only because that path acts on a
  // worktree that is still registered. Nothing in the cleanup path may copy
  // it: after `failed to delete` the registration is already gone, so
  // `--force` answers `is not a working tree` and deletes nothing.
  const skills = fs.readdirSync(path.join(path.dirname(SKILL_MD), '..'));
  let checked = 0;
  for (const name of skills) {
    const file = path.join(path.dirname(SKILL_MD), '..', name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    checked += 1;
    const bad = fencedLinesOf(fs.readFileSync(file, 'utf8')).filter((l) => /worktree remove.*--force/.test(l));
    assert.deepEqual(bad, [], `${name}/SKILL.md runs a forced worktree remove:\n${bad.join('\n')}`);
  }
  assert.ok(checked >= 6, `expected to have read every skill body, read ${checked}`);
});

test('no attention detail template offers `worktree prune`', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8');

  // Both recorded occurrences told a human to run `git worktree prune` on a
  // worktree git had already deregistered. The instruction was a no-op twice.
  // (The other half of this test — that the failed-delete branch records no
  // attention entry — is cleanup 3b/3c now.)
  const prune = text.split('\n').filter((l) => l.includes('--kind parked') && l.includes('worktree prune'));
  assert.deepEqual(prune, [], `an attention detail template still advises worktree prune:\n${prune.join('\n')}`);
});

test('ATTENTION_KINDS is still exactly needs-answers, parked, fix-exhausted — no cleanup kind was invented', () => {
  // The fix is prose-only: no new kind, no new stage, no new run-file field.
  // Case 11 above proves the tool refuses a fourth kind; this proves the
  // list itself was not widened to admit one.
  const tool = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(
    tool.includes("const ATTENTION_KINDS = ['needs-answers', 'parked', 'fix-exhausted']"),
    'ATTENTION_KINDS is no longer the exact three-member list SKILL.md is written against'
  );
});

test('git worktree remove: ignored build output alone removes cleanly, and a failed delete deregisters first', (t) => {
  // The two assumptions the §9 prose rests on, measured rather than asserted,
  // because the prose tells an unattended session which commands are pointless
  // (`--force`, `prune`) in a state it cannot inspect afterwards.
  if (process.getuid?.() === 0) return t.skip('root ignores the 0555 bit the second case needs');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-wt-')));
  const repo = path.join(root, 'main');
  t.after(() => {
    // Restore the mode first or the temp tree itself cannot be deleted.
    fs.chmodSync(path.join(repo, 'wt-locked', 'src'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  // 1. Nothing but ignored build output — the shape the bug report blamed.
  //    It removes cleanly: `--force` was never the fix for what was observed.
  git('worktree', 'add', '-q', 'wt-dist', '-b', 'b-dist');
  fs.mkdirSync(path.join(repo, 'wt-dist', 'dist'));
  fs.writeFileSync(path.join(repo, 'wt-dist', 'dist', 'bundle.js'), 'x'.repeat(1000));
  const clean = git('worktree', 'remove', 'wt-dist');
  assert.equal(clean.status, 0, `ignored output blocked a plain remove: ${clean.stderr}`);
  assert.equal(fs.existsSync(path.join(repo, 'wt-dist')), false);

  // 2. A tracked, unmodified tree git cannot finish deleting: the clean check
  //    passes, the delete fails, and the admin entry is already gone.
  git('worktree', 'add', '-q', 'wt-locked', '-b', 'b-locked');
  fs.chmodSync(path.join(repo, 'wt-locked', 'src'), 0o555);
  const failed = git('worktree', 'remove', 'wt-locked');
  assert.notEqual(failed.status, 0, 'the locked child did not stop the delete');
  assert.match(failed.stderr, /failed to delete/, `expected a delete failure, got: ${failed.stderr}`);
  assert.doesNotMatch(failed.stderr, /contains modified or untracked files/, 'this is the clean check, not the delete');

  const listed = git('worktree', 'list', '--porcelain').stdout;
  assert.ok(!listed.includes('wt-locked'), `the worktree is still registered after a failed delete:\n${listed}`);

  const forced = git('worktree', 'remove', '--force', 'wt-locked');
  assert.equal(forced.status, 128, `a --force retry should be refused outright, got ${forced.status}: ${forced.stderr}`);
  assert.match(forced.stderr, /is not a working tree/);
});

// --- task-34: a --json payload larger than the pipe buffer -------------------

test('a status --json larger than the pipe buffer arrives whole', (t) => {
  const { home, project } = orchFixture(t);
  // `process.stdout.write` to a PIPE is asynchronous, so `process.exit()` in
  // the entry guard drops everything past the 64KB pipe buffer — silently, and
  // only through a pipe (a `> file.json` redirect is a synchronous write on
  // POSIX and never shows it). `run` is spawnSync, i.e. a real pipe, which is
  // the whole point of driving the CLI here instead of calling cmdStatus.
  // retro.mjs:396-407 carries the long-form record of the shipped incident.
  const count = 250;
  const title = (i) => `Queued item ${i} with a deliberately long ASCII title so that the printed run file comfortably outgrows the pipe buffer`;
  for (let i = 1; i <= count; i += 1) seedReadyTask(project, `task-${i}`, title(i));
  // Load-bearing: the gate reads each item at `<base>` through `git show`, so
  // an uncommitted item is skipped as ungroomed and would never reach the
  // queue — leaving a fixture that is small, green, and proves nothing.
  commitEverything(project, 'seed a queue big enough to outgrow the pipe buffer');

  assert.equal(run(project, home, 'init', '--project', project).status, 0);
  const out = run(project, home, 'status', '--json');

  assert.equal(out.status, 0, out.stderr);
  const bytes = Buffer.byteLength(out.stdout, 'utf8');
  assert.ok(bytes > 65536, `only ${bytes} bytes reached the pipe`);
  assert.equal(JSON.parse(out.stdout).queue.length, count);
});

// --- task-44: the run-scoped base -------------------------------------------
// `--base` used to be a queue gate and nothing else; it is now the ref item
// worktrees are cut from and finished items are merged INTO, so `init` has to
// prove it is a branch that can actually receive a merge, and has to record it
// where every later command (and every resumed session) reads it back.

test('init --base records an existing local branch in the run file', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/x'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/x');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/x');
});

test('init with no --base records "main"', (t) => {
  const { home, project } = basedFixture(t);

  const out = run(project, home, 'init', '--project', project);

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'main');
});

test('init --base accepts a branch with slashes and records it verbatim', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/a/b'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/a/b');

  assert.equal(out.status, 0, out.stderr);
  // Verbatim: nothing sanitises the RECORDED value. The sanitising in SKILL.md
  // §9 names a directory, and a base that came back as `feature-a-b` here
  // would be a ref that does not exist.
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/a/b');
});

// One case per refusal rather than a loop, so a failure names which input
// regressed. All six share the same three assertions: exit 1, the value echoed
// back, and — the half that matters most — NO run file written, because
// `cmdInit` archives any existing run before writing and a check that ran
// after that point would destroy a real run for a call that never succeeds.
for (const [label, value, why] of [
  ['a tag', 'v1.0.0', 'a tag cannot move, and a run merges into its base'],
  ['a 40-hex SHA', '0123456789012345678901234567890123456789', 'a commit is not a branch'],
  ['a remote-tracking ref', 'origin/main', 'passes check-ref-format and is caught only by show-ref'],
  ['a branch that does not exist', 'no-such-branch', 'a typo is a refusal, never a create'],
  ['an empty string', '', 'a flag whose argv slot is empty is a different mistake from a misspelled one'],
  ['a leading dash', '-x', 'must never reach git as an option']
]) {
  test(`init --base refuses ${label} — exit 1, nothing written (${why})`, (t) => {
    const { home, project } = basedFixture(t);
    // The tag is real, so this case proves the REF KIND is refused rather than
    // merely that the name is unknown — the trap a nonexistent-name-only test
    // would fall into.
    if (label === 'a tag') assert.equal(spawnSync('git', ['-C', project, 'tag', value], { encoding: 'utf8' }).status, 0);

    const out = run(project, home, 'init', '--project', project, '--base', value);

    assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stdout}${out.stderr}`);
    assert.ok(out.stderr.includes(JSON.stringify(value)), `the refusal does not name the offending value: ${out.stderr}`);
    assert.equal(fs.existsSync(runFile(home, project)), false, 'init wrote a run file for a base it refused');
  });
}

// #343: `check-ref-format --branch` accepts `$(…)`, so a branch named that exists and passed both earlier checks — and the driver pastes `<base>` unquoted
// into its shell templates. The branch is REAL here, so the refusal is proven to come from the shape check, not from show-ref.
test('init --base refuses an existing branch whose name a shell would expand — exit 1, nothing written', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feat$(id)'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feat$(id)');

  assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stdout}${out.stderr}`);
  assert.match(out.stderr, /"feat\$\(id\)" is not a valid branch name \(only letters, digits, \. _ \/ - are allowed\)/);
  assert.equal(fs.existsSync(runFile(home, project)), false, 'init wrote a run file for a base it refused');
});

test('init --base still accepts a branch made only of letters, digits, . _ / and -', (t) => {
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feat/x-1.2_y'], { encoding: 'utf8' }).status, 0);

  const out = run(project, home, 'init', '--project', project, '--base', 'feat/x-1.2_y');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feat/x-1.2_y');
});

test('init --base refuses a base that is neither a branch nor the branch HEAD is on, even in a repo with no commits', (t) => {
  // The narrow half of the unborn-HEAD allowance: a commitless repo accepts
  // the branch HEAD points at, and nothing else. Without this case the
  // allowance could widen to "any base in a commitless repo" and no test
  // would notice.
  const { home, project } = orchFixture(t);

  const out = run(project, home, 'init', '--project', project, '--base', 'feature/x');

  assert.equal(out.status, 1, `expected exit 1, got ${out.status}: ${out.stdout}${out.stderr}`);
  assert.equal(fs.existsSync(runFile(home, project)), false);
});

test('a run file written before task-44 has no base, and stage/heartbeat/attention neither need one nor add one', (t) => {
  const { home, project } = basedFixture(t);
  seedReadyTask(project, 'task-1', 'An item');
  assert.equal(run(project, home, 'init', '--project', project).status, 0);

  // Strip `base` back off, reproducing a run file this tool wrote before the
  // field existed — the state every archived run on every machine is in.
  const file = runFile(home, project);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete before.base;
  fs.writeFileSync(file, JSON.stringify(before));

  for (const args of [
    ['stage', 'task-1', 'preflight'],
    ['heartbeat'],
    ['attention', 'task-1', '--kind', 'parked', '--detail', 'a detail']
  ]) {
    const out = run(project, home, ...args);
    assert.equal(out.status, 0, `${args[0]} failed on a run file with no base: ${out.stderr}`);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Neither invents one. Resolving an absent base is the SERVER reader's job
    // and happens in exactly one place (`sanitizeMergeFields`); a tool that
    // wrote `main` back into the file would be a second writer of that
    // decision, and would rewrite history for a run that never chose it.
    assert.equal('base' in after, false, `${args[0]} wrote a base into a run file that had none`);
  }
});

test('claim leaves a recorded base alone — a resumed run does not fall back to main', (t) => {
  // `--resume` is a prose flow rather than a command (SKILL.md §10), and
  // `claim` is the one write it opens with, so this is where "a resumed run
  // keeps its base" is actually testable. Asserting the VALUE in the file
  // afterwards, not `claim`'s own output, is the point: the failure this
  // guards against is a later command re-deriving BASE_REF_DEFAULT.
  const { home, project } = basedFixture(t);
  assert.equal(spawnSync('git', ['-C', project, 'branch', 'feature/x'], { encoding: 'utf8' }).status, 0);
  assert.equal(run(project, home, 'init', '--project', project, '--base', 'feature/x').status, 0);

  const out = run(project, home, 'claim');

  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, project), 'utf8')).base, 'feature/x');
});
