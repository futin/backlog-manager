import { readStyles, ruleBlock, ruleBlocks } from './helpers/css-rule';

/**
 * The stepper's three dot states have to be told apart by SIGHT — that is the
 * entire point of a stepper — and sight is exactly what jsdom cannot check: it
 * performs no layout, the component suites never load the stylesheet, and
 * `getComputedStyle` on a rendered dot would report nothing about its
 * background either way. run-time-ui.test.tsx pins the state CLASSES, which is
 * the half a render test can prove; this file pins that each of those classes
 * actually paints something different, which is the half it cannot.
 *
 * Same approach as run-drawer-tail-style.test.ts and run-stage-chip-style.ts
 * before it: assert on the stylesheet's own text, because the declarations
 * being DECLARED is the part a later cleanup can silently delete.
 */
describe('run stepper stylesheet rules', () => {
  const css = readStyles();

  it('has a rule for the track and for each of the three dot states', () => {
    for (const selector of [
      '.run-stepper',
      '.run-stepper-dot',
      '.run-stepper-dot-filled',
      '.run-stepper-dot-current',
      '.run-stepper-dot-hollow'
    ]) {
      const block = ruleBlock(css, selector);
      expect(block).not.toBeNull();
      expect((block as string).trim()).not.toEqual('');
    }
  });

  /**
   * The three states must differ in more than one channel each, because the
   * distinction has to survive both a colour-blind reader and a monochrome
   * one. Filled is a solid fill; hollow is a ring with NO fill (transparent
   * background, a border); current adds a halo. Asserting on the properties
   * rather than their exact values keeps a palette tweak from failing this.
   */
  it('gives each state a visual difference that is not colour alone', () => {
    expect(ruleBlock(css, '.run-stepper-dot-filled')).toMatch(/(^|[\s;])background\s*:/);

    const hollow = ruleBlock(css, '.run-stepper-dot-hollow') as string;
    expect(hollow).toMatch(/(^|[\s;])background\s*:\s*transparent\b/);
    expect(hollow).toMatch(/(^|[\s;])border\s*:/);

    expect(ruleBlock(css, '.run-stepper-dot-current')).toMatch(/(^|[\s;])box-shadow\s*:/);
  });

  /**
   * `box-sizing: border-box` on the base dot is what keeps the hollow state's
   * 1px border from growing that dot 2px wider than its filled neighbours —
   * a track whose dots change size as stages complete reads as a rendering
   * bug, not as progress. Easy to lose to a "redundant property" cleanup,
   * which is exactly why it is pinned.
   */
  it('keeps every dot the same size whether it is filled or ringed', () => {
    const base = ruleBlocks(css, '.run-stepper-dot').find((b) => /width\s*:/.test(b));
    expect(base).toBeDefined();
    expect(base as string).toMatch(/(^|[\s;])box-sizing\s*:\s*border-box\b/);
  });

  /**
   * The connector is drawn by each dot but the first, as a pseudo-element
   * reaching backwards across the flex gap — no wrapper element per segment.
   * Without it the seven dots read as seven unrelated marks rather than as
   * one pipeline.
   */
  it('draws the connector between dots without a per-segment element', () => {
    const connector = ruleBlock(css, '.run-stepper-dot + .run-stepper-dot::before');
    expect(connector).not.toBeNull();
    expect(connector as string).toMatch(/(^|[\s;])content\s*:/);
  });

  /**
   * Both live-ticking readings use tabular figures, and it matters more here
   * than anywhere else on the board: these two re-render every 5s while a run
   * is fresh, and proportional digits make the numbers shove their neighbours
   * sideways as minutes roll over. The drawer's row column needs them for a
   * second reason — a column of durations only supports "which took longest"
   * at a glance if the digits line up.
   */
  it('sets tabular figures on both time readings', () => {
    expect(ruleBlock(css, '.run-strip-elapsed')).toMatch(/font-variant-numeric\s*:\s*tabular-nums\b/);
    expect(ruleBlock(css, '.run-drawer-item-time')).toMatch(/font-variant-numeric\s*:\s*tabular-nums\b/);
  });
});
