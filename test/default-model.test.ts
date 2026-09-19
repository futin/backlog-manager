import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MODEL, MODELS } from '../shared/agent';

/**
 * `DEFAULT_MODEL` is the one place the model a spawn gets by default is chosen,
 * but two of the places it has to reach are not TypeScript: `backlog-orchestrate`'s
 * dispatch lines are shell inside SKILL.md, and the reviewer's model is agent
 * frontmatter. Neither can import `shared/` — the plugin publishes `skills/` and
 * `agents/` only — so each carries the literal, and this suite reads their text
 * and holds them to the constant, the way test/compose-env.test.ts holds the
 * compose file to its interpolation. Changing `DEFAULT_MODEL` goes red here until
 * both follow. Reason for the rule: a bare `claude -p` took the host CLI's own
 * default (Sonnet), so an orchestrated item ran on a different model from the
 * driver that the board had launched as Opus.
 */
const ROOT = join(__dirname, '..');
const SKILL = readFileSync(join(ROOT, 'skills', 'backlog-orchestrate', 'SKILL.md'), 'utf8');
const REVIEWER = readFileSync(join(ROOT, 'agents', 'backlog-reviewer.md'), 'utf8');

describe('DEFAULT_MODEL', () => {
  it('is a model this build offers', () => {
    expect(MODELS).toContain(DEFAULT_MODEL);
  });

  it('is on every headless dispatch line in backlog-orchestrate/SKILL.md', () => {
    // Every shell line that launches a session, first dispatch and retry alike.
    const launches = SKILL.split('\n').filter((l) => /exec claude -p/.test(l));
    expect(launches).toHaveLength(2);
    for (const line of launches) {
      expect(line).toContain(` --model ${DEFAULT_MODEL} `);
    }
  });

  it("is the reviewer agent's frontmatter model", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(REVIEWER)?.[1] ?? '';
    expect(/^model:\s*(\S+)\s*$/m.exec(front)?.[1]).toBe(DEFAULT_MODEL);
  });
});
