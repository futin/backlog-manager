import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  PR_RESOLVE_LOCK_TTL_MS,
  PR_RESOLVE_OUTCOMES,
  fileKey,
  parseFileKey,
  parseResolveBody,
  prResolveHome
} from '../../server/src/agents/pr-resolve.util';

/**
 * #599: the server's pr-resolve route reads files the `pr-resolve` skill's tool writes, and it cannot import that tool — skills are self-contained, and the
 * server never reaches into a skill's `tools/` — so `server/src/agents/pr-resolve.util.ts` holds a COPY of five of the tool's rules: the home, the file key,
 * the target grammar, the outcome list and the lock TTL. This suite is the one thing holding the copies together. A red case here means the two sides
 * disagree: change BOTH copies, never only the side this suite reads.
 *
 * The tool side is read the way `test/agents/review-shared.test.ts` reads `review.mjs`: by RUNNING its CLI where it exposes the rule (`parse` prints the
 * paths it would use), and by reading its source only where no command prints the value (the outcome list, the lock TTL). Before this suite the util's
 * header named `test/agents/agents-dispatch-pr-resolve.test.ts` as the guard, but that suite builds its fixtures through the SERVER's own `fileKey`, so both
 * sides of every assertion were the same copy and a drift stayed green.
 */

const ROOT = join(__dirname, '..', '..');
const TOOLS = join(ROOT, 'skills', 'pr-resolve', 'tools');
const CLI = join(TOOLS, 'pr-resolve.mjs');
const LIB = join(TOOLS, 'pr-resolve-lib.mjs');

interface Parsed {
  repo: string;
  number: number;
  reclaim: string | null;
  tree: string;
  baseTree: string;
  lockFile: string;
  outcomeFile: string;
}

/** The tool's `parse <target>` under `env`: its exit status, and its JSON when it exited 0. */
function parse(target: string, env: NodeJS.ProcessEnv): { status: number | null; out: Parsed | null } {
  const r = spawnSync(process.execPath, [CLI, 'parse', target], { env, encoding: 'utf8' });
  return { status: r.status, out: r.status === 0 ? (JSON.parse(r.stdout) as Parsed) : null };
}

/** The process env with the home override set to `home`, or removed and `HOME` pointed at `home` when `override` is false. */
function envWith(home: string, override: boolean): NodeJS.ProcessEnv {
  const { BM_PR_RESOLVE_HOME: _drop, ...rest } = process.env;
  return override ? { ...rest, BM_PR_RESOLVE_HOME: home } : { ...rest, HOME: home };
}

