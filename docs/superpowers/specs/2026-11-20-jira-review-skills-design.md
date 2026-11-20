# Jira review skills — design

Date: 2026-11-20. Follows [2026-11-19-jira-detail-tabs-design.md](2026-11-19-jira-detail-tabs-design.md), whose Non-goals deferred "Review skills" to this
spec and whose §4.4 reserved the slot. Builds on [2026-11-17-jira-skill-order-design.md](2026-11-17-jira-skill-order-design.md) (↑/↓ order, shipped).

## Mocks

| Mock | What this spec takes from it |
| ---- | ---------------------------- |
| [Review-Skills.dc.html](2026-11-19-jira-detail-tabs-mockups/Review-Skills.dc.html) (static copy `html/Review-Skills.html`) | Setup › Skills: the Run \| Review switch with counts, a pinned `BUILT IN` row per group, `YOUR RUN SKILLS` / `YOUR REVIEW SKILLS` with ↑/↓, the Edit sheet's Group toggle and per-group `Fills in:` line. Differences below. |
| [Main.dc.html](2026-11-19-jira-detail-tabs-mockups/Main.dc.html) (static `html/Main.html`) | The Delivery target row's `▶ Request review ▾` split and its menu: `BUILT IN` · `Review bot — request review` `default`, then the review skills. |
| [B-Modal.dc.html](2026-11-19-jira-detail-tabs-mockups/B-Modal.dc.html) | The live card's `Review the MR · Claude code review` label. |

**Mock differences, each taken or not:**

| Mock draws | This spec |
| --- | --- |
| ⋮⋮ drag handles, `drag ⋮⋮ or ↑↓` hint | not taken (Non-goals); hint `↑↓ to reorder · order = menu order` |
| one Run built-in row `Work it end to end · Open with the ticket loaded` · `pinned above your skills` | not taken: today's two built-in rows stay |
| upper-case heads `BUILT IN`, `YOUR RUN SKILLS` | taken as today's head style (`jira-run-head`); the strings are sentence case, CSS does the rest if it already does |
| a description line per skill (`— post findings as MR comments`) and whole templates on rows | not taken: `JiraSkill` has no description; rows keep today's `skillCommand` sub-line with the full prompt as `title` |
| `+ Add run skill` button opening an Edit sheet | not taken: today's inline add row stays (§2); Edit is inline, not a sheet |
| Edit sheet with Group toggle and `Fills in:` line | taken, inline (§2) |
| menu head `BUILT IN` with no count; bot row sub-line `Posts the review request on !16033; fix half once findings land` | head taken, no count; sub-line shortened per half (§4) |
| live card `Review the MR · Claude code review` | taken (§7) |

Read the mocks' relevant blocks by grep (`Review &#9662;`, `YOUR REVIEW SKILLS`, `Edit skill`), never whole.

## Intent

Today an open MR has exactly one reviewer the board can start: the repository's review bot, through mr-review-loop (`request` half, then `fix`). The user
wants to **pick the reviewer per MR** — the bot by default, or one of their own saved review prompts (e.g. `/code-review high {mr.url}`, `/backlog-review`
against the target, `/timify-gitlab:mr-review-loop {mr.url}`) — from the MR's own row on the ticket page, without leaving the board or retyping the prompt.

Success: on a ticket's Delivery tab, an open MR's review button opens a menu; picking a review skill opens the launch sheet already set to that skill, on
that MR's source branch, and Start runs it. Setup › Skills shows Run and Review skills apart and edits both with one sheet.

## Goals

1. A skill carries a **group**, `run` or `review`. Run skills are today's skills; review skills are prompts that run against one open MR.
2. Setup › Skills draws one group at a time behind a Run | Review switch, each with its pinned built-in row, its own list, ↑/↓ inside the group, and its own
   inline add row. A new inline Edit per row, with a Group toggle.
3. The Delivery tab's review split becomes `Review ▾`: the bot stays the left half's action (unchanged), the chevron opens a menu of the bot plus every
   review skill. Run ▾ lists run skills only.
