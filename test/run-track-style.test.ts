import { readStyles, ruleBlock } from './helpers/css-rule';

/**
 * StageTrack's reduced-motion carve-out — the `.run-track*` block's own
 * trailing `@media (prefers-reduced-motion: reduce)` rule in
 * client/src/styles.css — has no other guard anywhere in this suite, and
 * needs one for two independent reasons:
 *
 * - The file's blanket reduced-motion reset (`* { animation-duration:
 *   .01ms !important; ... }`, near the top of the file) cannot reach it.
 *   The universal selector matches real DOM elements only, never the
 *   generated content a `::before`/`::after` paints, and the sweep this
 *   rule cancels — `run-track-sweep` on
 *   `.run-track-node[data-in="live"]::before` — is that blanket rule's
 *   first pseudo-element animation in the whole file. The gap was real:
 *   left alone, the sweep keeps sliding for a reduced-motion reader.
 * - jsdom cannot evaluate media queries at all (and performs no layout, so
 *   it could not observe the sweep even without that limitation) — which
 *   is exactly why nothing in `stage-track.test.tsx`, a render suite, can
 *   ever stand in for this. That combination is precisely how the gap
 *   shipped in the first place: the implementation plan's own CSS section
 *   asserted "the file's reduced-motion block already zeroes every
 *   animation, so no new media rule is needed," which was true of every
 *   animation in the file up to this one, and wrong for this one — and
 *   nothing mechanical caught the mistake until a design review read the
 *   stylesheet by eye.
 *
 * Same register as run-stepper-style.test.ts (a frozen contract suite,
 * deliberately left untouched — this is its own file, not an edit to it):
 * assert on the stylesheet's own text, because the declarations being
 * DECLARED is the part a later cleanup can silently delete, and reduced
 * motion is the one property of this file no render test can ever prove.
 */
describe('stage-track reduced-motion stylesheet rules', () => {
  const css = readStyles();

  /**
   * `ruleBlocks` (helpers/css-rule.ts) captures a flat selector's own
   * `{...}` body by scanning to the very next `}` after its `{` — correct
   * for one rule, but wrong for an at-rule that wraps several: the next
   * `}` after `@media (...) {`'s own opening brace belongs to the FIRST
   * nested rule, not to the media block itself. Extracting the reduced-
   * motion block's full body needs brace-depth counting instead, which is
   * the one thing this file adds beyond the shared helper — kept local
   * rather than folded into helpers/css-rule.ts because no other caller of
   * that helper queries an at-rule's own body; every one of them looks up
   * a flat selector.
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

  // The file has two `@media (prefers-reduced-motion: reduce)` blocks: the
  // file-wide blanket reset near the top, and this section's own carve-out
  // at the end of the `.run-track*` block. Picking the one that actually
  // mentions a run-track selector — rather than assuming an index or a
  // position — keeps this test correct even if a third block is ever added
  // somewhere else in the file.
  const reducedMotionBlocks = mediaBlocks(css, '@media (prefers-reduced-motion: reduce)');
  const trackReducedMotion = reducedMotionBlocks.find((block) => block.includes('.run-track-node[data-in="live"]::before'));

  it('has a reduced-motion block that covers the stage track', () => {
    expect(trackReducedMotion).toBeDefined();
  });

  /* task-38 repainted the track in the two fill TOKENS (§8.2) rather than the
     raw `--cyan` it used to name: a reached node takes `--fill-progress` and
     the current one `--fill-live`, which are the same tokens the stage bars
     and the board's own dots read. The assertion follows the token, because
     what it is defending is "the fallback is a SOLID fill, not the gradient",
     and naming the old colour would pin a decision this task moved. */
  it('cancels the sweep animation and falls back to a solid fill, not the gradient', () => {
    const rule = ruleBlock(trackReducedMotion as string, '.run-track-node[data-in="live"]::before');
    expect(rule).not.toBeNull();
    expect(rule as string).toMatch(/(^|[\s;])animation\s*:\s*none\b/);
    expect(rule as string).toMatch(/(^|[\s;])background\s*:\s*var\(--fill-live\)/);
    expect(rule as string).not.toMatch(/linear-gradient/);
  });

  it('cancels the current-dot ring outright rather than freezing it on its last frame', () => {
    const rule = ruleBlock(trackReducedMotion as string, '.run-track-dot-current');
    expect(rule).not.toBeNull();
    expect(rule as string).toMatch(/(^|[\s;])animation\s*:\s*none\b/);
  });
});

/**
 * bug-15's fourth dot state has to be told apart by SIGHT from the other
 * three, and sight is exactly what jsdom cannot check — the same split
 * run-stepper-style.test.ts states for the drawer's own three states:
 * stage-track.test.tsx pins the state CLASSES, this pins that those classes
 * actually paint something different, and neither half can stand in for the
 * other.
 *
 * The claim being defended is the whole reason the state exists: a stalled
 * node must not read as "this is happening right now". It is amber (the tone
 * `run-stage.ts` already gives `parked`/`needs-answers` — a run that stopped
 * needing a human is the same register) and it never animates.
 */
