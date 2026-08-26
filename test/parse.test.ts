import { ItemParseError, deriveGroomed, parseFrontmatter, sectionText } from '../server/src/items/parse.util';

const BUG_GROOMED = `## Symptom

It breaks.

## Repro

Run it.

## Affects

src/a.ts:1

## Cause

The check uses < instead of <=.

## Fix

Use <=.
`;

const BUG_UNGROOMED = `## Symptom

It breaks.

## Cause

unknown

## Fix

unknown
`;

describe('parseFrontmatter', () => {
  it('parses fields, splits tags on commas, returns the body', () => {
    const { fm, body } = parseFrontmatter(
      '---\nid: bug-1\ntitle: it breaks\ncreated: 2026-08-26\ntags: ui, board\n---\n\n## Symptom\n'
    );
    expect(fm.fields.id).toBe('bug-1');
    expect(fm.fields.title).toBe('it breaks');
    expect(fm.tags).toEqual(['ui', 'board']);
    expect(body).toContain('## Symptom');
  });

  it('defaults tags to [] when absent', () => {
    expect(parseFrontmatter('---\nid: x-1\ntitle: t\n---\n').fm.tags).toEqual([]);
  });

  it('rejects a status: key — the directory is the status', () => {
    expect(() => parseFrontmatter('---\nid: x-1\nstatus: open\n---\n')).toThrow(ItemParseError);
  });

  it('rejects a missing opening or closing fence', () => {
    expect(() => parseFrontmatter('id: x-1\n---\n')).toThrow(ItemParseError);
    expect(() => parseFrontmatter('---\nid: x-1\n')).toThrow(ItemParseError);
  });
});

describe('sectionText', () => {
  it('returns the text between a heading and the next ## heading, trimmed', () => {
    expect(sectionText(BUG_GROOMED, 'Cause')).toBe('The check uses < instead of <=.');
  });

  it('returns the trailing section to end of body', () => {
    expect(sectionText(BUG_GROOMED, 'Fix')).toBe('Use <=.');
  });

  it('returns empty string for a heading the body lacks', () => {
    expect(sectionText(BUG_GROOMED, 'Plan')).toBe('');
  });

  it('matches headings case-insensitively', () => {
    expect(sectionText('## cause\n\nx\n', 'Cause')).toBe('x');
  });
});

describe('deriveGroomed', () => {
  it('bug with filled Cause and Fix is groomed', () => {
    expect(deriveGroomed('bugs', BUG_GROOMED)).toBe(true);
  });

  it('bug with unknown Cause/Fix (with or without a trailing period) is not', () => {
    expect(deriveGroomed('bugs', BUG_UNGROOMED)).toBe(false);
    expect(deriveGroomed('bugs', '## Cause\n\nUnknown.\n\n## Fix\n\nx\n')).toBe(false);
  });

  it('bug missing the sections entirely is not groomed', () => {
    expect(deriveGroomed('bugs', '## Symptom\n\nx\n')).toBe(false);
  });

  it('task with a Plan is groomed; without one is not', () => {
    expect(deriveGroomed('tasks', '## Goal\n\ng\n\n## Plan\n\n1. do it\n')).toBe(true);
    expect(deriveGroomed('tasks', '## Goal\n\ng\n\n## Plan\n\n## Test cases\n')).toBe(false);
  });

  it('ideas and out-of-scope have no groomed state', () => {
    expect(deriveGroomed('ideas', 'anything')).toBeNull();
    expect(deriveGroomed('out-of-scope', 'anything')).toBeNull();
  });
});
