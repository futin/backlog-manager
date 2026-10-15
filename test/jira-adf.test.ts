import { ADF_PLACEHOLDER_RE, adfToMarkdown, escapeMarkdown } from '../server/src/jira/adf';

/**
 * Jira integration, spec §8 (ADF → Markdown) and §14 P10 (the node inventory seen on real descriptions). One minimal fixture per node kind; every fixture is
 * a `{ type: 'doc', version: 1, content }` object built by `doc`, so a case names only the node it is about.
 */
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const text = (t: string, marks?: unknown[]) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const md = (...content: unknown[]) => adfToMarkdown(doc(...content)).markdown;

describe('adfToMarkdown — not a document', () => {
  it.each([null, undefined, 'a string', 42, {}, [], { type: 'doc' }])('%j → nothing', (value) => {
    expect(adfToMarkdown(value)).toEqual({ markdown: '', placeholders: 0 });
  });
});

describe('adfToMarkdown — paragraphs and headings', () => {
  it('renders one paragraph', () => {
    expect(md(para(text('Hello')))).toBe('Hello');
  });

  it('separates two paragraphs by one blank line', () => {
    expect(md(para(text('A')), para(text('B')))).toBe('A\n\nB');
  });

  it('drops an empty paragraph between two, leaving no triple newline', () => {
    expect(md(para(text('A')), { type: 'paragraph' }, para(text('B')))).toBe('A\n\nB');
    expect(md(para(text('A')), para(), para(text('B')))).toBe('A\n\nB');
  });

  it('renders a heading with its level', () => {
    expect(md({ type: 'heading', attrs: { level: 2 }, content: [text('Title')] })).toBe('## Title');
  });

  it('clamps a heading level to 1..6', () => {
    expect(md({ type: 'heading', attrs: { level: 7 }, content: [text('Title')] })).toBe('###### Title');
    expect(md({ type: 'heading', attrs: { level: 0 }, content: [text('Title')] })).toBe('# Title');
    expect(md({ type: 'heading', content: [text('Title')] })).toBe('# Title');
  });
});

describe('adfToMarkdown — lists', () => {
  const item = (...content: unknown[]) => ({ type: 'listItem', content });

  it('renders a bulletList', () => {
    expect(md({ type: 'bulletList', content: [item(para(text('one'))), item(para(text('two')))] })).toBe('- one\n- two');
  });

  it('renders an orderedList', () => {
    expect(md({ type: 'orderedList', content: [item(para(text('a'))), item(para(text('b')))] })).toBe('1. a\n2. b');
  });

  it('starts an orderedList at attrs.order', () => {
    expect(md({ type: 'orderedList', attrs: { order: 3 }, content: [item(para(text('a'))), item(para(text('b')))] })).toBe('3. a\n4. b');
  });

  it('indents a nested bulletList by two spaces', () => {
    const nested = { type: 'bulletList', content: [item(para(text('inner')))] };
    expect(md({ type: 'bulletList', content: [item(para(text('outer')), nested)] })).toBe('- outer\n  - inner');
  });

  it('indents a list nested in an orderedList item by the marker width', () => {
    const nested = { type: 'bulletList', content: [item(para(text('inner')))] };
    expect(md({ type: 'orderedList', content: [item(para(text('outer')), nested)] })).toBe('1. outer\n   - inner');
  });

  it('keeps a second paragraph of one item inside the item', () => {
    expect(md({ type: 'bulletList', content: [item(para(text('a')), para(text('b')))] })).toBe('- a\n  b');
  });

  it('renders a taskList as checkbox lines', () => {
    const list = {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('a')] },
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('b')] }
      ]
    };
    expect(md(list)).toBe('- [ ] a\n- [x] b');
  });
});

