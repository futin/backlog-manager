import { readStyles, ruleBlock, ruleBlocks } from './helpers/css-rule';

/**
 * The stage chip's tones are a stylesheet fact, and the same jsdom limit
 * run-drawer-tail-style.test.ts documents applies here: the component suites
 * never load styles.css, so a rendering assertion on the chip's colour would
 * pass whether or not the rule existed. What the component suites CAN prove is
 * that the right class name lands on the element (they do, in
 * orchestrator-drawer.test.tsx); this file proves the class name means
 * something.
 *
 * The point being guarded is that success, failure and waiting are visually
 * DISTINCT — a later "simplification" that collapses two tone rules into one
 * would restore exactly the bug this redesign fixed, where a merged item and a
 * still-running one shared the active cyan.
 */
const BASE = '.board-card-stage';
const TONES = ['done', 'bad', 'warn', 'idle', 'muted'] as const;

describe('stage chip stylesheet rules', () => {
  const css = readStyles();

  it('gives the base chip a pill radius and room for the glyph', () => {
    const block = ruleBlock(css, BASE);
    expect(block).not.toBeNull();
    // 999px, not the board's usual 2px: the chip is a status token that must
    // be told apart from its neighbours at a glance, which is the one place
    // the sheet departs from that radius on purpose.
    expect(block as string).toMatch(/border-radius\s*:\s*999px/);
    // The glyph sits inside the chip's flex row; without a gap it collides
    // with the first letter of the stage word.
    expect(block as string).toMatch(/(^|[\s;])gap\s*:/);
  });

  it('declares a rule for every tone the helper can emit', () => {
    for (const tone of TONES) {
      const blocks = ruleBlocks(css, `${BASE}-${tone}`);
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.some((b) => b.trim() !== '')).toBe(true);
    }
  });

  /**
   * Each tone must set a colour of its own. Asserted as "declares `color`"
   * rather than against a specific token, because the palette differs across
   * theme.css's five palettes and pinning `var(--green)` here would make a
   * palette retune a test failure — but a tone rule with no `color` at all is
   * a tone that does not exist.
   */
  it('paints each tone distinctly', () => {
    const colors = TONES.map((tone) => {
      // Every rule naming this tone, not just the first: the pulse-cancel
      // rule lists five of these six selectors as ancestors and declares no
      // colour at all (see ruleBlocks' own comment).
      const declared = ruleBlocks(css, `${BASE}-${tone}`)
        .map((block) => /(?:^|[\s;])color\s*:\s*([^;]+)/.exec(block))
        .filter((m): m is RegExpExecArray => m !== null);
      expect(declared.length).toBeGreaterThan(0);
      return declared[0][1].trim();
    });
    // done/bad/warn in particular: three different answers to "what happened",
    // and the one triple a reader must never have to guess between.
    const [done, bad, warn] = colors;
    expect(new Set([done, bad, warn]).size).toBe(3);
  });

  /**
   * The pulse is the active tone's only motion, and it is opt-out. jsdom
   * cannot run an animation, so this is the only place the reduced-motion
   * contract can be checked at all — and it is the assertion most likely to be
   * lost, since the sheet's blanket `*` rule LOOKS like it already covers it
   * (it does not: it lands the pulse on its dimmest keyframe and leaves it
   * there, which is why the explicit override exists).
   */
  it('cancels the glyph pulse under prefers-reduced-motion', () => {
    const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(media).not.toBeNull();
    const body = (media as RegExpExecArray)[1];
    expect(body).toMatch(/\.board-card-stage-glyph[^{]*\{[^}]*animation\s*:\s*none/);
  });

  it('defines the pulse keyframes the active glyph names', () => {
    expect(css).toMatch(/@keyframes\s+stage-pulse\s*\{/);
    expect(css).toMatch(/animation\s*:\s*stage-pulse\b/);
  });

  /**
   * Not about the chip specifically — about the way this sheet is written.
   * Its comment density is deliberate and the comments are long English prose,
   * which makes ONE editing mistake unusually easy and unusually quiet: close
   * a comment early — a stray close-comment marker mid-paragraph — and the
   * rest of the sentence becomes raw CSS, the browser discards the malformed
   * rule that follows, and
   * everything still "builds". That is not hypothetical — it happened while
   * writing the chip rules above, and the only symptom was an unstyled chip in
   * the running app. No unit test could have caught it, because every test
   * here reads the file as TEXT, and the text was exactly as intended.
   *
   * Comment prose in this sheet uses em dashes and typographic quotes; the CSS
   * itself uses neither. So a mark of that kind surviving comment-stripping
   * means a comment leaked into the stylesheet. A crude check that names its
   * one real failure mode, rather than a hand-rolled CSS parser that would be
   * wrong in more interesting ways.
   */
  it('has no comment prose leaking into the stylesheet', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const mark of ['—', '“', '”', '’', '‘']) {
      expect(stripped).not.toContain(mark);
    }
    // The other half of the same mistake: an unmatched `*/` left behind.
    expect(stripped).not.toContain('*/');
  });
});
