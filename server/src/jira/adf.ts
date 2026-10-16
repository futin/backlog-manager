/**
 * adf.ts — Atlassian Document Format → Markdown, the read side only (Jira phase 1; spec §8). Pure: no I/O, no clock, no module state, so the ticket block
 * (Task 7) and the detail route can call it on whatever Jira handed back without a fixture beyond the JSON itself.
 *
 * What it covers is the node inventory the phase-0 probe (§14 P10) saw on ten real descriptions — `paragraph heading bulletList orderedList listItem
 * codeBlock taskList taskItem media mediaSingle mention emoji inlineCard rule`, with `panel table tableRow tableHeader tableCell` collapsed to placeholders,
 * and the marks `strong em code link underline` — plus the documented nodes the probe did NOT see (`expand`, `date`, `status`, `strike`, `blockquote`, `hardBreak`), written
 * from Atlassian's schema and exercised only by fixtures. P10 also found `taskList` on real descriptions, which the first draft of §8 had left out.
 *
 * Three decisions carry the design.
 *
 * 1. Text is ESCAPED, code is not. A description is prose; the person who wrote `snake_case_name` or `2 * 3` meant exactly that, and unescaped it would
 *    render as italics. `escapeMarkdown` therefore runs on every text node and on every label this file builds, and a code mark or codeBlock — where Markdown is already
 *    suspended — is left raw. A side effect P7 relies on: a person's literal `[table omitted]` becomes `\[table omitted\]` and cannot be mistaken for a
 *    placeholder by `ADF_PLACEHOLDER_RE` (a codeBlock holding that text still can — the one false positive, accepted in P7).
 * 2. What cannot be said in a line becomes a ONE-LINE placeholder — `[attachment: name]`, `[attachment]`, `[table omitted]`, `[panel omitted]`,
 *    `[expand omitted]` — never a half-rendered table. `adfToMarkdown` counts them and `ADF_PLACEHOLDER_RE` is the one home of what one looks like, so the
 *    ticket block's "something was omitted — open in Jira" line detects them with the same pattern that wrote them. The pattern matches ANYWHERE in a line
 *    (P7), not only at its start, because a placeholder inside a list item or a blockquote sits behind a `- ` or `> ` the converter itself added.
 * 3. Unknown is not an error. A node this table has never heard of renders its text content (inline children concatenated, block children blank-line
 *    separated) and a node with none renders nothing, so a new Atlassian node costs a description its formatting, never the description. For the same reason
 *    every malformed shape — a non-object child, a `content` that is not an array, a `text` that is not a string — folds into "nothing", and a nesting deeper
 *    than `MAX_DEPTH` stops there instead of overflowing the stack.
 *
 * Links are the one place output could do harm in the client, so an href outside `http(s):` and `mailto:` is dropped to its plain text here as well as by the
 * client's sanitising `marked` config (§6.3) — belt and braces, and cheap.
 */

/** Deepest nesting `adfToMarkdown` follows; anything below is dropped. Real descriptions nest a handful of levels — this is a stack guard, not a feature. */
const MAX_DEPTH = 64;

/**
 * The longest attachment name a placeholder carries, before escaping; a longer `alt` is cut to it. `escapeMarkdown` at most doubles a name, so the escaped
 * name is at most twice this — the bound `ADF_PLACEHOLDER_RE` writes into its name class. Without a bound on both sides the detector scanned to the end of
 * the line from every `[attachment: ` start, quadratic in a remote description.
 */
export const ADF_MEDIA_NAME_MAX = 128;

/**
 * A placeholder line, anywhere in a line (P7). Deliberately NOT global: Task 7 uses it as a `.test` detector, and a global regex keeps `lastIndex` between
 * calls and answers every other call wrong. A caller that needs every match builds `new RegExp(ADF_PLACEHOLDER_RE.source, 'g')`.
 */
export const ADF_PLACEHOLDER_RE = /\[(?:attachment(?:: [^\]\n]{0,256})?|(?:table|panel|expand) omitted)\]/;

/**
 * Backslash-escape the characters Markdown would otherwise act on in running text. `>`, `#` and `-` are left alone — they only mean something at a line
 * start.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<~]/g, '\\$&');
}

type AdfNode = { type?: unknown; text?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };

/** What a renderer may count into; one per `adfToMarkdown` call, so the converter stays re-entrant. */
type Ctx = { placeholders: number };

type Renderer = (node: AdfNode, ctx: Ctx, depth: number) => string;

const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);

const childrenOf = (node: AdfNode): AdfNode[] => (Array.isArray(node.content) ? node.content.filter(isNode) : []);

