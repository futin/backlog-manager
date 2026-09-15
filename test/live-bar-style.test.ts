import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStyles, ruleBlock, ruleBlocks } from './helpers/css-rule';

/**
 * The card's live strip is a stylesheet fact, and the same jsdom limit
 * run-stage-chip-style.test.ts documents applies to it: the component suites
 * never load styles.css, so a rendered assertion on the strip's colour would
 * pass whether or not the rule existed. Those suites prove the right class name
 * lands on the element; this file proves the class name means something.
 *
 * task-37 rewrote what is being guarded, and the change is a DELETION rather
 * than a re-skin. Task 9's second tone — cyan for the orchestrator's six
 * working stages against amber for a run blocked on a person — is gone, along
 * with the `.board-card-live-bar-run`/`.board-card-live-run` modifier pair and
 * the card border both recoloured. DESIGN.md §8.3 draws ONE `--fill-live`
 * hatched strip for every case and lets the stage word carry the distinction,
 * because this design marks state by ink and never by accent (§5).
 *
 * So the cases below pin the opposite of what they used to: that there is one
 * fill, that it is the token the design names, that the ink on it is the one
 * that survives a dark theme, that the hatch it composes is the sheet's one
 * utility rather than a gradient restated here, and that no second tone has
 * crept back in. The derivation the old tone came from
 * (`liveBarFor`'s `tone`) is untouched and still pinned by the component
 * suites — what left is only its effect on the paint.
 */
const THEME = join(__dirname, '..', 'shared', 'theme.css');

describe('live strip stylesheet rules', () => {
  const css = readStyles();

  /**
   * The strip's own four tuned values, in one rule: the design's 24 px height,
   * the `--fill-live` fill, the ink that goes on it, and the `--card-pad-x`
   * inline padding that lines the stage word up with the title beneath it and
   * follows the compact-density retune with it.
   *
   * The ink is `--on-fill` and not the `--ink` DESIGN.md §8.3 writes, and that
   * is the one place this task departed from the design's letter to keep its
   * intent: `--ink` is near-white in four of the five palettes, so 11 px type
   * on a bright amber fill measured 1.4:1 on midnight — the DEFAULT theme.
   * `--on-fill` is the token task-37 added to every theme block for it, and
   * guard 5 (`test/design-guards.test.ts`) is what stops it being declared in
   * four blocks out of five — a miss resolves to nothing and inherits exactly
   * the unreadable pairing it was added to fix.
   */
  it('paints the strip with --fill-live at the design height, in the ink for it', () => {
    const strip = ruleBlock(css, '.board-card-live') as string;
    expect(strip).not.toBeNull();
    expect(strip).toMatch(/background\s*:\s*var\(--fill-live\)/);
    expect(strip).toMatch(/height\s*:\s*24px/);
    expect(strip).toMatch(/color\s*:\s*var\(--on-fill\)/);
    expect(strip).toMatch(/padding\s*:\s*0 var\(--card-pad-x\)/);
  });

  /**
   * The texture is `.hatch`, the sheet's one utility rule over any fill
   * (DESIGN.md §8.2), composed as a second class on the element rather than
   * restated as a gradient inside the strip's own rule. A second copy would be
   * a second 45°/1px/4px triple to keep in step with the design's signature
   * texture everywhere else it appears.
   */
  it('composes the sheet-wide hatch utility rather than its own gradient', () => {
    expect(ruleBlock(css, '.hatch') as string).toMatch(/repeating-linear-gradient/);
    expect(ruleBlock(css, '.board-card-live') as string).not.toMatch(/gradient/);
  });

  /**
   * The deletion, pinned as a deletion. A "restore the cyan for running items"
   * change would have to put one of these names back, and this is what catches
   * it — the rule that only one fill exists cannot be expressed by the presence
   * of the rule above, only by the absence of a second.
   */
  it('has no second tone: neither modifier exists anywhere in the sheet', () => {
    expect(ruleBlocks(css, '.board-card-live-bar-run')).toEqual([]);
    expect(ruleBlocks(css, '.board-card-live-run')).toEqual([]);
    // The card itself no longer recolours its own edge either — it has no edge:
    // §8.3 gives it no stroke at all, so a `border-color` on the card is the
    // other half of the same restoration.
    // `border-radius` is not a border — the card's 12 px corner is §8.3's and
    // stays — so the pattern excludes it by name rather than matching `border`
    // loosely and being fixed by whoever trips it next.
    expect(ruleBlock(css, '.board-card') as string).not.toMatch(/border(?!-radius)/);
  });

  /**
   * The palette itself, read rather than assumed. `--fill-live` is task-36's,
   * declared in every theme block precisely because the design draws bright
   * fills the palette had no non-text colour for — so the FILL needed no new
   * token, and one added for it would be a synonym the next reader has to tell
   * apart from the one already there. The ink on it did need one, for the
   * measured reason the first case records; guard 5 is what holds that one in
   * all five blocks, and what this case still refuses is a token named for
   * this SURFACE rather than for the job, which is how a palette grows a
   * private colour per component.
   */
  it("spends the palette's own tokens: --fill-live in every theme, and nothing named for a run", () => {
    const theme = readFileSync(THEME, 'utf8');
    // Five palettes: the default plus four `[data-theme=…]` blocks.
    expect(theme.match(/--fill-live\s*:/g) ?? []).toHaveLength(5);
    // Nothing named for the orchestrator, the run, or a card bar: those are the
    // shapes a new entry would take if someone added one later.
    expect(theme).not.toMatch(/--(?:run|orch|bar)[a-z-]*\s*:/i);
  });
});
