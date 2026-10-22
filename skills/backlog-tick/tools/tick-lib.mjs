// What `tick.mjs` reads and derives, none of it written.
//
// Every function here that exists somewhere else in this repository is a TWIN, with a comment naming each original. That is the rule and not an oversight:
// a plugin skill's `tools/` may never import another skill's `tools/`, nor anything under `server/` or `shared/` (CLAUDE.md Invariants) — an install is a copy of
// whatever shipped, and a prune of one skill must never break another. `skills/backlog-retro/tools/lib/paths.mjs` is the pattern, and the twin guards
// (the `UNKNOWN` regex below against `parse.util.ts`, the Jira-branch rule against `shared/`) live in this directory's tests and in `test/agents-shared.test.ts`
// so a drift in an original fails a suite rather than a tick at 3 a.m.
//
// Nothing in this file writes a byte. The one thing under `tickHome()` that a tick owns is written by `tick-state.mjs`, and only there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- where things live ---------------------------------------------------

// `$BM_TICK_HOME` when set, else `~/.backlog-manager/tick/` — the override exists so a test process, or a developer poking at the tool by hand, never touches a
// real machine's tick state: the same escape hatch `BM_ORCH_HOME` and `BM_RETRO_HOME` give their tools.
export function tickHome() {
  return process.env.BM_TICK_HOME || path.join(os.homedir(), '.backlog-manager', 'tick');
}

// Twin: `orchHome()` in skills/backlog-orchestrate/tools/orchestrate.mjs (and the server's copy in server/src/orchestrator/). Read-only from here — a tick asks
// the orchestrator's run-state directory whether a run is live and never writes under it.
export function orchHome() {
  return process.env.BM_ORCH_HOME || path.join(os.homedir(), '.backlog-manager', 'orchestrator');
}

// Twin: `projectDir()` in skills/backlog-orchestrate/tools/orchestrate.mjs. The project key is `encodeURIComponent(<abs main-checkout path>)`, reversible and a
// single path SEGMENT — `encodeURIComponent` turns every `/` into `%2F`, which is what makes it safe to join under a root without recreating the project's whole
// directory tree. The tick's own directory uses the same key as the orchestrator's, so one project is one name in both homes.
export function projectDir(root, project) {
  return path.join(root, encodeURIComponent(project));
}

// Twin: `apiBase()` in skills/backlog/tools/backlog.mjs. `BM_API_PORT` is the same variable compose reads, so a stack on a non-default port needs no second
// setting for the skills; `4322` is this app's API port (CLAUDE.md, Ports) and moves the HOST side only.
export function apiBase() {
  return `http://127.0.0.1:${process.env.BM_API_PORT || '4322'}`;
}

// --- the project's source ------------------------------------------------

// Same shape the server validates before interpolating a repo into a GitHub URL path, and `backlog.mjs`'s `REPO_SHAPE` is its twin: exactly one slash, each half
// limited to what GitHub allows in a login or a repository name.
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Twin: `sourceMode()` in skills/backlog/tools/backlog.mjs, and `resolveSource` in the server, which it restates. Three answers: `files` for no marker and for an
// explicit `{"kind":"files"}`; `github` for a github marker with a usable repo; `unsupported` for EVERYTHING else — an unreadable file, a non-object, another
// kind, a github marker whose repo is malformed. The load-bearing negative is theirs too: an unreadable marker is never read as `files`, because a tick that fell
// back would groom or execute against item files in a project whose items live on a tracker, on one machine, where nothing would report it.
//
// `root` is the project's main checkout. Read per call and cached nowhere, as every other reader of the marker is.
export function projectSource(root) {
  const marker = path.join(root, 'backlog', 'source.json');
  if (!fs.existsSync(marker)) return 'files';
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    return 'unsupported';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unsupported';
  if (parsed.kind === 'files') return 'files';
  if (parsed.kind === 'github' && typeof parsed.repo === 'string' && REPO_SHAPE.test(parsed.repo)) return 'github';
  return 'unsupported';
}

// --- frontmatter ---------------------------------------------------------

// The narrow `key: value` splitter. Twin of the loop inside `parseItemForGate` in skills/backlog-orchestrate/tools/orchestrate.mjs (and of `parseFrontmatter` in
// server/src/items/parse.util.ts, minus its `status:` ban and its `tags` list — a tick reads markers, it does not validate a file): a line is split at its FIRST
// colon, the key and the value are each trimmed, and a line with no colon is skipped. `fields` keeps the value as written, so a bare `runner-fix:` is `''` and
// `isMarked` can still tell it from an absent key.
//
// Text that does not open with a `---` line has no frontmatter: it is all body, which is what a tracker item's body is. A frontmatter with no closing `---`
// yields the fields read so far and an empty body, exactly as `parseItemForGate` does.
export function readFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { fields: {}, body: text };
  const fields = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const sep = lines[i].indexOf(':');
    if (sep === -1) continue;
    fields[lines[i].slice(0, sep).trim()] = lines[i].slice(sep + 1).trim();
  }
  if (i === lines.length) return { fields, body: '' };
  return { fields, body: lines.slice(i + 1).join('\n') };
}

