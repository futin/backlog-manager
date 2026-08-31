import type { Section } from '../../../shared/types';

/** Signals a malformed item file. The scanner catches exactly this type and
 *  reports the file instead of failing the whole index. */
export class ItemParseError extends Error {}

export interface Frontmatter {
  fields: Record<string, string>;
  tags: string[];
}

/**
 * TypeScript port of parseFrontmatter in skills/backlog/tools/backlog.mjs —
 * the same `key: value` line splitter, deliberately NOT a YAML parser. Kept
 * behaviour-identical so a file the tool wrote is always a file this can read:
 * tags is the one key that becomes a list (split on commas); a status: key is
 * rejected outright because the directory a file lives in is its status;
 * unknown keys (from:, promoted-to:, rejected:) are preserved as strings.
 */
export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    throw new ItemParseError('frontmatter must start with a --- line');
  }

  const fields: Record<string, string> = {};
  let tags: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const sep = lines[i].indexOf(':');
    if (sep === -1) continue;
    const key = lines[i].slice(0, sep).trim();
    const value = lines[i].slice(sep + 1).trim();
    if (key === 'status') {
      throw new ItemParseError('frontmatter must not carry a status: key — the directory a file lives in is its status');
    }
    if (key === 'tags') {
      tags = value === '' ? [] : value.split(',').map((t) => t.trim()).filter((t) => t !== '');
    } else {
      fields[key] = value;
    }
  }
  if (i === lines.length) {
    throw new ItemParseError('frontmatter has no closing --- line');
  }

  return { fm: { fields, tags }, body: lines.slice(i + 1).join('\n') };
}

/**
 * The text under one `## Heading`, up to the next `## ` line or end of body,
 * trimmed. Case-insensitive on the heading because these files are written by
 * skills following prose instructions, and "## cause" must not read as
 * ungroomed. Returns '' both for a missing heading and an empty section —
 * callers cannot tell the two apart, and for grooming they mean the same.
 */
export function sectionText(body: string, heading: string): string {
  const lines = body.split('\n');
  const wanted = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === wanted);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return rest.slice(0, end === -1 ? undefined : end).join('\n').trim();
}

/**
 * A Cause or Fix that still says "I don't know yet", any case.
 *
 * Not an exact match on the sentinel backlog-capture writes. That is what this
 * used to be (`/^unknown\.?$/i`) and it read every real ungroomed bug on the
 * board as groomed, because nobody stops at the word: the two live examples
 * when this was found were `unknown — likely just that SessionList receives…`
 * and `**Unknown — gated on the repro above.**`. Both got an execute button,
 * and execute is exactly what backlog-execute refuses on a bug whose Fix is
 * unknown — so the board promised work the skill would bounce.
 *
 * Hence three parts. Markdown emphasis is stripped from both ends, so
 * `**Unknown**` is the same answer as `Unknown`. The bare word alone still
 * matches, which is the sentinel backlog-capture actually writes. And the word
 * may be followed by punctuation or a dash and then keep going for a whole
 * paragraph — `[\s\S]*` rather than `.*` because `^`/`$` are not multiline
 * here and that tail routinely spans lines.
 *
 * What it deliberately does NOT match is a sentence that merely opens with the
 * word: "Unknown option passed to X" is a real cause, so whitespace alone
 * after the word is not enough — punctuation or a dash has to follow. The bias
 * runs one way on purpose: a false "ungroomed" costs a groom that had little
 * to do, while a false "groomed" spends a whole session to be refused.
 */
const UNKNOWN = /^[\s*_`#]*unknown[\s*_`]*(?:$|[.,:;!?\-–—][\s\S]*$)/i;

/**
 * `phase` frontmatter is `groom` | `execute` while work is live, and the key
 * is absent once `stop` clears it. Clamped rather than validated: a value
 * this reader doesn't recognise (a typo, a future phase written by a newer
 * CLI) must not fail the scan or drop the item from the index — see
 * `BacklogItem.phase` in shared/types.ts for what the board does with the
 * empty-string result.
 */
export function clampPhase(value: string | undefined): '' | 'groom' | 'execute' {
  return value === 'groom' || value === 'execute' ? value : '';
}

/**
 * `groom-elapsed` / `execute-elapsed` are whole seconds the CLI accumulates
 * on every `stop`. Only a plain string of digits is trusted — no sign, no
 * decimal point, no exponent — so `parseInt` is never given the chance to
 * silently truncate `"1.5"` to `1` or turn `""`/`"abc"` into `NaN`: anything
 * that isn't `/^\d+$/` reads as `0`, the same as the key being absent. The
 * CLI itself refuses to write a bad value; this only matters for a file
 * edited by hand.
 */
export function parseElapsed(value: string | undefined): number {
  return value !== undefined && /^\d+$/.test(value) ? parseInt(value, 10) : 0;
}

/**
 * Groomed is derived, never stored — see the spec. bugs: Cause and Fix both
 * filled and not the "unknown" sentinel (that emptiness is precisely what
 * backlog-execute refuses to work on). tasks: a non-empty Plan (capture
 * refuses a task without one, so false only ever means a hand-made file).
 * ideas, refactors and out-of-scope: null — grooming is not a state they have.
 *
 * Refactors reach that null through the same fall-through ideas do, and for the
 * same reason: what a refactor is waiting on is being PROMOTED into a task, not
 * being groomed, so `false` would advertise a gate it can never pass. Note this
 * is a fall-through and not a listed case — a section added later lands on null
 * by default, which is the safe direction (no false "ungroomed" badge, and
 * `deriveAction` in shared/agent.ts still routes it to groom).
 */
export function deriveGroomed(section: Section, body: string): boolean | null {
  if (section === 'bugs') {
    const filled = (t: string): boolean => t !== '' && !UNKNOWN.test(t);
    return filled(sectionText(body, 'Cause')) && filled(sectionText(body, 'Fix'));
  }
  if (section === 'tasks') {
    return sectionText(body, 'Plan') !== '';
  }
  return null;
}
