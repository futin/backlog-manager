import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every model-invocable skill's and agent's `description:` is preloaded into EVERY Claude Code session that has this plugin installed — not only sessions
 * in this repo — so each byte here is billed on every turn of every session on the machine. #557 cut them from 4,911 B to routing information only: what the
 * skill does, the phrases a person or a dispatch prompt actually uses, and at most one "Not for X — that is /Y" line. Mechanism and guarantees live in the
 * SKILL.md body, which loads only when the skill runs. Reasoning: docs/subsystems/skills.md, "Descriptions carry routing only".
 *
 * Two skills are typed-only (`disable-model-invocation: true`): nothing chooses them by description, so their description is not preloaded at all.
 * `backlog-tick` is started only by the dashboard's routines, as a typed `/backlog-manager:backlog-tick`; `backlog-retro` is typed by a person and invoked by
 * nothing in `server/`, `client/` or another skill. Four others MUST stay model-invocable, because something reaches them by natural language or the Skill
 * tool, and flagging one would break that caller silently — the skill would simply never load.
 *
 * Frontmatter is read by regex, not a YAML parser: the repo carries no direct YAML dependency, and the shape this guard pins (a `>`/`>-` block scalar of
 * two-space-indented lines) is exactly what makes a regex sufficient. A plain-scalar description is refused because a `: ` inside one breaks YAML parsing.
 */
const REPO = join(__dirname, '..', '..');

interface Entry {
  file: string;
  name: string;
  description: string;
  typedOnly: boolean;
}

function frontmatterOf(file: string): string {
  const text = readFileSync(join(REPO, file), 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw new Error(`${file} has no frontmatter`);
  return front[1];
}

/** The folded value: block-scalar lines joined with single spaces — the measure #557's figures use. `null` when the description is not a `>`/`>-` block. */
function foldedDescription(front: string): string | null {
  const block = front.match(/^description: >-?\n((?: {2}.*\n?)+)/m);
  if (!block) return null;
  return block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

const FILES = [
  ...readdirSync(join(REPO, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `skills/${d.name}/SKILL.md`),
  ...readdirSync(join(REPO, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `agents/${f}`)
];

const ENTRIES: Entry[] = FILES.map((file) => {
  const front = frontmatterOf(file);
  return {
    file,
    name: front.match(/^name: (.+)$/m)?.[1] ?? '',
    description: foldedDescription(front) ?? '',
    typedOnly: /^disable-model-invocation: true$/m.test(front)
  };
});

const byName = (name: string): Entry => {
  const entry = ENTRIES.find((e) => e.name === name);
  if (!entry) throw new Error(`no skill or agent named ${name}`);
  return entry;
};

/**
 * A RATCHET, not a target: the measured post-trim total (2,398 B at #557) rounded up to the next 100. Lower it when a trim lands; raise it only with a
 * reason in the PR — a new skill's description is the usual one, and the cheaper move is a shorter description or a typed-only flag.
 */
const MODEL_INVOCABLE_BUDGET = 2400;

/** The skills something reaches without a typed slash command, and the caller that would break if one became typed-only. */
const MUST_STAY_INVOCABLE: Record<string, string> = {
  'backlog-groom': 'server/src/agents/prompt.util.ts ("Use the backlog-manager:backlog-groom skill …") and backlog-tick step 2 (the Skill tool)',
  'backlog-execute': 'server/src/agents/prompt.util.ts ("Use the backlog-manager:backlog-execute skill …") and backlog-tick step 2 (the Skill tool)',
  'backlog-capture': 'server/src/agents/prompt.util.ts ("Use the backlog-manager:backlog-capture skill …")',
  jira: 'server/src/jira/prompt.util.ts ("Use the backlog-manager:jira skill to run: …")'
};

describe('skill and agent descriptions', () => {
  it('reads every skill and the one agent', () => {
    expect(FILES.filter((f) => f.startsWith('skills/')).length).toBe(10);
    expect(FILES.filter((f) => f.startsWith('agents/'))).toEqual(['agents/backlog-reviewer.md']);
  });

  it.each(FILES)('%s has a non-empty > or >- block-scalar description', (file) => {
    expect(foldedDescription(frontmatterOf(file))).toMatch(/\S/);
  });

  it.each(FILES)('%s carries no Trigger: trailer — the trigger: key already holds it, and it is not preloaded', (file) => {
    expect(foldedDescription(frontmatterOf(file)) ?? '').not.toContain('Trigger:');
  });

  it('backlog-tick and backlog-retro are typed-only, and no other skill is', () => {
    expect(ENTRIES.filter((e) => e.typedOnly).map((e) => e.name).sort()).toEqual(['backlog-retro', 'backlog-tick']);
  });

  it.each(Object.entries(MUST_STAY_INVOCABLE))('%s stays model-invocable', (name, caller) => {
    if (byName(name).typedOnly) throw new Error(`${name} carries disable-model-invocation, which breaks ${caller}`);
  });

  it.each([
    ['backlog-groom', /groom/i],
    ['backlog-execute', /execute|fix/i],
    ['backlog-capture', /capture|file/i]
  ])('%s still names its own verb', (name, verb) => {
    expect(byName(name).description).toMatch(verb);
  });

  it('the model-invocable descriptions stay under the ratchet', () => {
    expect(MODEL_INVOCABLE_BUDGET).toBeLessThanOrEqual(2600);
    const sizes = ENTRIES.filter((e) => !e.typedOnly).map((e) => `${Buffer.byteLength(e.description)} ${e.file}`);
    const total = ENTRIES.filter((e) => !e.typedOnly).reduce((sum, e) => sum + Buffer.byteLength(e.description), 0);
    if (total > MODEL_INVOCABLE_BUDGET) {
      throw new Error(`model-invocable descriptions total ${total} B, over the ${MODEL_INVOCABLE_BUDGET} B ratchet:\n${sizes.join('\n')}`);
    }
  });
});
