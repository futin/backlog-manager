import { readStyles, ruleBlock } from './helpers/css-rule';


/**
 * The run drawer's verification tail is a scroll box, and a scroll box is a
 * layout fact — which is exactly what jsdom cannot observe: it performs no
 * layout, and the component suites never load the stylesheet, so
 * `getComputedStyle` on the rendered span would report nothing about
 * `max-height` either way. A rendering test here would pass whether or not the
 * rule existed, which is worse than no test.
 *
 * So this file guards the stylesheet's own text, in the same spirit as
 * `csp.test.ts` pinning the theme script's hash by reading the file it hashes:
 * the assertion is that the declarations are *declared*, which is the part a
 * later cleanup can silently delete.
 */
const TAIL_SELECTOR = '.run-drawer-item-verify-tail';

describe('run drawer verification tail stylesheet rule', () => {
  const css = readStyles();
  const block = ruleBlock(css, TAIL_SELECTOR);

  // Case 3 of the plan, first because every other assertion depends on it: a
  // renamed or deleted selector must fail loudly here rather than let the
  // property checks below pass vacuously against an empty string.
  it('has a rule in client/src/styles.css', () => {
    expect(block).not.toBeNull();
    expect((block as string).trim()).not.toEqual('');
  });

  // The point being guarded is "this box cannot grow without limit", not a
  // particular height — a future 10em → 12em is a design tweak, not a
  // regression, so the assertion is on the properties, not their values.
  it('bounds its height and scrolls instead of growing', () => {
    // display: block first — max-height and overflow-y are inert on an inline
    // box, and the tail IS inline by default inside <details>'s
    // ::details-content slot (see the rule's own comment). Asserting the two
    // properties without this one would guard a bound that does not apply.
    expect(block).toMatch(/(^|[\s;])display\s*:\s*block\b/);
    expect(block).toMatch(/(^|[\s;])max-height\s*:/);
    expect(block).toMatch(/(^|[\s;])overflow-y\s*:\s*auto\b/);
  });

  // `runVerifyCommand` joins the captured lines with \n; without pre-wrap the
  // browser collapses every one of them into a space and the "twenty lines"
  // render as a single run-on paragraph. This is the assertion most likely to
  // be lost to a later cleanup of "redundant" whitespace properties.
  it('preserves the captured newlines', () => {
    expect(block).toMatch(/(^|[\s;])white-space\s*:\s*pre-wrap\b/);
  });
});
