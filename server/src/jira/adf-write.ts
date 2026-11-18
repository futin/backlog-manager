import { marked, type Token, type Tokens } from 'marked';

/**
 * The WRITE side of ADF (Jira › Mentions, Post reply): the only document this server ever sends Jira. A reply is Markdown — the draft session writes it
 * that way and the person edits it in a box that previews it rendered — and this file turns it into the narrow, validated subset of ADF a comment body
 * may hold (spec `docs/superpowers/specs/2026-11-18-jira-reply-markdown-design.md`, "Converter").
 *
 * Its types are its own and deliberately separate from the read side's loose `AdfNode` (`adf.ts`): the read side must survive anything Jira ever stored,
 * while this side must never emit anything Jira would refuse, and Jira refuses the WHOLE comment over one node or mark it does not allow in that place. So
 * every block is checked against the container it lands in, and whatever a container does not allow is degraded to text there — never dropped, never an
 * error. The person's words always arrive; at worst a construct arrives as the characters they typed.
 *
 * `marked` is the lexer because the client already renders the preview with it (`client/src/lib/markdown.ts`): the same tokenizer on both sides is what
 * makes "what the preview shows is what Jira gets" hold for the edge cases — an intraword `_`, a spaced `*`, a `1)` list marker. It is ESM-only; the
 * server, compiled to CommonJS, loads it through Node's `require(esm)` (Node >= 22.13, pinned by `engines`), and jest through the UMD mapping in
 * `jest.config.ts`.
 */

/** A mark this side emits. `code` combines with `link` only (ADF's rule), so `**`x`**` keeps `code` and loses `strong`. */
export type AdfMark = { type: 'strong' } | { type: 'em' } | { type: 'strike' } | { type: 'code' } | { type: 'link'; attrs: { href: string } };

/** A text node is never empty: Jira's validator refuses `text: ''`. */
export type AdfText = { type: 'text'; text: string; marks?: AdfMark[] };

/** The inline nodes this side emits — only these. */
export type AdfInline = AdfText | { type: 'mention'; attrs: { id: string; text: string } } | { type: 'hardBreak' };

export type AdfParagraph = { type: 'paragraph'; content: AdfInline[] };
export type AdfCodeBlock = { type: 'codeBlock'; attrs?: { language: string }; content: { type: 'text'; text: string }[] };
export type AdfListItem = { type: 'listItem'; content: AdfNestable[] };
export type AdfList = { type: 'bulletList'; content: AdfListItem[] } | { type: 'orderedList'; attrs?: { order: number }; content: AdfListItem[] };
/** What a list item and a quote may hold: ADF allows neither a heading, a rule, a table nor a quote inside them. */
export type AdfNestable = AdfParagraph | AdfList | AdfCodeBlock;
export type AdfTableCell = { type: 'tableHeader' | 'tableCell'; content: [AdfParagraph] };
export type AdfTable = { type: 'table'; content: { type: 'tableRow'; content: AdfTableCell[] }[] };

/** A top-level block this side emits. */
export type AdfBlock =
  | AdfNestable
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 }; content: AdfInline[] }
  | { type: 'blockquote'; content: AdfNestable[] }
  | { type: 'rule' }
  | AdfTable;

/** An ADF document as Jira's comment endpoint takes it (`POST issue/{key}/comment` `{ body }`). */
export type AdfDoc = { version: 1; type: 'doc'; content: AdfBlock[] };

/** Where a block lands — each container allows a different set of children. */
type Container = 'doc' | 'listItem' | 'blockquote';

/** Only these schemes become a link: anything else (`javascript:`, `data:`, a relative path Jira cannot resolve) posts its label as plain text. */
const LINK_SCHEMES = /^(?:https?:|mailto:)/i;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/**
 * `marked`'s lexer leaves character references undecoded in text tokens (the renderer decodes them, and the server has no renderer). This decodes the set
 * a person or a draft session plausibly writes — the five named references and any numeric one. Another named reference (`&hellip;`) posts as written;
 * the preview, which the browser decodes, shows `…` — accepted in the spec, since a full HTML entity table is a dependency for a character nobody types.
 */
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, (whole, name: string, dec?: string, hex?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[name] ?? whole;
  });
}

/** A mark set with `mark` added once; `code` drops every mark but `link`, and nothing but `link` is added to a `code` run. */
function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  if (marks.some((m) => m.type === mark.type)) return marks;
  const has = marks.some((m) => m.type === 'code');
  if (mark.type === 'code') return [...marks.filter((m) => m.type === 'link'), mark];
  if (has && mark.type !== 'link') return marks;
  return [...marks, mark];
}

