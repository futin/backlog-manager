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
 */
const BUSY = "[aria-busy='true']";
const DISABLED = "[aria-disabled='true']";

describe('dispatch busy stylesheet rules', () => {
  const css = readStyles();

  it.each(['.dispatch-tab', '.dispatch-chip'])('gives %s a visible busy state', (base) => {
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
  it.each(['.dispatch-tab', '.dispatch-chip'])('declares %s busy after its disabled rule', (base) => {
    expect(css.indexOf(`${base}${BUSY}`)).toBeGreaterThan(css.indexOf(`${base}${DISABLED}`));
  });
});
