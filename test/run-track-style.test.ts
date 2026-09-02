import { readStyles, ruleBlock } from './helpers/css-rule';

/**
 * StageTrack's reduced-motion carve-out — the `.run-track*` block's own
 * trailing `@media (prefers-reduced-motion: reduce)` rule in
 * client/src/styles.css — has no other guard anywhere in this suite, and
 * needs one for two independent reasons:
 *
 * - The file's blanket reduced-motion reset (`* { animation-duration:
 *   .01ms !important; ... }`, near the top of the file) cannot reach it.
 *   The universal selector matches real DOM elements only, never the
 *   generated content a `::before`/`::after` paints, and the sweep this
 *   rule cancels — `run-track-sweep` on
 *   `.run-track-node[data-in="live"]::before` — is that blanket rule's
 *   first pseudo-element animation in the whole file. The gap was real:
 *   left alone, the sweep keeps sliding for a reduced-motion reader.
 * - jsdom cannot evaluate media queries at all (and performs no layout, so
 *   it could not observe the sweep even without that limitation) — which
 *   is exactly why nothing in `stage-track.test.tsx`, a render suite, can
 *   ever stand in for this. That combination is precisely how the gap
 *   shipped in the first place: the implementation plan's own CSS section
 *   asserted "the file's reduced-motion block already zeroes every
 *   animation, so no new media rule is needed," which was true of every
 *   animation in the file up to this one, and wrong for this one — and
 *   nothing mechanical caught the mistake until a design review read the
 *   stylesheet by eye.
 *
 * Same register as run-stepper-style.test.ts (a frozen contract suite,
 * deliberately left untouched — this is its own file, not an edit to it):
 * assert on the stylesheet's own text, because the declarations being
 * DECLARED is the part a later cleanup can silently delete, and reduced
 * motion is the one property of this file no render test can ever prove.
 */
describe('stage-track reduced-motion stylesheet rules', () => {
  const css = readStyles();

  /**
   * `ruleBlocks` (helpers/css-rule.ts) captures a flat selector's own
   * `{...}` body by scanning to the very next `}` after its `{` — correct
   * for one rule, but wrong for an at-rule that wraps several: the next
   * `}` after `@media (...) {`'s own opening brace belongs to the FIRST
   * nested rule, not to the media block itself. Extracting the reduced-
   * motion block's full body needs brace-depth counting instead, which is
   * the one thing this file adds beyond the shared helper — kept local
   * rather than folded into helpers/css-rule.ts because no other caller of
   * that helper queries an at-rule's own body; every one of them looks up
   * a flat selector.
   */
  function mediaBlocks(source: string, atRule: string): string[] {
    const found: string[] = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf(atRule, from);
      if (at === -1) return found;
      const open = source.indexOf('{', at);
      if (open === -1) return found;
      let depth = 1;
      let i = open + 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      if (depth !== 0) return found; // unbalanced — bail rather than mis-slice
      found.push(source.slice(open + 1, i - 1));
      from = i;
    }
  }

  // The file has two `@media (prefers-reduced-motion: reduce)` blocks: the
  // file-wide blanket reset near the top, and this section's own carve-out
  // at the end of the `.run-track*` block. Picking the one that actually
  // mentions a run-track selector — rather than assuming an index or a
  // position — keeps this test correct even if a third block is ever added
  // somewhere else in the file.
  const reducedMotionBlocks = mediaBlocks(css, '@media (prefers-reduced-motion: reduce)');
  const trackReducedMotion = reducedMotionBlocks.find((block) =>
    block.includes('.run-track-node[data-in="live"]::before')
  );

  it('has a reduced-motion block that covers the stage track', () => {
    expect(trackReducedMotion).toBeDefined();
  });

  it('cancels the sweep animation and falls back to a solid cyan fill, not the gradient', () => {
    const rule = ruleBlock(trackReducedMotion as string, '.run-track-node[data-in="live"]::before');
    expect(rule).not.toBeNull();
    expect(rule as string).toMatch(/(^|[\s;])animation\s*:\s*none\b/);
    expect(rule as string).toMatch(/(^|[\s;])background\s*:\s*var\(--cyan\)/);
  });

  it('cancels the current-dot ring outright rather than freezing it on its last frame', () => {
    const rule = ruleBlock(trackReducedMotion as string, '.run-track-dot-current');
    expect(rule).not.toBeNull();
    expect(rule as string).toMatch(/(^|[\s;])animation\s*:\s*none\b/);
  });
});
