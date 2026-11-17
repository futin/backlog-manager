// The deterministic half of the pr-resolve skill: parsing the `owner/repo#N` target, the per-PR lock, and the outcome file the board's server reads. Every
// function is synchronous and takes its paths as arguments, so the suite drives it in a temp dir.
//
// Self-contained by the same rule every skill's tools are (`.claude/rules/skills.md`): it imports nothing from another skill's `tools/`, from `server/` or
// from `shared/`. `claimStale` is therefore a TWIN of `claimStaleLock` in `skills/backlog-tick/tools/tick-state.mjs`; a change to one is a change to the other.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A lock older than this is a resolve the dashboard killed (or a crash); same figure as backlog-tick's `--lock-ttl` default.
const LOCK_TTL_MS = 3 * 60 * 60 * 1000;

const TARGET = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

export function parseTarget(arg) {
  const m = typeof arg === 'string' ? TARGET.exec(arg) : null;
  if (!m) return null;
  return { owner: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

// Read per call, never cached: the suites and the server's tests point it at a temp dir through the env.
export function prResolveHome(env = process.env) {
  return env.BM_PR_RESOLVE_HOME || path.join(os.homedir(), '.backlog-manager', 'pr-resolve');
}

// `<owner>__<name>__<N>`. A GitHub owner never contains `_`, so the FIRST `__` ends the owner and the LAST one starts the number even when the repo name holds
// `__` itself; the server's `parseFileKey` relies on that to split a file name back into a target.
export function fileKey(repo, number) {
  return `${repo.replace('/', '__')}__${number}`;
}

export function paths(cwd, home, target) {
  const key = fileKey(target.repo, target.number);
  const trees = path.join(cwd, '.worktrees');
  return {
    tree: path.join(trees, `pr-resolve-${target.number}`),
    baseTree: path.join(trees, `pr-resolve-${target.number}-base`),
    lockFile: path.join(home, 'locks', `${key}.lock`),
    outcomeFile: path.join(home, `${key}.json`),
  };
}

function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// A lock is stale when it is older than the ttl by its own `at` (an unparseable one by the file's mtime — a crash can leave half a write), or when the
// caller is resuming exactly the session that holds it (`reclaim`, a non-null id: a null `sessionId` never matches, or every unset-env lock would be free).
function isStale(file, raw, now, reclaim) {
  let lock = null;
  try {
    lock = JSON.parse(raw);
  } catch {
    lock = null;
  }
  const object = lock !== null && typeof lock === 'object' && !Array.isArray(lock);
  if (object && reclaim !== null && reclaim !== undefined && lock.sessionId === reclaim) return true;
  const at = object && typeof lock.at === 'string' ? Date.parse(lock.at) : Number.NaN;
  if (!Number.isNaN(at)) return now - at > LOCK_TTL_MS;
  try {
    return now - fs.statSync(file).mtimeMs > LOCK_TTL_MS;
  } catch {
    return false;
  }
}

function wxWrite(file, sessionId, now) {
  try {
    fs.writeFileSync(file, JSON.stringify({ sessionId, at: new Date(now).toISOString() }) + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

// Exclusive create. A reader that lands between `wx` creating the name and the bytes arriving sees an unparseable file and judges it by mtime — fresh — so the
// worst outcome of that gap is a refusal, never a stolen lock.
export function takeLock(lockFile, { sessionId, now, reclaim }) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (wxWrite(lockFile, sessionId, now)) return { taken: true, recovered: false };
  const raw = readRaw(lockFile);
  if (raw === null || !isStale(lockFile, raw, now, reclaim)) return { taken: false };
  const claimed = claimStale(lockFile, raw);
  if (claimed === null) return { taken: false };
  fs.rmSync(claimed, { force: true });
  // Someone may have taken the freed name between the claim and here: that is a lost race, not an error.
  return wxWrite(lockFile, sessionId, now) ? { taken: true, recovered: true } : { taken: false };
}

// TWIN of `claimStaleLock` in `skills/backlog-tick/tools/tick-state.mjs` (copied, not imported: a skill's tools import nothing from another skill's). A recovery
// must own only the lock it JUDGED stale, so it renames the lock aside (atomic: only one claimer succeeds), re-reads the claimed bytes and compares them with
// `judgedRaw`. `ENOENT` means another claimer got there first: `null`. Different bytes mean a fresh lock was written after the judge and this claim took it by
// mistake: it is linked back (`EEXIST` — yet another lock is there now — is left alone), the claimed name removed, and `null`. A match returns the claimed
// path, which the caller deletes once it has recorded the recovery.
export function claimStale(lockFile, judgedRaw) {
  const claimed = `${lockFile}.recover-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockFile, claimed);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (readRaw(claimed) === judgedRaw) return claimed;
  try {
    fs.linkSync(claimed, lockFile);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    fs.rmSync(claimed, { force: true });
  }
  return null;
}

// Removes the lock only when it is THIS session's (`null` matches `null`): a resolve that outlived its ttl must not delete the lock a successor took.
export function releaseLock(lockFile, sessionId) {
  const raw = readRaw(lockFile);
  if (raw === null) return false;
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return false;
  }
  if (lock === null || typeof lock !== 'object' || (lock.sessionId ?? null) !== (sessionId ?? null)) return false;
  fs.rmSync(lockFile, { force: true });
  return true;
}

// Temp file in the same directory plus `rename`, so the server never reads half a record.
export function writeOutcome(outcomeFile, { sessionId, outcome, reason, fromSha, headSha, now }) {
  const dir = path.dirname(outcomeFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(outcomeFile)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const record = { sessionId, outcome, reason, fromSha, headSha, at: new Date(now).toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    fs.renameSync(tmp, outcomeFile);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
