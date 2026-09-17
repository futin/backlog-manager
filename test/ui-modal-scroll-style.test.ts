import { readStyles, ruleBlock, STYLES } from './helpers/css-rule';

/**
 * The sidecar modal's body has to scroll, and in the WIDE shape that is a property of the grid's ROW TEMPLATE rather than of the body's own
 * `overflow-y: auto` — which is exactly the trap this file exists to hold shut.
 *
 * `.ui-modal` is a two-column grid with a `max-height` and `overflow: hidden`. It declared no `grid-template-rows` at all, so the single row it
 * places its two children into was an IMPLICIT one, sized `auto` — i.e. to max-content. An auto row sized to max-content does not shrink to the
 * container's `max-height`: the row grew to the tallest child's full content height, the container clipped it, and the body's `overflow-y: auto`
 * never engaged because the body was never shorter than its own content. Measured on the running app at a 900 px viewport: `.ui-modal` capped at
 * 852 px with a 1036 px scroll height, `.ui-modal-body` 1036 px tall with a 1036 px scroll height — 184 px of an item's text clipped and
 * unreachable by any means, with no scrollbar to say so.
 *
 * `min-height: 0` on the children is NOT the fix and was measured not to be: a grid item whose computed overflow is not `visible` already has an
 * automatic minimum size of zero, so adding it changed nothing (still 1036/1036). The oversized thing is the TRACK, not the item's floor.
 * Bounding the track — one explicit `minmax(0, 1fr)` row — is what makes the container's cap reach the children: 852/852 on the container, and a
 * body 852 px tall over 1036 px of content, which scrolls. Short items still shrink-wrap (660, 788 and 812 px panels measured under the same
 * rule), because `1fr` resolves against the content when there is room to spare and only clamps when there is not.
 *
 * The narrow shape never had the bug — `.ui-modal-narrow` declares its own two rows AND a definite `height` — and it must keep winning, which is
 * a source-ORDER fact now that both rules set the same property at the same specificity. That ordering is asserted below rather than left to
 * whoever next tidies this block, because the failure it prevents is silent: a narrow modal whose facts column stopped folding above the body
 * still renders, it just renders the wrong reading order.
 *
 * A stylesheet source guard, in the register of run-track-style.test.ts and run-drawer-tail-style.test.ts, because jsdom performs no layout at
 * all: no render test in this suite can observe a row track, a clamp, or a scrollbar. The declaration BEING DECLARED is the whole contract.
 */
describe('the sidecar modal bounds its grid row so the body can scroll', () => {
  const css = readStyles();

  it('declares an explicit, clamped row template on .ui-modal', () => {
    const block = ruleBlock(css, '.ui-modal');
    expect(block).not.toBeNull();
    // `minmax(0, …)` is the load-bearing half: a floor of 0 is what lets the row shrink below its children's content height at all.
    expect(block).toMatch(/grid-template-rows:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
  });

  it('keeps the body and the facts column as their own scrollers', () => {
    // The row template only decides how tall each column's box is; these two are what turn the overflow into a scrollbar rather than a clip.
    expect(ruleBlock(css, '.ui-modal-body')).toMatch(/overflow-y:\s*auto/);
    expect(ruleBlock(css, '.ui-modal-facts')).toMatch(/overflow-y:\s*auto/);
  });

  it('orders .ui-modal before .ui-modal-narrow, so the narrow shape still overrides the row template', () => {
    const wide = css.indexOf('.ui-modal {');
    const narrow = css.indexOf('.ui-modal-narrow {');
    expect(wide).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(-1);
    expect(wide).toBeLessThan(narrow);
    // And the narrow rule still carries its own two-row template, which is the thing the ordering above protects.
    expect(ruleBlock(css, '.ui-modal-narrow')).toMatch(/grid-template-rows:\s*minmax\(\s*0\s*,\s*auto\s*\)\s+minmax\(\s*0\s*,\s*1fr\s*\)/);
  });

  it('reads the stylesheet the rest of the suite reads', () => {
    expect(STYLES).toMatch(/client[\\/]src[\\/]styles\.css$/);
  });
});
