/**
 * rule-tiers.ts — the one parser for the two prose tiers a rule in this repo is written in.
 *
 * A rule with a `Why:` link is stated at three depths, each with exactly one home: the HEADLINE (one bolded sentence, in CLAUDE.md, loaded by every session),
 * the MECHANISM (the full bullet — headline, how the rule is implemented, the same `Why:` link — in exactly one `.claude/rules/*.md`, loaded when a session
 * reads a file under that rule file's `paths:`), and the REASONING (`docs/subsystems/invariants.md#<anchor>`, read when a person follows the link). The
 * seams between tier one and tier two are what `test/claude-rules.test.ts` guards: the headline must be byte-equal on both sides, every anchor must have one
 * home, and CLAUDE.md must carry nothing past the headline — mechanism that creeps back into CLAUDE.md is paid for by every session, which is the cost the
 * split exists to remove (docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md).
 *
 * Everything here is a function over a STRING, deliberately: the guards run the same parser over the real files and over inline fixtures, and a parser that
 * produced nothing would match nothing against nothing and pass every guard while asserting exactly zero — so the parsers are pinned on fixtures first. No
 * fs, no repo paths, no YAML or glob dependency (the suite reads the files as source, like `test/csp.test.ts`).
 *
 * One parser for both tiers rather than one each, because "byte-equal headline" is only meaningful if both sides extracted it the same way. A headline may
 * wrap across a continuation line (CLAUDE.md wraps at 160 columns and one headline does), so every comparison happens on the JOINED bullet: continuation
 * breaks folded to single spaces, whitespace runs collapsed.
 */

export type TierBullet = {
  /** The bullet's lines exactly as written, continuation lines included. */
  raw: string;
  /** `raw` with continuation breaks folded into single spaces and whitespace runs collapsed. */
  joined: string;
  /** The first bold span of a bold-led bullet, or `null` when the bullet does not open with `- **` or the span never closes. */
  headline: string | null;
  /** Every `docs/subsystems/invariants.md#<anchor>` the bullet cites, in order, anchor part only. */
  anchors: string[];
  /** Whitespace-separated tokens of `joined` with the leading `- ` removed. */
  words: number;
  /** 1-based line of the bullet's first line, in the numbering the caller supplied. */
  line: number;
};

const INVARIANTS_ANCHOR = /docs\/subsystems\/invariants\.md#([\w-]+)/g;
const BULLET_START = /^- /;
const CONTINUATION = /^ {2,}\S/;

export function joinWrapped(raw: string): string {
  return raw.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export function headlineOf(joined: string): string | null {
  if (!joined.startsWith('- **')) return null;
  const close = joined.indexOf('**', 4);
  return close === -1 ? null : joined.slice(4, close);
}

export function anchorsOf(text: string): string[] {
  return [...text.matchAll(INVARIANTS_ANCHOR)].map((m) => m[1]);
}

export function wordCount(joined: string): number {
  return joined
    .replace(BULLET_START, '')
    .split(/\s+/)
    .filter((token) => token !== '').length;
}

function bulletOf(raw: string, line: number): TierBullet {
  const joined = joinWrapped(raw);
  return { raw, joined, headline: headlineOf(joined), anchors: anchorsOf(raw), words: wordCount(joined), line };
}

/**
 * A bullet starts at a column-0 `- ` and continues through the following lines that are indented by two or more spaces. A blank line, a heading, a
 * column-0 line of any other kind, or the next `- ` ends it. Lines outside every bullet are not this function's business — `freeProse` is where they count.
 */
export function splitBullets(body: string, firstLine = 1): TierBullet[] {
  const out: TierBullet[] = [];
  let start = -1;
  let buffer: string[] = [];
  const flush = () => {
    if (start !== -1) out.push(bulletOf(buffer.join('\n'), start + firstLine));
    start = -1;
    buffer = [];
  };
  body.split('\n').forEach((line, i) => {
    if (BULLET_START.test(line)) {
      flush();
      start = i;
      buffer = [line];
      return;
    }
    if (start !== -1 && CONTINUATION.test(line)) {
      buffer.push(line);
      return;
    }
    flush();
  });
  flush();
  return out;
}

/** Tier one: every bullet from the `## Invariants` heading to the end of CLAUDE.md, sorted by shape. */
export function tierOne(claudeMd: string): { linked: TierBullet[]; unlinked: TierBullet[]; plain: TierBullet[] } {
  const lines = claudeMd.split('\n');
  const at = lines.indexOf('## Invariants');
  if (at === -1) throw new Error('CLAUDE.md has no ## Invariants heading');
  const bullets = splitBullets(lines.slice(at).join('\n'), at + 1);
  return {
    linked: bullets.filter((b) => b.headline !== null && b.anchors.length > 0),
    unlinked: bullets.filter((b) => b.headline !== null && b.anchors.length === 0),
    plain: bullets.filter((b) => b.headline === null)
  };
}

/** Tier two: every bullet of a rule file's body — the text after the closing `---` of its frontmatter. */
export function tierTwo(ruleBody: string, firstLine = 1): TierBullet[] {
  return splitBullets(ruleBody, firstLine);
}

/** Every non-blank body line that is neither a heading, a bullet start nor a two-space continuation — prose a rule file must not carry. */
export function freeProse(ruleBody: string, firstLine = 1): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  ruleBody.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#') || BULLET_START.test(line) || /^ {2,}/.test(line)) return;
    out.push({ line: i + firstLine, text: line });
  });
  return out;
}

/**
 * The two tiers as multisets of `${anchor}\t${headline}`. `missingInRules` is what tier one states and tier two does not (a key present twice in tier one
 * and once in tier two is missing once); `missingInClaude` the reverse; `multiHomed` names an anchor whose tier-two bullets sit in more than one file.
 */
export function compareTiers(
  one: TierBullet[],
  two: { file: string; bullets: TierBullet[] }[]
): { missingInRules: string[]; missingInClaude: string[]; multiHomed: string[] } {
  const key = (b: TierBullet) => `${b.anchors[0]}\t${b.headline}`;
  const tally = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const oneTally = tally(one.map(key));
  const twoTally = tally(two.flatMap((f) => f.bullets.map(key)));
  const surplus = (from: Map<string, number>, against: Map<string, number>) =>
    [...from].flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (against.get(k) ?? 0)) }, () => k));

  const homes = new Map<string, string[]>();
  for (const f of two) {
    for (const b of f.bullets) {
      const anchor = b.anchors[0];
      const files = homes.get(anchor) ?? [];
      if (!files.includes(f.file)) files.push(f.file);
      homes.set(anchor, files);
    }
  }

  return {
    missingInRules: surplus(oneTally, twoTally),
    missingInClaude: surplus(twoTally, oneTally),
    multiHomed: [...homes].filter(([, files]) => files.length > 1).map(([anchor, files]) => `${anchor} → ${files.join(', ')}`)
  };
}
