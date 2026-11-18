# Jira mention replies: Markdown in, formatted ADF out, and a large reply editor

Date: 2026-11-18. Builds on [the Jira mentions design](2026-11-16-jira-mentions-design.md) and lifts its non-goal "The reply is plain paragraphs".

## Why

A reply drafted under **Jira › Mentions** posts as flat paragraphs. On TIMIFY-27770 the drafted reply (comment 116207) is six unbroken paragraphs under the
`@Boyan` mention, while the hand-posted research comment above it (116160) has headings, bold lead-ins, bullet and numbered lists, inline code and a table. A
reply that answers eight numbered points reads far worse as prose blocks, and the person posting it has no way to fix that from the board.

Two causes, both deliberate in the first design:

1. The reply session is told to "Write the reply as plain paragraphs" (`server/src/jira/prompt.util.ts`, `replyText`).
2. `replyDoc` (`server/src/jira/adf.ts`) maps the text to ADF paragraphs and `hardBreak`s only — "No Markdown is interpreted — a `*` is a `*`".

There is also a standing inconsistency: once a reply is posted, the mention modal shows it optimistically through `renderMarkdown`
(`client/src/components/jira/JiraMentionModal.tsx`, the `mine` comment), so the board already renders Markdown that Jira never receives.

The second complaint is reading and editing: the draft box is a 6-row textarea inside the mention modal's body column, too small to read or edit a reply of
the length these answers run to.

## Goals

- A reply's text is **Markdown**, and Post reply sends Jira the matching ADF: what the person sees in the preview is what lands in the thread.
- The reply session drafts in Markdown when structure helps (numbered answers, lists, a short table), plain prose when it does not.
- A **Reply editor** modal, opened from the draft box: Markdown on the left, the rendered comment on the right, live, at a size that reads comfortably.
- Post reply keeps every guarantee it has today: one door (`POST /api/jira/mentions/reply`), the leading mention node built from the cache's author, the
  `JIRA_REPLY_MAX_CHARS` cap, single-flight, the `unconfirmed` adopt-before-repost path.

## Non-goals

- A formatting toolbar, attachments, images, panels, expands, `@`-mentions typed in the body (a typed `@Name` stays text), editing a posted comment.
- Any change to the read side (`adfToMarkdown`, `adfToText`) beyond using it in tests.
- Any change to Jira writes other than the reply's body: no new route, no new outbound call.

## Anti-goals (a failure even if it works)

- A reply Jira refuses because the ADF is invalid. A Markdown construct the converter cannot map must **degrade to text**, never fail the post.
- A preview that promises formatting Jira will not get, on the constructs the converter claims to support.
- A link to a scheme outside `http`, `https`, `mailto` reaching Jira as a link.
- Losing the person's edits when moving between the draft box and the editor, or when closing the editor.

## Approaches

1. **Server-side Markdown → ADF on `marked`'s lexer — picked.** `marked` is already a runtime dependency (root `package.json`, used by the client's
   `renderMarkdown`), so the server can tokenise with `marked.lexer` and walk the tokens into ADF. Same Markdown dialect (GFM) as the preview renderer, so
   preview and post agree by construction on the supported set. Costs a converter of roughly 150–250 lines plus tests.
2. **A hand-written mini parser** for `**`, `-`/`1.` lists and `#`. Smaller, but breaks on nesting, `*` inside code and escapes, and reimplements what the
   lexer already does. Rejected.
3. **Jira wiki markup through the v2 comment API.** No converter, but the session would write Jira's own syntax (`*bold*`, `# item`), the board preview
   could not render it, the mention needs `[~accountid:…]`, and it adds a second comment format beside the ADF everything else uses. Rejected.

For the preview the person picked a **large modal with Write and Preview side by side** over a read-only preview (the sketch below).

## Design

### Converter (`server/src/jira/adf.ts`)

`replyDoc(to, text)` keeps its signature and its contract for the mention: the doc opens with one mention node of `to` (none when `accountId` is `''`),
followed by a space, inside the first paragraph. What changes is how `text` becomes blocks: it is lexed as GFM Markdown and mapped node by node.

Supported, with the ADF it maps to:

