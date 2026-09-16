import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { marked } from 'marked';

import { elapsedSince, formatSeconds } from '../../lib/item-age';
import { isInProgress } from '../../lib/item-progress';
import type { ProjectHues } from '../../lib/project-hue';
import { Dot } from '../ui/Dot';
import { Modal } from '../ui/Modal';
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
type Target = { kind: 'relative' } | { kind: 'protocol-relative' } | { kind: 'scheme'; scheme: string };

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
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
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
 * One fact in the modal's facts column: a 11/500 label over its value.
 *
 * A component rather than nine hand-written pairs, because a fact that is
 * absent must draw NOTHING — no label, no empty value, no stray separator —
 * and "absent" is a different question per fact (an empty string for a date, a
 * `null` for `groomed`, a zero for a counter). Each call site answers its own
 * question and this renders only what survived it.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="item-fact">
      <dt className="item-fact-label">{label}</dt>
      <dd className="item-fact-value">{children}</dd>
    </div>
  );
}

/**
 * Integers with thousands separators, pinned to `en-US` rather than the
 * viewer's locale — `run-stats.ts`'s `formatUsd` states the reason this board
 * keeps making the same choice: two people looking at the same item should
 * read the same string, and a locale-driven `toLocaleString` gives one of them
 * `1.234.567`.
 */
