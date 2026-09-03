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

/**
 * bug-15's fourth dot state has to be told apart by SIGHT from the other
 * three, and sight is exactly what jsdom cannot check — the same split
 * run-stepper-style.test.ts states for the drawer's own three states:
 * stage-track.test.tsx pins the state CLASSES, this pins that those classes
 * actually paint something different, and neither half can stand in for the
 * other.
 *
 * The claim being defended is the whole reason the state exists: a stalled
 * node must not read as "this is happening right now". It is amber (the tone
 * `run-stage.ts` already gives `parked`/`needs-answers` — a run that stopped
 * needing a human is the same register) and it never animates.
 */
describe('stalled stage-track stylesheet rules (bug-15)', () => {
  const css = readStyles();

  it('has a rule for the stalled dot, its segment, and the drawer-sized dot', () => {
    for (const selector of [
      '.run-track-dot-stalled',
      '.run-track-node[data-in="stalled"]::before',
      '.run-stepper-dot-stalled'
    ]) {
      const block = ruleBlock(css, selector);
      expect(block).not.toBeNull();
      expect((block as string).trim()).not.toEqual('');
    }
  });

  /**
   * Nothing on a stalled node may move. The blanket reduced-motion reset
   * cannot be leaned on here (it is media-gated, and never reaches a
   * pseudo-element at all — see this file's own header): a stalled node is
   * static for EVERY reader, because the motion would be asserting something
   * false, not merely something distracting.
   */
  it('never animates the stalled dot or its segment', () => {
    for (const selector of ['.run-track-dot-stalled', '.run-track-node[data-in="stalled"]::before']) {
      const rule = ruleBlock(css, selector) as string;
      const animation = /(^|[\s;])animation\s*:\s*([^;]+)/.exec(rule);
      if (animation !== null) expect(animation[2].trim()).toBe('none');
      expect(rule).not.toMatch(/run-track-ring|run-track-sweep/);
    }
  });

  /**
   * Two channels, not one — run-stepper-style.test.ts's own stated rule, for
   * its own stated reason: colour alone fails a monochrome reader. Stalled is
   * amber-ringed and static where `filled` is a solid green fill and
   * `current` is a cyan fill that pulses, so it differs from each of them in
   * both the declarations it makes and the ones it refuses to.
   */
  it('differs from the filled and current dots in more than colour', () => {
    const stalled = ruleBlock(css, '.run-track-dot-stalled') as string;
    const filled = ruleBlock(css, '.run-track-dot-filled') as string;
    const current = ruleBlock(css, '.run-track-dot-current') as string;

    const declarations = (rule: string): string[] =>
      rule.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter((d) => d !== '');

    for (const other of [filled, current]) {
      const differing = declarations(stalled).filter((d) => !declarations(other).includes(d));
      expect(differing.length).toBeGreaterThanOrEqual(2);
    }

    // The channel that carries the meaning: `current` moves, `stalled` does
    // not. Asserted on the pair rather than on `stalled` alone, so a future
    // edit that stops the current dot pulsing has to come back through here.
    expect(current).toMatch(/(^|[\s;])animation\s*:\s*run-track-ring\b/);
    expect(stalled).not.toMatch(/run-track-ring/);
  });
});
