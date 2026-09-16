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
  /*
    task-38 moved three of these selectors and the breakpoint, and every case
    below moved with them rather than being deleted (spec §9's rule for a
    renamed selector):

      `.runs-list`      the SCROLL box  ->  `.runs-history-sheet`. Under shape
                        D the 420 px column holds two sheets, and it is the
                        History one that scrolls — which is what lets the Live
                        sheet stay put above a long history and what makes a
                        sticky day kicker stick to the top of the list it
                        belongs to rather than to the top of the column.
                        `.runs-list` survives as that column's own layout
                        class, so it keeps the `min-height: 0` case.
      `.runs-day-heading`             ->  `.ui-ledger-day`. The kicker is the
                        `DayKicker` primitive now, so the sticky rule belongs
                        to the primitive — and its opaque background is the
                        SHEET's ground (`--strip`), not the page's (`--board`),
                        because it now scrolls inside a sheet.
      `@media (max-width: 700px)`     ->  `@media (max-width: 1100px)`. D's
                        split stacks at 1100, not 700 (§8.4.1), and the bound
                        comes off with the split for the reason it always did:
                        a scroll box nested inside a scrolling page is worse
                        than an unbounded page once the layout is one column.
  */
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

  // The file has more than one `@media (max-width: 1100px)` block (the figure
  // strip's own wrap, and this section's). Picking the one that actually
  // mentions `.runs-split` — rather than an index or a position — keeps this
  // correct however the file is reordered.
  const stackBlocks = mediaBlocks(css, '@media (max-width: 1100px)');
  const runsPhoneBlock = stackBlocks.find((block) => block.includes('.runs-split'));

  /**
   * Everything OUTSIDE that stacking block. The un-bounding rules there name
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
    // The 420 px list column (§8.4.1) — the figure every row design in this
    // redraw answers to, which is why it is pinned rather than left to a
    // fraction that would quietly widen the column and let a reading the
    // detail sheet owns creep back into a row.
    expect(declares(base, '.runs-split', /grid-template-columns\s*:\s*420px/)).toBe(true);
  });

  /*
    The column passes the remainder DOWN rather than scrolling itself, which
    is the same `min-height: 0` mechanism `.runs-split` needs one level up and
    fails the same silent way without it: a flex item that refuses to shrink
    below its content grows to the full run list, and the sheet inside it
    never gets a bound to scroll against.
  */
  it('lets the list column pass its height to the sheet inside it', () => {
    expect(declares(base, '.runs-col, .runs-list', /(^|[\s;])min-height\s*:\s*0\b/)).toBe(true);
    expect(declares(base, '.runs-col, .runs-list', /(^|[\s;])max-height\s*:\s*100%/)).toBe(true);
  });

  it('caps and scrolls both halves of the split, without chaining the scroll to the document', () => {
    for (const selector of ['.runs-history-sheet', '.runs-detail']) {
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

  it('sticks the day kicker to the top of the box scrolling it, on an opaque background', () => {
    expect(declares(css, '.ui-ledger-day', /(^|[\s;])position\s*:\s*sticky\b/)).toBe(true);
    expect(declares(css, '.ui-ledger-day', /(^|[\s;])top\s*:\s*0\b/)).toBe(true);
    // Opaque, not a mix or a transparency: rows scroll UNDER this, and
    // anything less shows a row's text through the kicker meant to be
    // labelling it — the same reason `.archive-month` states for itself.
    // `--strip`, the SHEET's ground, since task-38: the kicker scrolls inside
    // a sheet now, and `--board` would paint the page's ground over it.
    expect(declares(css, '.ui-ledger-day', /(^|[\s;])background\s*:\s*var\(\s*--strip\s*\)/)).toBe(true);
  });

  it('un-bounds the whole section once the split stacks', () => {
    expect(runsPhoneBlock).toBeDefined();
    const phone = runsPhoneBlock as string;
    // A scroll box nested inside a scrolling page is worse than the status
    // quo once the layout is one column — so the bound comes off entirely
    // rather than being narrowed.
    expect(declares(phone, '.runs-board', /(^|[\s;])height\s*:\s*auto\b/)).toBe(true);
    expect(declares(phone, '.runs-split', /grid-template-columns\s*:\s*minmax\(0, 1fr\)/)).toBe(true);
    for (const selector of ['.runs-col, .runs-list, .runs-history-sheet, .runs-detail']) {
      expect(declares(phone, selector, /(^|[\s;])max-height\s*:\s*none\b/)).toBe(true);
      expect(declares(phone, selector, /(^|[\s;])overflow\s*:\s*visible\b/)).toBe(true);
    }
  });
});
