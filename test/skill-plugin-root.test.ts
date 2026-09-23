import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Claude Code fills in a plugin skill's plugin root by TEXT substitution when it loads the SKILL.md, and it matches only the braced form,
 * `${CLAUDE_PLUGIN_ROOT}`. The Bash tool's environment carries no such variable. So a command written with the bare `$CLAUDE_PLUGIN_ROOT` reaches the shell
 * untouched, expands to the empty string, and runs `node "/skills/…"` — which is how every skill in this repo shipped until sessions started printing
 * "CLAUDE_PLUGIN_ROOT unset" and guessing the plugin cache path by hand. Nothing else fails when this regresses: the skill loads, the command is plausible,
 * and the first sign is a MODULE_NOT_FOUND in somebody's run. Reasoning: docs/subsystems/skills.md, next to "The plugin install".
 *
 * The guard covers EVERY file under `skills/`, not only the SKILL.md files, and refuses the bare spelling anywhere — prose included. The `references/`
 * files and the tools' usage headers are never substituted, so their spelling does not decide whether a command works; it is guarded anyway because a
 * session copies commands out of them, and one placeholder spelling is the only thing `backlog-orchestrate` has to tell it how to replace. A bare mention
 * in prose would also be the one spelling a later sweep could not tell apart from a broken command, which is how the unbraced form survived the first fix.
 */
const SKILLS_DIR = join(__dirname, '..', 'skills');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'fixtures' ? [] : filesUnder(full);
    return /\.(md|mjs)$/.test(d.name) ? [full] : [];
  });
}

describe('plugin-root spelling under skills/', () => {
  it('finds every skill this repo publishes, and the files beside them', () => {
    const files = filesUnder(SKILLS_DIR).map((f) => relative(SKILLS_DIR, f));
    expect(files.filter((f) => f.endsWith('/SKILL.md')).length).toBe(6);
    expect(files).toContain('backlog-orchestrate/references/recovery.md');
    expect(files).toContain('backlog/tools/backlog.mjs');
  });

  it.each(filesUnder(SKILLS_DIR).map((f) => [relative(SKILLS_DIR, f)]))('%s spells the plugin root only in its braced form', (rel) => {
    const lines = readFileSync(join(SKILLS_DIR, rel), 'utf8').split('\n');
    const bare = lines.map((line, i) => [i + 1, line] as const).filter(([, line]) => /\$CLAUDE_PLUGIN_ROOT\b/.test(line));
    expect(bare.map(([n]) => n)).toEqual([]);
  });
});