describe('adfToMarkdown — code', () => {
  it('fences a codeBlock with its language and does not escape the text', () => {
    expect(md({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const x = 1;')] })).toBe('```ts\nconst x = 1;\n```');
    expect(md({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a_b')] })).toBe('```ts\na_b\n```');
  });

  it('fences a codeBlock with no language bare', () => {
    expect(md({ type: 'codeBlock', content: [text('x')] })).toBe('```\nx\n```');
  });

  it('opens a longer fence when the code itself holds one', () => {
    expect(md({ type: 'codeBlock', content: [text('a\n```\nb')] })).toBe('````\na\n```\nb\n````');
  });

  it('renders an empty codeBlock as an empty fence', () => {
    expect(md({ type: 'codeBlock' })).toBe('```\n```');
  });
});

describe('adfToMarkdown — marks', () => {
  it.each([
    ['strong', '**b**'],
    ['em', '_b_'],
    ['code', '`b`'],
    ['strike', '~~b~~'],
    ['underline', 'b']
  ])('%s', (type, expected) => {
    expect(md(para(text('b', [{ type }])))).toBe(expected);
  });

  it('does not escape the content of an inline code mark', () => {
    expect(md(para(text('a_b*', [{ type: 'code' }])))).toBe('`a_b*`');
  });

  it('renders a link as [text](href)', () => {
    expect(md(para(text('site', [{ type: 'link', attrs: { href: 'https://example.com/x' } }])))).toBe('[site](https://example.com/x)');
  });

  it('keeps only http, https and mailto links, and leaves the text of any other', () => {
    expect(md(para(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])))).toBe('x');
    expect(md(para(text('x', [{ type: 'link', attrs: { href: '/relative' } }])))).toBe('x');
    expect(md(para(text('mail', [{ type: 'link', attrs: { href: 'mailto:a@b.c' } }])))).toBe('[mail](mailto:a@b.c)');
  });

  it('percent-encodes a space or closing paren in an href so the link cannot end early', () => {
    expect(md(para(text('x', [{ type: 'link', attrs: { href: 'https://e.com/a b)c' } }])))).toBe('[x](https://e.com/a%20b%29c)');
  });

  it('nests strong outside em whatever order the marks come in', () => {
    expect(md(para(text('x', [{ type: 'strong' }, { type: 'em' }])))).toBe('**_x_**');
    expect(md(para(text('x', [{ type: 'em' }, { type: 'strong' }])))).toBe('**_x_**');
  });

  it('keeps whitespace outside the marks, where Markdown needs it', () => {
    expect(md(para(text(' b ', [{ type: 'strong' }])))).toBe('**b**');
    expect(md(para(text('a'), text(' b ', [{ type: 'strong' }]), text('c')))).toBe('a **b** c');
  });

  it('puts a link outside the other marks', () => {
    expect(md(para(text('x', [{ type: 'strong' }, { type: 'link', attrs: { href: 'https://e.com' } }])))).toBe('[**x**](https://e.com)');
  });

  it('widens the backtick run of an inline code mark that contains one', () => {
    expect(md(para(text('a`b', [{ type: 'code' }])))).toBe('``a`b``');
  });
});

describe('adfToMarkdown — inline nodes', () => {
  it('renders an inlineCard as a link to its url', () => {
    expect(md(para({ type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/PAY-1' } }))).toBe(
      '[https://acme.atlassian.net/browse/PAY-1](https://acme.atlassian.net/browse/PAY-1)'
    );
  });

  it('renders an inlineCard with no url as nothing', () => {
    expect(md(para(text('a'), { type: 'inlineCard', attrs: {} }, text('b')))).toBe('ab');
  });

  it('renders a mention as @name, adding the @ only when it is missing', () => {
    expect(md(para({ type: 'mention', attrs: { text: '@Ada' } }))).toBe('@Ada');
    expect(md(para({ type: 'mention', attrs: { text: 'Ada' } }))).toBe('@Ada');
  });

  it('renders an emoji as its shortName', () => {
    expect(md(para({ type: 'emoji', attrs: { shortName: ':smile:' } }))).toBe(':smile:');
  });

  it('renders a date as an ISO day, from a millisecond timestamp string', () => {
    expect(md(para({ type: 'date', attrs: { timestamp: '1700000000000' } }))).toBe('2023-11-14');
  });

  it('renders a date with no usable timestamp as nothing', () => {
    expect(md(para(text('a'), { type: 'date', attrs: { timestamp: 'soon' } }, text('b')))).toBe('ab');
    expect(md(para(text('a'), { type: 'date', attrs: {} }, text('b')))).toBe('ab');
    expect(md(para(text('a'), { type: 'date', attrs: { timestamp: '' } }, text('b')))).toBe('ab');
  });

  it('renders a status as its text', () => {
    expect(md(para({ type: 'status', attrs: { text: 'DONE', color: 'green' } }))).toBe('DONE');
  });

  it('renders a hardBreak as a newline', () => {
    expect(md(para(text('a'), { type: 'hardBreak' }, text('b')))).toBe('a\nb');
  });
});

describe('adfToMarkdown — blocks', () => {
  it('renders a rule', () => {
    expect(md(para(text('a')), { type: 'rule' }, para(text('b')))).toBe('a\n\n---\n\nb');
  });

  it('renders a one-paragraph blockquote', () => {
    expect(md({ type: 'blockquote', content: [para(text('text'))] })).toBe('> text');
  });

  it('renders a two-paragraph blockquote with a bare > between', () => {
    expect(md({ type: 'blockquote', content: [para(text('a')), para(text('b'))] })).toBe('> a\n>\n> b');
  });

  it('quotes every line of a hardBreak inside a blockquote', () => {
    expect(md({ type: 'blockquote', content: [para(text('a'), { type: 'hardBreak' }, text('b'))] })).toBe('> a\n> b');
  });
});

describe('adfToMarkdown — placeholders', () => {
  const media = (attrs: Record<string, unknown>) => ({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', ...attrs } }] });
  const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('cell'))] }] }] };
  const panel = { type: 'panel', attrs: { panelType: 'info' }, content: [para(text('inside'))] };
  const expand = { type: 'expand', attrs: { title: 't' }, content: [para(text('hidden'))] };

  it('renders media with an alt as [attachment: alt]', () => {
    expect(adfToMarkdown(doc(media({ alt: 'shot.png' })))).toEqual({ markdown: '[attachment: shot.png]', placeholders: 1 });
  });

  it('renders media with no alt as [attachment]', () => {
    expect(adfToMarkdown(doc(media({})))).toEqual({ markdown: '[attachment]', placeholders: 1 });
  });

  it('keeps a "]" in an alt from ending the placeholder early', () => {
    expect(md(media({ alt: 'a]b' }))).toBe('[attachment: ab]');
  });

  it('renders a table, panel and expand as one-line placeholders, never their content', () => {
    expect(adfToMarkdown(doc(table))).toEqual({ markdown: '[table omitted]', placeholders: 1 });
    expect(adfToMarkdown(doc(panel))).toEqual({ markdown: '[panel omitted]', placeholders: 1 });
    expect(adfToMarkdown(doc(expand))).toEqual({ markdown: '[expand omitted]', placeholders: 1 });
    expect(adfToMarkdown(doc({ type: 'nestedExpand', content: [para(text('x'))] }))).toEqual({ markdown: '[expand omitted]', placeholders: 1 });
  });

  it('counts five placeholders in a doc with media (alt), media (no alt), table, panel and expand', () => {
    const out = adfToMarkdown(doc(media({ alt: 'shot.png' }), media({}), table, panel, expand));
    expect(out.placeholders).toBe(5);
    expect(out.markdown).toBe('[attachment: shot.png]\n\n[attachment]\n\n[table omitted]\n\n[panel omitted]\n\n[expand omitted]');
  });

  it('counts a placeholder inside a list item or a blockquote, and keeps it on the same line as its marker', () => {
    const item = { type: 'listItem', content: [table] };
    const out = adfToMarkdown(doc({ type: 'bulletList', content: [item] }, { type: 'blockquote', content: [panel] }));
    expect(out).toEqual({ markdown: '- [table omitted]\n\n> [panel omitted]', placeholders: 2 });
  });

  describe('ADF_PLACEHOLDER_RE', () => {
    it.each(['[attachment: shot.png]', '[attachment]', '[table omitted]', '[panel omitted]', '[expand omitted]'])('matches %j on a line of its own', (line) => {
      expect(ADF_PLACEHOLDER_RE.test(line)).toBe(true);
    });

    it.each(['- [table omitted]', '> [panel omitted]', '1. [expand omitted]', '  - [attachment: a b.png]', 'see [attachment] here'])(
      'matches %j anywhere in a line (P7)',
      (line) => {
        expect(ADF_PLACEHOLDER_RE.test(line)).toBe(true);
      }
    );

    it.each(['[attachments]', '[table]', '[omitted]', 'attachment', '\\[table omitted\\]'])('does not match %j', (line) => {
      expect(ADF_PLACEHOLDER_RE.test(line)).toBe(false);
    });

    it('is stateless, so a detector may call .test on it repeatedly', () => {
      expect(ADF_PLACEHOLDER_RE.global).toBe(false);
      expect(ADF_PLACEHOLDER_RE.test('[table omitted]')).toBe(true);
      expect(ADF_PLACEHOLDER_RE.test('[table omitted]')).toBe(true);
    });

    it('does not fire on a person\'s own literal "[table omitted]" text, because the text is escaped', () => {
      const out = adfToMarkdown(doc(para(text('[table omitted]'))));
      expect(out).toEqual({ markdown: '\\[table omitted\\]', placeholders: 0 });
      expect(ADF_PLACEHOLDER_RE.test(out.markdown)).toBe(false);
    });

    it('matches every placeholder form the converter emits', () => {
      const out = adfToMarkdown(
        doc(
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'x.png' } }] },
          { type: 'mediaSingle', content: [{ type: 'media', attrs: {} }] },
          { type: 'table' },
          { type: 'panel' },
          { type: 'expand' }
        )
      );
      const lines = out.markdown.split('\n\n');
      expect(lines).toHaveLength(5);
      for (const line of lines) expect(ADF_PLACEHOLDER_RE.test(line)).toBe(true);
    });
  });
});

