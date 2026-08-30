import { ItemParseError, clampPhase, deriveGroomed, parseElapsed, parseFrontmatter, sectionText } from '../server/src/items/parse.util';

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

  // The whole reason the sentinel is a pattern and not a string compare: an
  // exact match read every real ungroomed bug on the board as groomed, because
  // nobody writing "unknown" stops there. Both strings below are verbatim from
  // items that were showing an execute button.
  it('bug whose unknown keeps talking is still not groomed', () => {
    const cause = '## Cause\n\nunknown — likely just that `SessionList` receives the already\n'
      + 'filtered array.\n\n## Fix\n\nUse <=.\n';
    expect(deriveGroomed('bugs', cause)).toBe(false);

    const fix = '## Cause\n\nThe check uses < instead of <=.\n\n## Fix\n\n'
      + '**Unknown — gated on the repro above.** Three options are on the table.\n';
    expect(deriveGroomed('bugs', fix)).toBe(false);

    expect(deriveGroomed('bugs', '## Cause\n\nunknown. Needs grooming.\n\n## Fix\n\nx\n'))
      .toBe(false);
    expect(deriveGroomed('bugs', '## Cause\n\n**Unknown**\n\n## Fix\n\nx\n')).toBe(false);
    expect(deriveGroomed('bugs', '## Cause\n\nunknown, so far.\n\n## Fix\n\nx\n')).toBe(false);
  });

  // The other side of that bias. A cause is allowed to be about the word.
  it('bug whose Cause merely opens with the word is groomed', () => {
    const body = '## Cause\n\nUnknown option names reach renderFrontmatter and survive as\n'
      + 'strings.\n\n## Fix\n\nDrop them.\n';
    expect(deriveGroomed('bugs', body)).toBe(true);
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

describe('clampPhase', () => {
  it('accepts groom', () => {
    expect(clampPhase('groom')).toBe('groom');
  });

  it('accepts execute', () => {
    expect(clampPhase('execute')).toBe('execute');
  });

  it('clamps an unrecognised value to empty rather than throwing', () => {
    expect(clampPhase('wat')).toBe('');
  });

  it('clamps an absent value to empty', () => {
    expect(clampPhase(undefined)).toBe('');
  });
});

describe('parseElapsed', () => {
  it('parses a plain digit string as whole seconds', () => {
    expect(parseElapsed('90')).toBe(90);
  });

  it('clamps a negative value to 0', () => {
    expect(parseElapsed('-5')).toBe(0);
  });

  it('clamps a fractional value to 0', () => {
    expect(parseElapsed('1.5')).toBe(0);
  });

  it('clamps scientific notation to 0', () => {
    expect(parseElapsed('1e3')).toBe(0);
  });

  it('clamps a non-numeric value to 0', () => {
    expect(parseElapsed('abc')).toBe(0);
  });

  it('clamps an empty string to 0', () => {
    expect(parseElapsed('')).toBe(0);
  });

  it('clamps an absent value to 0', () => {
    expect(parseElapsed(undefined)).toBe(0);
  });
});
