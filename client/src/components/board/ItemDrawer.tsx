import { useEffect, useState } from 'react';
import { marked } from 'marked';

import { elapsedSince, formatSeconds } from '../../lib/item-age';
import { isInProgress } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * Absolute-URL schemes a link may point at. A relative href (no scheme at
 * all — './x', '/x', '#x') always passes; this only gates hrefs that name a
 * scheme, or that borrow this page's own — see `isAllowedTarget`.
 */
const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Absolute-URL schemes an image src may use — none. This is a read-only
 * local board with no legitimate reason to make an outbound fetch to a third
 * party on a viewer's behalf, so http(s) is exactly as unwelcome here as
 * javascript:/data: is dangerous elsewhere: only a same-origin-relative path
 * is ever actually requested. Being empty is also what rules out a
 * protocol-relative `//host/...` src, which names no scheme but borrows
 * http(s) from the page — see `isAllowedTarget`.
 */
const ALLOWED_IMAGE_SCHEMES = new Set<string>();

/** How a browser will read a rendered href/src. */
type Target =
  | { kind: 'relative' }
  | { kind: 'protocol-relative' }
  | { kind: 'scheme'; scheme: string };

/**
 * Classify an href the way the *browser's* URL parser will — the only
 * reading that matters, since it is that parser, not this file, that decides
 * what actually gets fetched.
 *
 * Every classification below starts from one normalized string, and that is
 * the entire reason this function exists. It replaces two sibling guards that
 * each normalized the same href their own way — one stripped whitespace
 * before sniffing a scheme, the other mapped backslashes before testing for
 * `//` — so an href spelled with the *other* one's blind spot walked
 * through. `![l](<TAB//evil.example/p.png>)` is the proof: an angle-bracket
 * destination keeps its interior whitespace, marked hands the tab over
 * verbatim, a `startsWith('//')` test says "that starts with a tab, not a
 * slash", and the URL parser then deletes the tab and fetches from
 * evil.example. Normalizing once, here, is what stops the next spelling from
 * being a fourth round of this.
 *
 * The normalization mirrors what that parser does before it decides anything:
 * it deletes tab/LF/CR wherever they appear and trims leading/trailing C0
 * controls and spaces. This deletes a wider set — every whitespace and
 * control character, in every position — because erring wide can only
 * *block* (a form feed mid-path renders as alt text instead of an image),
 * while erring narrow is the bug above.
 *
 * Backslashes fold into slashes for the authority test only, never for the
 * scheme test, because that is exactly where a browser folds them: under a
 * "special" scheme (http/https among them) `/\host`, `\\host` and `\/host`
 * all reach the same host as `//host`, but a backslash inside a scheme name
 * only stops it from being a scheme at all.
 */
function classifyTarget(href: string): Target {
  const bare = href.replace(/[\s\p{Cc}]/gu, '');
  const scheme = bare.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (scheme !== undefined) return { kind: 'scheme', scheme: scheme.toLowerCase() };
  if (/^[\\/]{2}/.test(bare)) return { kind: 'protocol-relative' };
  return { kind: 'relative' };
}

/**
 * The single policy gate, so `link` and `image` can never again disagree
 * about what an href says — they differ only in the allowlist they pass.
 */
