import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Daylight's status colours hold WCAG AA, and the four dark themes do not move to get there.
 *
 * Daylight's accents used to be one token per hue doing two jobs: the ink a warning word is set in, and the mark a meter or a dot is filled with. On white
 * those two jobs want opposite things — a mark reads at 3:1 and wants to stay bright enough to look like its hue, running text needs 4.5:1 — and the single
 * value that tried to serve both failed the text half everywhere (`--green` #5fa92c was 2.92:1 on `--strip`). The fix, mirrored from the sibling
 * claude-agents-dashboard so the two repos keep one vocabulary, is to split mark from text: `--green-solid` / `--amber-solid` carry the bright mark,
 * `--green` / `--amber-text` the text, and `--amber-ink` the amber word set on an amber tint. Every pair below is computed from the stylesheets' own text,
 * so a retune that drops a pair under the line goes red here before anybody has to see it.
 *
 * The cascade is emulated, not assumed. A theme's value of a token is the LAST declaration, in source order, among the `shared/theme.css` blocks whose
 * selector list names `:root` or that theme's `[data-theme="…"]` — which is how the browser resolves it on `<html>`, since every one of those blocks
 * matches that element at the same specificity. That is the whole reason for the "defaults precede daylight" case: a `:root{}` defaults block placed after
 * the daylight block would win, and silently hand daylight the dark themes' derivation.
 *
 * Jest rather than the dashboard's node runner because this repo's style guards are all flat jest suites in `test/` (`design-guards.test.ts`,
 * `run-detail-crashed-style.test.ts`) — see `.claude/rules/tests.md`.
 */

const ROOT = join(__dirname, '..');
const THEME = readFileSync(join(ROOT, 'shared', 'theme.css'), 'utf8');
const STYLES = readFileSync(join(ROOT, 'client', 'src', 'styles.css'), 'utf8');

/** WCAG 1.4.3 body text. */
const AA = 4.5;
/** WCAG 1.4.11: a non-text mark — a meter fill, a status dot, a border — against what it is drawn on. */
const MARK = 3;

const DARK = ['midnight', 'graphite', 'amber', 'nightshift'] as const;
const SURFACES = ['strip', 'strip-hi', 'board', 'steel'] as const;

/** Comments blanked, not deleted, so offsets (and the "precedes" comparison below) still index the real file. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Block {
  at: number;
  selectors: string[];
  decls: Record<string, string>;
}

function blocks(css: string): Block[] {
  const out: Block[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const kv = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
      if (kv) decls[kv[1]] = kv[2];
    }
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    out.push({ at: (m.index ?? 0) + m[1].length - m[1].trimStart().length, selectors, decls });
  }
  return out;
}

const THEME_BLOCKS = blocks(THEME);

/** Every token as `<html data-theme="id">` computes it: the last declaration among the `:root` / `[data-theme="id"]` blocks, in source order. */
function cascade(theme: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of THEME_BLOCKS) {
    if (!b.selectors.some((s) => s === ':root' || s === `[data-theme="${theme}"]`)) continue;
    Object.assign(out, b.decls);
  }
  return out;
}

type RGBA = [number, number, number, number];

/** A colour value resolved to sRGB 0–255 plus alpha: hex, `rgba()`, `transparent`, `var(--x)` and `color-mix(in srgb, A N%, B)` — every form theme.css and
 *  the tint sites use. Anything else throws, so a new form cannot be measured as black by accident. */
function color(value: string, tokens: Record<string, string>, depth = 0): RGBA {
  if (depth > 20) throw new Error(`var() cycle resolving ${value}`);
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  if (v === 'transparent') return [0, 0, 0, 0];
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref) {
    const next = tokens[ref[1]];
    if (next === undefined) throw new Error(`${ref[1]} is not declared for this theme`);
    return color(next, tokens, depth + 1);
  }
  const mix = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/.exec(v);
  if (mix) {
    // CSS Color 5: the mix is premultiplied, so mixing toward `transparent` keeps the hue and only lowers alpha.
    const p = Number(mix[2]) / 100;
    const a = color(mix[1], tokens, depth + 1);
    const b = color(mix[3], tokens, depth + 1);
    const alpha = a[3] * p + b[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = [0, 1, 2].map((i) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha);
    return [ch[0], ch[1], ch[2], alpha];
  }
  throw new Error(`cannot resolve colour value "${v}"`);
}

/** A translucent colour composited onto an opaque surface — what the eye actually sees under the text. */
function over(fg: RGBA, under: RGBA): RGBA {
  return [0, 1, 2].map((i) => fg[i] * fg[3] + under[i] * (1 - fg[3])).concat(1) as RGBA;
}

