import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { runGit } from '../git-run.util';

/**
 * uncommitted.util.ts — which item files the working tree holds in a state a
 * board-started orchestrator run will not read.
 *
 * A run gates every item at `<base>` — `BASE_REF_DEFAULT` (`main`) in
 * `skills/backlog-orchestrate/tools/orchestrate.mjs` unless the sheet's base
 * picker (task-44) chose another branch, in which case the board passes
 * `--base` and the sheet passes that same branch here (#254) — while the
 * board's own item scan reads the WORKING TREE. Every `main` below therefore
 * reads as "the chosen base"; it is spelled `main` because that is the
 * default and the common case. The two disagree whenever the file on disk is
 * not the file at the base, which
 * covers two shapes with two different fates — and the difference matters,
 * because the sheet has to state a consequence and only one of these is a
 * skip (review round 1 caught the note claiming both were):
 *
 *   - **absent from `main`** (`readBlob(relPath) === null` in
 *     `buildGatedQueue`): the run refuses it with `not committed on main —
 *     the worktree this run creates from main would not contain <path>` and
 *     moves on. This is the shape the 2026-09-06 sweep counted five of, each
 *     costing a run slot after the person had walked away.
 *   - **present at `main` but edited since**: the run gates and then EXECUTES
 *     main's bytes. It may read `ungroomed` there, or it may simply run the
 *     older plan — either way the work the person just wrote is not the work
 *     that happens, and no verdict in the run file says so.
 *
 * Both are worth knowing before a multi-hour unattended operation starts,
 * which is why the predicate is the broad one (Decision 2 below). Catching
 * them with one question is the point (task-32) — and since #235 the answer
 * also says WHICH fate each flagged row has (`absent`, Decision 3), so the
 * sheet's note can state only the fates actually on screen, each with its
 * count, instead of hedging over both whenever anything is flagged.
 *
 * Three decisions a later reader will otherwise "fix", all deliberate:
 *
 * 1. **Nothing here is memoised, and this must never join `lastCommitDates`'
 *    memo** (git-dates.util.ts). That memo is keyed on the mtimes of `index`
 *    and `logs/HEAD` — the files git rewrites when the answer to *its*
 *    question can change. Editing an item file in the working tree, which is
 *    the exact event this module reports, moves NEITHER, so a memo on that
 *    key would answer "clean" forever after its first hit: it would
 *    reintroduce the false negative this feature exists to remove. The cost
 *    is affordable without one — the two original spawns together measured
 *    50–270ms per project, and the third read (Decision 3) adds 4–9ms (re-measured
 *    2026-10-02 on three of this machine's projects, warm cache: the whole
 *    call 20–39ms) — and this runs for ONE project ONCE per sheet open, never on the
 *    board's poll path the way `lastCommitDates` does (which is the whole
 *    reason that one needed a memo and this one does not).
 * 2. **The question is "does the working copy differ from `main`", never
 *    "differs from `HEAD`".** `git status --porcelain` compares against
 *    `HEAD`, which is the wrong ref whenever the main tree is not sitting on
 *    `main` — and an item committed on a branch but absent from `main` is
 *    precisely one of the cases that gets skipped. Diffing against `main`
 *    also covers the sibling case `buildGatedQueue`'s own comment describes
 *    (an item committed while ungroomed and groomed only in the working copy
 *    is *present* at `main`, so it earns plain `ungroomed` rather than "not
 *    committed") with one question instead of two.
 * 3. **A row's fate is "does `main` hold this path at all", read by ONE
 *    third spawn — never "which of the two reads found it", and never one
 *    spawn per row.** The fate cannot be inferred from the read that reported
 *    a path: an item committed on a branch `main` does not contain is found
 *    by `diff` and is still absent from `main` (the run skips it), while an
 *    item `git rm --cached` from the index but still committed on `main` is
 *    found by `ls-files --others` and is still present there (the run
 *    executes `main`'s older copy). So the question is asked directly:
 *    `ls-tree -r --name-only main -- backlog` lists every path `main` holds,
 *    once per request, and a flagged path missing from that listing is
 *    absent. `cat-file -e main:<path>` per flagged path answers the same
 *    question but costs one spawn per row — N process launches per request —
 *    which is the cost this module's whole shape avoids.
 *
 * Since #277 every read here is ASYNC and time-bounded, so a slow repository
 * makes THIS route slow instead of freezing the process — and Decision 1
 * extends to the new seam: there is no in-flight sharing either. Two
 * concurrent callers spawn git twice, because a call that arrives after an
 * edit must not be handed a read that began before it (`git-dates.util.ts`
 * shares a pending spawn precisely because its question has a cheap key that
 * says when sharing is safe; this one has none). `test/git-run.test.ts` pins it.
 */

/**
 * The ref a board-started run gates at when no base was picked. Named rather than inlined because it
 * is a second copy of `orchestrate.mjs`'s `BASE_REF_DEFAULT` in a second
 * language — the `.mjs` tool is not importable into the Nest build — and
 * `test/uncommitted.test.ts` reads that file's SOURCE to pin the two
 * together, the way `test/server-bind.test.ts` reads `main.ts`.
 */
export const UNCOMMITTED_BASE_REF = 'main';

