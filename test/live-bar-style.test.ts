import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * Task 9's cyan run tone is a stylesheet fact, and the same jsdom limit
 * run-stage-chip-style.test.ts documents applies to it: the component suites
 * never load styles.css, so a rendered assertion on the bar's colour would pass
 * whether or not the rule existed. Those suites prove the right class name
 * lands on the element; this file proves the class name means something.
 *
 * Two things are being guarded, and neither is "the bar is pretty".
 *
 * First, that the cyan case is a MODIFIER and not a second bar. The base
 * `.board-card-live-bar` owns four tuned values — the `--card-pad-x` inline
 * padding that lines the label up with the title beneath it, the deliberately
 * fixed block padding, the `--on-accent` ink pairing, and the compact-density
 * retune elsewhere in the sheet. A "simplification" that gave the run tone its
 * own full rule would have to re-derive all four, and would drift from the
 * amber bar the first time one of them was tuned.
 *
 * Second, that no new palette entry was invented for a meaning the theme
 * already has a colour for. idea-4 originally proposed one across all five
 * themes; the board's own legend already reads cyan as "the orchestrator is
 * running this, without a human" (`.board-card-stage`'s own comment argues it
 * at length), so the tone had to be `var(--cyan)` and `shared/theme.css` had to
 * stay untouched.
 */
const THEME = join(__dirname, '..', 'shared', 'theme.css');

describe('live bar run-tone stylesheet rules', () => {
  const css = readStyles();

  // Both halves of the tone: the filled band across the card's face, and the
  // card's own hairline. Asserted together because a card whose bar is cyan and
  // whose border is still amber reads as two different claims about one item.
  it('paints both the run bar and the run card border with the theme cyan', () => {
    const bar = ruleBlocks(css, '.board-card-live-bar-run');
    expect(bar.length).toBeGreaterThan(0);
    expect(bar.some((b) => /background\s*:\s*var\(--cyan\)/.test(b))).toBe(true);

    const card = ruleBlocks(css, '.board-card-live-run');
    expect(card.length).toBeGreaterThan(0);
    expect(card.some((b) => /border-color\s*:\s*var\(--cyan\)/.test(b))).toBe(true);
  });

  // The modifier's whole contract: it overrides the fill and nothing else. A
  // padding, font or layout declaration appearing here is the exact drift this
  // pins — it would mean the run bar had started re-deriving what the base rule
  // already tunes, instead of inheriting it.
  it('declares nothing but the fill on the run bar modifier', () => {
    // Matched on the rule's own selector rather than through `ruleBlocks`,
    // which scans the raw text and so also finds a class name mentioned inside
    // a comment — harmless for a `.some()` assertion, fatal for this one, which
    // asserts an exact property list and would fail against whichever rule
    // happened to follow the prose.
    const rule = /(^|\n)\s*\.board-card-live-bar-run\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const props = (rule as RegExpExecArray)[2]
      .split(';').map((d) => d.split(':')[0].trim()).filter((p) => p !== '');
    expect(props).toEqual(['background']);
  });

  // The amber base is still the amber base: the hand-run bar and a run blocked
  // on a person both read as "a human is involved here", which is the legend
  // entry the cyan modifier deliberately does NOT touch.
  it('leaves the base bar and base live border amber', () => {
    expect(ruleBlocks(css, '.board-card-live-bar')
      .some((b) => /background\s*:\s*var\(--amber\)/.test(b))).toBe(true);
    expect(ruleBlocks(css, '.board-card-live')
      .some((b) => /border-color\s*:\s*var\(--amber\)/.test(b))).toBe(true);
  });

  // The palette itself, read rather than assumed: `--cyan` already exists in
  // every theme block, so the tone needed no new token — and a token added for
  // this would be a synonym for a meaning the sheet already carries.
  it('needs no new palette token: --cyan is already defined in every theme', () => {
    const theme = readFileSync(THEME, 'utf8');
    // Five palettes (the default plus four `[data-theme=…]` blocks), each
    // declaring the token this tone spends.
    expect(theme.match(/--cyan\s*:/g) ?? []).toHaveLength(5);
    // Nothing named for the orchestrator, the run, or a card bar: those would
    // be the shapes a new entry took if someone added one later.
    expect(theme).not.toMatch(/--(?:run|orch|live)[a-z-]*\s*:/i);
  });
});
