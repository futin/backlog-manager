import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readAgentsConfig } from '../server/src/agents/config.util';

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
    expect(assignments('BM_AGENTS_URL'))
      .toEqual(['${BM_AGENTS_DOCKER_URL:-http://host.docker.internal:4173}']);
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
