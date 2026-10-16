import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parseTagMessage } from 'release-kit';

import type { Release, ReleasesResponse } from '../../../shared/types';
import { runGit } from '../git-run.util';

/**
 * releases.service.ts — `GET /api/releases`: this app's own release history, read from its own checkout's annotated `vX.Y.Z` tags, which the release
 * workflow cuts on every releasing merge into `main` (docs/workflows/ci.md §Releases, docs/subsystems/releases.md).
 *
 * Why git is run HERE and release-kit's `readReleases` is not called (spec R4): `readReleases` launches git through its own `execFile` with no timeout,
 * and this server's rule is that every git read is `runGit` — async and bounded at 10 s — so a slow disk degrades one route instead of hanging it. Only the
 * pure `parseTagMessage` is imported. The price is reproducing release-kit's filters and its GitHub-remote regex below, and `test/api-releases.test.ts`
 * pins that price: for the same repo the route must deep-equal `readReleases`.
 *
 * Failure degrades per read, as `readReleases` catches per call: `for-each-ref` failing is the empty shape, `describe` failing is `current: null` with the
 * releases kept, `remote get-url` failing only drops `url`. Never an error status.
 *
 * The memo is its own, and shares nothing with the items memo or the `uncommitted` read (which is memoised nowhere, by rule). Its key is the root, HEAD and
 * the mtimes of `packed-refs` and `refs/tags` under the COMMON git dir: HEAD alone misses a tag fetched or cut by hand while HEAD stays put, and in a linked
 * worktree the worktree's own git dir holds no tags at all. A read in which `for-each-ref` or `describe` failed is answered but never memoised — the
 * precedent is `lastCommitDates` — so one timeout cannot hide the chip until HEAD or a tag next moves.
 */

/** release-kit's `VERSION_TAG` (dist `git.js`): only a full `vX.Y.Z` is a release — a floating `v1` or a `v2-rc` is not. */
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;

/** release-kit's `DESCRIBE_FILTER` (dist `git.js`), the same filter the release workflow computes the next version with. */
const DESCRIBE_FILTER = ['--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', 'v*[!0-9.]*'];

