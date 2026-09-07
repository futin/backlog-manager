import cp = require('node:child_process');
import fs = require('node:fs');
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { UNCOMMITTED_BASE_REF, uncommittedItemPaths } from '../server/src/items/uncommitted.util';
import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeRegistry } from './helpers/store';

/**
 * Real temp repos, not a stubbed `execFileSync` — the same choice
 * test/git-dates.test.ts makes and for the same reason: what is under test is
 * mostly git's own output contract (which files `diff <commit>` lists against
 * a working tree, that `ls-files --others` is the ONLY read that sees an
 * untracked file, `core.quotePath=false`, pathspec scoping).
 */

function git(cwd: string, ...args: string[]): void {
  cp.execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * `main` is created explicitly rather than trusted: `git init`'s default
 * branch name is machine configuration (`init.defaultBranch`), so a fixture
 * that assumed it would pass or fail depending on whose laptop ran it — and
 * one case below depends on `main` being genuinely ABSENT, which only means
 * something if every other case put it there on purpose.
 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-uncommitted-'));
  git(dir, 'init', '-q', '.');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'checkout', '-q', '-b', 'main');
  return dir;
}

/** Takes a repo-relative POSIX path. */
function write(root: string, rel: string, text: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/** Repo-relative POSIX path → the absolute string the util reports. */
function abs(root: string, rel: string): string {
  return join(root, ...rel.split('/'));
}

describe('uncommittedItemPaths', () => {
  const roots: string[] = [];

  function freshRepo(): string {
    const root = repo();
    roots.push(root);
    return root;
  }

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  });

  // --- case 1 -----------------------------------------------------------
  it('case 1: reports nothing for an item committed on main with a clean tree', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(root, 'one');
    expect(uncommittedItemPaths(root)).toEqual({ paths: [], known: true });
  });

  // --- case 2 -----------------------------------------------------------
  it('case 2: reports a committed item that has since been edited in the working tree', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    write(root, 'backlog/tasks/open/task-1.md', 'also committed\n');
    commit(root, 'one');
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n\n## Fix\n\nreal words\n');

    expect(uncommittedItemPaths(root)).toEqual({
      paths: [abs(root, 'backlog/bugs/open/bug-1.md')],
      known: true
    });
  });

  // --- case 3 -----------------------------------------------------------
  //
  // The asymmetry the whole two-read design rests on, and the case a
  // `git diff`-only implementation silently loses: `diff <commit>` never
  // lists a file git has never tracked, and a brand-new never-committed item
  // file is exactly that. The second half of this case proves the test can
  // FAIL — it re-runs the util's own two git reads by hand with the
  // `ls-files --others` half removed and asserts the answer goes empty, so a
  // future "simplification" down to one spawn cannot leave this green.
  it('case 3: reports an item that exists on disk and was never committed at all', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(root, 'one');
    write(root, 'backlog/tasks/open/task-9.md', 'brand new\n');

    expect(uncommittedItemPaths(root)).toEqual({
      paths: [abs(root, 'backlog/tasks/open/task-9.md')],
      known: true
    });

    const diffOnly = cp.execFileSync(
      'git',
      ['-C', root, 'diff', '--name-only', '--no-renames', 'main', '--', 'backlog'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(diffOnly.trim()).toBe('');
  });

  // --- case 4 -----------------------------------------------------------
  it('case 4: reports an item committed on a branch main does not contain', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(root, 'one');
    git(root, 'checkout', '-q', '-b', 'side');
    write(root, 'backlog/tasks/open/task-9.md', 'on a branch\n');
    commit(root, 'two');

    // Pins Decision 2. `git status --porcelain` — the shape this deliberately
    // is NOT — reports this tree as entirely clean, because it compares
    // against HEAD and HEAD is the branch tip that has the file.
    const porcelain = cp.execFileSync('git', ['-C', root, 'status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(porcelain.trim()).toBe('');

    expect(uncommittedItemPaths(root)).toEqual({
      paths: [abs(root, 'backlog/tasks/open/task-9.md')],
      known: true
    });
  });

  // --- case 5 -----------------------------------------------------------
  it('case 5: does not report a staged file whose content is identical to main', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(root, 'one');
    // Staged, unchanged: `diff main` compares the WORKING TREE against main,
    // and this worktree holds exactly what a run's worktree from main would.
    git(root, 'add', 'backlog/bugs/open/bug-1.md');

    expect(uncommittedItemPaths(root)).toEqual({ paths: [], known: true });
  });

  // --- case 6 -----------------------------------------------------------
  //
  // The fixture is deliberately one a NAIVE implementation would answer, not
  // one that fails for a second reason: `main` exists and carries a commit,
  // and the subdirectory really does hold an item file git has never seen —
  // so with the toplevel check removed, both reads succeed and `ls-files
  // --others` prints that file relative to the subdirectory, and the util
  // reports a path. The check is what turns that into `known: false`, which
  // mirrors blobReaderAt's own precondition: with no blob view the tool gates
  // the working copy, so there is no divergence to warn about and a chip
  // would be a false positive.
  it('case 6: known: false when the project is a subdirectory rather than the repo toplevel', () => {
    const root = freshRepo();
    write(root, 'anchor.md', 'so main has a commit\n');
    commit(root, 'one');
    write(root, 'sub/backlog/bugs/open/bug-1.md', 'never committed\n');

    expect(uncommittedItemPaths(join(root, 'sub'))).toEqual({ paths: [], known: false });
  });

  // --- case 7 -----------------------------------------------------------
  //
  // An OUTCOME pin, and honestly not a pin on the `rev-parse --verify main`
  // precondition itself: with that check deleted, `diff main` and `ls-files`
  // both fail against a repo with no `main`, the "either read failed" clause
  // catches it, and this case stays green. That precondition earns its place
  // for the other two reasons — it mirrors `blobReaderAt`'s own so the two
  // stop asking at the same seam, and it costs one cheap spawn instead of two
  // doomed ones — neither of which is observable from out here. What IS
  // observable is that a project whose trunk is not called `main` gets a
  // silent no-answer rather than a wrong one, and that is what this asserts.
  it('case 7: known: false when the repo has no main ref at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'bm-uncommitted-master-'));
    roots.push(root);
    git(root, 'init', '-q', '.');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'checkout', '-q', '-b', 'master');
    write(root, 'backlog/bugs/open/bug-1.md', 'on master\n');
    commit(root, 'one');
    write(root, 'backlog/tasks/open/task-9.md', 'uncommitted\n');

    expect(uncommittedItemPaths(root)).toEqual({ paths: [], known: false });
  });

  // --- case 8 -----------------------------------------------------------
  it('case 8: known: false and no throw when the path is not inside any git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'bm-uncommitted-nogit-'));
    roots.push(plain);
    write(plain, 'backlog/bugs/open/bug-1.md', 'no repo here\n');
    expect(() => uncommittedItemPaths(plain)).not.toThrow();
    expect(uncommittedItemPaths(plain)).toEqual({ paths: [], known: false });
  });

  // --- case 9 -----------------------------------------------------------
  it('case 9: reports a non-ASCII filename as raw UTF-8, not octal-escaped', () => {
    const root = freshRepo();
    const rel = 'backlog/bugs/open/bug-1-café-ø.md';
    write(root, 'backlog/bugs/open/bug-2.md', 'anchor\n');
    commit(root, 'one');
    write(root, rel, 'never committed\n');

    const { paths, known } = uncommittedItemPaths(root);
    expect(known).toBe(true);
    // The escaped form git prints without `core.quotePath=false` would be
    // quoted and backslashed; asserting the exact absolute path is what
    // catches that, since a `\303\251` spelling matches no BacklogItem.path.
    expect(paths).toEqual([abs(root, rel)]);
    expect(paths[0]).toContain('café');
  });

  // --- case 10 ----------------------------------------------------------
  //
  // Guards Decision 1 against a future memo. `lastCommitDates`' memo is keyed
  // on the mtimes of `index` and `logs/HEAD`, and the edit below moves
  // NEITHER — so a memo copied over from that module would answer "clean"
  // here forever after the first call, which is precisely the false negative
  // this feature exists to remove.
  it('case 10: caches nothing — a working-tree edit after a first call is reported by the second', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(root, 'one');

    expect(uncommittedItemPaths(root)).toEqual({ paths: [], known: true });

    const indexBefore = fs.statSync(join(root, '.git', 'index')).mtimeMs;
    write(root, 'backlog/bugs/open/bug-1.md', 'edited in the working tree\n');
    expect(fs.statSync(join(root, '.git', 'index')).mtimeMs).toBe(indexBefore);

    expect(uncommittedItemPaths(root)).toEqual({
      paths: [abs(root, 'backlog/bugs/open/bug-1.md')],
      known: true
    });
  });

  // --- case 11 ----------------------------------------------------------
  it('case 11: ignores uncommitted files outside backlog/', () => {
    const root = freshRepo();
    write(root, 'backlog/bugs/open/bug-1.md', 'committed\n');
    write(root, 'README.md', 'committed\n');
    commit(root, 'one');
    write(root, 'README.md', 'dirty now\n');
    write(root, 'src/thing.ts', 'brand new, untracked\n');

    expect(uncommittedItemPaths(root)).toEqual({ paths: [], known: true });
  });
});

