import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * the same hook, and therefore the same pair of rules.
 *
 * task-37 collapsed the three controls into one: `DispatchButton`'s two shapes
 * became one 28 px `Chip` and Orchestrate became the band's ink `Chip`
 * (DESIGN.md §8.3), so the pair of rules is declared once, on `.ui-chip`, in
 * the ui primitives block. That is a real simplification and it is also a new
 * way to lose the coverage: the rules are only ON these three controls while
 * the three actually compose a `Chip`. So the suite keeps three rows — they
 * are just source assertions now, one per control, rather than three copies of
 * one stylesheet rule.
 */
const ROOT = join(__dirname, '..');
const BUSY = "[aria-busy='true']";
const DISABLED = "[aria-disabled='true']";

/* Every control whose disabled state can be clicked to re-ask the status, and
   the source that draws it. `DispatchButton` is the card's chip and the item
   drawer's (bug-13 — ONE shape since task-37, where there were two);
   `BoardView` is the band's Orchestrate chip (bug-16). */
const REVERIFYING_CONTROLS = [
  ['the card / drawer dispatch chip', 'client/src/components/board/DispatchButton.tsx'],
  ['the band Orchestrate chip', 'client/src/components/board/BoardView.tsx']
];

describe('re-asking control busy stylesheet rules', () => {
  const css = readStyles();

  it('gives the chip a visible busy state', () => {
    const block = ruleBlock(css, `.ui-chip${BUSY}`);
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
  it('declares the chip busy rule after its disabled rule', () => {
    expect(css.indexOf(`.ui-chip${BUSY}`)).toBeGreaterThan(css.indexOf(`.ui-chip${DISABLED}`));
  });

  /* The other half, and the half that stopped being free when the three
     controls started sharing one rule: a control that re-asks has to BE a chip
     for the rule above to reach it. Read from the source rather than a render,
     for the same reason the rules themselves are read from the sheet — a
     rendered assertion here would prove the attribute is on some element, not
     that the element is the one the stylesheet paints. */
  it.each(REVERIFYING_CONTROLS)('draws %s as a Chip carrying aria-busy', (_name, file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).toMatch(/<Chip[\s\S]{0,2000}?aria-busy=/);
  });
});
