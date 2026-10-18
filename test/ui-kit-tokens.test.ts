import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `--uk-*` token ui-kit's stylesheet reads is either mapped onto this board's own in `client/src/styles.css`, or left to the kit's fallback on purpose
 * and named below with the reason (spec D13: the kit ships tokens with neutral fallbacks, and each app maps them once).
 *
 * The guard is over the kit's shipped CSS, not a list typed here, because the failure it exists for is a token nobody noticed: `--uk-code-bg` and
 * `--uk-font-mono` went unmapped through #298, so a code span in the release notes drew in a monospace face this board keeps out everywhere else and on a
 * 6 % black that all but vanishes on the four dark themes (#299). A ui-kit bump that starts reading a new token goes red here until someone decides which
 * side of this line it belongs on.
 */

const ROOT = join(__dirname, '..');
const KIT = readFileSync(require.resolve('ui-kit/styles.css'), 'utf8');
const STYLES = readFileSync(join(ROOT, 'client', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Sizes the kit's fallbacks already match this board's scale on, and the one geometry `styles.css` sets on `.uk-drawer` itself. None is a colour or a face. */
const KIT_DEFAULT: Record<string, string> = {
  '--uk-font-size': '14 px — the title, the ✕ and the version read it too; the notes are set to 13 px by their own rule instead',
  '--uk-font-size-sm': '12 px, the board’s small reading size',
  '--uk-font-size-xs': '11 px, the badge size §8.10 records',
  '--uk-radius': '12 px; the chip is redrawn as a pill by `.rail-release`, so only the ✕ reads it',
  '--uk-drawer-width': '400 px, and `.uk-drawer` sets its own width for the font-scale division'
};

function mapped(): Set<string> {
  const root = [...STYLES.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)].map((m) => m[1]).find((b) => b.includes('--uk-'));
  expect(root).toBeDefined();
  return new Set([...(root as string).matchAll(/(--uk-[\w-]+)\s*:/g)].map((m) => m[1]));
}

describe('ui-kit tokens', () => {
  it('every --uk-* token the kit reads is mapped in styles.css or deliberately left to its fallback', () => {
    const read = [...new Set([...KIT.matchAll(/var\(\s*(--uk-[\w-]+)/g)].map((m) => m[1]))].sort();
    // Guards the parser, not the mapping: a regex that matched nothing would pass the check below on an empty list.
    expect(read).toEqual(expect.arrayContaining(['--uk-accent', '--uk-feat-ink', '--uk-code-bg']));
    const map = mapped();
    expect(read.filter((t) => !map.has(t) && !(t in KIT_DEFAULT))).toEqual([]);
  });

  it('maps nothing the kit does not read, and leaves to the fallback nothing it maps', () => {
    const read = new Set([...KIT.matchAll(/var\(\s*(--uk-[\w-]+)/g)].map((m) => m[1]));
    const map = mapped();
    expect([...map].filter((t) => !read.has(t))).toEqual([]);
    expect(Object.keys(KIT_DEFAULT).filter((t) => map.has(t) || !read.has(t))).toEqual([]);
  });
});
