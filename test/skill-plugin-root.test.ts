import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code fills in a plugin skill's plugin root by TEXT substitution when it loads the SKILL.md, and it matches only the braced form,
 * `${CLAUDE_PLUGIN_ROOT}`. The Bash tool's environment carries no such variable. So a command written with the bare `$CLAUDE_PLUGIN_ROOT` reaches the shell
 * untouched, expands to the empty string, and runs `node "/skills/…"` — which is how every skill in this repo shipped until sessions started printing
 * "CLAUDE_PLUGIN_ROOT unset" and guessing the plugin cache path by hand. Nothing else fails when this regresses: the skill loads, the command is plausible,
 * and the first sign is a MODULE_NOT_FOUND in somebody's run. Reasoning: docs/subsystems/skills.md, next to "The plugin install".
 *
 * Only the COMMAND form is refused — a quoted `"$CLAUDE_PLUGIN_ROOT` — so prose may still name the unfilled placeholder, which backlog-orchestrate has to do
 * to tell a session what to replace it with in a file it read by hand. `references/` files are never substituted at all and are out of scope here.
 */
const SKILLS_DIR = join(__dirname, '..', 'skills');

function skillFiles(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(SKILLS_DIR, d.name, 'SKILL.md'));
}

describe('SKILL.md plugin-root spelling', () => {
  it('finds every skill this repo publishes', () => {
    expect(skillFiles().length).toBe(6);
  });

  it.each(skillFiles().map((f) => [f.slice(SKILLS_DIR.length + 1)]))('%s quotes the plugin root only in its braced form', (rel) => {
    const lines = readFileSync(join(SKILLS_DIR, rel), 'utf8').split('\n');
    const bare = lines.map((line, i) => [i + 1, line] as const).filter(([, line]) => /"\$CLAUDE_PLUGIN_ROOT\b/.test(line));
    expect(bare.map(([n]) => n)).toEqual([]);
  });
});