function isAllowedTarget(href: string, allowed: ReadonlySet<string>): boolean {
  const target = classifyTarget(href);
  if (target.kind === 'scheme') return allowed.has(target.scheme);
  // A protocol-relative reference names no scheme of its own, it inherits
  // whichever one this page was served under — so it is allowed only when
  // every scheme the page could be served under is. Links allow both http and
  // https, so `//host` stays a link; the image allowlist is empty, so it never
  // becomes a real third-party fetch.
  if (target.kind === 'protocol-relative') return allowed.has('http') && allowed.has('https');
  return true;
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
 *    with no `<a>` at all; an allowed one gets a hand-built, escaped anchor
 *    rather than marked's default.
 *  - `image` allows no scheme at all — see `ALLOWED_IMAGE_SCHEMES` — so a
 *    disallowed src renders as its alt text instead of an `<img>`.
 *  - Both ask `isAllowedTarget` the same question about the same normalized
 *    href, differing only in which allowlist they hand it.
 */
marked.use({
  renderer: {
    html() {
      return '';
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!isAllowedTarget(href, ALLOWED_LINK_SCHEMES)) return text;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${titleAttr}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (!isAllowedTarget(href, ALLOWED_IMAGE_SCHEMES)) return escapeHtml(text);
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
export function ItemDrawer(
  { item, hues, onClose, agents, onDispatch, runBlock, reverify }: {
    item: BacklogItem;
    hues: ProjectHues;
    onClose: () => void;
    /** null until the status probe answers; absent when the board is rendered
     *  without dispatch at all (older tests, and any future read-only view). */
    agents?: AgentsStatus | null;
    onDispatch?: () => void;
    /**
     * Why an orchestrator run forbids dispatching this item, or null/undefined
     * when none does — passed straight through to `DispatchButton`, and looked
     * up by BoardView from the same run payload the card's own copy of this
     * prop comes from. Both render sites need it: they render two independent
     * buttons for one item, and a drawer chip that stayed live while the card
     * tab went dead is half of the bug this exists to fix.
     */
    runBlock?: string | null;
    /** Re-ask the dashboard status, resolving to the fresh answer — passed
     *  straight through to `DispatchButton` (bug-13). Both render sites need
     *  it for the same reason they both need `runBlock`: the drawer chip and
     *  the card tab are two independent buttons for one item, and a chip that
     *  stayed unrecoverably disabled while the tab could clear itself would be
     *  the same contradiction on two surfaces. */
    reverify?: () => Promise<AgentsStatus>;
  }
) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /* The shared predicate, not a local copy of its two conditions — see
     item-progress.ts for why it is two and not one. This drawer and the card
     render the same claim about the same item side by side, so the day the
     rule grows a third condition (a stamp past some age no longer counting as
     live, say) they have to grow it together or the board will contradict
     itself about one item on two surfaces at once.
     Read once per render rather than twice inside the JSX below, where the
     null-check and the value would each call it. No injected clock, unlike the
     card: the drawer is opened, read and closed, so a reading that aged in place
     while it sat open would be motion for its own sake. */
  const inProgress = isInProgress(item);
  const elapsed = inProgress ? elapsedSince(item.started) : null;

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
          {/* Same pill the card carried, same hue — one shared helper rather
              than a second table here, so a card and the drawer it opens can
              never disagree. The drawer has no column to state the type, but
              the id's prefix on the meta line below still does. */}
          <span className={`pill ${hues.classFor(item.project)}`}>{item.project}</span>
          <span className="drawer-title">{item.title}</span>
          {onDispatch && (
            <DispatchButton
              item={item} status={agents ?? null} onDispatch={onDispatch} runBlock={runBlock}
              reverify={reverify}
            />
          )}
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>
        <div className="drawer-meta">
          <span>
            {/* Project lives in the pill above, not twice. */}
            {item.id} · {item.created}
            {/* Plain text, like the `done` marker beside it — the card has room
                only for an elapsed reading, so the drawer is where the stored
                value belongs: "in progress 47d" invites "since when", and the
                answer is here. Both halves, because they answer different
                questions — the elapsed is what a person reads, the parenthetical
                is the exact bytes on disk, which is what anyone reconciling a
                card against the file actually needs. The reading drops out on a
                value that cannot be aged (a hand-edited file), leaving the words
                and the verbatim value rather than printing NaN.
                Gated on status the same way the card is, so an archived item
                reads as done rather than as still being worked. */}
            {inProgress
              ? ` · ◍ in progress${elapsed === null ? '' : ` ${elapsed}`} (since ${item.started})`
              : ''}
            {item.status === 'done' ? ' · done' : ''}
            {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
            {/* Accumulated time, unlike the in-progress segment above, is NOT
                gated on `inProgress` or `item.status`: it is history, not a
                live reading, and `move` never rewrites an item's content, so
                a done item's billed seconds are exactly as true after
                archiving as before. Each bucket renders independently — an
                item can carry either, both, or neither — and a zero bucket
                is silent rather than printing "groomed for 0s", since `0` is
                also what an item that was never groomed or executed carries
                (see BacklogItem.groomElapsed/executeElapsed in
                shared/types.ts): there is nothing true to say about it. */}
            {item.groomElapsed > 0 ? ` · groomed for ${formatSeconds(item.groomElapsed)}` : ''}
            {item.executeElapsed > 0 ? ` · worked for ${formatSeconds(item.executeElapsed)}` : ''}
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
