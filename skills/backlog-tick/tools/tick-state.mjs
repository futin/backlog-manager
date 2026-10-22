// The only writer under `tickHome()`: one lock, and one record of what the last ticks did to which item.
//
// The same relationship `registry.json` has with `backlog.mjs` and `run.json` has with `orchestrate.mjs`, stated for a fourth directory: nothing else writes
// `<tickHome>/<project-key>/lock` or `state.json`. Every write is a temp file in the SAME directory and a `rename`/`link` — never an in-place write — so a
// crash mid-write leaves the previous bytes, or nothing, and a concurrent reader never sees half a file.
//
// `dir` is the project's own directory (`projectDir(tickHome(), root)`), made by the caller's choice of path and created here on first write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = 'lock';
const STATE_FILE = 'state.json';

// How much history `state.json` keeps. The per-item records in `items` are the working set; `recent` is only what the tick's own report shows an operator, and
// an unbounded one would grow for as long as the project lives.
const RECENT_MAX = 50;

// --- atomic write --------------------------------------------------------

// A name unique to this process and call, in the target's own directory: `rename` is atomic only within one filesystem, and a tmp file under `os.tmpdir()` would
// not be on the same one as `~/.backlog-manager`.
function tmpPath(file) {
  return `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPath(file);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// --- the lock ------------------------------------------------------------

// What `decide` took the lock for. `base` is the resolved `<base>` commit `decide` READ the item at, so `record` and a recovery hash the same blob `decide`
// compared against — an item file edited between the two cannot make a failure look like one on the new text.
//
//   type Lock = { host: string, verdict: { kind: 'execute' | 'groom', id: string }, base: string, at: string /* ISO */ }

// Free, held or stale, as of `now` (ms since epoch). A lock is `held` for `ttlMs` after its `at` and `stale` from then on. A file that cannot be read, is not JSON,
// is not an object, or has no parseable `at` is `stale` — NEVER free: a lock somebody (or a crash) left is evidence a tick was mid-flight, and reading it as free
// would start a second tick on top of it. `lock` carries whatever fields did parse (`{}` when none did), so the caller can still name the host and verdict.
export function lockState(dir, now, ttlMs) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'free' };
    return { state: 'stale', lock: {} };
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return { state: 'stale', lock: {} };
  }
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return { state: 'stale', lock: {} };
  const at = typeof lock.at === 'string' ? Date.parse(lock.at) : Number.NaN;
  if (Number.isNaN(at)) return { state: 'stale', lock };
  return now - at < ttlMs ? { state: 'held', lock } : { state: 'stale', lock };
}

// Exclusive create: `true` when this call made the lock, `false` when one was already there. The content is written to a tmp file first and then LINKED into place
// rather than opened with `wx` and written — both are exclusive (`link` fails `EEXIST` if the name exists), but `wx` creates the name before its bytes, and a
// second tick reading in that gap would find an empty, unparseable file, read it as stale, and remove it. A link makes the name and its whole content appear at once.
export function writeLock(dir, lock) {
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpPath(file);
  try {
    fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n');
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Removes the lock only when it is THIS verdict's — `verdict.id === id`. A tick that outlived its ttl and finds another tick's lock in place must not delete it.
// `false` when the lock is absent, unreadable, or someone else's.
export function releaseLock(dir, id) {
  const file = path.join(dir, LOCK_FILE);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (lock === null || typeof lock !== 'object' || lock.verdict?.id !== id) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// Unconditional — for a lock `lockState` has already called stale. Absent is fine.
export function removeLock(dir) {
  fs.rmSync(path.join(dir, LOCK_FILE), { force: true });
}

// --- the outcome record --------------------------------------------------

//   type ItemRecord = { outcome: 'ok' | 'failed', kind: 'execute' | 'groom', reason: string, at: string, hash?: string }
//   type RecentEntry = { at, id, kind, outcome, reason }
//
// `hash` rides on `failed` only: it is the `contentHash` of the item as `decide` read it, and a failed item is skipped until that hash moves — a person editing
// the item is the signal that trying again is not the same attempt.

// Missing file → empty. A file that exists and cannot be read as a state object THROWS, and nothing replaces it: the `jira.json` rule, a file that cannot be read
// is never overwritten, because the next write would silently discard every failure record in it and a tick would retry items it had been told to leave alone.
export function readState(dir) {
  const file = path.join(dir, STATE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { items: {}, recent: [] };
    throw new Error(`${file}: cannot be read (${e.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message}) — left untouched; fix or remove it by hand`);
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(parsed) || !isObject(parsed.items) || !Array.isArray(parsed.recent)) {
    throw new Error(`${file}: expected { "items": {…}, "recent": […] } — left untouched; fix or remove it by hand`);
  }
  return { items: parsed.items, recent: parsed.recent };
}

function writeState(dir, state) {
  writeAtomic(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

// Sets `items[id]`, appends one entry to `recent` and keeps the last 50. Read-modify-write, safe because the tick lock serialises ticks on one project and a
// malformed file throws before anything is written.
export function recordOutcome(dir, id, rec) {
  const state = readState(dir);
  state.items[id] = rec;
  state.recent.push({ at: rec.at, id, kind: rec.kind, outcome: rec.outcome, reason: rec.reason });
  if (state.recent.length > RECENT_MAX) state.recent = state.recent.slice(-RECENT_MAX);
  writeState(dir, state);
}

// Drops an item's record, leaving `recent` (history, not state). `false` when there was nothing to drop, and then nothing is written.
export function forgetItem(dir, id) {
  const state = readState(dir);
  if (!Object.hasOwn(state.items, id)) return false;
  delete state.items[id];
  writeState(dir, state);
  return true;
}

// --- the content hash ----------------------------------------------------

// Frontmatter keys that change when a tool or a session works on an item, not when a person does: `updated:` (stamped by every start and stop), `started:` and
// `phase:` (the lifecycle keys), `groomed-at:` (re-stamped by a groom `stop`), and the billing counters `*-elapsed` / `*-tokens`. A failed item's hash must survive
// the failed attempt's own bookkeeping, or every failure would un-skip itself the moment `stop` billed it.
const BOOKKEEPING = new Set(['updated', 'started', 'phase', 'groomed-at']);

function isBookkeeping(line) {
  const sep = line.indexOf(':');
  if (sep === -1) return false;
  const key = line.slice(0, sep).trim();
  return BOOKKEEPING.has(key) || key.endsWith('-elapsed') || key.endsWith('-tokens');
}

// sha256 hex over the body plus every frontmatter line whose key is not bookkeeping. Whole LINES are hashed as written, so a change to `title:` or `created:` moves
// the hash; a line the splitter would skip (no colon) is kept. Text with no frontmatter — a tracker item's body — hashes as the body alone, and so does a
// frontmatter with no closing `---` (the whole text), the direction that moves the hash on any edit.
export function contentHash(text) {
  const hash = crypto.createHash('sha256');
  const lines = text.split('\n');
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close === -1) return hash.update(text).digest('hex');
  const kept = lines.slice(1, close).filter((l) => !isBookkeeping(l));
  // A separator no frontmatter line can contain (lines never hold a newline), so moving a line from frontmatter into the body cannot collide.
  return hash.update(kept.join('\n') + '\n---\n' + lines.slice(close + 1).join('\n')).digest('hex');
}

// A failed item is skipped only while its content still hashes to what it failed on. `ok` is never skipped (the item has left the queue by then and a re-appearance
// is a new situation), and a `failed` record with no hash cannot prove the text is unchanged, so it does not skip.
export function isSkipped(rec, currentHash) {
  return rec !== undefined && rec.outcome === 'failed' && rec.hash !== undefined && rec.hash === currentHash;
}