| Markdown                         | ADF                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- |
| paragraph                        | `paragraph`                                                            |
| single newline inside a paragraph | `hardBreak` (as today); the client renders the reply with `breaks: true` to match — see Preview rendering |
| `#`…`######` heading             | `heading` with `attrs.level`                                           |
| `**x**` / `__x__`                | `strong` mark                                                          |
| `*x*` / `_x_`                    | `em` mark                                                              |
| `~~x~~`                          | `strike` mark                                                          |
| `` `x` ``                        | `code` mark                                                            |
| `[t](url)`, GFM autolink         | `link` mark, href `http`/`https`/`mailto` only; any other href → the label as plain text, no mark; a link `title` is dropped |
| `-`/`*`/`+` list, `1.` list      | `bulletList` / `orderedList` (`attrs.order` set only when the start is not 1), nested |
| fenced or indented code          | `codeBlock` with `attrs.language` when given                          |
| `>` quote                        | `blockquote`                                                           |
| `---`                            | `rule`                                                                 |
| GFM table                        | `table` → `tableRow` → `tableHeader` / `tableCell`, each holding a paragraph |
| `\*` escapes                     | the literal character                                                  |
| `&amp; &lt; &gt; &quot; &#39;`, numeric `&#NNN;` / `&#xHH;` | the literal character (the converter decodes this set itself: `marked`'s lexer leaves references undecoded in text tokens); any other named entity posts as its source text, while the preview (the browser) decodes it — accepted |

Rules that keep the ADF valid (the anti-goal above):

- Anything not in the table — raw HTML, images, reference definitions, a token type a later `marked` adds — becomes **its source text** in a paragraph (or
  inline text), never an error and never dropped silently.
- Each container accepts only the children ADF allows it, and the converter checks every block against its container:
  - `doc`: paragraph, heading, bulletList, orderedList, codeBlock, blockquote, rule, table.
  - `listItem`: paragraph, bulletList, orderedList, codeBlock — and its first child is always a paragraph (an empty one if the item starts with anything
    else).
  - `blockquote`: paragraph, bulletList, orderedList, codeBlock. A nested quote is flattened into the outer one's children.
  - `tableHeader` / `tableCell`: one paragraph of the cell's inline content (GFM cells are inline only); an empty cell gets one empty paragraph.
  - `codeBlock`: text only, no marks; an empty block has no content array entries.
- **Generic fallback:** a block its container does not allow becomes paragraphs there — a heading becomes one paragraph whose text carries `strong`; a
  rule becomes a paragraph `---`; a table becomes one paragraph per row, cells joined with ` | `. A GFM task-list item (`- [ ] x`) is a plain list item
  whose text starts with `[ ] ` / `[x] `.
- A text node is never empty (ADF rejects `text: ''`); an inline run that would be empty is left out.
- Marks follow ADF's combination rules: `code` combines with `link` only, so `**`x`**` keeps `code` and drops `strong`.
- When the first block is not a paragraph (the reply opens with a heading or a list), the mention gets a paragraph of its own before it.
- Text that trims to nothing still yields the mention alone (`[{ type: 'paragraph', content: [] }]` for an author with no account id, as today); the route
  still refuses blank text before this point.
- The cap stays on the **Markdown source** (`JIRA_REPLY_MAX_CHARS`, 8000), checked by the route and the client as today.

The narrow write types (`AdfDoc`, `AdfBlock`, `AdfInline`) grow to name exactly the nodes and marks above — still separate from the read side's loose
`AdfNode`, per the file's header. The header's "One WRITE sits at the bottom" paragraph and `replyDoc`'s doc comment are rewritten to say Markdown.

This is the server's first import of `marked`. `marked` 16 is ESM-only and the server compiles to CommonJS; it loads through `require(esm)` on the Node the
repo pins (`package.json` `engines`, `Dockerfile`) and through the existing UMD mapping under jest (`jest.config.ts`). The builder confirms both with one
run of each before writing the converter.

### Prompt (`server/src/jira/prompt.util.ts`)

`replyText` drops "plain paragraphs" and says the reply is Markdown: headings, bold, lists, inline code, links and small tables render in Jira; use them when
the answer has structure (numbered points, a list of decisions), plain paragraphs when it does not; still no leading `@`-mention, still hand over with
`jira.mjs draft`. `skills/jira/SKILL.md`'s `draft` paragraph says the text is Markdown. The prompt stays under the 1500-character cap the existing
reply-prompt tests pin (`test/jira/jira-prompt.test.ts`), and one new assertion pins that it names Markdown. The `SKILL.md` edit reaches running sessions
only after commit, push and `pnpm run plugin:sync` (held for the person under autopilot).

### Draft box and Reply editor (`client/src/components/jira/JiraMentionModal.tsx`)

The draft box keeps its textarea and footer. It gains one 28 px `Chip`, **Open editor**, in the footer's action group before Redraft. The box and the editor
edit **one** text: `DraftReply` keeps owning the text state (and its seed / "newer draft" logic) and renders the editor as its own child, passing the text
and its setter down, so what is typed in either shows in the other and closing the editor keeps it. Because the editor is `DraftReply`'s child, it closes
whenever the box unmounts (the draft is posted, discarded or replaced by a Redraft run) — the same moments the box disappears today; Redraft and Discard
are not in the editor, so only an outside change can do that while it is open.

**Where the editor's DOM goes.** `Modal` draws its scrim and panel in place, and the mention panel (`.ui-modal`) has `transform` and `overflow: hidden`,
so a `Modal` rendered inside `DraftReply` would be positioned against, and clipped to, the mention panel. The editor therefore renders through
`createPortal` into the `.shell` element (`App.tsx`), found from the draft box's own DOM node (`closest('.shell')`), so it stays inside the zoomed shell —
its sizes divide by `--font-scale` like every modal's — while escaping the mention panel. React state and events still flow through `DraftReply`. It
stacks above the mention modal by a modifier class on the shell (`.ui-modal-over`: scrim z 62, panel z 63, over the mention modal's 60 / 61).

The editor is a `Modal` opened over the mention modal — the shell's fourth composer, which `Modal.tsx`'s header and DESIGN.md §8.7 must now name (the header
says a fourth composer "is a design change, not a reuse"; this spec is that change). It uses the split shape (`head`, `lead` false — an even split): the
head reads `Reply to <KEY>` and, when the author is known, a second line `To @<name>` (omitted when `to` is null); the facts slot is **Write** (the
textarea, filling the column's height), the body is **Preview** (see Preview rendering, styled as a thread comment). Blank text previews as one muted line,
`Nothing to preview yet.`

The dialog's `label` is `Reply editor for <KEY>`; its textarea's accessible name is `Edit reply to <name or KEY>`, distinct from the box's
`Reply to <name or KEY>` so both can be mounted and queried apart.

`Modal` gains two optional props, neither passed by an existing composer, so nothing else changes: `foot`, drawn as a full-width band under both columns
in the split shape (and under the body in the sidecar), and `over`, which adds `.ui-modal-over` to its scrim and panel (the stacking above). The editor's foot carries the `n / 8000` counter, **Close** and **Post reply** (ink). Post reply has exactly
the box's enablement: disabled while `busy`, on blank text and past the cap. Post reply from the editor does exactly what the box's does and closes the
editor on success; a refusal shows its alert line in the editor's foot and keeps it open. A newer draft arriving while the editor is open shows the box's
`A newer draft arrived · Use it` note at the top of the Write column too, driven by the same state. Escape closes the editor only (`useDialogEscape`'s LIFO
stack). Under 700 px the shell folds as it does everywhere: Write above Preview. The editor component's header comment cites DESIGN.md §8.9.7.

### Preview rendering

The editor's preview and the posted `mine` comment (`JiraMentionModal.tsx`, today `@${posted.to} ${posted.text}`) go through one client helper that mirrors
`replyDoc`'s two rules, so what is previewed is what posts:

- **Mention placement:** when the text's first block is a paragraph, the source is `@<name> ` + text; otherwise (a heading, list, quote, code block,
  table or rule first) it is `@<name>` + a blank line + text, so the mention is its own paragraph as in `replyDoc`. No mention when `to` is null.
- **Line breaks:** rendered with `breaks: true`, so a single newline shows as the line break Jira will get. `renderMarkdown` gains an optional options
  argument for this; its other callers pass none and render exactly as today.

The leading `@<name>` is then chipped by `chipMentions`, as thread comments are.

Sketch the person picked:

```
┌─ Reply to TIMIFY-27770 ─────────────────────────── ✕ ┐
│ To @Boyan                                             │
├───────────────────────────────────────────────────────┤
│ Write                    │ Preview                    │
│ ┌──────────────────────┐ │ @Boyan Thanks Boyan, that  │
│ │### Answers           │ │ Answers                    │
│ │- **Limits:** agreed  │ │ • Limits: agreed           │
│ │- **Order:** check →  │ │ • Order: check → render    │
│ │  render → record     │ │   → record                 │
│ └──────────────────────┘ │                            │
├──────────────────────────┴────────────────────────────┤
│ 2140 / 8000            Close          [ Post reply ]  │
└───────────────────────────────────────────────────────┘
```

### Docs

- `.claude/DESIGN.md` §8.7 (four composers, the `foot` slot) and §8.9.7 (the draft box's Open editor, the editor itself), and every place DESIGN.md says
  the mentions work adds no new dialog.
- The editor is a **tenth dialog** on the Escape stack, so every place that pins nine moves to ten and names the editor: `.claude/rules/board.md` (the
  Escape bullet's count and `Modal`'s composer list), `docs/subsystems/invariants.md` (the Escape entry), `client/src/hooks/useDialogEscape.ts`'s comment,
  and the guard `test/guards/dialog-count-docs.test.ts`.
- `.claude/rules/jira.md`: the reply paragraph's description of `replyDoc`'s ADF.
- `docs/superpowers/specs/2026-11-16-jira-mentions-design.md`: the non-goal line points here.

## Testing

- `test/jira/jira-adf.test.ts`: the seven existing `replyDoc` cases stay and must keep passing (none uses Markdown syntax). New: one case per row of the
  table, each container's allowed children and the generic fallback, the mention-before-heading rule, link scheme filtering, no empty text node. A
  **round trip** — for a fixture that opens with a paragraph, is written in the read side's canonical spelling (`**x**`, `_x_`, `-` bullets) and uses
  every supported construct except tables, GFM autolinks and entities, `adfToMarkdown(replyDoc(to, md)).markdown` equals `@<name> ` + the source.
  Autolinks (read back as `[url](url)`) and entities (read back decoded) are asserted on their ADF directly. Tables are too, because the read side
  renders a table as `[table omitted]` and this spec does not change the read side — so a posted table reads back on the board's thread view as that
  placeholder, accepted.
- `test/jira/jira-mentions-routes.test.ts`: one Post reply with Markdown asserts the body Jira receives carries `heading`/`bulletList`/`strong`.
- Client (jsdom): Open editor opens the editor; typing in it updates the box; Close keeps the text; Escape closes only the editor; Post reply from the
  editor posts the shared text; Post reply disabled while busy; the newer-draft note shows in the editor; the preview renders a list and a heading; a
  reply opening with a heading previews the mention as its own paragraph; a single newline previews as `<br>`; `renderMarkdown` without options is
  unchanged (a single newline is no `<br>`).
- `test/guards/dialog-count-docs.test.ts` moves to ten.
- jsdom: the editor's dialog is not a descendant of the mention modal's `.ui-modal` (it is portalled into `.shell`).
- `/ui-verify` last: the editor at 1440 px and at 699 px (the folded side of the 700 px boundary) against the sketch, light theme.

## Left to the builder

- Exact class names and CSS for the editor's columns and footer, within DESIGN.md's tokens.
- Whether the converter lives in `adf.ts` or a sibling `adf-write.ts` (the read side is already long); either way `replyDoc` stays exported from `adf.ts`.
- The precise prompt wording, within the rule above.

## Calls I made (for the reader to check)

- GFM tables are supported, because the comment that prompted this has one and `marked` lexes them for free.
- A single newline stays a `hardBreak` (as today), not a soft wrap, so a reply edited in the textarea posts with the breaks the person typed.
- The preview uses the client's `renderMarkdown` (with `breaks: true` and the shared mention rule), not a server round trip. Both sides read the same GFM
  dialect through `marked`, and the converter's tests pin the server side per construct; an unsupported construct (an image, raw HTML, a relative or
  protocol-relative link, which the preview keeps as a link and the converter posts as text) may preview differently from how it posts — accepted.
- `Modal` gains a `foot` slot rather than the editor drawing its own footer inside a column, so the counter and Post reply sit under both columns as sketched.
- The editor is a fourth `Modal` composer rather than a new shell.
