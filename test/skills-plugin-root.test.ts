import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * bug-56. Claude Code rewrites the BRACED `${CLAUDE_PLUGIN_ROOT}` in a plugin skill's text when it loads the skill, so the session reads an absolute path and
 * the shell never has to know the variable. The UNBRACED spelling is left in the text verbatim, and the command then works only if the variable happens to be
 * exported into the Bash tool's environment — which it sometimes is not: 22 first calls on this machine failed with `Cannot find module
 * '/skills/backlog/tools/backlog.mjs'` against 486 that worked, and each failure cost a session ~10 s to ~2 min rediscovering the install.
 *
 * So the unbraced spelling is banned from every file under `skills/`, not only the SKILL.md bodies that get substituted. `references/*.md` and the tools'
 * usage comments are read with the Read tool and never substituted, so there the two spellings mean the same thing to the shell — but a command copied
 * from one of them into a SKILL.md would carry the broken spelling back in, and one rule over the whole root is a rule nobody has to remember the edge of.
 *
 * Read as source, the way `test/claude-rules.test.ts` reads its files.
 */
const SKILLS_ROOT = join(__dirname, '..', 'skills');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const FILES = filesUnder(SKILLS_ROOT).filter((path) => /\.(md|mjs|js|json)$/.test(path));

describe('skills/ spell the plugin root the way Claude Code substitutes it', () => {
  it('has no unbraced $CLAUDE_PLUGIN_ROOT anywhere under skills/', () => {
    const offenders = FILES.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes('$CLAUDE_PLUGIN_ROOT') ? [`${relative(SKILLS_ROOT, path)}:${i + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
  });

  // Non-vacuity: the guard above passes trivially on a skill that stopped naming the plugin root at all, which would be its own bug — every one of the six
  // skills calls a tool that lives under the install, and there is no other way for a skill body to reach it.
  it.each(['backlog', 'backlog-capture', 'backlog-groom', 'backlog-execute', 'backlog-orchestrate', 'backlog-retro'])(
    '%s/SKILL.md calls its tools through ${CLAUDE_PLUGIN_ROOT}',
    (skill) => {
      const body = readFileSync(join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf8');
      expect(body).toMatch(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/[a-z-]+\/tools\/[a-z]+\.mjs"/);
    },
  );

  // The verify launcher hands the root to its child through `env`, inside single quotes the outer shell must not expand (SKILL.md §8). Once the root is
  // substituted into the text, the assignment is a literal path — which is exactly what it must still read as.
  it("step 8's verify launcher assigns BM_PLUGIN_ROOT from the braced root", () => {
    const body = readFileSync(join(SKILLS_ROOT, 'backlog-orchestrate', 'SKILL.md'), 'utf8');
    const launcher = body.split('\n').find((line) => line.startsWith('nohup env BM_PLUGIN_ROOT='));
    expect(launcher).toContain('BM_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"');
  });
});
