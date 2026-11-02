/**
 * rule-tiers.ts — the one parser for the two prose tiers a rule in this repo is written in.
 *
 * A rule is stated at up to three depths, each with exactly one home: the MECHANISM (the full bullet — headline, how the rule is implemented, its `Why:`
 * link — in exactly one `.claude/rules/*.md`, loaded when a session reads a file under that rule file's `paths:`), the REASONING
 * (`docs/subsystems/invariants.md#<anchor>`, read when a person follows the link), and — only for a rule that matters whichever file is touched — the
 * HEADLINE (one bolded sentence, in CLAUDE.md, loaded by every session). The seams between tier one and tier two are what `test/claude-rules.test.ts` guards:
 * a headline CLAUDE.md states must be byte-equal in its one rule file, every rule must have one home, and CLAUDE.md must carry nothing past the headline —
 * whatever CLAUDE.md holds is paid for by every session, which is the cost the split exists to remove
 * (docs/superpowers/specs/2026-09-22-claude-md-three-tiers-design.md; tier one became a subset of tier two in
 * docs/superpowers/specs/2026-11-02-claude-md-floor-design.md).
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
 * Tier one as a SUBSET of tier two, keyed `${anchor}\t${headline}` (an unlinked bullet keys as `-\t${headline}`). `missingInRules` is what tier one states
 * and tier two does not — a key present twice in tier one and once in tier two is missing once. Tier two holding what tier one does not is the normal case
 * since 2026-11-02: a rule whose files all sit under one rule file's fence lives in that file alone, and CLAUDE.md keeps only the rules that matter whichever
 * file is touched (docs/superpowers/specs/2026-11-02-claude-md-floor-design.md). `multiHomed` names a rule whose tier-two bullets sit in more than one file,
 * keyed by its anchor when it has one and by its headline when it does not — an unlinked bullet has no anchor to be homed by, so without the headline key
 * the same rule pasted into two files would pass.
 */
export function compareTiers(
  one: TierBullet[],
  two: { file: string; bullets: TierBullet[] }[]
): { missingInRules: string[]; multiHomed: string[] } {
  const key = (b: TierBullet) => `${b.anchors[0] ?? '-'}\t${b.headline}`;
  const tally = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const oneTally = tally(one.map(key));
  const twoTally = tally(two.flatMap((f) => f.bullets.map(key)));
  const missingInRules = [...oneTally].flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (twoTally.get(k) ?? 0)) }, () => k));

  const homes = new Map<string, string[]>();
  for (const f of two) {
    for (const b of f.bullets) {
      const home = b.anchors[0] ?? b.headline ?? b.joined;
      const files = homes.get(home) ?? [];
      if (!files.includes(f.file)) files.push(f.file);
      homes.set(home, files);
    }
  }

  return { missingInRules, multiHomed: [...homes].filter(([, files]) => files.length > 1).map(([home, files]) => `${home} → ${files.join(', ')}`) };
}

/**
 * The most words a bullet without a `Why:` link may carry, in either tier. In CLAUDE.md it is what stops mechanism creeping back as an unlinked bullet; in
 * a rule file it is what lets a short rule with no reasoning to link — a homeless rule given a fence — sit there without an invariants.md entry, while a
 * long one still needs one: past 80 words a rule has reasoning, and reasoning belongs in tier three.
 */
export const UNLINKED_WORD_CAP = 80;

/** Rule-file bullets that break the anchor contract: two or more anchors, or none on a bullet over `UNLINKED_WORD_CAP` words. */
export function ruleBulletOffenders(bullets: TierBullet[]): string[] {
  return bullets.flatMap((b) => {
    if (b.anchors.length > 1) return [`${b.line}: ${b.headline ?? b.joined.slice(0, 60)} cites ${b.anchors.length} anchors`];
    if (b.anchors.length === 0 && b.words > UNLINKED_WORD_CAP) return [`${b.line}: ${b.words} words, no anchor`];
    return [];
  });
}
