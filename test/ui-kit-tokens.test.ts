import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `--uk-*` token ui-kit's stylesheet reads is mapped onto this board's own in `client/src/styles.css` (spec D13: the kit ships tokens with neutral
 * fallbacks, and each app maps them once). Since v0.3.0 the kit reads only its 22 public tokens — sizes, radius and width are its own literals — so nothing is
 * left to a fallback on purpose; the other half of the contract, that this board restyles no `.uk-*` class, is `test/ui-kit-guard.test.ts`.
 *
 * The guard is over the kit's shipped CSS, not a list typed here, because the failure it exists for is a token nobody noticed: `--uk-code-bg` and
 * `--uk-font-mono` went unmapped through #298, so a code span in the release notes drew in a monospace face this board keeps out everywhere else and on a
 * 6 % black that all but vanishes on the four dark themes (#299). A ui-kit bump that starts reading a new token goes red here until it is mapped.
 */

const ROOT = join(__dirname, '..');
const KIT = readFileSync(require.resolve('ui-kit/styles.css'), 'utf8');
const STYLES = readFileSync(join(ROOT, 'client', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function mapped(): Set<string> {
  const root = [...STYLES.matchAll(/(?:^|\})\s*:root\s*\{([^{}]*)\}/g)].map((m) => m[1]).find((b) => b.includes('--uk-'));
  expect(root).toBeDefined();
  return new Set([...(root as string).matchAll(/(--uk-[\w-]+)\s*:/g)].map((m) => m[1]));
}

describe('ui-kit tokens', () => {
  it('every --uk-* token the kit reads is mapped in styles.css', () => {
    const read = [...new Set([...KIT.matchAll(/var\(\s*(--uk-[\w-]+)/g)].map((m) => m[1]))].sort();
    // Guards the parser, not the mapping: a regex that matched nothing would pass the check below on an empty list.
    expect(read).toEqual(expect.arrayContaining(['--uk-accent', '--uk-feat-ink', '--uk-code-bg']));
    const map = mapped();
    expect(read.filter((t) => !map.has(t))).toEqual([]);
  });

  it('maps nothing the kit does not read', () => {
    const read = new Set([...KIT.matchAll(/var\(\s*(--uk-[\w-]+)/g)].map((m) => m[1]));
    const map = mapped();
    expect([...map].filter((t) => !read.has(t))).toEqual([]);
  });
});
