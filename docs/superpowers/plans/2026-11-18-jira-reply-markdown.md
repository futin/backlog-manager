# Jira mention replies in Markdown, with a reply editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mentions reply is Markdown; Post reply sends Jira the matching ADF; a large Write/Preview editor modal opens from the draft box.

**Architecture:** `replyDoc` lexes the reply with `marked` and walks GFM tokens into a validated ADF subset, degrading anything else to text. The client
previews through `renderMarkdown` with `breaks: true` and one mention-placement rule shared with the posted-comment view. The editor is a fourth `Modal`
composer, portalled into `.shell` and stacked over the mention modal.

**Tech Stack:** NestJS (CommonJS) server, React 18 client, `marked` 16, jest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-18-jira-reply-markdown-design.md` — read it in full before any task; its tables and rules are the contract.

**This plan states behaviour, signatures and exact test cases, never literal implementation code** (global rule: handed code gets transcribed verbatim, so
a plan bug becomes a branch bug). Disagree with the plan where the code says otherwise, and say so in the task's report. Size is a soft budget.

## Global Constraints

- Wrap new prose and comments at 160 columns; match the files' existing comment density (comments explain why, at length).
- `JIRA_REPLY_MAX_CHARS` stays 8000 and counts the Markdown source.
- Allowed link schemes: `http`, `https`, `mailto`.
- The reply prompt stays under 1500 characters (`test/jira/jira-prompt.test.ts:628`).
- No new route, no new outbound call; `POST /api/jira/mentions/reply` stays the one door.
- Copy, exact: chip `Open editor`; dialog label `Reply editor for <KEY>`; head `Reply to <KEY>` and `To @<name>` (omitted when `to` is null); editor
  textarea accessible name `Edit reply to <name or KEY>`; empty preview `Nothing to preview yet.`; footer `Close`, `Post reply`, counter `<n> / 8000`.
- Read `.claude/rules/jira.md` before Task 1–2, `.claude/rules/board.md` before Task 3–6, `.claude/rules/tests.md` before any test edit,
  `.claude/rules/dispatch-watchdog.md` before editing `server/src/jira/prompt.util.ts`, `.claude/rules/skills.md` before `skills/jira/SKILL.md`.
- Run only the suites a task touches; CI runs the full suite. Before the last commit, `grep -l` each symbol a task adds a caller of in `test/` and run
  every hit (CLAUDE.md, "Touched includes the source guards").

## Review Focus

1. A reply that is only a heading or only a list (no paragraph at all) — the mention must still lead, as its own paragraph, in ADF and in the preview.
2. Prose an LLM writes that is accidentally Markdown — `snake_case_name`, `2 * 3 * 4`, a line starting `1)` or `#123` — must post as the person sees it in
   the preview, not as surprise formatting the preview did not show.
3. A long reply near 8000 characters in the editor: both columns scroll on their own, the foot stays visible, nothing overflows horizontally.
4. Escape and scrim clicks with the editor open: only the editor closes; the mention modal and the shared text survive.
5. Text scale other than 100 % (`fontScale` 80 and 130): the portalled editor sizes inside the viewport like every other modal.

---

### Task 1: Markdown → ADF in `replyDoc`