const attrsOf = (node: AdfNode): Record<string, unknown> => (isNode(node.attrs) ? (node.attrs as Record<string, unknown>) : {});

/** Nodes that live inside a line. A run of them is concatenated; anything else is a block and gets its own paragraph. */
const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention', 'emoji', 'date', 'status', 'inlineCard', 'mediaInline']);

function placeholder(ctx: Ctx, line: string): string {
  ctx.placeholders += 1;
  return line;
}

/** Inline children, concatenated. */
function inline(nodes: AdfNode[], ctx: Ctx, depth: number): string {
  return nodes.map((n) => render(n, ctx, depth)).join('');
}

/**
 * Block children, joined by `sep`: a run of consecutive inline nodes is one piece (so an unknown container holding bare text nodes does not split them
 * across paragraphs) and an empty piece is dropped (so an empty paragraph never leaves a triple newline).
 */
function blocks(nodes: AdfNode[], ctx: Ctx, depth: number, sep = '\n\n'): string {
  const pieces: string[] = [];
  let run: AdfNode[] = [];
  const flush = (): void => {
    if (run.length > 0) pieces.push(inline(run, ctx, depth));
    run = [];
  };
  for (const n of nodes) {
    if (typeof n.type === 'string' && INLINE_TYPES.has(n.type)) run.push(n);
    else {
      flush();
      pieces.push(render(n, ctx, depth));
    }
  }
  flush();
  return pieces.filter((p) => p !== '').join(sep);
}

/** `marker` on the first line of `body`, `indent` on the rest; a blank line stays blank. */
function hang(marker: string, indent: string, body: string): string {
  const lines = body.split('\n');
  return lines.map((l, i) => (i === 0 ? (l === '' ? marker.trimEnd() : marker + l) : l === '' ? '' : indent + l)).join('\n');
}

function list(ordered: boolean): Renderer {
  return (node, ctx, depth) => {
    const start = ordered && typeof attrsOf(node).order === 'number' ? Math.trunc(attrsOf(node).order as number) : 1;
    const items = childrenOf(node)
      .filter((c) => c.type === 'listItem')
      .map((item, i) => {
        const marker = ordered ? `${start + i}. ` : '- ';
        return hang(marker, ' '.repeat(marker.length), blocks(childrenOf(item), ctx, depth, '\n'));
      });
    return items.join('\n');
  };
}

const taskList: Renderer = (node, ctx, depth) => {
  const lines: string[] = [];
  for (const child of childrenOf(node)) {
    if (child.type === 'taskItem') {
      const box = attrsOf(child).state === 'DONE' ? '[x]' : '[ ]';
      lines.push(hang(`- ${box} `, '  ', blocks(childrenOf(child), ctx, depth, '\n')));
    } else if (child.type === 'taskList') {
      // ADF nests a sub-checklist as a sibling taskList, not inside its parent item.
      const nested = taskList(child, ctx, depth);
      if (nested !== '') lines.push(nested.replace(/^/gm, '  '));
    }
  }
  return lines.join('\n');
};

/** Only `http(s):` and `mailto:` survive; whitespace, parens and angle brackets are percent-encoded so an href can never end its own link early. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (!/^(?:https?:|mailto:)/i.test(h)) return null;
  return h.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** An inline code span, its backtick fence one longer than the longest run inside and padded when the content touches a backtick at an edge. */
