import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * uncommitted.util.ts — which item files the working tree holds that a
 * board-started orchestrator run would NOT be able to see.
 *
 * A run gates every item at `<base>` (`BASE_REF_DEFAULT` in
 * `skills/backlog-orchestrate/tools/orchestrate.mjs`, and the board never
 * passes `--base`, so `main` is the ref for every board-started run there
 * will ever be), while the board's own item scan reads the WORKING TREE. The
 * two disagree exactly when someone groomed an item and did not commit it,
 * and then the sheet previews a ready bug, the run reports `not committed on
 * main — the worktree this run creates from main would not contain <path>`,
 * and the item is skipped after the person has walked away. This read is what
 * lets the Orchestrate sheet say so BEFORE the run starts (task-32).
 *
 * Two decisions a later reader will otherwise "fix", both deliberate:
 *
 * 1. **Nothing here is memoised, and this must never join `lastCommitDates`'
 *    memo** (git-dates.util.ts). That memo is keyed on the mtimes of `index`
 *    and `logs/HEAD` — the files git rewrites when the answer to *its*
 *    question can change. Editing an item file in the working tree, which is
 *    the exact event this module reports, moves NEITHER, so a memo on that
 *    key would answer "clean" forever after its first hit: it would
 *    reintroduce the false negative this feature exists to remove. The cost
 *    is affordable without one — both spawns together measured 50–270ms per
 *    project, and this runs for ONE project ONCE per sheet open, never on the
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
 */

/**
 * The ref a board-started run gates at. Named rather than inlined because it
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
  /** False whenever this read could not be made — no git, not a repo, the
   *  project is not the repo toplevel, no `main` ref, a timeout. The client
   *  renders NOTHING on `known: false`: an absent answer must never read as
   *  "nothing is uncommitted", since this feeds a render that asserts a fact
   *  about someone's repo. */
  known: boolean;
}

/** Fresh object per call — a shared constant would be one mutation away from
 *  leaking a previous caller's `paths` array. */
function unknown(): UncommittedItems {
  return { paths: [], known: false };
}

/**
 * null for every failure alike, exactly as `git-dates.util.ts`'s own `run`
 * does and for the same reason: this is a launch SURFACE, and an unreadable
 * repo must degrade to "no answer" rather than 500 the sheet. Bounded because
 * it runs synchronously inside a request.
 */
function run(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

/** Non-empty lines, which is all either git read produces. */
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
 * `-c core.quotePath=false` on both spawns for `lastCommitDates`' reason: the
 * default octal-escapes non-ASCII filenames, and the client matches these
 * strings against `BacklogItem.path` exactly.
 *
 * Every invocation carries BOTH `cwd` (from `run`) and an explicit `-C`, the
 * way `blobReaderAt` spells its own: they are the same directory here by
 * construction — the toplevel check above is what proves it — and the
 * redundancy is deliberate, because it makes each argument list say which
 * repository it is asking about instead of leaving that to a spawn option two
 * functions away.
 */
export function uncommittedItemPaths(projectPath: string): UncommittedItems {
  const top = run(projectPath, ['-C', projectPath, 'rev-parse', '--show-toplevel']);
  if (top === null) return unknown();
  try {
    if (realpathSync(top.trim()) !== realpathSync(projectPath)) return unknown();
  } catch {
    return unknown();
  }

  const resolved = run(projectPath, [
    '-C', projectPath, 'rev-parse', '--verify', '--quiet', `${UNCOMMITTED_BASE_REF}^{commit}`
  ]);
  if (resolved === null) return unknown();

  // Both reads are REQUIRED, and the asymmetry is the whole design: `diff`
  // never lists untracked files, and a brand-new never-committed item file is
  // untracked — which is the single most common shape of the failure this
  // module reports (verified 2026-09-07 against this machine's `ixray`, where
  // the diff printed nothing and `ls-files --others` printed the very bug the
  // 2026-09-06 sweep had recorded as skipped).
  const diffed = run(projectPath, [
    '-C', projectPath, '-c', 'core.quotePath=false',
    'diff', '--name-only', '--no-renames', UNCOMMITTED_BASE_REF, '--', 'backlog'
  ]);
  const untracked = run(projectPath, [
    '-C', projectPath, '-c', 'core.quotePath=false',
    'ls-files', '--others', '--exclude-standard', '--', 'backlog'
  ]);
  // A failure of EITHER read is a failure of the question: reporting the half
  // that worked would be a confident, incomplete statement of fact.
  if (diffed === null || untracked === null) return unknown();

  const rels = new Set([...lines(diffed), ...lines(untracked)]);
  // Built from `projectPath` verbatim with the same construction
  // `scanProject` uses for `BacklogItem.path`, so the client's `Set.has`
  // compare needs no realpath on either side.
  return { paths: [...rels].map((rel) => join(projectPath, ...rel.split('/'))), known: true };
}
