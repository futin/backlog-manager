import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The redesign's source guards (task-36; the design spec's §9).
 *
 * These read `client/src/styles.css`, `shared/theme.css`, `client/src/main.tsx`
 * and `package.json` AS TEXT, and that is the point rather than a shortcut.
 * Every rule below is a claim about what the sheet may contain, not about what
 * a rendered element looks like: "no rule anywhere sets a second face", "no
 * type is smaller than 11 px", "exactly one rule uppercases anything". A
 * behavioural test can only ever check the elements it happens to render, so a
 * new rule added in the wrong place next month would pass it — the failure
 * mode these exist for.
 *
 * Spec §9 heads this list "six source guards" and then lists seven. That
 * mismatch is the spec's own text; all seven are implemented here.
 */

const ROOT = join(__dirname, '..');
const STYLES = join(ROOT, 'client', 'src', 'styles.css');
const THEME = join(ROOT, 'shared', 'theme.css');
const MAIN = join(ROOT, 'client', 'src', 'main.tsx');
const PACKAGE = join(ROOT, 'package.json');

const styles = readFileSync(STYLES, 'utf8');
const theme = readFileSync(THEME, 'utf8');

/**
 * Comments are blanked rather than deleted, so a declaration's offset — and so
 * the line number in a failure message — still matches the real file. Every
 * guard below reads this and never the raw text: `--mono` appears in the
 * stylesheets' prose describing why it was removed, and a guard that counted
 * those would be unfixable without deleting the explanation.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Every `selector { declarations }` pair, comments already blanked. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(css))) !== null) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

const styleRules = rules(styles);

/**
 * A theme block is one that declares `--board`: the palette blocks and nothing
 * else. Selector alone cannot tell them apart, because `shared/theme.css`
 * reuses the same five selectors further down for the `--proj-N` sets, and a
 * guard keyed on the selector would count each theme twice and then fail for a
 * reason that has nothing to do with what it is checking.
 */
const themeBlocks = rules(theme).filter((r) => /--board:/.test(r.body));