describe('pr-resolve twin: the server copies agree with the skill tool', () => {
  // Case 1. The override home and the key together decide every path the server reads; computed here through the SERVER's functions and compared with what
  // the tool prints, plus the literal, so a change made identically on both sides still has to be made deliberately here.
  it('fileKey and the override home agree with the paths parse prints', () => {
    const home = mkdtempSync(join(tmpdir(), 'pr-resolve-twin-'));
    const { status, out } = parse('acme/my__lib#12', envWith(home, true));
    expect(status).toBe(0);
    const serverHome = prResolveHome({ BM_PR_RESOLVE_HOME: home });
    expect(out?.outcomeFile).toBe(join(serverHome, `${fileKey('acme/my__lib', 12)}.json`));
    expect(out?.lockFile).toBe(join(serverHome, 'locks', `${fileKey('acme/my__lib', 12)}.lock`));
    expect(out?.outcomeFile).toBe(`${home}/acme__my__lib__12.json`);
  });

  // Case 2. With no override both sides fall back to `~/.backlog-manager/pr-resolve`. The tool reads the home through the child's env and the server through
  // this process's, so the two are compared through the same suffix rather than one absolute path.
  it('the default home agrees', () => {
    const home = mkdtempSync(join(tmpdir(), 'pr-resolve-twin-home-'));
    const { status, out } = parse('futin/backlog-manager#7', envWith(home, false));
    expect(status).toBe(0);
    expect(out?.outcomeFile).toBe(join(home, '.backlog-manager', 'pr-resolve', 'futin__backlog-manager__7.json'));
    expect(prResolveHome({})).toBe(join(homedir(), '.backlog-manager', 'pr-resolve'));
  });

  // Case 3. The server lists outcome files by splitting a name back into a target; the tool has no inverse, so its keys are what that split must undo.
  it('parseFileKey inverts the key the tool writes', () => {
    const rows: [string, NodeJS.ProcessEnv][] = [
      ['acme/my__lib#12', envWith(mkdtempSync(join(tmpdir(), 'pr-resolve-twin-')), true)],
      ['futin/backlog-manager#7', envWith(mkdtempSync(join(tmpdir(), 'pr-resolve-twin-home-')), false)]
    ];
    for (const [target, env] of rows) {
      const { out } = parse(target, env);
      expect(out).not.toBeNull();
      expect(parseFileKey(basename((out as Parsed).outcomeFile, '.json'))).toEqual({ repo: out?.repo, number: out?.number });
    }
  });

  // Case 4. The board's body is the tool's target split in two: whatever one side accepts the other must too, or a click dispatches a session whose first
  // `parse` refuses it (or the route refuses a PR the tool could resolve). A leading-zero number has no server-side spelling (`number` is a JSON number).
  it.each<[string, { repo: string; number: number }, boolean]>([
    ['acme/my__lib#12', { repo: 'acme/my__lib', number: 12 }, true],
    ['futin/backlog-manager#7', { repo: 'futin/backlog-manager', number: 7 }, true],
    ['a-b/c.d_e#1', { repo: 'a-b/c.d_e', number: 1 }, true],
    ['acme_x/lib#1', { repo: 'acme_x/lib', number: 1 }, false],
    ['acme/lib#0', { repo: 'acme/lib', number: 0 }, false],
    ['acme/li b#3', { repo: 'acme/li b', number: 3 }, false],
    ['acme#3', { repo: 'acme', number: 3 }, false]
  ])('the target grammar agrees on %s', (target, body, accepted) => {
    const home = mkdtempSync(join(tmpdir(), 'pr-resolve-twin-'));
    expect(parse(target, envWith(home, true)).status === 0).toBe(accepted);
    expect(parseResolveBody(body) !== null).toBe(accepted);
  });

  // Case 5. The server drops an outcome file whose `outcome` is not on its list, so a value the tool learns to write and the server does not reads as no
  // outcome at all. Typecheck cannot see this: the tool is plain JavaScript.
  it('the outcome list agrees with the one the outcome command checks', () => {
    const source = readFileSync(CLI, 'utf8');
    const m = /!\[([^\]]*)\]\.includes\(values\.outcome\)/.exec(source);
    if (m === null) throw new Error(`${CLI} no longer checks --outcome with ![…].includes(values.outcome) — re-point this case at wherever it does`);
    const tool = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    expect(tool).toEqual([...PR_RESOLVE_OUTCOMES]);
    expect(tool).toEqual(['pushed', 'stopped', 'up-to-date']);
  });

  // Case 6. The server honours a lock that names no session for exactly as long as the tool does; a shorter copy dispatches over a live resolve, a longer
  // one refuses a PR the tool would already let through.
  it('the lock TTL agrees with LOCK_TTL_MS', () => {
    const source = readFileSync(LIB, 'utf8');
    const m = /^const LOCK_TTL_MS = ([^;]+);/m.exec(source);
    if (m === null) throw new Error(`${LIB} no longer declares const LOCK_TTL_MS = …; — re-point this case at wherever the TTL lives`);
    const factors = m[1].split('*').map((f) => f.trim());
    for (const f of factors) if (!/^[0-9][0-9_]*$/.test(f)) throw new Error(`${LIB}: LOCK_TTL_MS is no longer a product of integer literals (${m[1]})`);
    const product = factors.reduce((acc, f) => acc * Number(f.replace(/_/g, '')), 1);
    expect(product).toBe(PR_RESOLVE_LOCK_TTL_MS);
    expect(product).toBe(10_800_000);
  });
});
