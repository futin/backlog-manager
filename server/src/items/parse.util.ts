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

/** "unknown" with optional trailing period, any case — the exact sentinel
 *  backlog-capture writes into a fresh bug's Cause and Fix. */
const UNKNOWN = /^unknown\.?$/i;

/**
 * Groomed is derived, never stored — see the spec. bugs: Cause and Fix both
 * filled and not the "unknown" sentinel (that emptiness is precisely what
 * backlog-execute refuses to work on). tasks: a non-empty Plan (capture
 * refuses a task without one, so false only ever means a hand-made file).
 * ideas and out-of-scope: null — grooming is not a state they have.
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
