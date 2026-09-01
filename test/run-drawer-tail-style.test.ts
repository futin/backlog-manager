import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const STYLES = join(__dirname, '..', 'client', 'src', 'styles.css');
const TAIL_SELECTOR = '.run-drawer-item-verify-tail';

/**
 * Returns the declarations inside `selector`'s rule, or `null` if the selector
 * has no rule in the sheet at all. Deliberately not a `[^}]*` regex over the
 * whole file: that would also match a selector that merely *contains* this one
 * as a prefix, and it would silently return the wrong block if the rule were
 * ever moved after a similarly-named neighbour. The boundary check on the
 * character before/after the selector is what makes "found" mean this rule and
 * not a longer class name that happens to start the same way.
 */
function ruleBlock(css: string, selector: string): string | null {
  const boundary = /[\s,{]/;
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) return null;
    from = at + selector.length;
    const before = at === 0 ? '\n' : css[at - 1];
    const after = css[from] ?? '';
    // A selector token ends at whitespace, a comma or the opening brace; a
    // letter, digit or hyphen after it means we matched a prefix of a longer
    // class name (`-tail-wrapper`), not this selector.
    if (!boundary.test(before) || !boundary.test(after)) continue;
    const open = css.indexOf('{', from);
    const close = css.indexOf('}', open);
    if (open === -1 || close === -1) return null;
    return css.slice(open + 1, close);
  }
}

describe('run drawer verification tail stylesheet rule', () => {
  const css = readFileSync(STYLES, 'utf8');
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
