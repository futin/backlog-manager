import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * task-40's test cases 7 and 8 — DESIGN.md §8.8's three moving elements, and
 * the one mechanism that silences all three.
 *
 * Why this reads the stylesheet as text rather than computing styles: jsdom
 * evaluates no media query in `getComputedStyle`, so a `prefers-reduced-motion`
 * stub proves nothing about what a browser would actually paint. The repo's own
 * `*-style.test.ts` suites take exactly this shape for exactly this reason, and
 * this one is their §8.8 sibling — one table, all three elements, rather than a
 * case marooned in whichever suite happens to own each selector.
 *
 * The hazard being pinned is specific and has already happened once here: the
 * file-wide blanket rule (`* { animation-duration: .01ms !important;
 * animation-iteration-count: 1 !important }`) does not CANCEL an animation, it
 * runs it once, instantly — which parks the element on its LAST keyframe. That
 * is right only when the last frame is the element's resting state, and wrong
 * the moment it is not. Each of the three therefore needs an explicit
 * `animation: none`, and `!important` on it only where the rule it is
 * correcting outranks it on specificity.
 */
const css = readStyles();

/** Every `@media (prefers-reduced-motion: reduce)` block's body, in source
 *  order. Brace-counted rather than regex-sliced: these blocks contain nested
 *  rules, so the first `}` is never the block's own. */
function reducedMotionBlocks(): string[] {
  const needle = '@media (prefers-reduced-motion: reduce)';
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at === -1) return found;
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    while (i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    found.push(css.slice(open + 1, i));
    from = i + 1;
  }
}

const blocks = reducedMotionBlocks();

/**
 * §8.8's three, as one table.
 *
 * `important` is a per-selector judgement and is recorded as such, because that
 * is the rule the design section states: the flag is needed only where the
 * unconditional rule outranks the override. `.board-card-stage-glyph`'s is two
 * classes deep (`.board-card-stage .board-card-stage-glyph`), so source order
 * cannot win; the other three each share their own single selector with the
 * rule they correct, and come after it.
 */
const MOVERS = [
  {
    what: "the run chip's breathing dot",
    selector: '.ui-dot-breathe',
    animation: /animation\s*:\s*ui-dot-ring\b/,
    important: false
  },
  {
    what: "the stage track's current node",
    selector: '.run-track-dot-current',
    animation: /animation\s*:\s*run-track-ring\b/,
    important: false
  },
  {
    what: 'the needs-you control fading in',
    selector: '.run-controls-needs-you',
    animation: /animation\s*:\s*run-controls-fade\b/,
    important: false
  }
] as const;

describe('§8.8 — the three moving elements', () => {
  it.each(MOVERS.map((m) => [m.what, m] as const))('%s declares an animation of its own', (_what, mover) => {
    const unconditional = ruleBlocks(css, mover.selector).filter((rule) => mover.animation.test(rule));
    expect(unconditional.length).toBeGreaterThan(0);
  });

  it.each(MOVERS.map((m) => [m.what, m] as const))('%s is cancelled outright under reduced motion, not frozen on its last frame', (_what, mover) => {
    const override = blocks
      .flatMap((block) => ruleBlocks(block, mover.selector))
      .find((rule) => /(^|[\s;])animation\s*:\s*none\b/.test(rule));
    expect(override).toBeDefined();
    // `!important` exactly where the corrected rule outranks the override, and
    // nowhere else — a uniformly-applied flag would hide the day one of these
    // selectors grows a descendant form and genuinely needs it.
    expect(/animation\s*:\s*none\s*!important/.test(override as string)).toBe(mover.important);
  });

  /* The worked example the section names, asserted here beside the three it is
     the example FOR: its unconditional rule is two classes deep, so it is the
     one case where source order cannot settle it and the flag is load-bearing.
     `run-stage-chip-style.test.ts` owns the glyph's own styling; this case owns
     only the contrast — that `important` above is a judgement per selector and
     not a habit. */
  it('the stage glyph, whose unconditional rule outranks it, keeps its !important', () => {
    const override = blocks.flatMap((block) => ruleBlocks(block, '.board-card-stage-glyph')).find((rule) => /animation\s*:\s*none/.test(rule));
    expect(override).toBeDefined();
    expect(override as string).toMatch(/animation\s*:\s*none\s*!important/);
  });
});

/**
 * Test case 8. The fade marks a control that appears when the sweeper has given
 * up, and "has the sweeper given up" is `watchdogStoodDown` — one function,
 * never two agreeing expressions (CLAUDE.md's resume-coupling invariant). The
 * fade must therefore add no gate of its own: it rides the control the
 * predicate already decides.
 */
describe('the needs-you fade reads the existing gate rather than deriving one', () => {
  const COMPONENTS = join(__dirname, '..', 'client', 'src', 'components');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  }

  it('is applied by exactly one component, and that component is the one reading watchdogStoodDown', () => {
    const wearers = walk(COMPONENTS).filter((f) => readFileSync(f, 'utf8').includes('run-controls-needs-you'));
    expect(wearers.map((f) => f.slice(COMPONENTS.length + 1))).toEqual(['RunControls.tsx']);
    expect(readFileSync(wearers[0], 'utf8')).toMatch(/watchdogStoodDown\(/);
  });
});
