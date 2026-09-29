import { mediaBlocks, readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * The phone's rail bar (#229): brand, the tracker chip and ☰ in one flex row on a 351 px content box. With the chip's login in it the row ran ~9 px over
 * at 375 px, and ☰ — the only item without `flex: none` — absorbed the deficit: 26.9 px wide instead of 36, then pushed out of the clipped `.rail` once a
 * longer login or `POLL overdue` widened the chip. The fix is two narrow-only rules: ☰ stops yielding, and the chip's login leaves the bar whenever meters
 * follow it.
 *
 * Stylesheet facts rather than render assertions for the reason run-track-style.test.ts gives: jsdom evaluates no media query and performs no layout, so
 * tracker-chip.test.tsx still sees the login rendered — which is the point, since the desktop strip keeps it. What is pinned here is where the hide rule
 * sits and how narrowly it is scoped: the popover's `.tracker-pop-who` and the `no token` chip both use `.tracker-name` and must keep showing it.
 */
describe('narrow rail bar stylesheet rules', () => {
  // Comments blanked first: a brace in a comment would throw the media block's depth count off.
  const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const narrow = mediaBlocks(css, '@media (max-width: 700px)');
  const inNarrow = (selector: string) => narrow.flatMap((block) => ruleBlocks(block, selector));
  const HIDE = '.rail-bar .tracker-chip .tracker-name:has(+ .tracker-meters)';

  it('keeps ☰ at its full 36 px on a phone: `.rail-menu` does not shrink', () => {
    expect(inNarrow('.rail-menu').some((body) => /(^|[^-])flex\s*:\s*none/.test(body))).toBe(true);
  });

  it('drops the chip’s login from the phone’s rail bar when meters follow it', () => {
    expect(inNarrow(HIDE).some((body) => /display\s*:\s*none/.test(body))).toBe(true);
  });

  it('hides the login nowhere else — not on the desktop strip, not in the popover, not on the no-token chip', () => {
    // Every rule anywhere in the sheet that names `.tracker-name` and hides it must be the one scoped rule above.
    const hiders = [...css.matchAll(/([^{}]*\.tracker-name[^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => /display\s*:\s*none/.test(m[2]))
      .map((m) => m[1].trim().replace(/\s+/g, ' '));
    expect(hiders).toEqual([HIDE]);
    // And that rule exists only inside the narrow block, so the desktop strip still prints the login.
    const wide = narrow.reduce((rest, block) => rest.replace(block, ''), css);
    expect(ruleBlocks(wide, HIDE)).toEqual([]);
  });
});
