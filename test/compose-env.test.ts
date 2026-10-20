import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readAgentsConfig } from '../server/src/agents/config.util';
import { JIRA_ENV, REPO_ROOTS_ENV } from '../server/src/jira/env.util';
import { GITHUB_TOKEN_ENV } from '../server/src/tracker/token.util';

/**
 * bug-25: `docker-compose.yml` sat for months with `BM_AGENTS: 'on'` as a
 * literal, four lines under its own comment promising "Dispatch is off unless
 * you turn it on", while README, .env.example and CLAUDE.md all documented the
 * off default. Nothing caught it because the only thing asserting the default
 * was prose sitting above the line — and the line and the prose drifted apart
 * inside one hunk that was only ever meant to touch BM_AGENTS_URL.
 *
 * So the assertion is on the file's own text, the way test/vite-proxy.test.ts
 * and test/csp.test.ts already assert config files: there is no YAML parser in
 * the dependency tree, and the value under test is a compose interpolation
 * (`${BM_AGENTS:-off}`) that a parser would hand back verbatim anyway.
 */
const COMPOSE = readFileSync(join(__dirname, '..', 'docker-compose.yml'), 'utf8');

/**
 * Every *uncommented* `KEY: value` assignment of `key`, quotes stripped.
 * Commented lines are skipped deliberately: the pair of lines this bug came
 * from shipped commented out and was uncommented later, so a check that could
 * not tell the two apart would have been green through the entire life of the
 * defect. The key is matched whole, so `BM_AGENTS` never collects
 * `BM_AGENTS_URL`.
 */