4. A review skill's session runs on the MR's source branch (`continue`, never a new branch or worktree choice), is held by the same live-session gate the
   bot review uses, and is labelled `Review the MR · <skill name>` on Sessions, History and the live card.

## Non-goals

- **Drag reordering** (the mock's ⋮⋮). ↑/↓ only; drag can be its own spec later. The user's call.
- A fix half for review skills. A review skill is one prompt; what it does with findings (post comments, fix, report) is what its prompt says.
- Review skills on the board card, the List, the band or Sessions' Run ▾ — they exist only on an open MR's row in Delivery.
- Changing the bot review: its halves, its state gate (`no review state yet`, `nothing to review`, `moved on`), its prompt — all byte-for-byte as today.
- A `{mr.title}` placeholder, or any other free text from GitLab or Jira (§Prompt).

## Anti-goals

- A review skill that can be started on a branch other than the MR's source branch, or that cuts a branch.
- An existing `jira.json` that needs migrating, or an existing skill that changes menu.
- A review skill reachable from Run ▾, or a run skill reachable from `Review ▾`, by any route — including a stored `jiraDefaultAction`.

## Approaches

- **A. A `group` field on each skill, one list (picked).** `JiraSkill` gains `group: 'run' | 'review'`; `/skills`, `/skills/delete`, `/skills/order` keep their
  shape; dispatch and the prompt preview branch on the resolved skill's group. Matches the mock's single editor with a Group toggle; one id space.
- **B. A separate `reviewSkills` list.** Own routes, writer, reader and tests — all duplicated; changing a skill's group becomes delete + create with a new id,
  which the mock's toggle does not expect. Rejected.
- **C. `review` takes a skill instead of a half.** Reuses the bot's MR plumbing directly but mixes user templates into the bot's request/fix logic. Rejected.

## Design

### 1. Data

- `JiraSkill` in `shared/types.ts`: `{ id, name, prompt, group: 'run' | 'review' }`.
- `readSkill` (`server/src/jira/config.util.ts`): `group` absent → `'run'` (every existing file keeps working, no migration, nothing rewritten on read);
  `'run'` or `'review'` → itself; anything else → the entry is dropped with a warning, like any malformed skill.
- `parseSkillWrite`: `group` is optional. A **create** without it stores `group: 'run'` (written explicitly); an **update** without it keeps the stored group
  (`writeSkill`'s `{ ...stored, ...skill }` merge, `config.util.ts:632`, must not overwrite it with a default), so an older client's save neither fails nor
  moves a review skill; present and not one of the two is the 400
  `group must be run or review`. An update may change the group; the skill keeps its id and its position in the list.
- `writeSkillOrder` and `POST /skills/order`: **unchanged**. The list stays one list; a group's order is the relative order of its members in it. The card
  moves a skill inside its group's slice and posts the whole list (the route still demands exactly the file's id set).

### 2. Setup › Skills (`JiraSkillsGroup.tsx`)

Per `Review-Skills.dc.html`:

- A two-segment switch `Run <n>` | `Review <n>` (counts from the list). Default segment: Run; per-render, not persisted (my call — like Delivery's fold).
- Under it the group's one-line explainer: Run — `Run skills show in a ticket's Run ▾.`; Review — `Review skills show in an MR's Review ▾ and start on that
  MR's source branch, never a new one.`
- `BUILT IN`: Run shows today's two built-in rows; Review shows one row, `Review bot` · `request a review, or fix what it found`, with no `Make default`
  (the bot is always the split's left half).
- Today's card (`JiraSkillsGroup.tsx:183-250`) has heads `Built in` / `Skills on this machine · N`, rows with ↑/↓ and `×` (inline `ui/Confirm`), an
  always-visible inline add row (name input, prompt textarea, `Add` chip), an error `role="alert"` row, and two placeholder hint rows. **There is no Edit and
  no sheet today.**
- Heads become `Built in` and `Your run skills · <n>` / `Your review skills · <n>` (no head at zero, as today), followed by the hint row
  `↑↓ to reorder · order = menu order` while the group has two or more skills. Rows as today (↑/↓, `×`) plus a new `Edit` chip. The first row's ↑ and the
  last row's ↓ are disabled **within the group**. A group with no skills draws, under its built-in rows, the hint `No review skills yet.` (Review) — Run
  with none draws nothing extra, as today.
- **Add:** today's inline add row stays, under the shown group, and adds to that group (`group` sent = the segment). Its placeholders per group: Run as today
  (`Groom ticket`, `/jira-groom {key}`); Review `Claude code review`, `/code-review high {mr.url}`.
- **Edit (new, inline — not a sheet):** `Edit` swaps that row, in place, for the add row's two fields pre-filled, a two-segment **Group** toggle `Run` |
  `Review` (sub-line `Review: shows on an open MR, works on its source branch` while Review is pressed), and chips `Save` / `Cancel`. Save posts
  `POST /api/jira/skills` with the id (an update: id and list position kept) and closes the editor; a refusal shows in the card's existing alert row and the
  editor stays open. One editor open at a time; opening another, or pressing `×` on a row, cancels the first. Escape cancels it through `useDialogEscape`,
  called while the editor is open, exactly as `ui/Confirm` does — Escape has one owner (`.claude/rules/board.md`, bug-23), so the editor binds no listener
  of its own. It joins the hook's non-dialog entries (`board.md` list and `useDialogEscape.ts` header) and gets a `test/board/dialog-escape.test.tsx` case. Saving a group change moves the skill to the other
  segment; the shown segment does not follow. Changing a skill that is the stored `jiraDefaultAction` to Review is allowed; the default then resolves as
  unknown and falls back to `execute` (§5).
- The placeholder hint rows become per group: Run's two rows as today; Review's one row `Fills in: {key}, {mr.url}, {mr.iid}, {mr.source}, {mr.target},
  {mr.project} · a template without {key} gets the ticket key on a line after it`.
- `Make default` appears on run skills only.

### 3. Placeholders

- **Run** skills: today's six — `{key} {url} {repo} {branch} {base} {worktree}`. Unchanged.
- **Review** skills: `{key} {mr.url} {mr.iid} {mr.source} {mr.target} {mr.project}`, plus every run placeholder — `{url} {repo} {branch} {base}
  {worktree}` — filled exactly as for a run skill from the review's `continue` workspace (so `{branch}` equals `{mr.source}` and `{base}` is empty). The
  `Fills in:` line shows the mock's six; the others still fill (my call: one widened regex, not a second placeholder set).
- Values: `{mr.url}` = the cached MR's `webUrl`, `{mr.iid}` its iid, `{mr.source}`/`{mr.target}` its branches, `{mr.project}` its project path — all from the
  GitLab poller's cache entry the dispatch already resolves, never from the request.
- A run skill that writes `{mr.url}` gets it literally (today's rule: unknown brace text stays literal). The key-appended-when-unnamed rule applies to both.

### 4. `Review ▾` on the Delivery tab

Per `Main.dc.html`'s target row. `ReviewSplit` (`ReviewRow.tsx`) gains a chevron half when there is at least one review skill; with none it is today's lone
half, unchanged.

- **Left half:** today's bot action (preset half), unchanged — label, gate, disabled skin, reason line.
- **Chevron:** aria-label `More reviewers`; opens a `ui/Popover` (as `JiraRunMenu` does, `JiraRunMenu.tsx:155`, so it joins that file's Escape-stack
  composers) labelled `Review menu`, in `JiraRunMenu`'s row language: head `Built in`, the bot row `Review bot — request review` (sub-line
  `Posts the review request on !<iid>`) or, on the fix half, `Review bot — fix findings` (sub-line `Fixes the open findings on !<iid>`), marked `default`;
  then head `Your review skills` and each skill (sparkle tile, name, command sub-line via `skillCommand`). Picking the bot is the left half's click;
  picking a skill opens the launch sheet for that skill on that MR (§6).
- **Where review skills are offered when the bot has nothing to do.** With review skills present, every expanded target whose representative MR is open also
  offers them where the bot split is not drawn: a **ghost `Review ▾`** (outline skin, label `Review ▾`, aria-label `Review with a skill`), menu only, whose
  `Review menu` holds **only** the skills — never the bot row, because a bot dispatch without a half is refused (`jira-dispatch.service.ts:235-239`).
  Rationale: picking a reviewer per MR must not wait on the bot's state. **The user's call (2026-11-20)**; `NextRow` therefore draws on rows where it
  returns `null` today. Per next-row kind (`NextRow.tsx:72-101`):

  | Next kind | Control today | With ≥1 review skill |
  | --- | --- | --- |
  | `request` / `fix` (no live bot review link) | `ReviewSplit` | `ReviewSplit` + chevron |
  | `fix` with a live bot `review` link | `Open session` | `Open session`, then the ghost `Review ▾` |
  | `run` | `Run ▾` | `Run ▾`, then the ghost |
  | `merge` / `gitlab` | the GitLab chip | the chip, then the ghost |
  | none | nothing (row may be `null`) | the ghost alone; the row draws |

- **Gate:** the same `reviewGate` holds the chevron, the ghost and every skill row: disabled, dashed skin, the gate's sentence as title, and the reason line
  `ReviewWhy` with its tail from `reviewBlockedTail`, which widens to take `'Review'` for the ghost: ` — Review waits until it ends or you stop it.` On the
  split the tail keeps the split's own label. Hidden under the same conditions the split is hidden (no candidate repo, agents off, no `onReview`, no
  review skills).

### 5. Run ▾ and the default action

- Every surface that offers a skill to START from Run lists `group === 'run'` skills only: `JiraRunMenu` (card, modal, Delivery `run` kind) and the launch
  sheet (below). Sessions' Run filter (`client/src/lib/jira-list.ts:218-264`) is not one: it builds its options from the links' actions, so a review-skill
  link keeps its option, labelled per §7. Run ▾'s heads (`Built in`, `Skills on this machine · N`) are unchanged; N
  counts run skills.
- The launch sheet's `A skill` tile, its skill select, its sub-line count (`<n> on this machine`) and its empty hint (`no skills on this machine`,
  `JiraLaunchSheet.tsx:322-345`) are built from run skills only on a non-review sheet, so a review skill is never pickable from Run.
- `resolveJiraAction(stored, skills)` resolves a skill id only among run skills; a stored id that is now a review skill reads as unknown → `execute`, the
  existing fallback. Settings › Local's `Jira default action` select offers run skills only.

### 6. Launch sheet, preview, dispatch

- `JiraLaunchSheet`'s `review` prop gains a variant: `{ skill: <s_ id>, mr, repos }` beside today's `{ half, mr, repos }`. The sheet is a review sheet either
  way (one pressed, inert tile — title the skill's name, sub-line `on !<iid> · <source branch>`; Desktop seeded; branch section locked to `continue` on the
  MR's source branch; no `openMr`).
- **Wire (the one definition):** the action is the existing `{ skill: id }` (body) / `skill:<id>` (query), with **no** `half`.
  - Preview query: `mrProject`, `mrIid`, `mrUrl`, `mrSource`, `mrTarget`.
  - Dispatch body: `mr: { project, iid, url, source, target }`, `iid` a JSON number (as the bot's body, `jira-agents.controller.ts:66-73`).
  - Shape, both routes, before any lookup: `project`/`iid` via `parseReviewMr` as today; `url` a string of at most 2 000 characters starting `https://` or
    `http://` (self-hosted GitLab may be plain http); `source` and `target` each pass `branchNameProblem` (`shared/jira-branch.ts:38`). Any failure — or
    any of the five missing — is the 400 `mr must be { project, iid, url, source, target }`.
  - A `half` sent with a skill action is the 400 `half is the review bot's only`. The bot's own wire (`mr: { project, iid }` + `half`) is unchanged.
- **Server rule, both routes (preview and dispatch):** after `resolveJiraActionOrThrow` finds the skill —
  - `group === 'review'` and no MR → 400 `<name> is a review skill and needs an MR`;
  - `group === 'run'` with an MR → 400 `<name> is a run skill and takes no MR`.
- **Dispatch, a review skill:** the bot path's `reviewOrThrow` checks run **except the state checks** — candidate repo (400), `continue` on the MR's source
  branch without `openMr` (400), MR in the cache and `opened` and its keys holding the ticket or its parent (today's 400 `!<iid> is not an open merge
  request of <KEY>`, `jira-dispatch.service.ts:225-226`, `:557-559`), the branch
  hold and the strict one-session gate (`strict` = any review, bot or skill). It does **not** require review state, `nothing to review`, or a half match: a
  review skill is a reviewer of the user's choosing, on any open MR.
- **Preview:** `jira/` may not read the GitLab poller (`gitlab.module.ts` imports `JiraModule`, and `.claude/rules/jira.md` limits `jira/`'s use of
  `gitlab/` to `remote.util.ts`), so the client sends the five wire values from the `GitlabMr` it drew the row from, and the preview shapes them (above) and
  composes from them. No GitLab read.
- **Dispatch re-checks against the cache:** dispatch resolves the MR from the cache as today and, if any of `webUrl`,
  `sourceBranch`, `targetBranch` differs from what was sent, refuses with 409 `!<iid> changed since the sheet opened — reopen the sheet` (the bot's
  `moved on` pattern). It then composes from the cache values, which equal the sent ones — the preview is the spawn, byte for byte. (My call.)
- **Wire plumbing the build must touch:** `jira-agents.controller.ts` today drops `mr` for any action but `review` — parse it for a skill action too. The
  branch lock lives in three places, each keyed on the review today and each extended to a review skill: `JiraBranchSection.tsx:138`, `useBranchState`'s
  `locked` (`JiraBranchSection.tsx` near lines 64/84), and `reviewOrThrow`'s `continue` check (`jira-dispatch.service.ts:232-234`). (`parseBranchChoice`
  has no review lock and needs none.)
- **Compose:** `JiraComposeAction` gains `{ kind: 'skill'; skill; mr: { url, iid, source, target, project } | null }`; `skillPrompt` fills `{mr.*}` when `mr`
  is set. `{mr.*}` in the placeholder regex only when `mr` is non-null, so a run skill's literal `{mr.url}` stays literal.

### 7. Labels

- A link whose action is a review skill renders `Review the MR · <skill name>` (`client/src/lib/jira-sessions.ts`, `jira-list.ts`, the live card). Run
  skills keep their bare name.
- No new stored field: the client decides by looking up the skill's group in `GET /api/jira`'s `skills`. A link to a since-deleted review skill reads
  as a deleted run skill does today — its bare id, no prefix (my call: the link has no group of its own, and adding one is a link-store write for a label).
- A live review-skill session does **not** count as the ticket's live review: `liveReviewLink` stays `action === 'review'`, so the bot's `fix` half does not
  turn into `Open session` for it. The gate still disables the split with the skill session's name in the reason line (my call: the bot's fix half is about
  the bot's findings, which a skill session is not working).

## Copy (verbatim)

- Card scope line: `this machine · the prompts a card's Run menu and an MR's Review menu can start a session with`
- Switch: `Run <n>` / `Review <n>`
- Explainers: `Run skills show in a ticket's Run ▾.` / `Review skills show in an MR's Review ▾ and start on that MR's source branch, never a new one.`
- Card heads: `Built in`, `Your run skills · <n>`, `Your review skills · <n>`; hint `↑↓ to reorder · order = menu order`; empty Review `No review skills yet.`
- Built-in review row: `Review bot` / `request a review, or fix what it found`
- Remove confirm: Run `Remove <name>? A card's Run menu stops offering it.` (today's); Review `Remove <name>? An MR's Review menu stops offering it.`
- Edit: `Edit`, `Group`, `Run`, `Review`, `Review: shows on an open MR, works on its source branch`, `Save`, `Cancel`
- Review hint: `Fills in: {key}, {mr.url}, {mr.iid}, {mr.source}, {mr.target}, {mr.project} · a template without {key} gets the ticket key on a line after it`
- Menu: popover `Review menu`; heads `Built in`, `Your review skills`; `Review bot — request review` / `Posts the review request on !<iid>`;
  `Review bot — fix findings` / `Fixes the open findings on !<iid>`; `default`
- Chevron aria-label `More reviewers`; ghost label `Review ▾`, aria-label `Review with a skill`; reason tail ` — Review waits until it ends or you stop it.`
- Launch sheet review-skill tile: `<skill name>` / `on !<iid> · <source branch>`
- 400: `mr must be { project, iid, url, source, target }`; 400 (today's, reused): `!<iid> is not an open merge request of <KEY>`
- 409: `!<iid> changed since the sheet opened — reopen the sheet`
- 400s: `group must be run or review`, `<name> is a review skill and needs an MR`, `<name> is a run skill and takes no MR`, `half is the review bot's only`
- Label: `Review the MR · <skill name>`

## Testing

- `config.util`: `group` absent → run; `review` round-trips; bad group dropped on read, 400 on write; update changes group, keeps id and position; order route
  unchanged across mixed groups.
- `prompt.util`: review skill fills all `{mr.*}` and `{branch}`; run skill leaves `{mr.url}` literal; key appended when unnamed in both.
- Preview + dispatch routes: the two group/MR 400s, `half` with a skill 400, review skill on a closed or foreign MR refused with today's sentences, review skill
  accepted on an MR with no review state and on a `clean` one, strict gate and branch hold apply, bot review path unchanged (existing tests stay green); the
  400 `mr must be { project, iid, url, source, target }` for each missing or malformed field (url not http(s), url over 2 000, a branch `branchNameProblem`
  refuses) on both routes; the 409 `!<iid> changed since the sheet opened — reopen the sheet`, one row each for a differing `url`, `source`, `target`.
- `config.util` (add): create without `group` stores `run`; update without `group` keeps a stored `review`.
- Client: Skills card switch counts and per-group ↑/↓ edges, the add row adds to the shown group, inline Edit (Group toggle, Save keeps id and position, a refusal keeps it open, one editor at a time,
  Escape cancels), per-group hints and remove confirms, the review tile hidden from a non-review launch sheet, `Make default` run-only; Run ▾
  hides review skills; `resolveJiraAction` falls back for a review id; `Review ▾` chevron present only with ≥1 review skill, gated with the split, ghost menu
  on non-review next kinds; launch sheet for a skill locks the branch; link labels.
- Source guards: grep `test/` for each symbol gaining a caller (`reviewGate`, `ReviewSplit`, `resolveJiraAction`, `skillCommand`) per CLAUDE.md.
- Last task: `/ui-verify` against the three mocks (Setup › Skills both segments, a target row's open menu, the live card label).

## Rule and doc updates

- `.claude/rules/jira.md`: skill group, the two placeholder sets, review-skill dispatch checks (which of `reviewOrThrow`'s run, which don't), label rule.
- `.claude/rules/board.md`: the review-button bullet (today: split only on `request`/`fix`, one `Fix review`/`Request review` tile, the half on the wire)
  gains the chevron, the ghost per the §4 table and the review-skill tile; the Escape bullet's `ui/Popover` composer list gains the `Review menu`.
- `.claude/rules/dispatch-watchdog.md`: what a caller can influence for `review` gains the review skill's `{ skill }` + five-field `mr` and the 409 re-check.
- `docs/subsystems/invariants.md`: any section those two rule bullets link to that states the review is the bot's alone.
- Header comments of `ReviewRow.tsx` and `NextRow.tsx` (they describe the split as the lone review control).
- `.claude/DESIGN.md` §8.9.3 (Setup › Skills) and §8.9.6 (Delivery next row) for the switch, the inline editor, the chevron and the ghost `Review ▾`.
- `docs/subsystems/` Jira page for the `jira.json` `group` key.
- The detail-tabs spec's §4.4 "Reserved slot" sentence gains a pointer to this spec.

## Left to the builder

- Component split for the menu (extend `ReviewSplit` or a sibling `ReviewMenu`), and whether the menu reuses `JiraRunMenu`'s row renderer.
- Exact spacing of the ghost `Review ▾` beside each next-row kind, within DESIGN.md's row language.
