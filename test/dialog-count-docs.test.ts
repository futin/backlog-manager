import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * task-40's test case 6. The Escape rule is stated at three depths — the headline in `CLAUDE.md`, the mechanism bullet in `.claude/rules/board.md`, the
 * reasoning in `invariants.md` — and the one thing that can silently rot is the COUNT: the code had three callers, the docs said four for as long as it took
 * someone to notice. The count lives in the second and third tiers; the headline is pinned only so a reader arriving from CLAUDE.md still finds the rule.
 *
 * Jira phase 2 moved the count from three to five — `JiraIssueModal` composes `ui/Modal` and `JiraBoardSheet` composes `ui/FormSheet`, so both joined the
 * stack through the shells, by construction, with no line of `useDialogEscape` changed — which is exactly the edit this suite exists to catch half-made.
 *
 * Read as text, the way `test/claude-rules.test.ts` reads the rule files: these are prose, there is nothing to import, and the point is that the sentences a
 * reader arrives at say what the stack actually does.
 *
 * What is asserted is deliberately narrow — the count, the five names, and that `RunDrawer`'s departure is EXPLAINED rather than merely erased — because
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

describe('the Escape rule reads five dialogs, not three or four', () => {
  const FIVE = ['ItemModal', 'LaunchSheet', 'OrchestrateSheet', 'JiraIssueModal', 'JiraBoardSheet'];

  it("invariants.md names five and says WHY the run drawer left, rather than dropping it", () => {
    const entry = escapeEntry();
    expect(entry).toMatch(/all five dialogs/);
    expect(entry).not.toMatch(/all (three|four) dialogs/);
    for (const name of FIVE) expect(entry).toContain(name);
    // The rule survives every surface that has ever carried it: the entry is
    // edited in place, and the departure carries its reason — the content is
    // an inline sheet now, never a dialog.
    expect(entry).toContain('RunDrawer');
    expect(entry).toMatch(/inline/);
    expect(entry).toMatch(/never a dialog/);
  });

  it("the board rule file's bullet says the same five and points at the same reason", () => {
    const bullet = mechanismBullet();
    expect(bullet).toMatch(/five dialogs/);
    expect(bullet).not.toMatch(/(three|four) dialogs/);
    expect(bullet).toContain('LaunchSheet');
    expect(bullet).toContain('OrchestrateSheet');
    expect(bullet).toContain('JiraIssueModal');
    expect(bullet).toContain('JiraBoardSheet');
    expect(bullet).toMatch(/item modal/);
    expect(bullet).toMatch(/never a dialog/);
  });

  it('CLAUDE.md keeps the headline', () => {
    expect(CLAUDE).toContain('- **Escape has one owner, and the topmost dialog is the only one that closes.**');
  });

  /* The half a doc edit cannot state on its own: the hook's own doc comment is
     the third copy of this count, and it is the one a reader lands in from the
     code rather than from the docs. Its history sentence stays — three was true
     from task-37 to Jira phase 2 — and the five is the sentence after it. The
     Popover count (R6) is pinned beside it, because it is the other number in
     that comment and rots the same way. */
  it("the hook's own comment keeps the three's history and says five, with six Popover composers", () => {
    const hook = readFileSync(join(ROOT, 'client', 'src', 'hooks', 'useDialogEscape.ts'), 'utf8');
    expect(hook).toMatch(/Three of them now, not four/);
    expect(hook).toMatch(/Five since Jira phase 2/);
    expect(hook).toMatch(/six composers/);
  });
});
