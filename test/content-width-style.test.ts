import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStyles, ruleBlocks } from './helpers/css-rule';

/**
 * `contentWidth` is the one setting on this page whose whole effect lives
 * outside anything a component suite can observe, so it gets a source guard in
 * the idiom of live-bar-style.test.ts: these cases read files, they render
 * nothing.
 *
 * Two halves, and both are invisible to behaviour for their own reason. The
 * CSS half is invisible because jsdom applies no stylesheet — a rendered
 * assertion on the released measure would pass whether or not the rule
 * existed, and the failure mode is a segmented control that toggles cleanly
 * and changes nothing on screen. The pre-paint half is invisible because
 * `client/index.html` is never loaded by any suite: React's own stamp (pinned
 * in settings-view.test.tsx) would keep every case green while a `full`
 * install visibly snapped out of the fixed measure on every single load.
 *
 * Neither half is a detail a reader would think to check by hand, which is
 * exactly why they are checked here.
 */
const INDEX_HTML = join(__dirname, '..', 'client', 'index.html');

describe('content width', () => {
  /**
   * BOTH wraps are released, not just the narrow one. `.wrap.wide` is what
   * every section renders in — Settings included, since task-42 dropped the
   * shell's narrow-Settings ternary — so a rule that freed `.wrap` alone would
   * leave the entire app capped at 1280 px in a mode whose only promise is
   * that it is not.
   */
  it('releases both .wrap and .wrap.wide under the full stamp', () => {
    const css = readStyles();

    const narrow = ruleBlocks(css, ':root[data-width="full"] .wrap');
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.some((b) => /max-width: *none/.test(b))).toBe(true);

    const wide = ruleBlocks(css, ':root[data-width="full"] .wrap.wide');
    expect(wide.length).toBeGreaterThan(0);
    expect(wide.some((b) => /max-width: *none/.test(b))).toBe(true);
  });

  /**
   * The pre-paint stamp, read out of the one inline script the CSP pins.
   * Scoped to that script rather than to the file, so a mention of
   * `contentWidth` in a comment somewhere else in the page could not satisfy
   * this on its own.
   */
  it('stamps the width before first paint, from the same stored key', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

    expect(script).toContain('contentWidth');
    expect(script).toMatch(/dataset\.width *=/);
  });
});
