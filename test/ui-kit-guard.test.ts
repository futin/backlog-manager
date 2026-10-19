import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkHostCss } from 'ui-kit/guard';

/**
 * ui-kit owns every shape of the version chip and the What's new drawer (v0.3.0); this board owns only the `--uk-*` mapping and the chip's placement. The
 * guard reads each stylesheet this board ships and fails on a rule that restyles a `.uk-*` class or sets a `--uk-*` property that is not a public token —
 * the failure it exists for is the one #298 shipped: a `.uk-drawer` override here, quietly making this board's drawer differ from the other two apps'.
 *
 * The sheets are listed explicitly, so a new stylesheet is a deliberate add to this suite rather than an unread one.
 */
const ROOT = join(__dirname, '..');
const SHEETS = ['client/src/styles.css', 'shared/theme.css'];

describe('ui-kit guard', () => {
  it.each(SHEETS)('%s maps tokens and never restyles the kit', (file) => {
    const css = readFileSync(join(ROOT, file), 'utf8');
    // A message with the file name in it: `toEqual([])` alone would print the offences without saying which sheet they came from.
    expect({ file, offences: checkHostCss(css) }).toEqual({ file, offences: [] });
  });

  /**
   * The guard cannot see a token nobody mapped. `--uk-chip-bg` unmapped leaves the kit's light default well on a dark rail, and `--uk-zoom` unmapped lets the
   * drawer overhang the screen by the text scale (`.shell` zooms, and `100vw`/`100dvh` stay the unzoomed screen).
   */
  it('maps --uk-chip-bg and --uk-zoom', () => {
    const css = readFileSync(join(ROOT, 'client/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const mapping = [...css.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)].map((m) => m[1]).find((b) => b.includes('--uk-'));
    expect(mapping).toBeDefined();
    expect(mapping).toMatch(/--uk-chip-bg\s*:\s*var\(--steel\)/);
    expect(mapping).toMatch(/--uk-zoom\s*:\s*var\(--font-scale,\s*1\)/);
  });
});