function codeSpan(core: string): string {
  const longest = Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = core.startsWith('`') || core.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${core}${pad}${fence}`;
}

const text: Renderer = (node) => {
  const raw = typeof node.text === 'string' ? node.text : '';
  // Whitespace goes OUTSIDE the marks: `** b **` is not bold in Markdown. A whitespace-only run carries no marks at all. Sliced by `trimStart`/`trimEnd`,
  // not a regex: `/^(\s*)([\s\S]*?)(\s*)$/` backtracked O(n²) on an interior run (~1.4 s for 30 000 spaces), and `trim` strips exactly `\s`'s set.
  const start = raw.length - raw.trimStart().length;
  const end = raw.trimEnd().length;
  if (start >= end) return raw;
  const lead = raw.slice(0, start);
  const core = raw.slice(start, end);
  const trail = raw.slice(end);
  const marks = Array.isArray(node.marks) ? node.marks.filter(isNode) : [];
  const has = (type: string): boolean => marks.some((m) => m.type === type);
  let out = has('code') ? codeSpan(core) : escapeMarkdown(core);
  // One fixed nesting whatever order the marks arrive in: link outside strong outside em outside strike.
  if (has('strike')) out = `~~${out}~~`;
  if (has('em')) out = `_${out}_`;
  if (has('strong')) out = `**${out}**`;
  const link = marks.find((m) => m.type === 'link');
  const href = link ? safeHref(attrsOf(link).href) : null;
  if (href) out = `[${out}](${href})`;
  return `${lead}${out}${trail}`;
};

const media: Renderer = (node, ctx) => {
  const alt = attrsOf(node).alt;
  // A `]` or a newline in a file name would end the placeholder early (and defeat ADF_PLACEHOLDER_RE), so it is removed before the name is escaped.
  // Cut to ADF_MEDIA_NAME_MAX after the trim, so the escaped name stays inside the detector's bound.
  const name = typeof alt === 'string' ? alt.replace(/[\]\r\n]+/g, '').trim().slice(0, ADF_MEDIA_NAME_MAX).trimEnd() : '';
  return placeholder(ctx, name === '' ? '[attachment]' : `[attachment: ${escapeMarkdown(name)}]`);
};

const omitted =
  (what: string): Renderer =>
  (_node, ctx) =>
    placeholder(ctx, `[${what} omitted]`);

const RENDERERS: Record<string, Renderer> = {
  doc: (n, ctx, d) => blocks(childrenOf(n), ctx, d),
  paragraph: (n, ctx, d) => inline(childrenOf(n), ctx, d),
  heading: (n, ctx, d) => {
    const level = attrsOf(n).level;
    const hashes = '#'.repeat(typeof level === 'number' && level >= 1 ? Math.min(6, Math.trunc(level)) : 1);
    const body = inline(childrenOf(n), ctx, d).replace(/\n/g, ' ').trim();
    return body === '' ? '' : `${hashes} ${body}`;
  },
  bulletList: list(false),
  orderedList: list(true),
  taskList,
  codeBlock: (n) => {
    const body = childrenOf(n)
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join('');
    const lang = attrsOf(n).language;
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const info = typeof lang === 'string' ? lang.replace(/[^\w+#.-]/g, '') : '';
    return body === '' ? `${fence}${info}\n${fence}` : `${fence}${info}\n${body}\n${fence}`;
  },
  blockquote: (n, ctx, d) =>
    blocks(childrenOf(n), ctx, d)
      .split('\n')
      .map((l) => (l === '' ? '>' : `> ${l}`))
      .join('\n'),
  rule: () => '---',
  text,
  hardBreak: () => '\n',
  inlineCard: (n) => {
    const url = attrsOf(n).url;
    if (typeof url !== 'string' || url.trim() === '') return '';
    const href = safeHref(url);
    return href ? `[${escapeMarkdown(url.trim())}](${href})` : escapeMarkdown(url.trim());
  },
  mention: (n) => {
    const name = attrsOf(n).text;
    if (typeof name !== 'string' || name.trim() === '') return '';
    const bare = name.trim().replace(/^@/, '');
    return `@${escapeMarkdown(bare)}`;
  },
  emoji: (n) => {
    const a = attrsOf(n);
    const short = typeof a.shortName === 'string' ? a.shortName : typeof a.text === 'string' ? a.text : '';
    return escapeMarkdown(short);
  },
  date: (n) => {
    const raw = attrsOf(n).timestamp;
    // `Number('')` and `Number(null)` are 0 — a missing timestamp must not render as 1970-01-01.
    if ((typeof raw !== 'string' && typeof raw !== 'number') || raw === '') return '';
    const d = new Date(Number(raw));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  },
  status: (n) => {
    const t = attrsOf(n).text;
    return typeof t === 'string' ? escapeMarkdown(t) : '';
  },
  media,
  mediaInline: media,
  table: omitted('table'),
  panel: omitted('panel'),
  expand: omitted('expand'),
  nestedExpand: omitted('expand')
};

function render(node: AdfNode, ctx: Ctx, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  const renderer = typeof node.type === 'string' && Object.hasOwn(RENDERERS, node.type) ? RENDERERS[node.type] : undefined;
  // An unknown node renders its content: inline children concatenated, block children blank-line separated, nothing when it has none.
  return renderer ? renderer(node, ctx, depth + 1) : blocks(childrenOf(node), ctx, depth + 1);
}

/**
 * An ADF document (any shape — Jira's `description` is `null` on an empty ticket) → Markdown plus the number of placeholders it had to write. Anything that
 * is not an object, or has no renderable content, is `{ markdown: '', placeholders: 0 }`.
 */
export function adfToMarkdown(doc: unknown): { markdown: string; placeholders: number } {
  if (!isNode(doc)) return { markdown: '', placeholders: 0 };
  const ctx: Ctx = { placeholders: 0 };
  const markdown = blocks([doc], ctx, 0).trim();
  return { markdown, placeholders: markdown === '' ? 0 : ctx.placeholders };
}
