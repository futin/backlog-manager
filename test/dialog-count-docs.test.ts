import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * task-40's test case 6. The Escape rule is stated at three depths — the headline in `CLAUDE.md`, the mechanism bullet in `.claude/rules/board.md`, the
 * reasoning in `invariants.md` — and the one thing that can silently rot is the COUNT: the code had three callers, the docs said four for as long as it took
 * someone to notice. The count lives in the second and third tiers; the headline is pinned only so a reader arriving from CLAUDE.md still finds the rule.
 *
 * Jira phase 2 moved the count from three to five — `JiraIssueModal` composes `ui/Modal` and `JiraBoardSheet` composes `ui/FormSheet`, so both joined the
 * stack through the shells, by construction, with no line of `useDialogEscape` changed — which is exactly the edit this suite exists to catch half-made.
 * The What's new drawer moved it to six: `ReleasesDrawer` composed `ui/Drawer`, a third shell, and since #298 calls the hook itself over ui-kit's drawer.
 * Jira phase 5 moved it to seven — the same edit a third time: `JiraLaunchSheet` composes `ui/FormSheet`, `FormSheet`'s fourth composer, and joined the stack
 * through the shell with no line of the hook changed. (The Jira spec's §12 says "to six", written before the drawer made today's six.) `Run ▾`'s panel also
 * made `Popover`'s composers seven, which is the OTHER number the hook's comment carries and is pinned the same way. The Dashboards card's add/edit sheet
 * moved the dialog count to eight, the same edit a fourth time: `DashboardSheet` composes `ui/FormSheet`, its fifth composer.
 *
 * Read as text, the way `test/claude-rules.test.ts` reads the rule files: these are prose, there is nothing to import, and the point is that the sentences a
 * reader arrives at say what the stack actually does.
 *
 * What is asserted is deliberately narrow — the count, the eight names, and that `RunDrawer`'s departure is EXPLAINED rather than merely erased — because
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

describe('the Escape rule reads eight dialogs, not three, four, five, six or seven', () => {
  const EIGHT = ['ItemModal', 'LaunchSheet', 'OrchestrateSheet', 'JiraIssueModal', 'JiraBoardSheet', 'ReleasesDrawer', 'JiraLaunchSheet', 'DashboardSheet'];

  it('invariants.md names eight and says WHY the run drawer left, rather than dropping it', () => {
    const entry = escapeEntry();
    expect(entry).toMatch(/all eight dialogs/);
    expect(entry).not.toMatch(/all (three|four|five|six|seven) dialogs/);
    for (const name of EIGHT) expect(entry).toContain(name);
    // The rule survives every surface that has ever carried it: the entry is
    // edited in place, and the departure carries its reason — the content is
    // an inline sheet now, never a dialog.
    expect(entry).toContain('RunDrawer');
    expect(entry).toMatch(/inline/);
    expect(entry).toMatch(/never a dialog/);
  });

  it("the board rule file's bullet says the same eight and points at the same reason", () => {
    const bullet = mechanismBullet();
    expect(bullet).toMatch(/eight dialogs/);
    expect(bullet).not.toMatch(/(three|four|five|six|seven) dialogs/);
    expect(bullet).toContain('LaunchSheet');
    expect(bullet).toContain('OrchestrateSheet');
    expect(bullet).toContain('JiraIssueModal');
    expect(bullet).toContain('JiraBoardSheet');
    expect(bullet).toContain('ReleasesDrawer');
    expect(bullet).toContain('JiraLaunchSheet');
    expect(bullet).toContain('DashboardSheet');
    expect(bullet).toMatch(/item modal/);
    expect(bullet).toMatch(/never a dialog/);
  });

  it('CLAUDE.md keeps the headline', () => {
    expect(CLAUDE).toContain('- **Escape has one owner, and the topmost dialog is the only one that closes.**');
  });

  /* The half a doc edit cannot state on its own: the hook's own doc comment is
     the third copy of this count, and it is the one a reader lands in from the
     code rather than from the docs. Its history sentence stays — three was true
     from task-37 to Jira phase 2, and five until the What's new drawer, six until the Jira launch sheet and seven until the Dashboards sheet — and the eight
     is the sentence after them. The
     Popover count (R6) is pinned beside it, because it is the other number in
     that comment and rots the same way. */
  it("the hook's own comment keeps the three's, five's, six's and seven's history and says eight, with seven Popover composers", () => {
    const hook = readFileSync(join(ROOT, 'client', 'src', 'hooks', 'useDialogEscape.ts'), 'utf8');
    expect(hook).toMatch(/Three of them now, not four/);
    expect(hook).toMatch(/Five since Jira phase 2/);
    expect(hook).toMatch(/Six since the What's new drawer/);
    expect(hook).toMatch(/Seven since Jira phase 5/);
    expect(hook).toMatch(/Eight since the Dashboards card's add\/edit sheet/);
    expect(hook).toMatch(/seven composers/);
  });
});