**Files:**
- Modify: `server/src/jira/adf.ts` (header's "One WRITE" paragraph; write types `AdfInline`/`AdfBlock`/`AdfDoc`; `replyDoc` and its doc comment). If the write
  side grows past ~200 lines, move it to `server/src/jira/adf-write.ts` and re-export `replyDoc` and the write types from `adf.ts`.
- Test: `test/jira/jira-adf.test.ts` (the `describe('replyDoc')` block), `test/jira/jira-mentions-routes.test.ts`

**Interfaces:**
- Produces: `replyDoc(to: { accountId: string; name: string }, text: string): AdfDoc` — signature unchanged; `AdfDoc` now admits the node and mark set of
  the spec's table.

- [ ] **Step 1: Confirm `marked` loads in both places.** One throwaway `require('marked')` through the server build (`pnpm run build` then `node -e` on the
  built module, or `pnpm run dev` start) and one jest run of `test/jira/jira-adf.test.ts`. Expected: both load. If the server cannot load it, stop and report.
- [ ] **Step 2: Write the failing tests.** Keep the seven existing `replyDoc` cases untouched. Add, each asserting the exact ADF `content` (mention `MARA`
  as the file already defines):
  - `'Hi **bold** _em_ ~~gone~~ `code`'` → one paragraph: mention, `' Hi '`, `bold`+strong, `' '`, `em`+em, `' '`, `gone`+strike, `' '`, `code`+code.
  - `'# Title\n\nBody'` → `[paragraph[mention], heading{level:1}[Title], paragraph[Body]]` (mention gets its own paragraph, no trailing space text node).
  - `'- a\n- b\n  - c'` → mention paragraph, then `bulletList[listItem[paragraph[a]], listItem[paragraph[b], bulletList[listItem[paragraph[c]]]]]`.
  - `'3. x\n4. y'` → `orderedList` with `attrs: { order: 3 }`; `'1. x'` → `orderedList` with no `attrs.order`.
  - `` '```ts\nconst a = 1\n```' `` → `codeBlock{language:'ts'}` with one text node, no marks.
  - `'> q'` → `blockquote[paragraph[q]]`; `'> > q'` → `blockquote[paragraph[q]]` (flattened).
  - `'a\n\n---\n\nb'` → `paragraph, rule, paragraph`.
  - `'| h1 | h2 |\n| - | - |\n| a |  |'` → `table[tableRow[tableHeader[paragraph[h1]], tableHeader[paragraph[h2]]], tableRow[tableCell[paragraph[a]], tableCell[paragraph[]]]]`.
  - Links: `'[t](https://x.io)'` → text `t` with `link{href:'https://x.io'}`; `'[t](javascript:alert(1))'` → text `t`, no marks; `'see https://x.io'` →
    autolink text with link mark; `'**`x`**'` → text `x` with `code` only.
  - Entities and escapes: `'a &amp; b &lt; &#169; &#x41; &hellip; \\*'` → text `a & b < © A &hellip; *`.
  - Fallbacks: `'- # h'` → list item's paragraph `h` with `strong`; `'> # h'` → blockquote paragraph `h` with `strong`; `'- [ ] todo'` → list item text
    `[ ] todo`; raw HTML `'<b>x</b>'` → its source text in a paragraph; an image `'![alt](/a.png)'` → its source text.
  - Remaining table rows: `'__s__ *e*'` → `s`+strong, `e`+em; `'    code'` (indented) → `codeBlock` with no `language`; `'[m](mailto:a@b.io)'` → link
    mark kept; `'[t](https://x.io "T")'` → link mark `{href:'https://x.io'}`, no title; `'&gt; &quot; &#39;'` → text `> " '`; `` '```\n```' `` →
    `codeBlock` with no content.
  - Containers: `'- a\n\n  ---'` → the list item holds `paragraph[a]`, `paragraph[---]`; `'> | a |\n> | - |\n> | b |'` → blockquote paragraphs `a`, `b`
    (one per row, cells joined ` | `); `'- ```\n  x\n  ```'` → list item's first child an empty `paragraph`, then `codeBlock`.
  - Prose that only looks like Markdown (Review Focus 2): `'snake_case_name and 2 * 3 * 4'` → one paragraph, one plain text node after the mention;
    `'#123 is fixed'` → paragraph text `#123 is fixed`; `'1) first'` → `orderedList` (CommonMark marker — the preview renders the same list, which is
    the contract: post what the preview shows).
  - No empty text node anywhere: walk every result above and assert no `text: ''`.
  - Round trip: a fixture opening with a paragraph, in canonical spelling (`**x**`, `_x_`, `-` bullets, `1.` list, heading, code block, quote, rule,
    inline code, `[t](https://x.io)`), no tables / autolinks / entities: `adfToMarkdown(replyDoc(MARA, md)).markdown` equals `'@Mara Ilić ' + md`.
  - In `jira-mentions-routes.test.ts`: one Post reply with text `'# H\n\n- **a**'` asserts the body sent to Jira contains a `heading`, a `bulletList` and a
    `strong` mark, mention first.
- [ ] **Step 3: Run them.** `pnpm run test:jest -- test/jira/jira-adf.test.ts test/jira/jira-mentions-routes.test.ts`. Expected: the new cases FAIL, the
  seven old ones PASS.
- [ ] **Step 4: Implement.** `marked.lexer(text, { gfm: true })` then a token walk per the spec's table, container rules and generic fallback. Single
  newlines inside a paragraph stay `hardBreak` (the lexer gives `br` only for two-space breaks — split text tokens on `\n` the way today's code does). The
  mention rule is the spec's: inside the first paragraph with a leading space when the first block is a paragraph, else a paragraph of its own. Decode only
  the entity set the spec names. Keep `replyDoc` pure.
- [ ] **Step 5: Run.** Same command. Expected: all PASS. Also `pnpm run typecheck`.
- [ ] **Step 6: Commit** `feat(jira): post mention replies as Markdown-formatted ADF` with the files above.

### Task 2: Reply prompt, skill text, server rule doc

**Files:**
- Modify: `server/src/jira/prompt.util.ts` (`replyText` and its doc comment ~179-196), `skills/jira/SKILL.md:81-82`, `.claude/rules/jira.md:91` (the
  `replyDoc`'s ADF clause), `docs/superpowers/specs/2026-11-16-jira-mentions-design.md:123` (the non-goal line points to the new spec)
- Test: `test/jira/jira-prompt.test.ts` (`describe('the reply built-in')`)

**Interfaces:** none.

- [ ] **Step 1: Failing test.** In `the reply built-in`: the prompt contains `Markdown` and does not contain `Write the reply as plain paragraphs` (today's
  wording, `server/src/jira/prompt.util.ts:194`; the new text still says "plain paragraphs when it does not"); the existing `< 1_500` assertion stays.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira/jira-prompt.test.ts`. Expected: the new test FAILS.
- [ ] **Step 3: Implement.** Reword per the spec's Prompt section: Markdown (headings, bold, lists, inline code, links, small tables) when the answer has
  structure, plain paragraphs when not; still no leading `@`-mention; still `jira.mjs draft` on stdin, never post. Update SKILL.md, jira.md and the old
  spec's non-goal in the same commit.
- [ ] **Step 4: Run** the same suite plus `pnpm run test:jest -- test/guards` (rule files are read by guards). Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): ask reply sessions for Markdown`.

### Task 3: Preview rendering helper and the posted comment

**Files:**
- Modify: `client/src/lib/markdown.ts` (`renderMarkdown` gains an optional second argument), `client/src/lib/jira-mentions.ts` (new helper),
  `client/src/components/jira/JiraMentionModal.tsx:273-284` (the `mine` comment's `markdown`) and the render at `:542` (the `mine` comment renders with
  breaks)
- Test: `test/jira/jira-mentions-lib.test.ts`, `test/jira/jira-mention-modal.test.tsx`

**Interfaces:**
- Produces: `renderMarkdown(source: string, opts?: { breaks?: boolean }): string` — no `opts` renders exactly as today.
- Produces: `replyMarkdown(to: string | null, text: string): string` in `client/src/lib/jira-mentions.ts` — the spec's mention-placement rule (`@<to> ` +
  text when the first block is a paragraph, else `@<to>` + `\n\n` + text; text alone when `to` is null). Decide "first block is a paragraph" with
  `marked.lexer`, the same lexer the server uses.

- [ ] **Step 1: Failing tests.**
  - `replyMarkdown('Boyan', 'Thanks')` → `'@Boyan Thanks'`; `replyMarkdown('Boyan', '# H')` → `'@Boyan\n\n# H'`; `replyMarkdown('Boyan', '- a')` →
    `'@Boyan\n\n- a'`; `replyMarkdown(null, '# H')` → `'# H'`.
  - `renderMarkdown('a\nb')` contains no `<br`; `renderMarkdown('a\nb', { breaks: true })` contains `<br`.
  - Modal suite: after a Post reply of `'# Done\n\nok'` lands, the optimistic comment renders an `h1` (or the heading level `renderMarkdown` emits) and a
    mention chip before it, not `@Name # Done` as one paragraph.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira/jira-mentions-lib.test.ts test/jira/jira-mention-modal.test.tsx`. Expected: new cases FAIL.
- [ ] **Step 3: Implement** both functions; the `mine` comment uses `replyMarkdown(posted.to, posted.text)` and renders with `{ breaks: true }`; thread
  comments by others keep rendering without options.
- [ ] **Step 4: Run** the same command plus `test/server/csp.test.ts` and `test/items/item-modal.test.tsx` (other `renderMarkdown` callers). Expected: PASS.
- [ ] **Step 5: Commit** `feat(board): preview replies the way Jira will show them`.

### Task 4: `Modal` gains `foot` and `over`

**Files:**
- Modify: `client/src/components/ui/Modal.tsx` (props and header comment: four composers, the two props), `client/src/styles.css` (`.ui-modal-foot` as a
  full-width row under both columns in the split shape and under the body in the sidecar — add a grid row only when a foot is passed, keeping the
  `minmax(0, 1fr)` content row and the comment that explains it; `.ui-modal-over` on scrim z 62 and panel z 63)
- Test: `test/ui/ui-modal.test.tsx` (existing shell suite); `test/ui/ui-modal-scroll-style.test.ts` (CSS guard on the modal's scroll rules) must stay green

**Interfaces:**
- Produces: `Modal` props `foot?: ReactNode` and `over?: boolean`; with neither, the DOM is identical to today's.

- [ ] **Step 1: Failing tests.** With `foot`, a `.ui-modal-foot` holding it is a child of the dialog after the body; without, no `.ui-modal-foot`. With
  `over`, both `[data-testid="modal-scrim"]` and the dialog carry `ui-modal-over`; without, neither does.
- [ ] **Step 2: Run** the suite. Expected: FAIL.
- [ ] **Step 3: Implement** the props and CSS.
- [ ] **Step 4: Run** it plus `test/ui/ui-modal-scroll-style.test.ts`, `test/items/item-modal.test.tsx`, `test/jira/jira-detail.test.tsx` and
  `test/jira/jira-mention-modal.test.tsx` (existing composers). Expected: PASS.
- [ ] **Step 5: Commit** `feat(board): give the modal shell a foot and an over-stack class`.

### Task 5: The reply editor

**Files:**
- Create: `client/src/components/jira/JiraReplyEditor.tsx` (header comment cites DESIGN.md §8.9.7 and the spec)
- Modify: `client/src/components/jira/JiraMentionModal.tsx` (`DraftReply`: `Open editor` chip first in `.jira-reply-acts`, an `open` state, a ref on the
  box's root for `closest('.shell')`, renders the editor through `createPortal`), `client/src/styles.css` (editor column and textarea fill rules)
- Test: `test/jira/jira-mention-modal.test.tsx` (render the modal inside a `<div className="shell">` for these cases); `test/ui/ui-modal.test.tsx:116-117`
  (exactly three `Modal` composers → four, adding `jira/JiraReplyEditor.tsx`, with a comment why — Step 1)

**Interfaces:**
- Consumes: `Modal` `foot`/`over` (Task 4); `replyMarkdown`, `renderMarkdown(…, { breaks: true })` (Task 3); `chipMentions` (existing).
- Produces: `JiraReplyEditor({ issueKey, to, text, onText, busy, newer, onUseNewer, error, onPost, onClose })` — `to: string | null`, `text: string`,
  `onText(text: string)`, `busy: boolean`, `newer: boolean`, `onUseNewer()`, `error: string | null`, `onPost(text: string)`, `onClose()`. It owns no
  reply state.

- [ ] **Step 1: Failing tests** (spec Testing, client bullets), each a separate `it`:
  - `Open editor` opens a dialog named `Reply editor for <KEY>` whose DOM is not inside the mention modal's `.ui-modal`, and is inside `.shell`.
  - Typing in `Edit reply to <name>` updates `Reply to <name>` (the box), and the reverse.
  - `Close` closes the editor and the box keeps the edited text; Escape closes only the editor (the mention dialog is still there); a click on the
    editor's scrim does the same — mention dialog still open, box text unchanged.
  - Preview of `'snake_case_name and 2 * 3 * 4'` has no `<em>`/`<strong>`; of `'1) first'` has an `<ol>` (matches Task 1's ADF).
  - The preview shows `<h1>`/`<li>` for `'# H\n\n- a'`, the mention as its own paragraph before the heading, and `<br>` for `'a\nb'`.
  - Blank text previews `Nothing to preview yet.` and disables `Post reply`; text past 8000 disables it; `busy` disables it.
  - `Post reply` in the editor posts the shared text once and the editor closes on success; a refused post keeps it open with the alert line in its foot.
  - A newer draft arriving while open shows `A newer draft arrived · Use it` in the editor; `Use it` swaps the text in both.
  - Without `to`, the head has no `To @` line and the textarea is `Edit reply to <KEY>`.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/jira/jira-mention-modal.test.tsx`. Expected: new cases FAIL.
- [ ] **Step 3: Implement.** `Modal` with `head`, `lead` false, `over`, `foot`; Write column = newer-draft note + textarea filling the column height;
  Preview column = `chipMentions(renderMarkdown(replyMarkdown(to, text), { breaks: true }), to === null ? [] : [to])` styled with the thread comment's
  classes (only the addressee is chipped: the thread's author list lives in `Thread`, `JiraMentionModal.tsx:489`, and the preview needs only the lead
  mention tinted). `DraftReply` has no error state today: `JiraMentionModal`'s `refused` (`:152`, shown at `:358` behind the editor's scrim) is threaded
  through a new `DraftReply` prop `refused: string | null` into the editor's `error`, so a refused Post reply from the editor is readable in its foot.
- [ ] **Step 4: Run** the same suite, then `grep -l` in `test/` for `createPortal`, `DraftReply`, `JiraMentionModal`, `renderMarkdown`, `Modal` and run
  every hit. Expected: PASS. `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(board): open a mention reply in a Write/Preview editor`.

### Task 6: Ten dialogs — docs and the guard

**Files:**
- Modify: `test/guards/dialog-count-docs.test.ts` (nine → ten, names the editor), `docs/subsystems/invariants.md:2269-2331` (Escape entry: ten, the editor
  as `Modal`'s fourth composer, portalled), `.claude/rules/board.md:11-30` (count, `Modal`'s composer list), `client/src/hooks/useDialogEscape.ts` comment
  (~39-42), `.claude/DESIGN.md:568` (§8.7: four composers, `foot`, `over`), `:572` (three surfaces → four; "among the nine dialogs" → ten), `:898` and
  §8.9.7 (the draft box's `Open editor`
  and the editor itself, replacing "no new dialog")

**Interfaces:** none.

- [ ] **Step 1: Failing test.** Update the guard's expectations to ten and the editor's name (`JiraReplyEditor`), keeping every history assertion.
- [ ] **Step 2: Run** `pnpm run test:jest -- test/guards/dialog-count-docs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit the docs** — new sentences only, existing prose not reflowed; the history ("nine since Jira mentions") stays as history.
- [ ] **Step 4: Run** `pnpm run test:jest -- test/guards`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(board): count the reply editor as the tenth dialog`.

### Task 7: `/ui-verify`

**Files:** none changed unless a defect is found (fix it on the branch in its own commit).

- [ ] **Step 1:** Run `/ui-verify` against the spec's sketch (`docs/superpowers/specs/2026-11-18-jira-reply-markdown-design.md`, Design › Draft box and
  Reply editor), light theme (`daylight`), with fixture data from `page.route` on `**/api/jira/mentions*` and `**/api/jira/thread*` carrying an open
  mention with a ~7900-character Markdown draft (headings, lists, a table). Shoot: the draft box (does the action bar wrap with four chips?), the editor
  at 1440 × 900 and at 699 × 900, the editor at `fontScale` 80 and 130. Assert `scrollWidth <= clientWidth` on the editor, both columns and the document;
  at 1440 assert each column's `scrollHeight > clientHeight` (each scrolls on its own) and the foot's bounding box lies inside the viewport.
- [ ] **Step 2:** Fix any defect, re-run the affected shots, commit.

---

## Self-review notes

- Spec coverage: converter (T1), prompt + skill + rules (T2), preview rendering + `mine` (T3), `Modal` slots (T4), editor + ownership + portal (T5), ten
  dialogs + DESIGN.md (T6), `/ui-verify` (T7). The spec's `plugin:sync` step is held for the person (autopilot), not a task.
- Review Focus coverage: 1 → T1 heading/list cases + T3 `replyMarkdown`; 2 → GFM leaves intraword `_` and spaced `*` alone in both lexer and preview —
  T1 and T5 pin `snake_case_name`, spaced `*`, `#123` and `1)`; 3 and 5 → T7 shots; 4 → T5 Escape and scrim cases.