/** Appends a text run, merging it into the previous one when the marks match, and dropping it when empty — so no `text: ''` ever reaches Jira. */
function pushText(out: AdfInline[], text: string, marks: AdfMark[]): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last !== undefined && last.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
    last.text += text;
    return;
  }
  out.push(marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks });
}

/** Text with newlines in it: each single newline inside a paragraph is a `hardBreak`, as it was before Markdown, and as the preview's `breaks: true` shows. */
function pushLines(out: AdfInline[], text: string, marks: AdfMark[]): void {
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    pushText(out, line, marks);
  });
}

function inlines(tokens: readonly Token[], marks: AdfMark[] = [], out: AdfInline[] = []): AdfInline[] {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text;
        if (t.tokens !== undefined && t.tokens.length > 0) inlines(t.tokens, marks, out);
        else pushLines(out, decode(t.text), marks);
        break;
      }
      case 'escape':
        pushText(out, (tok as Tokens.Escape).text, marks);
        break;
      case 'strong':
        inlines((tok as Tokens.Strong).tokens, withMark(marks, { type: 'strong' }), out);
        break;
      case 'em':
        inlines((tok as Tokens.Em).tokens, withMark(marks, { type: 'em' }), out);
        break;
      case 'del':
        inlines((tok as Tokens.Del).tokens, withMark(marks, { type: 'strike' }), out);
        break;
      case 'codespan':
        // A code span is literal: no entity decoding, no newline-as-break (CommonMark folds a span's newline to a space).
        pushText(out, (tok as Tokens.Codespan).text.replace(/\n/g, ' '), withMark(marks, { type: 'code' }));
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'link': {
        const l = tok as Tokens.Link;
        // The title is dropped: ADF's link mark carries one, but Jira's renderer never shows it, and it is one more string to validate.
        const next = LINK_SCHEMES.test(l.href) ? withMark(marks, { type: 'link', attrs: { href: l.href } }) : marks;
        inlines(l.tokens, next, out);
        break;
      }
      default:
        // Raw HTML, an image, anything a later `marked` adds: the characters the person typed.
        pushLines(out, tok.raw, marks);
    }
  }
  return out;
}

const para = (content: AdfInline[]): AdfParagraph => ({ type: 'paragraph', content });

/** Source text as a paragraph, the generic fallback for a block nothing else maps; blank source yields nothing. */
function rawParagraph(raw: string): AdfParagraph[] {
  const s = raw.replace(/^\n+|\s+$/g, '');
  if (s === '') return [];
  const out: AdfInline[] = [];
  pushLines(out, s, []);
  return [para(out)];
}

/** A table's rows as paragraphs, cells joined by ` | ` — what a table becomes inside a quote or a list item, where ADF allows none. */
function tableRows(t: Tokens.Table): AdfParagraph[] {
  return [t.header, ...t.rows].map((row) => {
    const out: AdfInline[] = [];
    row.forEach((cell, i) => {
      if (i > 0) pushText(out, ' | ', []);
      inlines(cell.tokens, [], out);
    });
    return para(out);
  });
}

function list(l: Tokens.List): AdfList {
  const items: AdfListItem[] = l.items.map((item) => {
    const content = blocks(item.tokens, 'listItem') as AdfNestable[];
    // ADF wants a list item to open with a paragraph; one that opens with code (or holds nothing) gets an empty one first.
    if (content[0]?.type !== 'paragraph') content.unshift(para([]));
    // A GFM task item: the lexer strips the box into `task`/`checked`, and ADF's taskList is not allowed in a comment reply's list — so the box is text.
    if (item.task) (content[0] as AdfParagraph).content.unshift({ type: 'text', text: item.checked ? '[x] ' : '[ ] ' });
    const first = (content[0] as AdfParagraph).content;
    if (item.task && first[1]?.type === 'text' && first[1].marks === undefined) {
      first[0] = { type: 'text', text: (first[0] as AdfText).text + first[1].text };
      first.splice(1, 1);
    }
    return { type: 'listItem', content };
  });
  if (!l.ordered) return { type: 'bulletList', content: items };
  const start = typeof l.start === 'number' ? l.start : 1;
  return start === 1 ? { type: 'orderedList', content: items } : { type: 'orderedList', attrs: { order: start }, content: items };
}

