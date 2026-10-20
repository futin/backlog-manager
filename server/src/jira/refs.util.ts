import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { branchCarriesKey } from '../../../shared/jira-branch';
import type { JiraRefBranch, JiraRepoRefs, JiraRepoUnavailable, JiraWorktree } from '../../../shared/types';
import { runGit } from '../git-run.util';

/**
 * refs.util.ts — what this server can read of a mapped repository's branches and worktrees, for the launch sheet's branch picker and Setup's warnings (Jira
 * repo/branch, spec §4 and §5.2).
 *
 * **Read-only, always.** Every git call here is `runGit` — async, bounded at 10 s, a timeout landing in the call site's failure branch (the invariant in
 * `git-run.util.ts`) — and every one of them is a READ: `rev-parse`, `for-each-ref`, `rev-list`, `symbolic-ref`, `worktree list`. There is no fetch, no
 * worktree add, no checkout and no branch write anywhere in this file: the writing is `jira.mjs worktree`'s, run by the session on the host, and the compose
 * mount this reads through is `:ro` so a slip here would be refused by the kernel as well. `fetchedAt` is how a stale picture says it is stale — the board
 * never refreshes it, because the container holds no SSH credentials (spec §4).
 *
 * **Not cached.** Each request reads afresh, each read bounded; the picker is opened by a person, not polled, and a cache would need the invalidation that
 * `jira.mjs worktree` — which runs outside this process — cannot give it. Revisit only if the sheet feels slow.
 *
 * **Unavailable is a value.** A mapped path the server cannot list is not an error: the sheet still lets the person type a branch. `checkRepo` answers the
 * reason, in spec §4's order.
 */

/** A listing of a big monorepo's branches runs to a few hundred KiB; `execFile`'s 1 MiB default would turn a very large one into "not a git repository". */
const REFS_MAX_BUFFER = 32 * 1024 * 1024;

/** Is `repo` the root or under it? Whole path segments — `/data/ab` does not hold `/data/abc` — and a root's trailing slash is no part of it. */
function underRoot(repo: string, root: string): boolean {
  const base = root.replace(/\/+$/, '');
  return base === '' || repo === base || repo.startsWith(`${base}/`);
}

/**
 * The first reason `repo` cannot be listed, or `null` when it can, in spec §4's order: outside every root (only when the server knows its roots — a host-run
 * API passes `null` and skips the check), missing or not a directory, and not the top of a git repository. The last compares REAL paths: macOS reports a tmp
 * path as `/private/var/...` from `rev-parse --show-toplevel`, and a mapped path may itself be a symlink; a plain string compare would call both "not a git
 * repository". A subdirectory of a repo has a different toplevel and is refused the same way — a mapped path names a repository, not somewhere inside one.
 */
async function checkRepo(repo: string, roots: string[] | null): Promise<JiraRepoUnavailable | null> {
  if (roots !== null && !roots.some((root) => underRoot(repo, root))) return 'not mounted into the board';
  const info = await stat(repo).catch(() => null);
  if (info === null || !info.isDirectory()) return 'does not exist';
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: repo });
  if (top === null || top.trim() === '') return 'not a git repository';
  const [real, realTop] = await Promise.all([realpath(repo).catch(() => null), realpath(top.trim()).catch(() => null)]);
  return real !== null && real === realTop ? null : 'not a git repository';
}

interface RawWorktree {
  path: string;
  branch: string | null;
}

/** `git worktree list --porcelain`: blocks separated by a blank line, the repo's own working tree first; a detached or bare tree has no `branch` line. */
function parseWorktrees(porcelain: string): RawWorktree[] {
  const trees: RawWorktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    }
    if (path !== null) trees.push({ path, branch });
  }
  return trees;
}

/**
 * Every working tree of `repo`, the repo's own first and marked `main`, or why the repo cannot be read. A `worktree list` that fails after `checkRepo`
 * passed (a timeout, a git that died between the two) is reported as `not a git repository` — the union has no sentence for "slow", and the sheet's answer to
 * either is the same: type the branch by hand.
 */
export async function readWorktrees(repo: string, roots: string[] | null): Promise<JiraWorktree[] | JiraRepoUnavailable> {
  const unavailable = await checkRepo(repo, roots);
  if (unavailable !== null) return unavailable;
  const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: repo, maxBuffer: REFS_MAX_BUFFER });
  if (listed === null) return 'not a git repository';
  return parseWorktrees(listed).map((tree, index) => ({ repo, path: tree.path, branch: tree.branch, main: index === 0 }));
}

interface RawRef {
  name: string;
  committedAt: string;
  /** `%(upstream)` — the full ref, `refs/remotes/origin/<name>` when the branch tracks its own twin. */
  upstream: string;
  /** `%(upstream:track)` — `[ahead 1]`, `[behind 2]`, `[ahead 1, behind 2]`, or empty (in step, or no upstream). */
  track: string;
}

const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/origin/';

/** Fields are tab-separated (`%09`): a ref name cannot hold a control character, so the separator cannot occur inside one. */
const REF_FORMAT = '%(refname)%09%(committerdate:iso-strict)%09%(upstream)%09%(upstream:track)';

/** The committer date as the UTC ISO instant the rest of the API speaks; the raw text when git printed something that does not parse. */
function isoOf(raw: string): string {
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? raw : at.toISOString();
}

type Sync = NonNullable<JiraRefBranch['sync']>;

function syncOfCounts(ahead: number, behind: number): Sync {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'same';
}