function luminance(c: RGBA): number {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const DAY = cascade('daylight');
const day = (token: string): RGBA => color(`var(${token})`, DAY);

/** The rules of client/src/styles.css whose `background` is a tint — `color-mix(in srgb, var(--X) N%, <surface>)` — with the colour the rule sets on it. */
interface TintSite {
  selector: string;
  hue: string;
  pct: number;
  surface: string;
  color: string | null;
}

function tintSites(): TintSite[] {
  const out: TintSite[] = [];
  for (const m of stripComments(STYLES).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const bg = /(?<![-\w])background\s*:\s*color-mix\(\s*in srgb\s*,\s*var\((--[\w-]+)\)\s+(\d+)%\s*,\s*(var\(--[\w-]+\)|transparent)\s*\)/.exec(m[2]);
    if (!bg) continue;
    // Lookbehind so `border-color:` is not read as the rule's text colour.
    const fg = /(?<![-\w])color\s*:\s*var\((--[\w-]+)\)\s*(?:;|$)/.exec(m[2]);
    out.push({
      selector: m[1].trim().replace(/\s+/g, ' '),
      hue: bg[1],
      pct: Number(bg[2]),
      surface: bg[3],
      color: fg ? fg[1] : null
    });
  }
  return out;
}

/**
 * What a rule's own `background` puts under its text. Only a value that actually paints something is a ground: `background: none` on a button reset, or
 * `transparent`, leaves the word on whatever surface is behind the rule, so it is measured there like a rule with no background at all — a
 * `color: var(--fill-live); background: none` must not pass as reverse type. `fill` is one token, measured by the reverse-type case; `tint` is the
 * `color-mix` shape `tintSites` reads; `other` (a gradient, an image, a shorthand with more than a colour) is a ground this file cannot compute.
 */
type Ground = { kind: 'none' } | { kind: 'fill'; token: string } | { kind: 'tint' } | { kind: 'other' };

function groundOf(body: string): Ground {
  const bg = /(?<![-\w])background(?:-color)?\s*:\s*([^;]+)/.exec(body);
  if (!bg) return { kind: 'none' };
  const v = bg[1].trim().replace(/\s*!important$/, '');
  if (/^(none|transparent|inherit|initial|unset|revert|revert-layer)$/.test(v)) return { kind: 'none' };
  const fill = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (fill) return { kind: 'fill', token: fill[1] };
  if (/^color-mix\(\s*in srgb\s*,\s*var\(--[\w-]+\)\s+\d+%\s*,\s*(var\(--[\w-]+\)|transparent)\s*\)$/.test(v)) return { kind: 'tint' };
  return { kind: 'other' };
}

/** Every rule of client/src/styles.css that sets a word in a token, with what its own background puts under that word. */
function textSites(): { selector: string; token: string; ground: Ground }[] {
  const out: { selector: string; token: string; ground: Ground }[] = [];
  for (const m of stripComments(STYLES).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // Lookbehind so `border-color:` / `background-color:` are not read as the rule's text colour; the first token is taken, so a `var(--a, var(--b))`
    // fallback is measured on the value that wins.
    const fg = /(?<![-\w])color\s*:\s*var\(\s*(--[\w-]+)/.exec(m[2]);
    if (!fg) continue;
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), token: fg[1], ground: groundOf(m[2]) });
  }
  return out;
}

