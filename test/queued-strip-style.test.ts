import { readStyles, ruleBlock, ruleBlocks } from './helpers/css-rule';

/**
 * The card's queued strip is a stylesheet fact for the reason live-bar-style.test.ts gives: the component suites never load styles.css, so they can prove
 * the class lands on the element and nothing about what it paints.
 *
 * What is pinned is the strip's one difference from the live strip. Same band — height, inline padding — so the two read as one family across a column;
 * a different fill, because `--fill-live` under the hatch means "somebody is on this right now" and `orchestrator:queued` is a plan, never a claim
 * (docs/subsystems/invariants.md). The markers it replaced are pinned as gone, so the label cannot be drawn twice.
 */
describe('queued strip stylesheet rules', () => {
  const css = readStyles();

  it('is the live strip’s band as an ink band, --strip text on --ink2', () => {
    const band = ruleBlock(css, '.board-card-queued') as string;
    expect(band).not.toBeNull();
    expect(band).toMatch(/height\s*:\s*24px/);
    expect(band).toMatch(/padding\s*:\s*0 var\(--card-pad-x\)/);
    // Not `--strip-hi`: on daylight that is #f2f2f1 on a white card, which is the band nobody could see.
    expect(band).toMatch(/background\s*:\s*var\(--ink2\)/);
    expect(band).toMatch(/(^|[^-])color\s*:\s*var\(--strip\)/);
  });

  it('borrows neither the live fill nor the hatch', () => {
    const band = ruleBlock(css, '.board-card-queued') as string;
    expect(band).not.toMatch(/--fill-live/);
    expect(band).not.toMatch(/gradient/);
  });

  it('steps the stale variant back to --ink2 on --hairline2, the pair that holds contrast on daylight', () => {
    const stale = ruleBlock(css, '.board-card-queued[data-state="stale"]') as string;
    expect(stale).toMatch(/background\s*:\s*var\(--hairline2\)/);
    expect(stale).toMatch(/(^|[^-])color\s*:\s*var\(--ink2\)/);
  });

  it('has no queued marker rules left', () => {
    expect(ruleBlocks(css, '.ui-marker-queued')).toEqual([]);
    expect(ruleBlocks(css, '.ui-marker-queued-stale')).toEqual([]);
  });
});