/** `describe --long` output; `--long` is what makes HEAD-on-a-tag print `-0-g<sha>` rather than the bare tag. release-kit's `LONG_DESCRIBE`. */
const LONG_DESCRIBE = /^v(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/;

/**
 * `git@github.com:owner/repo(.git)`, `https://github.com/owner/repo(.git)(/)` and `ssh://git@github.com/owner/repo(.git)` — copied verbatim from release-kit's
 * `read-releases.js`, not shared with `tracker/origin.util.ts`'s parser, because parity with `readReleases` is the contract here.
 */
const GITHUB = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

// NUL cannot occur in a tag message, so it ends every field, the last one included; the newline git prints after each record then lands at the start of the
// next record's first field, which is why that field is stripped of one leading `\n`. Records are cut on field count, not lines: `%(contents)` has its own.
const FIELDS = 4;
const TAG_FORMAT = '--format=%(refname:short)%00%(objecttype)%00%(creatordate:iso-strict)%00%(contents)%00';

const MAX_BUFFER = 32 * 1024 * 1024;

const EMPTY: ReleasesResponse = { current: null, releases: [] };

/** The first directory at or above `from` that holds a `.git` entry — a directory in a main checkout, a FILE in a linked worktree. */
export function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The checkout whose tags are read: `BM_RELEASES_ROOT` when set (the test seam, read per request like `BM_REGISTRY_FILE` and `BM_ORCH_HOME`), else this
 * server's own checkout, found from its own files — never `process.cwd()`, which is wherever the server happened to be started. In the compose stack that
 * is `/app`, the bind-mounted checkout with its `.git`.
 */
export function releasesRoot(): string | null {
  return process.env.BM_RELEASES_ROOT || findRepoRoot(__dirname);
}

interface Computed {
  value: ReleasesResponse;
  /** False when a read that decides the answer failed — never memoised then. */
  complete: boolean;
}

function cmpVersion(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function memoKey(root: string): Promise<string | null> {
  const out = await runGit(['rev-parse', 'HEAD', '--git-common-dir'], { cwd: root });
  if (out === null) return null;
  const [head, common] = out.trim().split('\n');
  if (!head || !common) return null;
  const dir = resolve(root, common);
  return [root, head, mtime(join(dir, 'packed-refs')), mtime(join(dir, 'refs', 'tags'))].join('\0');
}

async function repoUrl(root: string): Promise<string | null> {
  const out = await runGit(['remote', 'get-url', 'origin'], { cwd: root });
  const m = out === null ? null : GITHUB.exec(out.trim());
  return m ? `https://github.com/${m[1]}` : null;
}

async function compute(root: string): Promise<Computed> {
  const [out, base] = await Promise.all([
    runGit(['for-each-ref', '--sort=-creatordate', TAG_FORMAT, 'refs/tags/v*'], { cwd: root, maxBuffer: MAX_BUFFER }),
    repoUrl(root)
  ]);
  if (out === null) return { value: EMPTY, complete: false };

  const parts = out.split('\0');
  const tags: { version: string; date: string; message: string }[] = [];
  for (let i = 0; i + FIELDS <= parts.length; i += FIELDS) {
    const [rawName, type, date, message] = parts.slice(i, i + FIELDS);
    const name = rawName.replace(/^\n/, '');
    if (type === 'tag' && VERSION_TAG.test(name)) tags.push({ version: name.slice(1), date, message });
  }
  // `--sort=-creatordate` has one-second resolution and breaks ties by ASCENDING refname, which puts v0.10.0 before v0.9.0 before v0.2.0 — and the release
  // workflow tags several commits within one second. Re-sorted: date descending, then version descending.
  tags.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || cmpVersion(b.version, a.version));

  const releases: Release[] = tags.map((t) => {
    const p = parseTagMessage(t.message);
    const r: Release = { version: t.version, date: t.date, title: p.title, type: p.type, breaking: p.breaking, notes: p.notes };
    if (p.scope) r.scope = p.scope;
    if (p.pr !== undefined) {
      r.pr = p.pr;
      if (base) r.url = `${base}/pull/${p.pr}`;
    }
    return r;
  });
  if (releases.length === 0) return { value: EMPTY, complete: true };

  const described = await runGit(['describe', '--long', ...DESCRIBE_FILTER], { cwd: root });
  // `describe` exits non-zero both when it fails AND when no release tag is reachable from HEAD (a branch cut before the baseline); the second is a
  // settled answer, but runGit cannot tell them apart, so neither is memoised — one extra read per request on such a branch, never a pinned failure.
  const m = described === null ? null : LONG_DESCRIBE.exec(described.trim());
  const current = m ? { version: m[1], ahead: Number(m[2]) } : null;
  return { value: { current, releases }, complete: m !== null };
}

@Injectable()
export class ReleasesService {
  private memo: { key: string; value: ReleasesResponse } | null = null;
  private inflight: { key: string; promise: Promise<Computed> } | null = null;

  async read(): Promise<ReleasesResponse> {
    const root = releasesRoot();
    if (root === null) return EMPTY;
    const key = await memoKey(root);
    // A key git cannot produce (not a checkout, no commit yet, a timeout) is never memoised: the read runs and answers whatever it gets.
    if (key === null) return (await compute(root)).value;
    if (this.memo?.key === key) return this.memo.value;
    if (this.inflight?.key === key) return (await this.inflight.promise).value;

    const entry = { key, promise: compute(root) };
    this.inflight = entry;
    try {
      const done = await entry.promise;
      if (done.complete) this.memo = { key, value: done.value };
      return done.value;
    } finally {
      // Dropped only if still ours: a request under a newer key may already have replaced it.
      if (this.inflight === entry) this.inflight = null;
    }
  }
}