describe('daylight status tokens hold AA', () => {
  it('every text token clears 4.5:1 on each surface text is set on', () => {
    const fails: string[] = [];
    // `--amber-ink` is here as well as on its tints: Review Focus 5 sends it onto bare surfaces too, at every amber word with no amber mark beside it.
    // `--live-ink` is the live/paused status word's text twin of `--fill-live` (final review I1): before it, three rules set `running` in the fill itself,
    // 2.07:1 on `--strip` in daylight.
    for (const fg of ['--ink', '--ink2', '--ink3', '--green', '--mustard', '--cyan', '--red', '--magenta', '--amber-text', '--amber-ink', '--live-ink']) {
      if (DAY[fg] === undefined) {
        fails.push(`${fg} is not declared for daylight`);
        continue;
      }
      for (const bg of SURFACES) {
        const r = ratio(day(fg), day(`--${bg}`));
        if (r < AA) fails.push(`${fg} ${DAY[fg]} on --${bg} ${DAY[`--${bg}`]}: ${r.toFixed(2)}:1`);
      }
    }
    expect(fails).toEqual([]);
  });

  /**
   * The pairs are read off the stylesheet, not listed here: the percentage and the surface a pill mixes over are the site's own, and the worst of them
   * (amber at 12 % over `--steel`, `.orchestrate-preview-flag`) is a site a hand list would have measured over white and passed.
   */
  it('every status word set on a tint clears 4.5:1 over the tint it actually sits on', () => {
    const sites = tintSites().filter((s) => s.color !== null);
    // Guards the parser, not the palette: a regex that stopped matching would let the loop below pass on nothing.
    for (const sel of ['.board-card-stage-warn', '.orchestrate-preview-flag', '.ui-pill-warn', '.ui-pill-done', '.run-detail-crashed']) {
      expect(sites.map((s) => s.selector)).toContain(sel);
    }
    const fails: string[] = [];
    for (const s of sites) {
      const unders = s.surface === 'transparent' ? SURFACES.map((x) => `var(--${x})`) : [s.surface];
      for (const under of unders) {
        const fill = over(color(`color-mix(in srgb, var(${s.hue}) ${s.pct}%, ${under})`, DAY), color(under, DAY));
        const r = ratio(day(s.color as string), fill);
        if (r < AA) fails.push(`${s.selector}: ${s.color} on ${s.pct}% ${s.hue} over ${under}: ${r.toFixed(2)}:1`);
      }
    }
    expect(fails).toEqual([]);
  });

  /**
   * The list above says which TOKENS are text; this case says which tokens the stylesheet actually SETS text in, and holds every one of them to the same
   * line. It exists because the list could not catch the failure it was meant to: `.runs-status-live`, `.runs-status-paused` and `.watchdog-kind-live` set
   * their words in `--fill-live`, a fill that was never on the list, and so passed it at 2.07:1 while the list was green (final review I1). Read off the
   * stylesheet rather than enumerated, so a new rule that sets a word in a fill or a `-solid` mark goes red here the day it lands.
   *
   * Three kinds of rule are not measured against the four surfaces:
   * - a rule that paints its own `background` — reverse type on a fill, or a word on a tint. Its text does not sit on a surface; the tints are the case
   *   above, measured at their own percentage, and reverse type on a one-token fill is the case below. "Paints" is `groundOf`'s call: `background: none`
   *   or `transparent` paints nothing, so such a rule is measured here like one with no background — before that, any `background` declaration at all
   *   exempted the rule, and `color: var(--fill-live); background: none` would have passed.
   * - a glyph that IS a mark, closed by selector below: the `●` status dots and the wordmark's caret are drawn with `color:` but read as a dot and a
   *   logotype, so they answer to the mark tokens and to 1.4.11 (or, for the logotype, to 1.4.3's exemption), not to 4.5:1. By selector and not by token,
   *   so `--green-solid` set on a word elsewhere is still measured.
   * - the project hues `--proj-N`: identity colours, not status ones, outside the status split this file guards. They sit on a card or a drawer head
   *   (`--strip`), not on all four surfaces, and their daylight set has its own reasoning in shared/theme.css; measured against `--steel` here, `--proj-3`
   *   would read 4.34:1 — a judgement about that set, not about whether a status word is legible, so it is left to whoever next retunes it.
   */
  it('every token client/src/styles.css sets text in clears 4.5:1 on each surface, unless it paints its own ground, is a mark glyph or a project hue', () => {
    const MARK_GLYPHS: Record<string, string> = {
      '.rail-caret': '--green-solid'
    };
    const sites = textSites();
    // Guards the parser, not the palette: these must be found, or the loop below passes on nothing. `.rail-link` declares `background: none` and must be
    // measured — the narrowing of the ground exemption, held by a real rule.
    const measured = sites.filter((s) => s.ground.kind === 'none').map((s) => s.selector);
    for (const sel of ['.runs-status-live', '.runs-status-paused', '.watchdog-kind-live', '.set-error', '.rail-caret', '.rail-link']) {
      expect(measured).toContain(sel);
    }
    const fails: string[] = [];
    for (const s of sites) {
      if (s.ground.kind !== 'none' || s.token.startsWith('--proj-')) continue;
      if (s.selector in MARK_GLYPHS) {
        if (s.token !== MARK_GLYPHS[s.selector]) fails.push(`${s.selector} is a mark glyph and must read ${MARK_GLYPHS[s.selector]}, reads ${s.token}`);
        continue;
      }
      for (const bg of SURFACES) {
        const r = ratio(day(s.token), day(`--${bg}`));
        if (r < AA) fails.push(`${s.selector}: ${s.token} on --${bg}: ${r.toFixed(2)}:1`);
      }
    }
    expect(fails).toEqual([]);
  });

  /**
   * Reverse type: a word on a rule's own one-token fill, measured against that fill. The exemption in the case above left these unmeasured, and so
   * `.ui-pill-live` read `--on-accent` on `--fill-live` — white on #F5A15C, 2.0:1 in daylight — for as long as no caller passed `tone="live"`. It reads
   * `--on-fill` now, as the card's live strip always has: the one token whose job is ink on a fill. A translucent fill is composited over each of the four
   * surfaces, since the rule cannot know which one it sits on.
   */
  it('every word set on a rule\'s own one-token fill clears 4.5:1 against that fill', () => {
    const sites = textSites().filter((s) => s.ground.kind === 'fill');
    // Guards the parser, not the palette.
    for (const sel of ['.ui-pill-live', '.board-card-live', '.ui-chip-ink', '.board-card-queued']) {
      expect(sites.map((s) => s.selector)).toContain(sel);
    }
    const fails: string[] = [];
    for (const s of sites) {
      const fill = day((s.ground as { token: string }).token);
      for (const under of fill[3] < 1 ? SURFACES.map((x) => day(`--${x}`)) : [fill]) {
        const r = ratio(day(s.token), over(fill, under));
        if (r < AA) fails.push(`${s.selector}: ${s.token} on ${(s.ground as { token: string }).token}: ${r.toFixed(2)}:1`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('groundOf counts only a background that paints as a ground', () => {
    expect(groundOf('color: var(--fill-live); background: none')).toEqual({ kind: 'none' });
    expect(groundOf('background: transparent')).toEqual({ kind: 'none' });
    expect(groundOf('background-color: inherit')).toEqual({ kind: 'none' });
    expect(groundOf('color: var(--x)')).toEqual({ kind: 'none' });
    expect(groundOf('background: var(--fill-live)')).toEqual({ kind: 'fill', token: '--fill-live' });
    expect(groundOf('background: color-mix(in srgb, var(--red) 14%, var(--strip))')).toEqual({ kind: 'tint' });
    expect(groundOf('background: linear-gradient(var(--a), var(--b))')).toEqual({ kind: 'other' });
  });

  it('--amber-solid, a mark, clears 3:1 on the surfaces marks are drawn on', () => {
    const fails: string[] = [];
    for (const bg of ['strip', 'strip-hi', 'board']) {
      const r = ratio(day('--amber-solid'), day(`--${bg}`));
      if (r < MARK) fails.push(`--amber-solid ${DAY['--amber-solid']} on --${bg}: ${r.toFixed(2)}:1`);
    }
    expect(fails).toEqual([]);
  });
  /**
   * The release badges are ui-kit's (#298), so their rule is not in this stylesheet and `tintSites` never sees them: the kit sets each badge in
   * `--uk-<type>-ink` on `--uk-<type>-tint`, and the board decides only what those tokens are, in the `:root` mapping block. So the pairs are read off that
   * block — both halves, resolved through daylight's cascade — rather than off a rule. A tint is already opaque (it mixes into `--strip`), so it is the
   * ground as written; `over` the drawer's `--uk-panel-bg` is there for a mapping that someday mixes into `transparent`.
   */
  it('every release badge ui-kit draws clears 4.5:1, its mapped ink over its mapped tint', () => {
    const mapping = blocks(STYLES).find((b) => b.selectors.length === 1 && b.selectors[0] === ':root' && '--uk-feat-ink' in b.decls);
    expect(mapping).toBeDefined();
    const tokens = { ...DAY, ...(mapping as Block).decls };
    const panel = color('var(--uk-panel-bg)', tokens);
    const fails: string[] = [];
    for (const type of ['feat', 'fix', 'perf', 'breaking']) {
      const ink = (mapping as Block).decls[`--uk-${type}-ink`];
      const tint = (mapping as Block).decls[`--uk-${type}-tint`];
      if (ink === undefined || tint === undefined) {
        fails.push(`--uk-${type}-ink / --uk-${type}-tint is not mapped`);
        continue;
      }
      const r = ratio(color(ink, tokens), over(color(tint, tokens), panel));
      if (r < AA) fails.push(`${type}: ${ink} on ${tint}: ${r.toFixed(2)}:1`);
    }
    expect(fails).toEqual([]);
  });
});

describe('the four dark themes do not move', () => {
  /** Each split token, and the token every rule that now reads it read before the split — which is what it must compute to in every dark block. */
  const DERIVED: Record<string, string> = {
    '--green-solid': '--green',
    '--amber-solid': '--amber',
    '--amber-text': '--amber',
    '--amber-ink': '--amber',
    // Not a split of --amber: the three live/paused status words read --fill-live before I1, and --fill-live is var(--amber) in every dark block.
    '--live-ink': '--fill-live'
  };
  const OWN = ['--green', '--mustard', '--cyan', '--ink2', '--ink3'];
  const palettes = THEME_BLOCKS.filter((b) => '--board' in b.decls);
  const darkPalette = (id: string) => palettes.find((b) => b.selectors.includes(`[data-theme="${id}"]`));

  it('every token in the split is declared by each dark block or derived in a :root block — never a hex a dark theme could inherit', () => {
    for (const id of DARK) expect(darkPalette(id)).toBeDefined();
    const fails: string[] = [];
    for (const token of [...OWN, ...Object.keys(DERIVED)]) {
      if (DARK.every((id) => token in (darkPalette(id) as Block).decls)) continue;
      const defaults = THEME_BLOCKS.filter((b) => b.selectors.length === 1 && b.selectors[0] === ':root' && token in b.decls);
      const value = defaults.length === 1 ? defaults[0].decls[token] : '';
      const derived = /^var\(--[\w-]+\)$/.test(value) || (/^color-mix\(.*var\(--/.test(value) && !value.includes('#'));
      if (!derived) fails.push(`${token}: ${defaults.length} :root declarations, value "${value}"`);
      const overridden = DARK.filter((id) => token in (darkPalette(id) as Block).decls);
      if (overridden.length > 0) fails.push(`${token} is derived on :root but overridden by ${overridden.join(', ')}`);
    }
    expect(fails).toEqual([]);
  });

  it('each split token computes, in every dark theme, to exactly the token its rules read before the split', () => {
    const fails: string[] = [];
    for (const id of DARK) {
      const tokens = cascade(id);
      for (const [token, was] of Object.entries(DERIVED)) {
        const now = color(`var(${token})`, tokens).join(',');
        const before = color(`var(${was})`, tokens).join(',');
        if (now !== before) fails.push(`${id}: ${token} is ${now}, was ${was} ${before}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('the :root defaults block comes before the daylight block, so daylight overrides it rather than the reverse', () => {
    const defaults = THEME_BLOCKS.find((b) => b.selectors.length === 1 && b.selectors[0] === ':root' && '--green-solid' in b.decls);
    const daylight = THEME.indexOf('[data-theme="daylight"]{');
    expect(defaults).toBeDefined();
    expect(daylight).toBeGreaterThan(-1);
    expect((defaults as Block).at).toBeLessThan(daylight);
  });

  /**
   * The ten tint sites keep their own percentage and surface. A shared `--X-tint` token per hue (the dashboard's shape) was rejected for exactly this: the
   * board's tints run 6 to 14 % over `--strip` or `--steel`, and one token per hue would move every dark theme's pill fill. Only the hue each site mixes
   * changes — the `-solid` mark for green and amber, the bare token for mustard and cyan, which are dark enough in daylight to be a mark as they are.
   */
  it('the ten tint sites keep their percentage and surface, and mix the mark token of their hue', () => {
    const PINNED: Record<string, [string, number, string]> = {
      '.board-card-stage': ['--cyan', 10, 'var(--strip)'],
      '.board-card-stage-done': ['--green-solid', 10, 'var(--strip)'],
      '.board-card-stage-warn': ['--amber-solid', 10, 'var(--strip)'],
      '.run-drawer-note': ['--amber-solid', 10, 'var(--strip)'],
      '.orchestrate-preview-flag': ['--amber-solid', 12, 'var(--steel)'],
      '.run-drawer-attn': ['--amber-solid', 6, 'var(--strip)'],
      '.run-detail-mode-note': ['--mustard', 10, 'var(--strip)'],
      '.run-detail-crashed': ['--amber-solid', 10, 'var(--strip)'],
      '.ui-pill-warn': ['--amber-solid', 14, 'var(--strip)'],
      '.ui-pill-done': ['--green-solid', 14, 'var(--strip)']
    };
    const sites = tintSites();
    const actual: Record<string, [string, number, string] | undefined> = {};
    for (const sel of Object.keys(PINNED)) {
      const s = sites.find((x) => x.selector === sel);
      actual[sel] = s ? [s.hue, s.pct, s.surface] : undefined;
    }
    expect(actual).toEqual(PINNED);
  });
});

describe('the split reaches every rule', () => {
  it('client/src/styles.css reads bare var(--amber) nowhere — a mark reads --amber-solid, a word --amber-text or --amber-ink', () => {
    const lines = STYLES.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => l.includes('var(--amber)'))
      .map(([n, l]) => `styles.css:${n}: ${l.trim()}`);
    expect(lines).toEqual([]);
  });
});