export interface UncommittedItems {
  /** Absolute paths, built from `projectPath` verbatim so they compare equal
   *  to `BacklogItem.path` without either side calling `realpath`. */
  paths: string[];
  /** The subset of `paths` whose path `main` does not hold at all, so a run
   *  refuses it with `not committed on main` and skips it. Absolute, built
   *  with the same construction as `paths` from the same relative strings,
   *  so the two compare with `Set.has` byte for byte. Every other entry of
   *  `paths` is STALE — present at `main` with older bytes, which the run
   *  gates and executes — and is deliberately not named on the wire, so the
   *  two lists cannot disagree about it (Decision 3 in the header). */
  absent: string[];
  /** False whenever this read could not be made — no git, not a repo, the
   *  project is not the repo toplevel, no `main` ref, a timeout — and, since
   *  task-45, whenever it could not be ASKED: a tracker project has no item
   *  files, so `ItemsService.uncommitted` answers this shape without reaching
   *  this module at all. The client
   *  renders NOTHING on `known: false`: an absent answer must never read as
   *  "nothing is uncommitted", since this feeds a render that asserts a fact
   *  about someone's repo. */
  known: boolean;
}

/** Fresh object per call — a shared constant would be one mutation away from
 *  leaking a previous caller's `paths` array. */
function unknown(): UncommittedItems {
  return { paths: [], absent: [], known: false };
}

/**
 * null for every failure alike — a timeout included — exactly as
 * `git-dates.util.ts`'s own `run` does and for the same reason: this is a
 * launch SURFACE, and an unreadable repo must degrade to "no answer" (`known:
 * false`) rather than 500 the sheet. Async and time-bounded (`runGit`) because
 * it runs inside a request (#277).
 */
function run(cwd: string, args: string[]): Promise<string | null> {
  return runGit(args, { cwd, maxBuffer: 32 * 1024 * 1024 });
}

/** Non-empty lines, which is all any of the three git reads produces. */
function lines(out: string): string[] {
  return out.split('\n').filter((line) => line !== '');
}

/**
 * Item files under `<projectPath>/backlog` whose working-tree state differs
 * from `main` — tracked-and-modified plus never-tracked-at-all.
 *
 * The two preconditions mirror `blobReaderAt`'s own (orchestrate.mjs) rather
 * than inventing looser ones, and that mirroring is the point: when the
 * project root is not the repo toplevel, or `main` does not resolve, the tool
 * has NO blob view and gates the working copy instead — so there is no
 * divergence to warn about and a chip would be a false positive. `known:
 * false` is the honest answer at exactly the same seam the tool stops asking.
 *
 * `-c core.quotePath=false` on all three reads for `lastCommitDates`' reason: the
 * default octal-escapes non-ASCII filenames, and the client matches these
 * strings against `BacklogItem.path` exactly.
 *
 * Every invocation carries BOTH `cwd` (from `run`) and an explicit `-C`, the
 * way `blobReaderAt` spells its own: they are the same directory here by
 * construction — the toplevel check above is what proves it — and the
 * redundancy is deliberate, because it makes each argument list say which
 * repository it is asking about instead of leaving that to a spawn option two
 * functions away.
 *
 * `base` is trusted here, not validated: `ItemsService.uncommitted` proves it
 * is an existing local branch (#254) before this runs, the way `resolveBase`
 * proves the orchestrate base before composition, so no caller text reaches
 * an argument list unchecked. A base that does not resolve still degrades to
 * `known: false` at the `rev-parse` below, the same seam `blobReaderAt` stops at.
 */
export async function uncommittedItemPaths(projectPath: string, base: string = UNCOMMITTED_BASE_REF): Promise<UncommittedItems> {
  const top = await run(projectPath, ['-C', projectPath, 'rev-parse', '--show-toplevel']);
  if (top === null) return unknown();
  try {
    if (realpathSync(top.trim()) !== realpathSync(projectPath)) return unknown();
  } catch {
    return unknown();
  }

  const resolved = await run(projectPath, ['-C', projectPath, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (resolved === null) return unknown();

  // Both reads are REQUIRED, and the asymmetry is the whole design: `diff`
  // never lists untracked files, and a brand-new never-committed item file is
  // untracked — which is the single most common shape of the failure this
  // module reports (verified 2026-09-07 against this machine's `ixray`, where
  // the diff printed nothing and `ls-files --others` printed the very bug the
  // 2026-09-06 sweep had recorded as skipped).
  const diffed = await run(projectPath, [
    '-C',
    projectPath,
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '--no-renames',
    base,
    '--',
    'backlog'
  ]);
  const untracked = await run(projectPath, ['-C', projectPath, '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', 'backlog']);
  // The third read answers each row's fate (Decision 3 in the header): every
  // path `main` holds under `backlog/`, so a flagged path missing from it is
  // absent. Quoted-path off for the same reason as the other two — an escaped
  // listing would not contain a raw non-ASCII path and would misreport an
  // edited item as absent.
  const atBase = await run(projectPath, ['-C', projectPath, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', base, '--', 'backlog']);
  // A failure of ANY of the three reads is a failure of the question:
  // reporting the part that worked — paths without their fates included —
  // would be a confident, incomplete statement of fact.
  if (diffed === null || untracked === null || atBase === null) return unknown();

  const held = new Set(lines(atBase));
  const rels = [...new Set([...lines(diffed), ...lines(untracked)])];
  // Built from `projectPath` verbatim with the same construction
  // `scanProject` uses for `BacklogItem.path`, so the client's `Set.has`
  // compare needs no realpath on either side — and both arrays come from the
  // same relative strings, so `absent` is a subset of `paths` byte for byte.
  const toAbs = (rel: string): string => join(projectPath, ...rel.split('/'));
  return { paths: rels.map(toAbs), absent: rels.filter((rel) => !held.has(rel)).map(toAbs), known: true };
}
