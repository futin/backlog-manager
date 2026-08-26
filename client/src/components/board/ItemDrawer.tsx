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
 * Absolute-URL schemes an item body is allowed to link out to. A relative
 * href (no scheme at all — './x', '/x', '#x') is always safe and passes
 * straight through unexamined; this only gates hrefs that name a scheme.
 */
const ALLOWED_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function hasDisallowedScheme(href: string): boolean {
  // Browsers ignore embedded whitespace when sniffing a URL's scheme (that's
  // how `java\tscript:` bypasses a naive check), so strip it before matching.
  // No scheme match at all means relative — nothing to strip it down to.
  const scheme = href.replace(/\s/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  return scheme !== undefined && !ALLOWED_HREF_SCHEMES.has(`${scheme.toLowerCase()}:`);
}

/**
 * Item bodies are Markdown, but not *trusted* Markdown: they are LLM-written
 * from prompts that routinely carry pasted stack traces and copied HTML, and
 * `backlog/` travels with a repo — a body is exactly as trustworthy as
 * whatever the last prompt happened to paste in. The registry allowlist
 * (`server/src/items/allow.util.ts`) only decides which *paths* are
 * readable; it says nothing about the *bytes* inside them.
 *
 * marked renders raw HTML tokens and non-http(s) link hrefs verbatim by
 * default, which turns the `dangerouslySetInnerHTML` below into a same-origin
 * XSS vector: a body containing `<img src=x onerror=…>` or `[x](javascript:…)`
 * would execute in this page and could call the same `/api/*` endpoints this
 * drawer itself uses, for every registered project. Configured once at module
 * scope so every parse gets it, not just this component's:
 *  - `html` drops every raw HTML token — block-level and inline both route
 *    through this one renderer method — so a pasted `<script>` or
 *    `<img onerror>` renders as nothing rather than as markup.
 *  - `link` swaps a disallowed scheme for plain text with no `<a>` at all —
 *    the same fallback marked's own renderer uses when a URL fails to clean —
 *    instead of a clickable `javascript:`/`data:`/etc. href. Returning
 *    `false` for an allowed scheme defers to marked's built-in renderer, so
 *    the href-cleaning and attribute-escaping it already does for
 *    http(s)/mailto links is untouched.
 */
marked.use({
  renderer: {
    html() {
      return '';
    },
    link({ href, tokens }) {
      return hasDisallowedScheme(href) ? this.parser.parseInline(tokens) : false;
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
     the marked.use() above strips raw HTML and disallowed-scheme hrefs from
     every parse before this component ever sees the resulting string. */
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
