import { useEffect, useState } from 'react';
import { marked } from 'marked';

import type { BacklogItem, Section } from '../../../../shared/types';

const PILL: Record<Section, { cls: string; label: string }> = {
  bugs: { cls: 'pill-bug', label: 'bug' },
  ideas: { cls: 'pill-idea', label: 'idea' },
  tasks: { cls: 'pill-task', label: 'task' },
  'out-of-scope': { cls: 'pill-oos', label: 'oos' }
};

/**
 * Absolute-URL schemes a link may point at. A relative href (no scheme at
 * all — './x', '/x', '#x') always passes; this only gates hrefs that name a
 * scheme once whitespace is stripped (see `schemeOf`).
 */
const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Absolute-URL schemes an image src may use — none. This is a read-only
 * local board with no legitimate reason to make an outbound fetch to a third
 * party on a viewer's behalf, so http(s) is exactly as unwelcome here as
 * javascript:/data: is dangerous elsewhere: only a relative, same-origin-ish
 * path is ever actually requested.
 */
const ALLOWED_IMAGE_SCHEMES = new Set<string>();

/**
 * The scheme named at the start of a raw (pre-entity-decode) href, or
 * undefined for a relative reference. Whitespace is stripped first because
 * browsers ignore embedded tabs/newlines when sniffing a URL's scheme —
 * that's how a literal `java\tscript:` bypasses a naive check.
 */
function schemeOf(href: string): string | undefined {
  return href.replace(/\s/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
}

function isDisallowedScheme(href: string, allowed: ReadonlySet<string>): boolean {
  const scheme = schemeOf(href);
  return scheme !== undefined && !allowed.has(scheme);
}

/**
 * Minimal HTML escaping for anything hand-built markup below interpolates:
 * href/src/title attribute values, and the image-alt-text fallback. `&` is
 * the case that matters most — see the comment on `marked.use` — but a raw
 * `"` breaking out of an attribute, or a raw `<` starting a new tag, are
 * exactly as real, so all five characters get escaped together.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Item bodies are Markdown, but not *trusted* Markdown: they are LLM-written
 * from prompts that routinely carry pasted stack traces and copied HTML, and
 * `backlog/` travels with a repo — a body is exactly as trustworthy as
 * whatever the last prompt happened to paste in. The registry allowlist
 * (`server/src/items/allow.util.ts`) only decides which *paths* are
 * readable; it says nothing about the *bytes* inside them.
 *
 * marked renders raw HTML tokens verbatim and does not escape `&` in hrefs,
 * which turns the `dangerouslySetInnerHTML` below into a same-origin XSS
 * vector two different ways:
 *  - A body containing `<img src=x onerror=…>`, `<svg onload=…>`, a raw
 *    `<script>`, etc. would execute in this page outright.
 *  - A scheme can be hidden from a plain string/regex check by spelling it
 *    with HTML character references: `[x](&#106;avascript:alert(1))`,
 *    `[x](java&Tab;script:alert(1))`, `[x](javascript&#58;alert(1))` all read
 *    as "no scheme, therefore relative" at the point a scheme check runs,
 *    because the entities haven't been decoded yet. They get decoded later,
 *    when `dangerouslySetInnerHTML` hands the string to the *browser's own*
 *    HTML parser to build the DOM — which is exactly what turns `&#106;`
 *    into `j` and reassembles the `javascript:` scheme a naive check already
 *    let through. Enumerating entity spellings is not a fix (decimal, hex,
 *    leading zeros, named references like `&Tab;`/`&NewLine;` all decode to
 *    the same characters), and a reference-style link (`[x][r]` with a
 *    separate `[r]: <href>` definition) reaches this same renderer with the
 *    same problem once marked resolves the reference.
 *
 * The fix closes the mechanism instead of chasing spellings: every tag below
 * is hand-built rather than left to marked's default renderer, and every
 * href/src/title interpolated into one is escaped with `escapeHtml` — `&` in
 * particular. An entity in the *source* href — `&#106;avascript:` — has its
 * `&` turned into `&amp;` before the string ever reaches the browser's
 * parser, so decoding that attribute recovers a literal `&` followed by the
 * literal text `#106;avascript:`, not the letter `j`. No scheme character
 * has moved, so nothing downstream can reconstitute one, regardless of which
 * entity spelling tried to hide it. `isDisallowedScheme` still runs on the
 * raw, pre-escape href — it exists for the *other* case, a scheme spelled
 * out directly with no entities at all, which escaping alone doesn't touch.
 *
 * Configured once at module scope so every parse gets it, not just this
 * component's:
 *  - `html` drops every raw HTML token — block-level and inline both route
 *    through this one renderer method — so a pasted `<script>`, `<svg
 *    onload>`, `<iframe srcdoc>`, HTML comment, etc. renders as nothing
 *    rather than as markup, wherever it sits (list item, blockquote, table
 *    cell, heading, ...).
 *  - `link` renders a disallowed (or entity-hidden) scheme as plain text
 *    with no `<a>` at all; an allowed scheme gets a hand-built, escaped
 *    anchor rather than marked's default one.
 *  - `image` never lets a scheme through — see `ALLOWED_IMAGE_SCHEMES`. A
 *    disallowed src renders as the alt text instead of an `<img>`.
 */
marked.use({
  renderer: {
    html() {
      return '';
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (isDisallowedScheme(href, ALLOWED_LINK_SCHEMES)) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${titleAttr}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (isDisallowedScheme(href, ALLOWED_IMAGE_SCHEMES)) return escapeHtml(text);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    }
  }
});

/**
 * The right-hand detail drawer. Read-only on purpose — every write to an item
 * belongs to the skills, so the drawer renders and never edits.
 *
 * The body is fetched on open rather than carried in the index: the index is
 * refetched on every window focus, and shipping every body every time would
 * make that refresh pay for content nobody is looking at.
 */
export function ItemDrawer({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setFailed(false);
    fetch(`/api/items/body?path=${encodeURIComponent(item.path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((text) => {
        if (alive) setBody(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* marked is synchronous unless handed async extensions — none here. The
     HTML goes in via dangerouslySetInnerHTML below — safe not because these
     files are "local" (an item body is LLM-written, not vetted), but because
     the marked.use() above drops raw HTML outright and hand-builds every
     link/image tag with its href/src escaped, so neither a literal nor an
     entity-hidden scheme survives to reach the browser's own HTML parser. */
  const html = body === null ? '' : (marked.parse(body, { async: false }) as string);

  return (
    <>
      <div className="drawer-backdrop" data-testid="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={item.title}>
        <div className="drawer-head">
          <span className={`pill ${PILL[item.section].cls}`}>{PILL[item.section].label}</span>
          <span className="drawer-title">{item.title}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>
        <div className="drawer-meta">
          <span>
            {item.id} · {item.project} · {item.created}
            {item.status === 'done' ? ' · done' : ''}
            {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
          </span>
          <span className="drawer-path">{item.path}</span>
        </div>
        <div className="drawer-body">
          {failed ? (
            <div className="drawer-empty">item file unavailable</div>
          ) : body === null ? (
            <div className="drawer-empty">loading…</div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </aside>
    </>
  );
}
