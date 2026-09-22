import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * task-40's test case 6. The Escape rule is stated at three depths — the headline in `CLAUDE.md`, the mechanism bullet in `.claude/rules/board.md`, the
 * reasoning in `invariants.md` — and the one thing that can silently rot is the COUNT: the code has three callers, the docs said four for as long as it took
 * someone to notice. The count lives in the second and third tiers; the headline is pinned only so a reader arriving from CLAUDE.md still finds the rule.
 *
 * Read as text, the way `test/claude-rules.test.ts` reads the rule files: these are prose, there is nothing to import, and the point is that the sentences a
 * reader arrives at say what the stack actually does.
 *
 * What is asserted is deliberately narrow — the count, the three names, and that `RunDrawer`'s departure is EXPLAINED rather than merely erased — because
 * a test that pinned whole paragraphs would fail on every rewording and teach the next person to delete it.
 */
const ROOT = join(__dirname, '..');
const CLAUDE = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
const BOARD_RULES = readFileSync(join(ROOT, '.claude', 'rules', 'board.md'), 'utf8');
const INVARIANTS = readFileSync(join(ROOT, 'docs', 'subsystems', 'invariants.md'), 'utf8');

/** The `invariants.md` section for this rule, and nothing either side of it —
 *  `RunDrawer` is named all over that file for other reasons. */
function escapeEntry(): string {
  const at = INVARIANTS.indexOf('## Escape has one owner');
  expect(at).toBeGreaterThan(-1);
  const next = INVARIANTS.indexOf('\n## ', at + 1);
  return INVARIANTS.slice(at, next === -1 ? undefined : next);
}

/** The mechanism bullet for the same rule, in the rule file scoped to `client/src/**`. Bullets are separated by `\n- `. */
function mechanismBullet(): string {
  const at = BOARD_RULES.indexOf('- **Escape has one owner');
  expect(at).toBeGreaterThan(-1);
  const next = BOARD_RULES.indexOf('\n- ', at + 1);
  return BOARD_RULES.slice(at, next === -1 ? undefined : next);
}

describe('the Escape rule reads three dialogs, not four', () => {
  it("invariants.md names three and says WHY the run drawer left, rather than dropping it", () => {
    const entry = escapeEntry();
    expect(entry).toMatch(/all three dialogs/);
    expect(entry).not.toMatch(/all four dialogs/);
    for (const name of ['ItemModal', 'LaunchSheet', 'OrchestrateSheet']) expect(entry).toContain(name);
    // The rule survives every surface that has ever carried it: the entry is
    // edited in place, and the departure carries its reason — the content is
    // an inline sheet now, never a dialog.
    expect(entry).toContain('RunDrawer');
    expect(entry).toMatch(/inline/);
    expect(entry).toMatch(/never a dialog/);
  });

  it("the board rule file's bullet says the same three and points at the same reason", () => {
    const bullet = mechanismBullet();
    expect(bullet).toMatch(/three dialogs/);
    expect(bullet).not.toMatch(/four dialogs/);
    expect(bullet).toContain('LaunchSheet');
    expect(bullet).toContain('OrchestrateSheet');
    expect(bullet).toMatch(/item modal/);
    expect(bullet).toMatch(/never a dialog/);
  });

  it('CLAUDE.md keeps the headline', () => {
    expect(CLAUDE).toContain('- **Escape has one owner, and the topmost dialog is the only one that closes.**');
  });

  /* The half a doc edit cannot state on its own: the hook's own doc comment is
     the third copy of this count, and it is the one a reader lands in from the
     code rather than from the docs. */
  it("the hook's own comment agrees that there are three", () => {
    const hook = readFileSync(join(ROOT, 'client', 'src', 'hooks', 'useDialogEscape.ts'), 'utf8');
    expect(hook).toMatch(/Three of them now, not four/);
  });
});