describe('guard 1 — no second face is named anywhere', () => {
  it('neither stylesheet declares or reads --mono or --display', () => {
    const offenders: string[] = [];
    for (const [name, css] of [
      ['styles.css', styles],
      ['theme.css', theme]
    ] as const) {
      for (const token of ['--mono', '--display']) {
        if (stripComments(css).includes(token)) offenders.push(`${name} still mentions ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('guard 2 — one --font stack, and nothing else picks a face', () => {
  it('every theme block in theme.css declares exactly one --font stack', () => {
    expect(themeBlocks).toHaveLength(5);
    for (const block of themeBlocks) {
      const decls = block.body.match(/--font: *[^;]+/g) ?? [];
      expect({ selector: block.selector, count: decls.length }).toEqual({
        selector: block.selector,
        count: 1
      });
      expect(decls[0]).toContain("'Hanken Grotesk'");
    }
  });

  /**
   * §9's wording is "styles.css declares no other font-family but `inherit`".
   * One declaration necessarily names the face — `body`, which is where the
   * app's own font is applied — so the guard is stated as the rule that
   * sentence means: exactly one `font-family: var(--font)`, on `body`, and
   * every other `font-family` in the sheet is `inherit`. A second
   * `var(--font)` would be a second place to edit the face; anything else at
   * all would be a second face.
   */
  it('styles.css names the face once, on body, and inherits everywhere else', () => {
    const decls = styleRules.flatMap((r) =>
      (r.body.match(/font-family: *[^;}]+/g) ?? []).map((d) => ({
        selector: r.selector,
        value: d.replace(/font-family: */, '').trim()
      }))
    );
    const named = decls.filter((d) => d.value !== 'inherit');
    expect(named).toEqual([{ selector: 'body', value: 'var(--font)' }]);
    for (const d of decls) expect(['var(--font)', 'inherit']).toContain(d.value);
  });
});

describe('guard 3 — 11 px is the floor', () => {
  /**
   * The three legal non-px sizes, each with the reason it cannot be a px
   * literal. A selector not on this list may not use `em`, `calc()` or any
   * other non-px value at all: the point of the guard is that a size which
   * cannot be read off the scale has to be argued for here, in the test, where
   * the next person changing it will see the argument.
   */
  const NON_PX_ALLOWED: Record<string, string> = {
    '.board-card-stage-glyph': 'sized off the chip’s own font (1.15em) so a ✓ matches the word beside it at any scale',
    '.watchdog-verdict-glyph': 'same bargain as the stage glyph: 1.05em keeps the mark level with its row’s type',
    '.set-control input[type=number], .set-control input[type=text]': 'iOS Safari’s 16 px no-zoom floor, stated in declared px by dividing out --font-scale'
  };

  it('every px-literal font-size in styles.css is at least 11 px', () => {
    const tooSmall = styleRules.flatMap((r) =>
      (r.body.match(/font-size: *([0-9.]+)px/g) ?? [])
        .map((d) => Number(/([0-9.]+)px/.exec(d)?.[1]))
        .filter((px) => px < 11)
        .map((px) => `${r.selector} → ${px}px`)
    );
    expect(tooSmall).toEqual([]);
  });

  it('a non-px font-size is legal only for an allowlisted selector', () => {
    const nonPx = styleRules
      .filter((r) => (r.body.match(/font-size: *([^;}]+)/g) ?? []).some((d) => !/^font-size: *[0-9.]+px$/.test(d.trim())))
      .map((r) => r.selector);
    expect(nonPx.sort()).toEqual(Object.keys(NON_PX_ALLOWED).sort());
  });
});

describe('guard 4 — one rule uppercases anything', () => {
  it('text-transform: uppercase appears in exactly one rule, .rail-kicker', () => {
    const shouting = styleRules.filter((r) => /text-transform: *uppercase/.test(r.body));
    expect(shouting.map((r) => r.selector)).toEqual(['.rail-kicker']);
  });
});

describe('guard 5 — the daylight palette and the two fill tokens', () => {
  /** The design spec's §2.2 table, verbatim. */
  const DAYLIGHT: Record<string, string> = {
    '--board': '#f4f4f3',
    '--steel': '#ededec',
    '--strip': '#ffffff',
    '--strip-hi': '#f2f2f1',
    '--edge': 'rgba(0,0,0,.03)',
    '--hairline': '#eaeae8',
    '--hairline2': '#dcdcda',
    '--ink': '#131313',
    '--ink2': '#6e6e6e',
    '--ink3': '#a0a0a0',
    '--green': '#5fa92c',
    '--amber': '#c4761f',
    '--mustard': '#9a8712',
    '--cyan': '#3f8f14',
    '--red': '#b03b28',
    '--magenta': '#6b52a8',
    '--on-accent': '#ffffff',
    '--scrim': 'rgba(19,19,19,.28)',
    '--shadow': 'rgba(0,0,0,.06)',
    '--shadow2': 'rgba(0,0,0,.1)',
    '--fill-live': '#F5A15C',
    '--fill-progress': '#7DC242'
  };

  it('the daylight block carries §2.2’s values exactly', () => {
    const daylight = themeBlocks.find((b) => b.selector.includes('daylight'));
    expect(daylight).toBeDefined();
    const actual: Record<string, string> = {};
    for (const token of Object.keys(DAYLIGHT)) {
      const m = new RegExp(`${token}: *([^;\\n]+)`).exec((daylight as { body: string }).body);
      actual[token] = m ? m[1].trim() : '(absent)';
    }
    expect(actual).toEqual(DAYLIGHT);
  });

  it('every theme block declares both fill tokens', () => {
    for (const block of themeBlocks) {
      expect({
        selector: block.selector,
        live: /--fill-live: *[^;]+/.test(block.body),
        progress: /--fill-progress: *[^;]+/.test(block.body)
      }).toEqual({ selector: block.selector, live: true, progress: true });
    }
  });
});

describe('guard 6 — one font package, four weights', () => {
  const main = readFileSync(MAIN, 'utf8');
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('main.tsx imports Hanken Grotesk at 400/500/600/700 and no other @fontsource', () => {
    const imports = (main.match(/@fontsource\/[^']+/g) ?? []).sort();
    expect(imports).toEqual([
      '@fontsource/hanken-grotesk/400.css',
      '@fontsource/hanken-grotesk/500.css',
      '@fontsource/hanken-grotesk/600.css',
      '@fontsource/hanken-grotesk/700.css'
    ]);
  });

  it('package.json lists exactly one @fontsource package', () => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@fontsource'));
    expect(deps).toEqual(['@fontsource/hanken-grotesk']);
  });
});

describe('guard 7 — one home per primitive', () => {
  /**
   * The families owned by `client/src/components/ui/`, one per component in the
   * design spec's §12.2 table minus `Modal` and `FormSheet` (task 5's). The
   * pairs that ship together share a family on purpose: a `SheetHead` outside a
   * `Sheet` is not a thing, and neither is a `Figure` outside a `FigureStrip`.
   */
  const FAMILIES = [
    '.ui-band',
    '.ui-sheet',
    '.ui-figure',
    '.ui-chip',
    '.ui-pill',
    '.ui-dot',
    '.ui-marker',
    '.ui-progress',
    '.ui-ledger',
    '.ui-seg',
    '.ui-select',
    '.ui-number',
    '.ui-switch'
  ];

  const HEADER = '/* ── ui primitives';
  const FOOTER = '/* ── end ui primitives';
  const blockStart = styles.indexOf(HEADER);
  const blockEnd = styles.indexOf(FOOTER);

  /**
   * The block is delimited at BOTH ends, and the closing marker is the half
   * that matters: the block sits last in the sheet, so "after the header"
   * would mean "anywhere below it" and a rule appended to the file — the
   * single likeliest way a page comes to restate a primitive's look — would
   * have read as part of the block and passed.
   */
  const inside = (at: number): boolean => at > blockStart && at < blockEnd;

  it('the ui primitives block is delimited at both ends', () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
  });

  it('each family is declared exactly once, as a bare base selector, inside the block', () => {
    for (const family of FAMILIES) {
      const bare = styleRules.filter((r) => r.selector === family);
      expect({ family, count: bare.length }).toEqual({ family, count: 1 });
      expect({ family, inside: inside(styles.indexOf(`\n${family} {`)) }).toEqual({ family, inside: true });
    }
  });

  /**
   * A page may LAY a primitive out — grid, gap, width, from its own class — and
   * may never restate its look. Any selector outside the block whose own
   * classes start with a family name would be exactly that restatement, which
   * is how two surfaces come to disagree about a radius.
   */
  it('no selector outside the block starts with a family name', () => {
    const offenders: string[] = [];
    for (const rule of styleRules) {
      const at = styles.indexOf(`${rule.selector.split(',')[0].trim()} {`);
      if (inside(at)) continue;
      // Prefix matching, not equality: `.ui-chip-quiet` declared on a page is
      // the restatement this guard exists to catch, and it is not the family
      // name on the nose. Every class token in the selector is checked, so a
      // descendant selector cannot smuggle one in on its right-hand side.
      for (const token of rule.selector.match(/\.[\w-]+/g) ?? []) {
        const family = FAMILIES.find((f) => token.startsWith(f));
        if (family) offenders.push(`${rule.selector} (family ${family})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
