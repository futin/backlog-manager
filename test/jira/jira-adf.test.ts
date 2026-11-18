import { performance } from 'node:perf_hooks';

import { ADF_MEDIA_NAME_MAX, ADF_PLACEHOLDER_RE, adfToMarkdown, adfToText, escapeMarkdown, replyDoc } from '../../server/src/jira/adf';

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

  // A description is remote input up to ~32k characters and is converted on every issue read, so the split must be linear: the regex it replaced backtracked
  // O(n²) on an INTERIOR whitespace run (~1.4 s for this one, synchronous, blocking every route). The bound is generous; the regression is three orders out.
  it('splits an interior whitespace run of 30 000 in linear time, keeping it inside the marks', () => {
    const run = ' '.repeat(30_000);
    const started = performance.now();
    const out = md(para(text(`a${run}b`, [{ type: 'strong' }])));
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toBe(`**a${run}b**`);
  });

  it('keeps leading and trailing whitespace outside the marks around an interior run', () => {
    // Between two plain nodes, because the document trims its own edges. `\u00a0` is whitespace to both `\s` and `trim`, the equivalence the split rests on.
    expect(md(para(text('x'), text(' \ta  b\n ', [{ type: 'em' }]), text('y')))).toBe('x \t_a  b_\n y');
    expect(md(para(text('x'), text(' \u00a0 ', [{ type: 'strong' }]), text('y')))).toBe('x \u00a0 y');
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

  it('caps an alt at ADF_MEDIA_NAME_MAX characters, so the escaped name always fits ADF_PLACEHOLDER_RE', () => {
    // Every character escapable: the escaped name is twice the cap, the longest a placeholder can carry.
    const out = md(media({ alt: '_'.repeat(ADF_MEDIA_NAME_MAX + 50) }));
    expect(out).toBe(`[attachment: ${'\\_'.repeat(ADF_MEDIA_NAME_MAX)}]`);
    expect(ADF_PLACEHOLDER_RE.test(out)).toBe(true);
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

    // The detector runs on every `?format=text` over a remote description; an unbounded name scanned to the end of the line from every `[attachment: `
    // start, so a line made of nothing else was quadratic.
    it('rejects 100 000 characters of unterminated "[attachment: " starts in linear time', () => {
      const line = '[attachment: '.repeat(Math.ceil(100_000 / 13));
      const started = performance.now();
      expect(ADF_PLACEHOLDER_RE.test(line)).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
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

describe('adfToText', () => {
  const txt = (...content: unknown[]) => adfToText(doc(...content));

  it('writes text nodes as written, with no markdown escaping', () => {
    expect(txt(para(text('Hi *there*')))).toBe('Hi *there*');
  });

  it('writes a mention with exactly one leading @', () => {
    expect(txt(para({ type: 'mention', attrs: { id: 'a1', text: '@Mara Ilić' } }))).toBe('@Mara Ilić');
    expect(txt(para({ type: 'mention', attrs: { id: 'a1', text: 'Mara Ilić' } }))).toBe('@Mara Ilić');
  });

  it('concatenates inline siblings without adding spaces', () => {
    expect(txt(para({ type: 'mention', attrs: { id: 'a1', text: '@Mara' } }, text(', can you')))).toBe('@Mara, can you');
    expect(txt(para(text('bo'), text('ld', [{ type: 'strong' }])))).toBe('bold');
  });

  it('writes an emoji as its text', () => {
    expect(txt(para({ type: 'emoji', attrs: { text: ':)' } }))).toBe(':)');
  });

  it('turns hardBreak and block boundaries into one space', () => {
    expect(txt(para(text('a'), { type: 'hardBreak' }, text('b')))).toBe('a b');
    expect(txt(para(text('a')), para(text('b')))).toBe('a b');
  });

  it('writes an inlineCard as its url, drops media, and adds nothing for an empty unknown node', () => {
    expect(txt(para({ type: 'inlineCard', attrs: { url: 'https://x.test/1' } }))).toBe('https://x.test/1');
    expect(txt(para(text('a')), { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm' } }] }, { type: 'wat' })).toBe('a');
  });

  it("walks an unknown node's children rather than dropping it: a node type Jira adds later keeps its words in the excerpt", () => {
    expect(txt(para(text('a')), { type: 'wat', content: [para(text('kept'))] })).toBe('a kept');
    expect(txt(para(text('a'), { type: 'wat', content: [text('-b')] }))).toBe('a -b');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(txt(para(text('  a   b\n\n c  ')))).toBe('a b c');
  });

  it.each([null, undefined, 'a string', 42, [], {}])('%j → empty string', (value) => {
    expect(adfToText(value)).toBe('');
  });
});

/**
 * The WRITE side (Jira › Mentions, plan Task 5): the one document this server ever sends Jira, a reply that opens by @-mentioning the person it answers.
 * Plain text in, ADF out — paragraphs on blank lines, a `hardBreak` on a single newline, nothing empty, so Jira never sees a node it would refuse.
 */
describe('replyDoc', () => {
  const MARA = { accountId: 'acc-m', name: 'Mara Ilić' };
  const mention = { type: 'mention', attrs: { id: 'acc-m', text: '@Mara Ilić' } };

  it('opens the first paragraph with the mention and a space, and puts a later paragraph after it', () => {
    expect(replyDoc(MARA, 'Hi\n\nSecond')).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention, { type: 'text', text: ' Hi' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
      ]
    });
  });

  it('turns a single newline, CRLF included, into a hardBreak inside one paragraph', () => {
    expect(replyDoc(MARA, 'a\r\nb').content).toEqual([
      { type: 'paragraph', content: [mention, { type: 'text', text: ' a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }
    ]);
  });

  it('makes no empty paragraph from a run of blank lines, a whitespace-only line among them', () => {
    expect(replyDoc(MARA, 'a\n\n\n\nb').content).toHaveLength(2);
    expect(replyDoc(MARA, 'a\n  \n\t\nb').content).toEqual([
      { type: 'paragraph', content: [mention, { type: 'text', text: ' a' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }
    ]);
  });

  it('trims trailing spaces and newlines, so the document ends on the last word', () => {
    expect(replyDoc(MARA, 'Thanks  \n\n \n').content).toEqual([{ type: 'paragraph', content: [mention, { type: 'text', text: ' Thanks' }] }]);
  });

  it('targets the given account id with exactly one @, even for a name that already carries one', () => {
    const first = (d: ReturnType<typeof replyDoc>) => (d.content[0] as { content: unknown[] }).content[0];
    expect(first(replyDoc(MARA, 'x'))).toEqual(mention);
    expect(first(replyDoc({ accountId: 'acc-m', name: '@Mara Ilić' }, 'x'))).toEqual(mention);
  });

  it("leaves the mention node out for an author with no account id (authorOf's '' for an author-less comment), and the leading space with it", () => {
    const anon = { accountId: '', name: 'Someone' };
    expect(replyDoc(anon, 'Hi\nthere\n\nSecond')).toEqual({
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }, { type: 'hardBreak' }, { type: 'text', text: 'there' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
      ]
    });
    expect(JSON.stringify(replyDoc(anon, 'x'))).not.toContain('mention');
    expect(replyDoc(anon, '  ').content).toEqual([{ type: 'paragraph', content: [] }]);
  });

  it('round-trips through the read side as the person would see it', () => {
    expect(adfToMarkdown(replyDoc(MARA, 'Hi there\nline two\n\nSecond')).markdown).toBe('@Mara Ilić Hi there\nline two\n\nSecond');
  });
});

/**
 * The WRITE side reads Markdown (spec 2026-11-18-jira-reply-markdown, "Converter"): the reply is GFM, lexed by `marked` and mapped onto a narrow, validated
 * ADF subset, so a draft with headings, lists and bold posts to Jira looking as it did in the board's preview. Every case asserts the exact ADF, because
 * Jira refuses a whole comment over one node it does not allow — "close enough" is a 400.
 */
describe('replyDoc — Markdown', () => {
  const MARA = { accountId: 'acc-m', name: 'Mara Ilić' };
  const mention = { type: 'mention', attrs: { id: 'acc-m', text: '@Mara Ilić' } };
  const t = (s: string, ...marks: unknown[]) => (marks.length === 0 ? { type: 'text', text: s } : { type: 'text', text: s, marks });
  const p = (...content: unknown[]) => ({ type: 'paragraph', content });
  const li = (...content: unknown[]) => ({ type: 'listItem', content });
  const bullets = (...content: unknown[]) => ({ type: 'bulletList', content });
  const strong = { type: 'strong' };
  const em = { type: 'em' };
  const code = { type: 'code' };
  const link = (href: string) => ({ type: 'link', attrs: { href } });
  const blocks = (s: string) => replyDoc(MARA, s).content as unknown[];

  it('maps strong, em, strike and code marks inside the first paragraph, the mention leading', () => {
    expect(blocks('Hi **bold** _em_ ~~gone~~ `code`')).toEqual([
      p(mention, t(' Hi '), t('bold', strong), t(' '), t('em', em), t(' '), t('gone', { type: 'strike' }), t(' '), t('code', code))
    ]);
  });

  it('reads the other spellings of strong and em', () => {
    expect(blocks('__s__ *e*')).toEqual([p(mention, t(' '), t('s', strong), t(' '), t('e', em))]);
  });

  it('gives the mention a paragraph of its own when the reply opens with a heading', () => {
    expect(blocks('# Title\n\nBody')).toEqual([p(mention), { type: 'heading', attrs: { level: 1 }, content: [t('Title')] }, p(t('Body'))]);
  });

  it('maps a bullet list, nested', () => {
    expect(blocks('- a\n- b\n  - c')).toEqual([p(mention), bullets(li(p(t('a'))), li(p(t('b')), bullets(li(p(t('c'))))))]);
  });

  it('sets orderedList attrs.order only when the list does not start at 1', () => {
    expect(blocks('3. x\n4. y')[1]).toEqual({ type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('x'))), li(p(t('y')))] });
    const one = blocks('1. x')[1];
    expect(one).toEqual({ type: 'orderedList', content: [li(p(t('x')))] });
    expect(one).not.toHaveProperty('attrs');
  });

  it('maps a fenced code block with its language, text only', () => {
    expect(blocks('```ts\nconst a = 1\n```')).toEqual([p(mention), { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1')] }]);
  });

  it('maps an indented code block with no language, and an empty fence to a codeBlock with no content', () => {
    const indented = blocks('a\n\n    code');
    expect(indented).toEqual([p(mention, t(' a')), { type: 'codeBlock', content: [t('code')] }]);
    expect(indented[1]).not.toHaveProperty('attrs');
    expect(blocks('```\n```')).toEqual([p(mention), { type: 'codeBlock', content: [] }]);
  });

  it('maps a quote, and flattens a nested quote into the outer one', () => {
    expect(blocks('> q')).toEqual([p(mention), { type: 'blockquote', content: [p(t('q'))] }]);
    expect(blocks('> > q')).toEqual([p(mention), { type: 'blockquote', content: [p(t('q'))] }]);
  });

  it('maps a thematic break to a rule', () => {
    expect(blocks('a\n\n---\n\nb')).toEqual([p(mention, t(' a')), { type: 'rule' }, p(t('b'))]);
  });

  it('maps a GFM table to header and cell nodes, each one paragraph, an empty cell an empty paragraph', () => {
    const row = (...content: unknown[]) => ({ type: 'tableRow', content });
    const th = (...content: unknown[]) => ({ type: 'tableHeader', content });
    const td = (...content: unknown[]) => ({ type: 'tableCell', content });
    expect(blocks('| h1 | h2 |\n| - | - |\n| a |  |')).toEqual([
      p(mention),
      { type: 'table', content: [row(th(p(t('h1'))), th(p(t('h2')))), row(td(p(t('a'))), td(p()))] }
    ]);
  });

  it('keeps an http(s) or mailto link, drops its title, and posts any other scheme as the bare label', () => {
    expect(blocks('[t](https://x.io)')).toEqual([p(mention, t(' '), t('t', link('https://x.io')))]);
    expect(blocks('[t](https://x.io "T")')).toEqual([p(mention, t(' '), t('t', link('https://x.io')))]);
    expect(blocks('[m](mailto:a@b.io)')).toEqual([p(mention, t(' '), t('m', link('mailto:a@b.io')))]);
    expect(blocks('[t](javascript:alert(1))')).toEqual([p(mention, t(' t'))]);
  });

  it('marks a GFM autolink as a link', () => {
    expect(blocks('see https://x.io')).toEqual([p(mention, t(' see '), t('https://x.io', link('https://x.io')))]);
  });

  it('lets code combine with nothing but link, so bold code is just code', () => {
    expect(blocks('**`x`**')).toEqual([p(mention, t(' '), t('x', code))]);
  });

  it('decodes the five named entities, numeric references and backslash escapes, and leaves any other entity as written', () => {
    expect(blocks('a &amp; b &lt; &#169; &#x41; &hellip; \\*')).toEqual([p(mention, t(' a & b < © A &hellip; *'))]);
    expect(blocks('&gt; &quot; &#39;')).toEqual([p(mention, t(' > " \''))]);
  });

  it('turns a heading inside a list item or a quote into a strong paragraph', () => {
    expect(blocks('- # h')).toEqual([p(mention), bullets(li(p(t('h', strong))))]);
    expect(blocks('> # h')).toEqual([p(mention), { type: 'blockquote', content: [p(t('h', strong))] }]);
  });

  it('turns a rule inside a list item into a paragraph ---, and a table inside a quote into one paragraph per row', () => {
    expect(blocks('- a\n\n  ---')).toEqual([p(mention), bullets(li(p(t('a')), p(t('---'))))]);
    expect(blocks('> | a | b |\n> | - | - |\n> | c | d |')).toEqual([p(mention), { type: 'blockquote', content: [p(t('a | b')), p(t('c | d'))] }]);
  });

  it('opens a list item that starts with code with an empty paragraph', () => {
    expect(blocks('- ```\n  x\n  ```')).toEqual([p(mention), bullets(li(p(), { type: 'codeBlock', content: [t('x')] }))]);
  });

  it('posts a task item as a plain item whose text starts with its box', () => {
    expect(blocks('- [ ] todo\n- [x] done')).toEqual([p(mention), bullets(li(p(t('[ ] todo'))), li(p(t('[x] done'))))]);
  });

  it('posts raw HTML and an image as their source text', () => {
    expect(blocks('<b>x</b>')).toEqual([p(mention, t(' <b>x</b>'))]);
    expect(blocks('![alt](/a.png)')).toEqual([p(mention, t(' ![alt](/a.png)'))]);
  });

  it('leaves prose that only looks like Markdown alone, and maps a 1) list as the preview shows it', () => {
    expect(blocks('snake_case_name and 2 * 3 * 4')).toEqual([p(mention, t(' snake_case_name and 2 * 3 * 4'))]);
    expect(blocks('#123 is fixed')).toEqual([p(mention, t(' #123 is fixed'))]);
    expect(blocks('1) first')).toEqual([p(mention), { type: 'orderedList', content: [li(p(t('first')))] }]);
  });

  it('never emits an empty text node', () => {
    const inputs = [
      'Hi **bold** _em_ ~~gone~~ `code`',
      '# Title\n\nBody',
      '- a\n- b\n  - c',
      '```\n```',
      '| h1 | h2 |\n| - | - |\n| a |  |',
      '[t](https://x.io)',
      '**`x`**',
      '- # h',
      '- ```\n  x\n  ```',
      '> | a | b |\n> | - | - |\n> | c | d |',
      'a  \nb',
      '**a** \n_b_'
    ];
    const empties = (n: unknown): number => {
      if (Array.isArray(n)) return n.reduce((s: number, c) => s + empties(c), 0);
      if (n === null || typeof n !== 'object') return 0;
      const o = n as { type?: string; text?: string; content?: unknown };
      return (o.type === 'text' && o.text === '' ? 1 : 0) + empties(o.content);
    };
    for (const s of inputs) expect(empties(replyDoc(MARA, s).content)).toBe(0);
  });

  // ADF's schema gives `blockquote.content` a minimum of one block, so an empty quote makes Jira refuse the whole comment while the preview showed nothing
  // wrong. A line holding only `>` lexes to a quote with no children.
  it('never emits an empty blockquote', () => {
    const emptyQuotes = (n: unknown): number => {
      if (Array.isArray(n)) return n.reduce((s: number, c) => s + emptyQuotes(c), 0);
      if (n === null || typeof n !== 'object') return 0;
      const o = n as { type?: string; content?: unknown[] };
      return (o.type === 'blockquote' && (o.content ?? []).length === 0 ? 1 : 0) + emptyQuotes(o.content);
    };
    for (const s of ['>', '> ', '>\n>', 'Before\n\n>\n\nAfter']) expect(emptyQuotes(replyDoc(MARA, s).content)).toBe(0);
    // The text around an empty quote still posts.
    expect(JSON.stringify(replyDoc(MARA, 'Before\n\n>\n\nAfter').content)).toContain('After');
  });

  it('round-trips canonical Markdown through the read side unchanged', () => {
    const md = [
      'Thanks, **bold**, _em_ and `code`, see [t](https://x.io)',
      '## Heading',
      '- one\n- two',
      '1. first\n2. second',
      '```ts\nconst a = 1\n```',
      '> quoted',
      '---',
      'End'
    ].join('\n\n');
    expect(adfToMarkdown(replyDoc(MARA, md)).markdown).toBe(`@Mara Ilić ${md}`);
  });
});