function groupDigits(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * ItemModal — the item's detail, and the ONE modal this app draws
 * (.claude/DESIGN.md §8.7, the design spec's §6.1 and §12.3).
 *
 * It composes `Modal`, which owns the scrim, the exit, the Escape key and the
 * 700 px shape; this file owns what goes in the two slots. Read-only on
 * purpose — every write to an item belongs to the skills, so this renders and
 * never edits.
 *
 * It was `ItemDrawer`, a panel pinned to the right edge, until task-40. The
 * facts it drew as one run-on meta line are a facts COLUMN now, one labelled
 * row each, which is what 290 px of column buys over 480 px of panel: the same
 * readings, none dropped, and each one findable without parsing a sentence.
 * Three of the facts §6.1 lists — `section`, `updated`/`last commit`, and the
 * token counters — were in `BacklogItem` all along and were the casualties of
 * that one-line shape; they are drawn here rather than left out, which is why
 * this is not quite a like-for-like move.
 *
 * The body is fetched on open rather than carried in the index: the index is
 * refetched on every window focus, and shipping every body every time would
 * make that refresh pay for content nobody is looking at.
 */
export function ItemModal({
  item,
  hues,
  onClose,
  agents,
  onDispatch,
  runBlock,
  reverify
}: {
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
   * buttons for one item, and a modal chip that stayed live while the card
   * tab went dead is half of the bug this exists to fix.
   */
  runBlock?: string | null;
  /** Re-ask the dashboard status, resolving to the fresh answer — passed
   *  straight through to `DispatchButton` (bug-13). Both render sites need
   *  it for the same reason they both need `runBlock`: the modal's chip and
   *  the card tab are two independent buttons for one item, and a chip that
   *  stayed unrecoverably disabled while the tab could clear itself would be
   *  the same contradiction on two surfaces. */
  reverify?: () => Promise<AgentsStatus>;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /* The shared predicate, not a local copy of its two conditions — see
     item-progress.ts for why it is two and not one. This modal and the card
     render the same claim about the same item side by side, so the day the
     rule grows a third condition (a stamp past some age no longer counting as
     live, say) they have to grow it together or the board will contradict
     itself about one item on two surfaces at once.
     Read once per render rather than twice inside the JSX below, where the
     null-check and the value would each call it. No injected clock, unlike the
     card: the modal is opened, read and closed, so a reading that aged in place
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

  /* marked is synchronous unless handed async extensions — none here. The
     HTML goes in via dangerouslySetInnerHTML below — safe not because these
     files are "local" (an item body is LLM-written, not vetted), but because
     the marked.use() above drops raw HTML outright and hand-builds every
     link/image tag with its href/src escaped, so neither a literal nor an
     entity-hidden scheme survives to reach the browser's own HTML parser. */
  const html = body === null ? '' : (marked.parse(body, { async: false }) as string);

  const facts = (
    <div className="item-facts">
      {/* The project reads as a dot plus its name (§6.1) rather than as the
          filled pill the card used to draw here: a pill is a status
          micro-label, and the project is an identity. The hue is the same
          assignment the card's dot takes, from the one helper, so a card and
          the modal it opens can never disagree about a colour. */}
      <div className="item-facts-proj">
        <Dot hue={hues.hueFor(item.project)} size={10} />
        <span className="item-facts-proj-name">{item.project}</span>
      </div>
      <dl className="item-facts-list">
        <Fact label="id">{item.id}</Fact>
        <Fact label="section">{item.section}</Fact>
        {item.created !== '' && <Fact label="created">{item.created}</Fact>}
        {/* Verbatim, all three of them, and never collapsed into `lastTouched`'s
            one answer: that derivation exists to decide Board versus Archive,
            and this column is the surface someone reconciling a card against
            the bytes on disk comes to. Which rung won is their question to ask;
            printing only the winner would answer it for them, wrongly, on any
            item whose `updated` is silent because a groom edited the file
            without `start`. */}
        {item.updated !== '' && <Fact label="updated">{item.updated}</Fact>}
        {item.lastCommit !== '' && <Fact label="last commit">{item.lastCommit}</Fact>}
        {/* `null` is a reading, not a missing value: an idea, a refactor and an
            out-of-scope item have no groomed state at all (CLAUDE.md —
            "grooming is not a state they have"), so the row is absent rather
            than saying `no`, which would be a claim about them that is false. */}
        {item.groomed !== null && <Fact label="groomed">{item.groomed ? 'yes' : 'no'}</Fact>}
        {item.tags.length > 0 && <Fact label="tags">{item.tags.join(', ')}</Fact>}
        {/* Both halves, because they answer different questions — the elapsed
            is what a person reads, the parenthetical is the exact bytes on
            disk, which is what anyone reconciling a card against the file
            actually needs. The reading drops out on a value that cannot be aged
            (a hand-edited file), leaving the stored value alone rather than
            printing NaN. Gated on `isInProgress` the same way the card is, so
            an archived item reads as done rather than as still being worked. */}
        {inProgress && <Fact label="in progress">{elapsed === null ? `(since ${item.started})` : `${elapsed} (since ${item.started})`}</Fact>}
        {item.status === 'done' && <Fact label="status">done</Fact>}
        {/* Accumulated time and tokens, unlike the in-progress row above, are
            NOT gated on `inProgress` or `item.status`: they are history, not a
            live reading, and `move` never rewrites an item's content, so a done
            item's billed seconds are exactly as true after archiving as before.
            Each counter renders independently — an item can carry any subset —
            and a zero is silent rather than printing `0s`, since `0` is also
            what an item that was never groomed or executed carries (see
            BacklogItem.groomElapsed/groomTokens in shared/types.ts): there is
            nothing true to say about it. */}
        {item.groomElapsed > 0 && <Fact label="groomed for">{formatSeconds(item.groomElapsed)}</Fact>}
        {item.executeElapsed > 0 && <Fact label="worked for">{formatSeconds(item.executeElapsed)}</Fact>}
        {item.groomTokens > 0 && <Fact label="groom tokens">{groupDigits(item.groomTokens)}</Fact>}
        {item.executeTokens > 0 && <Fact label="execute tokens">{groupDigits(item.executeTokens)}</Fact>}
        <Fact label="file">
          <span className="item-facts-path">{item.path}</span>
        </Fact>
      </dl>
      {onDispatch && (
        <div className="item-facts-dispatch">
          <DispatchButton item={item} status={agents ?? null} onDispatch={onDispatch} runBlock={runBlock} reverify={reverify} />
        </div>
      )}
    </div>
  );

  return (
    <Modal label={item.title} facts={facts} onClose={onClose}>
      <h2 className="item-body-title">{item.title}</h2>
      <div className="item-body">
        {failed ? (
          <div className="drawer-empty">item file unavailable</div>
        ) : body === null ? (
          <div className="drawer-empty">loading…</div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </Modal>
  );
}