describe('stalled stage-track stylesheet rules (bug-15)', () => {
  const css = readStyles();

  it('has a rule for the stalled dot, its segment, and the drawer-sized dot', () => {
    for (const selector of ['.run-track-dot-stalled', '.run-track-node[data-in="stalled"]::before', '.run-stepper-dot-stalled']) {
      const block = ruleBlock(css, selector);
      expect(block).not.toBeNull();
      expect((block as string).trim()).not.toEqual('');
    }
  });

  /**
   * Nothing on a stalled node may move. The blanket reduced-motion reset
   * cannot be leaned on here (it is media-gated, and never reaches a
   * pseudo-element at all — see this file's own header): a stalled node is
   * static for EVERY reader, because the motion would be asserting something
   * false, not merely something distracting.
   */
  it('never animates the stalled dot or its segment', () => {
    for (const selector of ['.run-track-dot-stalled', '.run-track-node[data-in="stalled"]::before']) {
      const rule = ruleBlock(css, selector) as string;
      const animation = /(^|[\s;])animation\s*:\s*([^;]+)/.exec(rule);
      if (animation !== null) expect(animation[2].trim()).toBe('none');
      expect(rule).not.toMatch(/run-track-ring|run-track-sweep/);
    }
  });

  /**
   * Two channels, not one — run-stepper-style.test.ts's own stated rule, for
   * its own stated reason: colour alone fails a monochrome reader. Stalled is
   * amber-ringed and static where `filled` is a solid green fill and
   * `current` is a cyan fill that pulses, so it differs from each of them in
   * both the declarations it makes and the ones it refuses to.
   */
  it('differs from the filled and current dots in more than colour', () => {
    const stalled = ruleBlock(css, '.run-track-dot-stalled') as string;
    const filled = ruleBlock(css, '.run-track-dot-filled') as string;
    const current = ruleBlock(css, '.run-track-dot-current') as string;

    const declarations = (rule: string): string[] =>
      rule
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter((d) => d !== '');

    for (const other of [filled, current]) {
      const differing = declarations(stalled).filter((d) => !declarations(other).includes(d));
      expect(differing.length).toBeGreaterThanOrEqual(2);
    }

    // The channel that carries the meaning: `current` moves, `stalled` does
    // not. Asserted on the pair rather than on `stalled` alone, so a future
    // edit that stops the current dot pulsing has to come back through here.
    expect(current).toMatch(/(^|[\s;])animation\s*:\s*run-track-ring\b/);
    expect(stalled).not.toMatch(/run-track-ring/);
  });
});

/**
 * task-38's four node states (DESIGN.md §8.4.3), and the one property no
 * render suite can ever prove: that they are told apart by **fill and ring
 * together**, never by four shades of one colour. `stage-track.test.tsx` pins
 * which class each node carries; this pins that the four classes actually
 * paint four distinguishable things — the same split `run-stepper-style` and
 * the stalled block above already document, applied to the pair this redraw
 * exists for.
 *
 * That pair is `skipped` against not-reached. Both are unfilled; before this
 * task the only thing separating "never needed" from "not there yet" was the
 * duration underneath, which reads `—` in both cases. The DASHED stroke is
 * what carries it, and a dashed stroke is invisible to jsdom.
 */
describe('stage-track four-state stylesheet rules (task-38)', () => {
  const css = readStyles();

  /** Every declaration in a rule, normalised — `prop: value`, one per entry. */
  const declarations = (rule: string): string[] =>
    rule
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter((d) => d !== '');

  it('gives the not-reached base a steel fill and a hairline ring', () => {
    const base = ruleBlock(css, '.run-track-dot') as string;
    expect(base).not.toBeNull();
    expect(base).toMatch(/background\s*:\s*var\(--steel\)/);
    expect(base).toMatch(/box-shadow\s*:[^;]*var\(--hairline2\)/);
  });

  it('gives reached and current the two fill tokens, never two shades of one', () => {
    expect(ruleBlock(css, '.run-track-dot-filled') as string).toMatch(/background\s*:\s*var\(--fill-progress\)/);
    expect(ruleBlock(css, '.run-track-dot-current') as string).toMatch(/background\s*:\s*var\(--fill-live\)/);
  });

  /*
    The assertion this whole describe exists for. `dashed` is the word: a
    skipped node and a not-reached one are both unfilled, so the STROKE is the
    only channel left, and a solid one on either would collapse the pair.
  */
  it('rings a skipped node with a dashed stroke and nothing else', () => {
    const skipped = ruleBlock(css, '.run-track-dot-skipped') as string;
    expect(skipped).not.toBeNull();
    expect(skipped).toMatch(/border\s*:[^;]*\bdashed\b/);
    expect(skipped).toMatch(/border\s*:[^;]*var\(--hairline2\)/);
    // No fill: a skipped node that painted anything would read as reached.
    expect(skipped).toMatch(/background\s*:\s*none/);
  });

  /*
    Pairwise, not against one reference: four states that each differ from a
    base are not necessarily four states that differ from EACH OTHER, and it
    is the pairs a reader actually compares.
  */
  it('draws all four states differently from one another', () => {
    const base = declarations(ruleBlock(css, '.run-track-dot') as string);
    const states: Record<string, string[]> = {
      notReached: base,
      reached: declarations(ruleBlock(css, '.run-track-dot-filled') as string),
      current: declarations(ruleBlock(css, '.run-track-dot-current') as string),
      skipped: declarations(ruleBlock(css, '.run-track-dot-skipped') as string)
    };
    const names = Object.keys(states);
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const differing = states[a].filter((d) => !states[b].includes(d));
        expect({ pair: `${a} vs ${b}`, differs: differing.length > 0 }).toEqual({ pair: `${a} vs ${b}`, differs: true });
      }
    }
  });

  /* The rail the nodes sit on: 2 px `--steel` (§8.4.3), and the reached
     segments repainted in the same token the reached node wears, so a run's
     progress reads as one object rather than as dots on an unrelated line. */
  it('draws the rail in steel and the travelled segments in the reached fill', () => {
    const rail = ruleBlock(css, '.run-track-node::before') as string;
    expect(rail).toMatch(/height\s*:\s*2px/);
    expect(rail).toMatch(/background\s*:\s*var\(--steel\)/);
    expect(ruleBlock(css, '.run-track-node[data-in="done"]::before') as string).toMatch(/background\s*:\s*var\(--fill-progress\)/);
  });
});