// =====================================================================
// The route. Same split test/merge-check.test.ts uses between a util's own
// suite and the HTTP one, and the same registry-gating cases.
// =====================================================================
describe('GET /api/items/uncommitted', () => {
  let app: INestApplication;
  let projectPath: string;
  /** A second registered project so case 12's answer proves the service
   *  resolved the RIGHT entry rather than the only one. */
  let otherPath: string;

  beforeEach(async () => {
    projectPath = repo();
    otherPath = repo();
    write(projectPath, 'backlog/bugs/open/bug-1.md', 'committed\n');
    commit(projectPath, 'one');
    write(projectPath, 'backlog/tasks/open/task-9.md', 'never committed\n');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }, { name: 'beta', path: otherPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(otherPath, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // --- case 12 ----------------------------------------------------------
  it('case 12: 200s with { paths, known } for a registered project', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/items/uncommitted')
      .query({ project: projectPath })
      .expect(200);
    // The uncommitted file of THIS project, not the other registered one —
    // which is clean, so a service that resolved the wrong entry would answer
    // an empty list here.
    expect(res.body).toEqual({ paths: [join(projectPath, 'backlog', 'tasks', 'open', 'task-9.md')], known: true });
  });

  // --- case 13 ----------------------------------------------------------
  it('case 13: 404s an unregistered project, and never asks git about it', async () => {
    // Never created on disk on purpose, exactly as merge-check's own
    // unregistered case is: what this pins is the ORDER — the registry gate
    // is a pure in-memory compare that runs BEFORE anything spawns git — not
    // merely the eventual status code, which a gate running afterwards would
    // also produce.
    //
    // The spy is on `execFileSync` rather than on `realpathSync`, and that
    // choice is the whole case: `uncommittedItemPaths` SPAWNS FIRST (`git
    // rev-parse --show-toplevel`) and only calls `realpathSync` on that
    // spawn's success, so against a path that does not exist a gate running
    // after the util would still never reach realpath — and a realpath spy
    // would sit there green while the server shelled out to git about an
    // arbitrary caller-supplied path. The first thing that leaves this
    // process is the first thing worth watching.
    const unregistered = join(tmpdir(), 'bm-uncommitted-unregistered-never-created');
    const spawnSpy = jest.spyOn(cp, 'execFileSync');
    await request(app.getHttpServer())
      .get('/api/items/uncommitted')
      .query({ project: unregistered })
      .expect(404, { error: 'not found' });
    const asked = spawnSpy.mock.calls.some(
      ([, args, opts]) =>
        JSON.stringify(args ?? []).includes(unregistered) ||
        String((opts as { cwd?: string } | undefined)?.cwd ?? '').startsWith(unregistered)
    );
    expect(asked).toBe(false);
    // Guards the guard: with the registry gate removed the util is reached,
    // its very first spawn happens, and the assertion above is what catches
    // it — so this line proves the spy was installed on the function the
    // implementation actually calls, rather than passing because nothing at
    // all was recorded.
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  // --- case 14 ----------------------------------------------------------
  it('case 14: 400s when project is absent, and when it is blank', async () => {
    await request(app.getHttpServer())
      .get('/api/items/uncommitted')
      .expect(400, { error: 'project is required' });
    await request(app.getHttpServer())
      .get('/api/items/uncommitted')
      .query({ project: '   ' })
      .expect(400, { error: 'project is required' });
  });
});

// =====================================================================
// Case 26 — the one thing two copies of the string `'main'` in two languages
// can be pinned by. `orchestrate.mjs` is not importable into the Nest build
// (it is a plugin-published `.mjs` tool, and one skill's tools may not be
// imported by anything else here), so its SOURCE is read and matched — the
// same technique test/server-bind.test.ts uses on main.ts.
// =====================================================================
describe('UNCOMMITTED_BASE_REF', () => {
  it("case 26: equals orchestrate.mjs's own BASE_REF_DEFAULT", () => {
    const source = readFileSync('skills/backlog-orchestrate/tools/orchestrate.mjs', 'utf8');
    const match = source.match(/^const BASE_REF_DEFAULT = '([^']+)'/m);
    // Asserted rather than optional-chained: a rename of the constant itself
    // must fail this test loudly instead of quietly skipping the comparison.
    expect(match).not.toBeNull();
    expect((match as RegExpMatchArray)[1]).toBe(UNCOMMITTED_BASE_REF);
  });
});