describe('adfToMarkdown — unknown nodes', () => {
  it('renders the text content of an unknown node', () => {
    expect(md({ type: 'fancy', content: [text('kept')] })).toBe('kept');
    expect(md(para(text('a'), { type: 'fancy', content: [text('b')] }, text('c')))).toBe('abc');
  });

  it('renders the block children of an unknown container as blocks', () => {
    expect(md({ type: 'fancy', content: [para(text('a')), para(text('b'))] })).toBe('a\n\nb');
  });

  it('renders an unknown node with no children as nothing', () => {
    expect(md({ type: 'fancy' })).toBe('');
    expect(md(para(text('a'), { type: 'fancy' }, text('b')))).toBe('ab');
  });

  it('ignores malformed nodes rather than throwing', () => {
    expect(md(null, 7, 'x', { content: [text('y')] }, para(null, text('z')))).toBe('y\n\nz');
  });

  it('gives up on a pathologically deep document instead of overflowing the stack', () => {
    let node: unknown = text('deep');
    for (let i = 0; i < 5000; i++) node = { type: 'blockquote', content: [node] };
    expect(() => adfToMarkdown(doc(node))).not.toThrow();
  });
});

describe('escapeMarkdown', () => {
  it.each([
    ['snake_case_name', 'snake\\_case\\_name'],
    ['2 * 3', '2 \\* 3'],
    ['a < b', 'a \\< b'],
    ['[x]', '\\[x\\]'],
    ['back\\slash', 'back\\\\slash'],
    ['~', '\\~'],
    ['a`b', 'a\\`b'],
    ['plain text.', 'plain text.']
  ])('%j → %j', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it('escapes the specials of text nodes in a document', () => {
    expect(md(para(text('snake_case_name and 2 * 3')))).toBe('snake\\_case\\_name and 2 \\* 3');
  });
});
