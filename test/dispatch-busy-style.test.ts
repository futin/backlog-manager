import { readStyles, ruleBlock } from './helpers/css-rule';

/**
 * bug-13 gave the dispatch control a second attribute state: `aria-busy` while
 * a click on a project-visibility block re-asks the status. The component suite
 * proves the attribute lands on the button; this file proves it means something
 * visually, which is the same jsdom limit every other `*-style` suite here
 * documents — the component suites never load styles.css, so a rendering
 * assertion on the busy look would pass whether or not the rule existed.
 *
 * What it is guarding is that a click on a disabled-looking control is not
 * silent. The whole failure bug-13 describes is a reader who cannot tell an
 * answered question from an ignored one, and an aria-only signal would leave
 * every sighted reader in exactly that position.
 *
 * bug-16 gave the toolbar's Orchestrate button the same re-asking click, from
 * the same hook, and therefore the same pair of rules — so it is a third row
 * in both tables below rather than a suite of its own. The parametrized shape
 * is the point: a fourth status-gated control gets its coverage by adding one
 * string, which is the only version of this that stays true. The rule itself
 * shipped unpinned for exactly one review round, and both halves of it were
 * deletable with all 1131 tests green.
 */
const BUSY = "[aria-busy='true']";
const DISABLED = "[aria-disabled='true']";

/* Every control whose disabled state can be clicked to re-ask the status.
   `.dispatch-tab`/`.dispatch-chip` are DispatchButton's two shapes (bug-13);
   `.board-orchestrate` is the board toolbar's own control (bug-16). */
const REVERIFYING_CONTROLS = ['.dispatch-tab', '.dispatch-chip', '.board-orchestrate'];

describe('re-asking control busy stylesheet rules', () => {
  const css = readStyles();

  it.each(REVERIFYING_CONTROLS)('gives %s a visible busy state', (base) => {
    const block = ruleBlock(css, `${base}${BUSY}`);
    expect(block).not.toBeNull();
    // A cursor, because the pointer is already over the control when the
    // re-ask starts — it is the one channel that needs no second glance.
    expect(block as string).toMatch(/cursor\s*:/);
    expect(block as string).toMatch(/color\s*:/);
  });

  /* Source order is the mechanism, not a formatting preference: the busy rule
     and the `[aria-disabled='true']` rule above it have equal specificity and
     both match at once (the control is disabled AND busy), so the later one
     wins. Declared the other way round, the busy state would be silently
     overwritten by the disabled colour and nothing would appear to happen —
     the exact symptom this whole fix exists to remove. */
  it.each(REVERIFYING_CONTROLS)('declares %s busy after its disabled rule', (base) => {
    expect(css.indexOf(`${base}${BUSY}`)).toBeGreaterThan(css.indexOf(`${base}${DISABLED}`));
  });
});