// The presence rule `runner-fix:` and `plan-review:` are both read by (`parseItemForGate` in orchestrate.mjs, `parseItemForGate` in backlog.mjs): a key with any value
// but `false` marks the item. Absent is unmarked. Only `false` opts out — trimmed and case-insensitive, because `False` and `FALSE` are the same YAML boolean a
// human meant to write — and `yes`, `true` and a bare key all mark. The reason is the failure each marker exists to prevent: a `plan-review: yes` that silently
// did not gate would let an unreviewed plan run.
export function isMarked(value) {
  if (value === undefined) return false;
  return value.trim().toLowerCase() !== 'false';
}

// --- groomed -------------------------------------------------------------

// Twin: `sectionText` in server/src/items/parse.util.ts. The text under one `## Heading`, up to the next `## ` line or end of body, trimmed; case-insensitive on
// the heading; `''` for a missing heading and an empty section alike — callers cannot tell the two apart, and for grooming they mean the same.
function sectionText(body, heading) {
  const lines = body.split('\n');
  const wanted = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === wanted);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return rest
    .slice(0, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

// Twin: `UNKNOWN` in server/src/items/parse.util.ts, copied BYTE FOR BYTE — `tick-lib.test.mjs` reads that file as text and fails if this source is not in it.
// A Cause or Fix that still says "I don't know yet", any case: the bare sentinel `backlog-capture` writes, with markdown emphasis stripped from both ends, and the
// word followed by punctuation/a dash and a tail, or ending its line and followed by a paragraph. It deliberately does NOT match a sentence that merely opens with
// the word ("Unknown option passed to X" is a real cause). The server's header comment tells the whole story; the bias runs one way on purpose — a false
// "ungroomed" costs a groom that had little to do, a false "groomed" spends a whole session to be refused.
//
// Exported only so the twin guard can read `.source`.
export const UNKNOWN = /^[\s*_`#]*unknown[ \t*_`]*(?:$|\r?\n[\s\S]*$|[.,:;!?\-–—][\s\S]*$)/i;

// Twin: `deriveGroomed` in server/src/items/parse.util.ts. A bug is groomed when its Cause AND its Fix are filled and neither is the unknown sentinel; a task when
// its Plan is non-empty. Ideas and refactors derive `null`, not `false` — grooming is not a state they have, what they wait in is being promoted.
export function deriveGroomed(section, body) {
  if (section === 'bugs') {
    const filled = (t) => t !== '' && !UNKNOWN.test(t);
    return filled(sectionText(body, 'Cause')) && filled(sectionText(body, 'Fix'));
  }
  if (section === 'tasks') {
    return sectionText(body, 'Plan') !== '';
  }
  return null;
}

// --- ordering ------------------------------------------------------------

// `bug-7` → 7, `#12` → 12, `task-100` → 100: the digits at the end of an id, which is the item's creation order because the counter is monotonic max+1 per store
// (orchestrate.mjs says the same above its queue builder). A file id and a tracker id are the only two shapes the tick sees.
export function itemNumber(id) {
  const m = /(\d+)$/.exec(id);
  return m === null ? Number.POSITIVE_INFINITY : Number(m[1]);
}

// One stable sort by (rank, section, number). `Array.prototype.sort` is stable, so two items that tie on all three keep the order they arrived in.
function orderBy(items, sectionOrder, hoist) {
  const rank = (section) => {
    const i = sectionOrder.indexOf(section);
    return i === -1 ? sectionOrder.length : i;
  };
  return [...items].sort((a, b) => {
    if (hoist && a.runnerFix !== b.runnerFix) return a.runnerFix ? -1 : 1;
    if (a.section !== b.section) return rank(a.section) - rank(b.section);
    return itemNumber(a.id) - itemNumber(b.id);
  });
}

// What a tick executes, in the order the orchestrator would drain it: bugs oldest-first, then tasks oldest-first, with `runner-fix:` items hoisted to the front.
// The hoist OUTRANKS the bugs-then-tasks rule rather than sorting inside it, and the hoisted items stay bugs-before-tasks and oldest-first among themselves — the
// partition `orderGatedQueue` in orchestrate.mjs applies (a runner fix repairs the machinery a later item would run on). Returns a new array.
export function orderExecute(items) {
  return orderBy(items, ['bugs', 'tasks'], true);
}

// What a tick grooms: bugs oldest-first, then refactors oldest-first. No hoist — `runner-fix:` is about the order things RUN in, and a groom only writes a plan.
export function orderGroom(items) {
  return orderBy(items, ['bugs', 'refactors'], false);
}