/** `%(upstream:track)` read as a sync; `[gone]` and anything else unfamiliar is `null` rather than a guess. */
function syncOfTrack(track: string): Sync | null {
  if (track === '') return 'same';
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (!ahead && !behind) return null;
  return syncOfCounts(ahead ? Number(ahead[1]) : 0, behind ? Number(behind[1]) : 0);
}

/** Where the local copy of `name` stands against `origin/<name>`, by name — the board cuts its branches `--no-track`, so no upstream can be relied on. */
async function syncByName(repo: string, name: string): Promise<Sync | null> {
  const out = await runGit(['rev-list', '--left-right', '--count', `${LOCAL_PREFIX}${name}...${REMOTE_PREFIX}${name}`], { cwd: repo });
  const counts = out === null ? null : /^(\d+)\s+(\d+)\s*$/.exec(out);
  return counts ? syncOfCounts(Number(counts[1]), Number(counts[2])) : null;
}

/**
 * A mapped repo's branches — local and `origin/` twin folded into one entry — with the worktree holding each, the main branch and the base a New worktree
 * defaults to, or why it cannot be read (`checkRepo`). `key` marks the ticket's own branches (`ticket`, spec §5.2) and sorts them first, newest commit first;
 * the rest follow by name. `defaultBase` is `storedBase` when the caller has one (Task 4 wires the repo's stored default; until then the route passes `null`),
 * else the branch `origin/HEAD` points at, else the main tree's branch, else `null`.
 *
 * `sync` is the cost-bounded part. Every ticket branch on both sides gets one `rev-list --left-right --count`, by name, because those are the branches the
 * person is about to continue and a board-cut branch has no upstream; every other branch on both sides is read from the one `for-each-ref` already made, and
 * only when its upstream IS `origin/<name>`. One call per ticket branch, not one per branch in the repo.
 *
 * A failed side read (`worktree list`, `symbolic-ref`, `--git-common-dir`) degrades that field — no worktree, no base, no `fetchedAt` — rather than the
 * listing; only a failed `for-each-ref` makes the repo unavailable, since without it there is nothing to show.
 */
export async function readRepoRefs(repo: string, key: string | null, roots: string[] | null, storedBase: string | null): Promise<JiraRepoRefs> {
  const unavailable = await checkRepo(repo, roots);
  if (unavailable !== null) return { repo, available: false, reason: unavailable };

  const [listed, trees, head, commonDir] = await Promise.all([
    runGit(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes/origin'], { cwd: repo, maxBuffer: REFS_MAX_BUFFER }),
    runGit(['worktree', 'list', '--porcelain'], { cwd: repo, maxBuffer: REFS_MAX_BUFFER }),
    runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo }),
    runGit(['rev-parse', '--git-common-dir'], { cwd: repo })
  ]);
  if (listed === null) return { repo, available: false, reason: 'not a git repository' };

  const locals = new Map<string, RawRef>();
  const remotes = new Map<string, RawRef>();
  for (const line of listed.split('\n')) {
    if (line === '') continue;
    const [refname = '', committedAt = '', upstream = '', track = ''] = line.split('\t');
    if (refname.startsWith(LOCAL_PREFIX)) {
      const name = refname.slice(LOCAL_PREFIX.length);
      locals.set(name, { name, committedAt, upstream, track });
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      const name = refname.slice(REMOTE_PREFIX.length);
      // `origin/HEAD` is a symbolic ref to a branch listed in its own right, not a branch.
      if (name !== 'HEAD') remotes.set(name, { name, committedAt, upstream, track });
    }
  }

  const worktrees = trees === null ? [] : parseWorktrees(trees);
  const heldBy = new Map<string, string>();
  for (const tree of worktrees) if (tree.branch !== null) heldBy.set(tree.branch, tree.path);
  const mainBranch = worktrees[0]?.branch ?? null;

  const names = [...new Set([...locals.keys(), ...remotes.keys()])];
  const branches = await Promise.all(
    names.map(async (name): Promise<JiraRefBranch> => {
      const local = locals.get(name);
      const remote = remotes.get(name);
      const ticket = key !== null && branchCarriesKey(name, key);
      let sync: Sync | null = null;
      if (local && remote) {
        sync = ticket ? await syncByName(repo, name) : local.upstream === `${REMOTE_PREFIX}${name}` ? syncOfTrack(local.track) : null;
      }
      const newest = [local, remote]
        .filter((ref): ref is RawRef => ref !== undefined)
        .map((ref) => isoOf(ref.committedAt))
        .sort()
        .pop() as string;
      return { name, local: local !== undefined, remote: remote !== undefined, sync, committedAt: newest, worktree: heldBy.get(name) ?? null, ticket };
    })
  );
  branches.sort((a, b) => {
    if (a.ticket !== b.ticket) return a.ticket ? -1 : 1;
    if (a.ticket) return a.committedAt < b.committedAt ? 1 : a.committedAt > b.committedAt ? -1 : a.name < b.name ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const originHead = head === null ? null : head.trim().replace(/^origin\//, '');
  let fetchedAt: string | null = null;
  if (commonDir !== null && commonDir.trim() !== '') {
    const fetched = await stat(resolve(repo, commonDir.trim(), 'FETCH_HEAD')).catch(() => null);
    if (fetched !== null) fetchedAt = fetched.mtime.toISOString();
  }

  return {
    repo,
    available: true,
    fetchedAt,
    mainBranch,
    defaultBase: storedBase ?? (originHead === '' ? null : originHead) ?? mainBranch,
    branches
  };
}