/** One token → the blocks it becomes in `container`; whatever the container does not allow degrades to paragraphs there. */
function blocks(tokens: readonly Token[], container: Container): AdfBlock[] {
  const out: AdfBlock[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'paragraph':
        out.push(para(inlines((tok as Tokens.Paragraph).tokens)));
        break;
      case 'text': {
        // A tight list item's body: block-level `text` with inline tokens of its own.
        const t = tok as Tokens.Text;
        out.push(para(t.tokens !== undefined ? inlines(t.tokens) : inlines([{ type: 'text', raw: t.raw, text: t.text } as Tokens.Text])));
        break;
      }
      case 'heading': {
        const h = tok as Tokens.Heading;
        if (container === 'doc') out.push({ type: 'heading', attrs: { level: h.depth as 1 | 2 | 3 | 4 | 5 | 6 }, content: inlines(h.tokens) });
        else out.push(para(inlines(h.tokens, [{ type: 'strong' }])));
        break;
      }
      case 'code': {
        const c = tok as Tokens.Code;
        const lang = (c.lang ?? '').trim().split(/\s+/)[0];
        const content = c.text === '' ? [] : [{ type: 'text' as const, text: c.text }];
        out.push(lang === '' ? { type: 'codeBlock', content } : { type: 'codeBlock', attrs: { language: lang }, content });
        break;
      }
      case 'blockquote': {
        const children = blocks((tok as Tokens.Blockquote).tokens, container === 'listItem' ? 'listItem' : 'blockquote') as AdfNestable[];
        // Only the document holds a quote; a quote inside a quote is flattened into it, and inside a list item its children stand in the item.
        if (container === 'doc') out.push({ type: 'blockquote', content: children });
        else out.push(...children);
        break;
      }
      case 'list':
        out.push(list(tok as Tokens.List));
        break;
      case 'hr':
        if (container === 'doc') out.push({ type: 'rule' });
        else out.push(para([{ type: 'text', text: '---' }]));
        break;
      case 'table': {
        const t = tok as Tokens.Table;
        if (container !== 'doc') {
          out.push(...tableRows(t));
          break;
        }
        const row = (cells: Tokens.TableCell[], type: AdfTableCell['type']) => ({
          type: 'tableRow' as const,
          content: cells.map((cell): AdfTableCell => ({ type, content: [para(inlines(cell.tokens))] }))
        });
        out.push({ type: 'table', content: [row(t.header, 'tableHeader'), ...t.rows.map((r) => row(r, 'tableCell'))] });
        break;
      }
      default:
        // An HTML block, a reference definition, anything a later `marked` adds: its source text.
        out.push(...rawParagraph(tok.raw));
    }
  }
  return out;
}

/**
 * A Markdown reply → the ADF comment body, opening with an @-mention of `to`, so Jira notifies the person being answered as it would for a reply typed in
 * Jira itself. The draft session is told to write no leading @-mention (prompt.util.ts, `replyText`) precisely because it is added here, from the cache's
 * author — an account id a session or a browser could spell wrong never reaches the mention node.
 *
 * The text is GFM, lexed once; CRLF is LF, leading blank lines and trailing whitespace are dropped (leading INDENT on the first line is kept, since four
 * spaces open a code block in the preview too). When the first block is a paragraph the mention opens it, followed by a space; when the reply opens with
 * a heading, a list or code, the mention gets a paragraph of its own before it — a mention inside a heading would make the whole name a heading. The
 * mention's display text is `@` + the name with any `@` it already carries stripped, so it is never `@@`. Text that is blank yields the mention alone; the
 * route refuses blank text before it gets here.
 *
 * An empty `accountId` gets no mention node at all: `authorOf` answers `''` for a comment Jira sent without an author (an app, a deleted account), and the
 * check does not filter those out, so the newest open mention can carry one. A mention node with `id: ''` is not a mention of anyone — Jira would most
 * likely refuse the whole comment over it — so the reply is posted without one, and with no leading space where the mention would have been.
 */
export function replyDoc(to: { accountId: string; name: string }, text: string): AdfDoc {
  const mention: AdfInline | null = to.accountId === '' ? null : { type: 'mention', attrs: { id: to.accountId, text: `@${to.name.replace(/^@+/, '')}` } };
  const source = text.replace(/\r\n?/g, '\n').replace(/^(?:[^\S\n]*\n)+/, '').trimEnd();
  const content = source === '' ? [] : blocks(marked.lexer(source, { gfm: true }), 'doc');
  if (mention === null) return { version: 1, type: 'doc', content: content.length === 0 ? [para([])] : content };
  const first = content[0];
  if (first?.type === 'paragraph') {
    const lead = first.content[0];
    // The space after the mention rides on the first text run when it is plain, so the paragraph holds no text node that is only a space.
    if (lead?.type === 'text' && lead.marks === undefined) lead.text = ` ${lead.text}`;
    else if (lead !== undefined) first.content.unshift({ type: 'text', text: ' ' });
    first.content.unshift(mention);
  } else {
    content.unshift(para([mention]));
  }
  return { version: 1, type: 'doc', content };
}
