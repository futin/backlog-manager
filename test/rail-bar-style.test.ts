import { mediaBlocks, readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * The phone's rail bar (#229): brand, the status pills and ☰ in one flex row on a 351 px content box. The old chip's login and meters overflowed it and ☰ —
 * the only item without `flex: none` — absorbed the deficit (26.9 px wide, then clipped out of `.rail`). The chip is a pill now (spec §4.9) with neither a
 * login nor meters, so the four rules that hid them are gone; what stays is the one that matters whichever pill is in the bar: ☰ never yields.
 *
 * A stylesheet fact rather than a render assertion for the reason run-track-style.test.ts gives: jsdom evaluates no media query and performs no layout.
 */
describe('narrow rail bar stylesheet rules', () => {
  // Comments blanked first: a brace in a comment would throw the media block's depth count off.
  const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const narrow = mediaBlocks(css, '@media (max-width: 700px)');
  const inNarrow = (selector: string) => narrow.flatMap((block) => ruleBlocks(block, selector));

  it('keeps ☰ at its full 36 px on a phone: `.rail-menu` does not shrink', () => {
    expect(inNarrow('.rail-menu').some((body) => /(^|[^-])flex\s*:\s*none/.test(body))).toBe(true);
  });
});
