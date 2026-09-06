import { readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * task-16's half that no render test can ever stand in for: the Runs section
 * is bounded to one viewport by LAYOUT — a definite height on `.runs-board`,
 * a flex child that absorbs the remainder, two boxes that scroll their own
 * overflow — and jsdom evaluates no media queries and performs no layout at
 * all. That is the same gap `run-track-style.test.ts` documents for the stage
 * track's reduced-motion carve-out, and the same answer: assert on the
 * stylesheet's own TEXT, because the declarations being DECLARED is exactly
 * what a later cleanup can silently delete.
 *
 * "Silently" is the operative word for two of these in particular.
 * `.runs-split`'s `min-height: 0` reads like noise beside `flex: 1` and is
 * the single declaration whose removal turns the whole mechanism into a
 * no-op (a flex item's default `min-height: auto` refuses to shrink below
 * its content, so the box just grows to the full run list again). And
 * `.runs-board`'s height is DIVIDED by `--font-scale`, which reads like a
 * flourish until you notice `.shell` carries `zoom: var(--font-scale, 1)`:
 * a plain `100vh` there is drawn 20% taller than the screen at 120%. Both
 * would still render "fine" in every jsdom test in this repo.
 */
describe('runs list bounded-scroll stylesheet rules (task-16)', () => {
  /**
   * Comments are stripped BEFORE anything below looks at the text, and that
   * is load-bearing rather than tidiness. This file's rules are documented
   * at the density the rest of the sheet is, and those comments quote the
   * very declarations being asserted ("`min-height: 0` is not decoration…",
   * "…back to `height: auto`") and name neighbouring selectors in prose
   * ("see .runs-split below"). Both defeat `ruleBlocks`' boundary check,
   * which only knows how to tell a selector token from a longer class name —
   * it cannot tell either from English. Left in, a test here could pass on
   * the strength of a sentence describing the rule after the rule itself was
   * deleted, which is the exact failure this suite exists to catch.
   */
  const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * `ruleBlocks` (helpers/css-rule.ts) captures a flat selector's body by
   * scanning to the very next `}` after its `{`, which is wrong for an
   * at-rule wrapping several rules: that `}` belongs to the FIRST nested
   * rule. Brace-depth counting is the fix, lifted from
   * run-track-style.test.ts's own local helper for the identical reason it
   * lives there rather than in the shared module — every other caller of
   * `ruleBlocks` looks up a flat selector.
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

  // The file has several `@media (max-width: 700px)` blocks (the rail, the
  // board columns, the runs tiles, and this section's own). Picking the one
  // that actually mentions `.runs-split` — rather than an index or a
  // position — keeps this correct however the file is reordered.
  const phoneBlocks = mediaBlocks(css, '@media (max-width: 700px)');
  const runsPhoneBlock = phoneBlocks.find((block) => block.includes('.runs-split'));

  /**
   * Everything OUTSIDE that phone block. The un-bounding rules there name
   * the exact same selectors as the bounding rules here and declare the
   * opposite values, so a search over the whole sheet would let either half
   * satisfy an assertion meant for the other — the phone block's
   * `max-height: none` would happily answer "does `.runs-list` declare a
   * max-height".
   */
  const base = runsPhoneBlock === undefined ? css : css.replace(runsPhoneBlock, '');

  /** True when any rule naming `selector` (in `source`) declares something matching `pattern`. */
  function declares(source: string, selector: string, pattern: RegExp): boolean {
    return ruleBlocks(source, selector).some((block) => pattern.test(block));
  }

  it('gives .runs-board a definite height derived from 100vh DIVIDED by --font-scale', () => {
    // The division is the assertion, not the presence of `100vh`: a plain
    // `100vh` is the bug this guards, and it is what an author reaching for
    // "one viewport" writes by default.
    expect(declares(base, '.runs-board', /height\s*:\s*calc\([^;}]*100vh\s*\/\s*var\(\s*--font-scale/)).toBe(true);
  });

  it('makes .runs-split absorb the remainder, with the min-height:0 that lets it', () => {
    expect(declares(base, '.runs-split', /(^|[\s;])flex\s*:\s*1\b/)).toBe(true);
    expect(declares(base, '.runs-split', /(^|[\s;])min-height\s*:\s*0\b/)).toBe(true);
  });

  it('caps and scrolls both halves of the split, without chaining the scroll to the document', () => {
    for (const selector of ['.runs-list', '.runs-detail']) {
      expect(declares(base, selector, /(^|[\s;])max-height\s*:\s*100%/)).toBe(true);
      expect(declares(base, selector, /(^|[\s;])overflow-y\s*:\s*auto\b/)).toBe(true);
      // Without this, bottoming out the inner box lurches the whole page —
      // strictly worse than the unbounded list this replaces.
      expect(declares(base, selector, /(^|[\s;])overscroll-behavior\s*:\s*contain\b/)).toBe(true);
      // The graceful degrade for a viewport too short (or a --font-scale too
      // large) for the bar and tiles alone: the boxes keep a usable height
      // and the PAGE scrolls again, rather than the list collapsing to zero.
      expect(declares(base, selector, /(^|[\s;])min-height\s*:\s*\d/)).toBe(true);
    }
  });

  it('sticks the day heading to the top of the list box, on an opaque background', () => {
    expect(declares(base, '.runs-day-heading', /(^|[\s;])position\s*:\s*sticky\b/)).toBe(true);
    expect(declares(base, '.runs-day-heading', /(^|[\s;])top\s*:\s*0\b/)).toBe(true);
    // Opaque, not a mix or a transparency: rows scroll UNDER this, and
    // anything less shows a row's text through the heading meant to be
    // labelling it — the same reason `.archive-month` states for itself.
    expect(declares(base, '.runs-day-heading', /(^|[\s;])background\s*:\s*var\(\s*--board\s*\)/)).toBe(true);
  });

  it('un-bounds the whole section below 700px', () => {
    expect(runsPhoneBlock).toBeDefined();
    const phone = runsPhoneBlock as string;
    // A scroll box nested inside a scrolling page is worse than the status
    // quo on a phone, and the layout is already one column there — so the
    // bound comes off entirely rather than being narrowed.
    expect(declares(phone, '.runs-board', /(^|[\s;])height\s*:\s*auto\b/)).toBe(true);
    for (const selector of ['.runs-list', '.runs-detail']) {
      expect(declares(phone, selector, /(^|[\s;])max-height\s*:\s*none\b/)).toBe(true);
      expect(declares(phone, selector, /(^|[\s;])overflow\s*:\s*visible\b/)).toBe(true);
    }
  });
});
