import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// `import fs = require(...)`, not `import * as fs from 'node:fs'`: the
// latter compiles (esModuleInterop, this repo's tsconfig) through TS's own
// __importStar helper, which re-wraps every property as a non-configurable
// getter on a NEW object — jest.spyOn then throws "Cannot redefine
// property" on it, and even if it didn't, spying on that wrapper would never
// touch the actual `node:fs` module object merge-check.util.ts's plain named
// import calls into. `import fs = require(...)` compiles to a bare
// `require("node:fs")`, the same singleton Node hands back everywhere else,
// with every property still configurable.
import fs = require('node:fs');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { mergeCheck } from '../server/src/agents/merge-check.util';
import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeRegistry } from './helpers/store';

/** Writes `{ permissions: { allow } }` under `<root>/.claude/<filename>` and returns its path. */
function writeAllow(root: string, filename: 'settings.local.json' | 'settings.json', allow: unknown): string {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  writeFileSync(file, JSON.stringify({ permissions: { allow } }));
  return file;
}

/** Writes arbitrary (possibly non-JSON) text under `<root>/.claude/<filename>` and returns its path. */
function writeRaw(root: string, filename: string, contents: string): string {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  writeFileSync(file, contents);
  return file;
}

describe('mergeCheck (util)', () => {
  let projectRoot: string;
  let homeRoot: string;

  beforeEach(() => {
    // Two separate roots per case, neither ever containing a `.claude`
    // directory unless a case writes one — this is what lets case 5 (no
    // settings files at all) and every "only file X exists" case stay
    // unambiguous.
    projectRoot = mkdtempSync(join(tmpdir(), 'bm-merge-check-project-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'bm-merge-check-home-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('case 1: covers from project settings.local.json', () => {
    const file = writeAllow(projectRoot, 'settings.local.json', ['Bash(git merge:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: file });
  });

  it('case 2: covers from project settings.json when no local override exists', () => {
    const file = writeAllow(projectRoot, 'settings.json', ['Bash(git merge:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: file });
  });

  it('case 3: covers from home settings.json when neither project file exists', () => {
    const file = writeAllow(homeRoot, 'settings.json', ['Bash(git merge:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: file });
  });

  it('case 4: precedence — settings.local.json wins even when a lower file also covers', () => {
    // Deliberately skips the middle tier (project settings.json) so this
    // proves an explicit precedence ORDER rather than merely "the first
    // file that happens to exist" — local.json must win over home
    // settings.json even with nothing in between.
    const local = writeAllow(projectRoot, 'settings.local.json', ['Bash(git merge:*)']);
    writeAllow(homeRoot, 'settings.json', ['Bash(git merge:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: local });
  });

  it('case 5: no settings files at all', () => {
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: false, source: null });
  });

  it('case 6: malformed JSON degrades to not covered, and never throws', () => {
    writeRaw(projectRoot, 'settings.local.json', '{ this is not json');
    expect(() => mergeCheck(projectRoot, homeRoot)).not.toThrow();
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: false, source: null });
  });

  it('case 7: permissions.allow as a string instead of an array degrades to not covered', () => {
    writeRaw(projectRoot, 'settings.local.json', JSON.stringify({ permissions: { allow: 'Bash(git merge:*)' } }));
    expect(() => mergeCheck(projectRoot, homeRoot)).not.toThrow();
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: false, source: null });
  });

  it('case 8: a narrower prefix that still covers the flags the run issues', () => {
    const file = writeAllow(projectRoot, 'settings.local.json', ['Bash(git merge --no-ff:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: file });
  });

  it('case 9: a broader prefix covers too', () => {
    const file = writeAllow(projectRoot, 'settings.local.json', ['Bash(git:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: true, source: file });
  });

  it('case 10: a different git subcommand does not cover', () => {
    writeAllow(projectRoot, 'settings.local.json', ['Bash(git status:*)']);
    expect(mergeCheck(projectRoot, homeRoot)).toEqual({ covered: false, source: null });
  });
});

describe('GET /api/agents/merge-check', () => {
  let app: INestApplication;
  let projectPath: string;
  let homePath: string;
  // A second registered project, unused by cases 11-13 (they only ever name
  // `projectPath`) and present purely so cases 14-15 below have a WRONG
  // project to prove `AgentsService.mergeCheck` didn't pick — see those
  // cases' own comments for why a single registered project can't do that.
  let otherPath: string;
  const env = { ...process.env };

  beforeEach(async () => {
    projectPath = mkdtempSync(join(tmpdir(), 'bm-merge-check-http-project-'));
    otherPath = mkdtempSync(join(tmpdir(), 'bm-merge-check-http-other-'));
    // Overrides os.homedir() (it reads $HOME on POSIX, checked fresh on every
    // call, never cached) so this suite's answer never depends on whatever
    // the developer running it actually has in their own
    // ~/.claude/settings.json — without this, case 11 would be
    // machine-dependent instead of a fixed expectation.
    homePath = mkdtempSync(join(tmpdir(), 'bm-merge-check-http-home-'));
    process.env.HOME = homePath;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }, { name: 'beta', path: otherPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(otherPath, { recursive: true, force: true });
    rmSync(homePath, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('case 11: 200s with the covered/source shape for a registered project', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .query({ project: projectPath })
      .expect(200);
    expect(res.body).toEqual({ covered: false, source: null });
  });

  it('case 12: 404s an unregistered project, and never reads its filesystem', async () => {
    // Never created on disk on purpose: if the implementation's registry
    // gate ran AFTER a filesystem read (or not at all), an attempt to read
    // `<this path>/.claude/settings.local.json` would show up on the spy
    // below even though the read itself fails with ENOENT and is swallowed —
    // proving the ORDER, not just the eventual status code, is what this
    // case is for (see the brief's own framing of case 12).
    const unregistered = join(tmpdir(), 'bm-merge-check-unregistered-never-created');
    const spy = jest.spyOn(fs, 'readFileSync');
    await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .query({ project: unregistered })
      .expect(404, { error: 'not found' });
    const touchedUnregisteredPath = spy.mock.calls.some(([path]) => String(path).startsWith(unregistered));
    expect(touchedUnregisteredPath).toBe(false);
  });

  it('case 13: 400s when project is absent', async () => {
    await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .expect(400, { error: 'project is required' });
  });

  // --- Cases 14-15: prove the ROUTE wires the util correctly, not just that
  // the util itself is correct in isolation --------------------------------
  //
  // Cases 1-10 exercise `mergeCheck()` directly and cases 11-13 only ever
  // leave both `.claude` trees empty, so every one of the thirteen brief
  // cases returns (or must return) `{ covered: false, source: null }` at the
  // HTTP layer — none of them can tell a correct
  // `checkMergeCoverage(entry.path, homedir())` call apart from a broken one
  // that, say, swapped its two arguments or resolved the wrong registry
  // entry, because both mistakes still degrade to "nothing found" against an
  // all-empty fixture. These two cases each write a REAL covering entry into
  // a REAL settings file and assert the 200 body reports `covered: true`
  // with the matching `source`, which only happens if the service handed the
  // util the right project path in the right argument slot.

  it('case 14: threads the registered project\'s own path into the util as the PROJECT argument, not the home one', async () => {
    // Written to settings.local.json specifically, not settings.json: that
    // file is the util's project-side tier ONLY — it is never consulted as
    // the home-side candidate under any argument order — so if
    // AgentsService.mergeCheck ever called
    // `checkMergeCoverage(homedir(), entry.path)` (project and home swapped)
    // instead of the intended `checkMergeCoverage(entry.path, homedir())`,
    // the util would look for this project's covering entry under
    // `<projectPath>/.claude/settings.json` (the swapped call's third
    // candidate) — a file this test never writes — and report
    // `covered: false`, failing the assertion below instead of coincidentally
    // still passing it. A fixture using settings.json instead would not
    // catch that swap, because settings.json IS one of the swapped call's
    // real candidates.
    const file = writeAllow(projectPath, 'settings.local.json', ['Bash(git merge:*)']);
    const res = await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .query({ project: projectPath })
      .expect(200);
    expect(res.body).toEqual({ covered: true, source: file });
  });

  it('case 15: selects the registry entry matching the requested project, not some other registered project', async () => {
    // `beta` (otherPath) is the one with a covering entry; `alpha`
    // (projectPath) has none. A service that resolved the wrong registry
    // entry for a given `project` query — e.g. always taking
    // `registry.projects[0]` regardless of which path was asked for, or
    // matching on `name` instead of `path` — would answer this request with
    // alpha's (uncovered) result instead of beta's (covered) one, and this
    // assertion would catch that: it would see `covered: false` where
    // `covered: true` is expected.
    const file = writeAllow(otherPath, 'settings.local.json', ['Bash(git merge:*)']);
    const res = await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .query({ project: otherPath })
      .expect(200);
    expect(res.body).toEqual({ covered: true, source: file });

    // The other half of the same proof, run against the same fixture: asking
    // about alpha (which has no covering entry of its own) must NOT come
    // back contaminated with beta's coverage — the failure mode a
    // registry-wide "does ANY project cover this" bug would produce instead
    // of "does THIS project cover this".
    const alphaRes = await request(app.getHttpServer())
      .get('/api/agents/merge-check')
      .query({ project: projectPath })
      .expect(200);
    expect(alphaRes.body).toEqual({ covered: false, source: null });
  });
});