function assignments(key: string): string[] {
  const found: string[] = [];
  for (const line of COMPOSE.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== key) continue;
    found.push(match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return found;
}

describe('docker-compose BM_AGENTS', () => {
  it('passes the host value through with the documented off default', () => {
    expect(assignments('BM_AGENTS')).toEqual(['${BM_AGENTS:-off}']);
  });

  it('never assigns a value the server would read as enabled', () => {
    // Driven through readAgentsConfig itself rather than a hand-copied list of
    // on/1/true: that vocabulary lives in config.util.ts, and a second copy of
    // it here is the copy that goes stale. Any literal compose might grow back
    // is checked against the real gate; a `${...}` interpolation is not a
    // literal and trivially reads as off here, which is what makes assertion
    // one above the load-bearing half of the pair.
    for (const value of assignments('BM_AGENTS')) {
      expect(readAgentsConfig({ BM_AGENTS: value }).enabled).toBe(false);
    }
  });

  it('overrides BM_AGENTS_URL under a second name, never a passthrough of itself', () => {
    // Topology, not policy: inside the stack the loopback form .env.example
    // documents for `pnpm run dev` is wrong, so a passthrough of BM_AGENTS_URL
    // itself would let that host-oriented line flow in and silently break
    // dispatch in the container. The override therefore rides a DIFFERENT key,
    // and the default is still the documented Docker Desktop topology — so a
    // `cp .env.example .env` install reaches the same address it always did.
    expect(assignments('BM_AGENTS_URL')).toEqual(['${BM_AGENTS_DOCKER_URL:-http://host.docker.internal:4173}']);
  });

  it('never interpolates the host-oriented key into the container', () => {
    // The load-bearing half of the pair above. Asserting the exact string is
    // what pins the default, but this is what pins the SEPARATION: a later
    // edit that "simplifies" the two names back into one — `${BM_AGENTS_URL:-…}`
    // — matches the shape of the line it replaces and would read as a cleanup.
    // Matched against the whole file rather than this one assignment, because
    // the mistake is just as wrong anywhere else in it.
    expect(COMPOSE).not.toMatch(/\$\{BM_AGENTS_URL[:}]/);
  });
});

/**
 * The same shape for the GitHub credential (task-45). Extended in THIS file
 * rather than a second one on purpose: the rule is "how compose passes an
 * environment value through", it already has a home, and a `compose-token.test.ts`
 * beside it would be a second place to remember when the next variable lands.
 *
 * The stake is higher than BM_AGENTS': a literal here is not a wrong default,
 * it is a credential committed to a public repository, and the fix for that is
 * revoking the token rather than editing the line.
 */
describe('docker-compose BM_GITHUB_TOKEN', () => {
  it('passes the host value through with an empty default', () => {
    expect(assignments('BM_GITHUB_TOKEN')).toEqual(['${BM_GITHUB_TOKEN:-}']);
  });

  it('holds no literal token', () => {
    // Every assignment of the key must BE an interpolation — the check is
    // "starts with ${", not a guess at what a token looks like. GitHub has
    // shipped several token prefixes (ghp_, gho_, github_pat_, and the classic
    // 40-hex form) and a pattern list would be the thing that goes stale; a
    // value that is not an interpolation is wrong whatever it looks like.
    for (const value of assignments('BM_GITHUB_TOKEN')) {
      expect(value.startsWith('${')).toBe(true);
    }
  });

  it('spells the variable the way the server reads it', () => {
    // The server's own constant, not a string copied into this test: a rename
    // that missed compose would otherwise pass here and fail only on a machine
    // with a token set.
    expect(assignments(GITHUB_TOKEN_ENV)).toEqual(['${BM_GITHUB_TOKEN:-}']);
  });
});

/**
 * The same shape again for the three Jira credentials (Jira phase 1, spec §10 and §12) — extended here for the reason the GitHub block gives: the rule is "how
 * compose passes an environment value through", and it already has a home. All three, not only the token: the email is half of the Basic credential and the
 * site is the host that credential is sent to, so a literal for any of them is one machine's account committed to a public repository. Asserted through
 * `JIRA_ENV`, the server's own spellings, so a rename that missed compose fails here rather than on a machine with Jira set.
 */
describe('docker-compose BM_JIRA_SITE / BM_JIRA_EMAIL / BM_JIRA_TOKEN', () => {
  it.each(Object.values(JIRA_ENV))('passes %s through with an empty default', (key) => {
    expect(assignments(key)).toEqual([`\${${key}:-}`]);
  });

  it.each(Object.values(JIRA_ENV))('holds no literal value for %s', (key) => {
    // An interpolation or nothing — the GitHub case's check, for the same reason: a pattern for what a token (or an email, or a site) looks like is the
    // thing that goes stale, and a value that is not an interpolation is wrong whatever it looks like.
    const found = assignments(key);
    expect(found.length).toBeGreaterThan(0);
    for (const value of found) expect(value.startsWith('${')).toBe(true);
  });

  it('spells the three variables the way the server reads them', () => {
    expect(JIRA_ENV).toEqual({ site: 'BM_JIRA_SITE', email: 'BM_JIRA_EMAIL', token: 'BM_JIRA_TOKEN' });
  });
});

/**
 * #225 — the server's copy of the machine name, read by the board's Release claim on a session it did not dispatch. A passthrough with an empty default,
 * because a hostname read inside the container is its id and would match no claim, and a literal here would be one machine's name on every machine.
 */
describe('docker-compose BM_MACHINE_NAME', () => {
  it('passes the host value through with an empty default', () => {
    expect(assignments('BM_MACHINE_NAME')).toEqual(['${BM_MACHINE_NAME:-}']);
  });
});

/**
 * #15 — the server's TypeScript watch polls, in the container only. `nest start --watch` runs tsc's own `createWatchProgram`, not chokidar, and on a Docker
 * Desktop virtiofs bind mount its inode-bound `fs.watch` per file went silent twice over: a file replaced by `git merge` lost its watch for good, and the
 * long-lived inotify instance later stopped being fed at all — so the stack kept serving a pre-merge build with nothing on the board to say so. tsc reads
 * these two variables only while no tsconfig carries `watchOptions`, which is why they live here and not in a tsconfig the host `pnpm run dev` and every
 * editor would also read.
 */
describe('docker-compose TSC_WATCHFILE / TSC_WATCHDIRECTORY', () => {
  it('polls source files with dynamic priority', () => {
    expect(assignments('TSC_WATCHFILE')).toEqual(['DynamicPriorityPolling']);
  });

  it('polls directories with dynamic priority, in the directory variable\'s own vocabulary', () => {
    // Not the file variable's spelling: tsc's updateOptionsForWatchDirectory accepts only the two `RecursiveDirectoryUsing…` values and falls back to
    // inotify for anything else without a word, so `'DynamicPriorityPolling'` here read as configured and changed nothing (review of #15, fix loop 1).
    expect(assignments('TSC_WATCHDIRECTORY')).toEqual(['RecursiveDirectoryUsingDynamicPriorityPolling']);
  });
});

/**
 * Jira repo/branch, Task 3 (spec §4) — the second read-only project root, and the variable that tells the server where both roots are. The Timify repos live
 * under `~/Documents/timify-projects`, which the container cannot see until compose mounts it; `BM_REPO_ROOTS` is how `refs.util.ts` tells "not mounted into
 * the board" from "does not exist". The mount's source and target are the same interpolation, so the path means the same thing on both sides, and each root in
 * the variable carries the same default its mount uses — a root that drifted from its mount would name a directory the container does not have.
 */
describe('docker-compose BM_JIRA_REPO_ROOT / BM_REPO_ROOTS', () => {
  const PROJECT_ROOT = '${BM_PROJECT_ROOT:-${HOME}/Documents/custom-projects}';
  const JIRA_ROOT = '${BM_JIRA_REPO_ROOT:-${HOME}/Documents/timify-projects}';

  /** Every uncommented `- <volume>` list item, quotes stripped. */
  const mounts = COMPOSE.split('\n')
    .map((line) => /^\s*-\s+(.*?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/^(['"])(.*)\1$/, '$2'));

  it('mounts the Jira repo root read-only at the same path', () => {
    expect(mounts.filter((m) => m.includes('BM_JIRA_REPO_ROOT'))).toEqual([`${JIRA_ROOT}:${JIRA_ROOT}:ro`]);
  });

  it('still mounts the project root read-only at the same path', () => {
    expect(mounts).toContain(`${PROJECT_ROOT}:${PROJECT_ROOT}:ro`);
  });

  it('names both roots to the server, each with the default its mount uses', () => {
    expect(assignments(REPO_ROOTS_ENV)).toEqual([`${PROJECT_ROOT}:${JIRA_ROOT}`]);
  });
});
