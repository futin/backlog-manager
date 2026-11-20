# Jira review skills — design

Date: 2026-11-20. Follows [2026-11-19-jira-detail-tabs-design.md](2026-11-19-jira-detail-tabs-design.md), whose Non-goals deferred "Review skills" to this
spec and whose §4.4 reserved the slot. Builds on [2026-11-17-jira-skill-order-design.md](2026-11-17-jira-skill-order-design.md) (↑/↓ order, shipped).

## Mocks

| Mock | What this spec takes from it |
| ---- | ---------------------------- |
| [Review-Skills.dc.html](2026-11-19-jira-detail-tabs-mockups/Review-Skills.dc.html) (static copy `html/Review-Skills.html`) | Setup › Skills: the Run \| Review switch with counts, a pinned `BUILT IN` row per group, `YOUR RUN SKILLS` / `YOUR REVIEW SKILLS` with ↑/↓, `+ Add run skill` / `+ Add review skill`, the Edit sheet's Group toggle and per-group `Fills in:` line. NOT the ⋮⋮ drag handles (§Non-goals). |
| [Main.dc.html](2026-11-19-jira-detail-tabs-mockups/Main.dc.html) (static `html/Main.html`) | The Delivery target row's `▶ Request review ▾` split and its menu: `BUILT IN` · `Review bot — request review` `default`, then the review skills. |
| [B-Modal.dc.html](2026-11-19-jira-detail-tabs-mockups/B-Modal.dc.html) | The live card's `Review the MR · Claude code review` label. |

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
   `+ Add … skill`. One Edit sheet, with a Group toggle.
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
- `parseSkillWrite`: `group` required? **No — absent means `run`**, so an older client's save still works; present and not one of the two is the 400
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
- `YOUR RUN SKILLS` / `YOUR REVIEW SKILLS` with the hint `↑↓ to reorder · order = menu order` (the mock's hint minus its drag words), then the rows exactly as
  today (↑/↓, Edit, ×). The first row's ↑ and the last row's ↓ are disabled **within the group**.
- `+ Add run skill` / `+ Add review skill` opens the sheet with Group preset to the segment shown.
- **Edit sheet:** Name, **Group** (Run | Review toggle; sub-line `Review: shows on an open MR, works on its source branch` when Review), Prompt, and a
  `Fills in:` line listing the group's placeholders (§3). Changing a skill that is the stored `jiraDefaultAction` to Review is allowed; the default then
  resolves as unknown and falls back to `execute` (§5).
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
- **Chevron:** opens a menu in `JiraRunMenu`'s row language: `BUILT IN` · `Review bot — request review` (or `— fix findings` on the fix half) with `default`,
  then `YOUR REVIEW SKILLS · <n>` with each skill (sparkle tile, name, command sub-line via `skillCommand`). Picking the bot is the left half's click;
  picking a skill opens the launch sheet for that skill on that MR (§6).
- **Where review skills are offered when the bot has nothing to do.** The split draws today only on the next row's `request`/`fix` kinds. With review skills
  present, every expanded target whose representative MR is open also offers them on the other kinds (`run`, `merge`, `gitlab`, none): a ghost
  `Review ▾` (menu only, no left half) placed after the row's own button. Rationale: picking a reviewer per MR must not wait on the bot's state. **The user's
  call (2026-11-20)**; `NextRow` therefore draws on rows where it returns `null` today.
- **Gate:** the same `reviewGate` holds the chevron and every skill row (disabled, the gate's sentence as title); hidden under the same conditions the split
  is hidden (no candidate repo, agents off, no `onReview`).

### 5. Run ▾ and the default action

- `JiraRunMenu` and Sessions' run surfaces list `group === 'run'` skills only.
- `resolveJiraAction(stored, skills)` resolves a skill id only among run skills; a stored id that is now a review skill reads as unknown → `execute`, the
  existing fallback. Settings › Local's `Jira default action` select offers run skills only.

### 6. Launch sheet, preview, dispatch

- `JiraLaunchSheet`'s `review` prop gains a variant: `{ skill: <s_ id>, mr, repos }` beside today's `{ half, mr, repos }`. The sheet is a review sheet either
  way (one pressed tile — the skill's name; Desktop seeded; branch section locked to `continue` on the MR's source branch; no `openMr`).
- **Wire:** the action is the existing `{ skill: id }` / `skill:<id>`, plus the MR (`mrProject`, `mrIid` on the preview's query; `mr` on dispatch's body) and
  **no** `half`. A request with a `half` and a skill action is a 400 `half is the review bot's only`.
- **Server rule, both routes (preview and dispatch):** after `resolveJiraActionOrThrow` finds the skill —
  - `group === 'review'` and no MR → 400 `<name> is a review skill and needs an MR`;
  - `group === 'run'` with an MR → 400 `<name> is a run skill and takes no MR`.
- **Dispatch, a review skill:** the bot path's `reviewOrThrow` checks run **except the state checks** — candidate repo (400), `continue` on the MR's source
  branch without `openMr` (400), MR open and in the cache (today's 409/404 sentences), the MR's keys hold the ticket or its parent (today's), the branch
  hold and the strict one-session gate (`strict` = any review, bot or skill). It does **not** require review state, `nothing to review`, or a half match: a
  review skill is a reviewer of the user's choosing, on any open MR.
- **Preview:** `jira/` may not read the GitLab poller (`gitlab.module.ts` imports `JiraModule`, and `.claude/rules/jira.md` limits `jira/`'s use of
  `gitlab/` to `remote.util.ts`), so the client sends all five MR values on the preview's query — `mrProject`, `mrIid`, `mrUrl`, `mrSource`, `mrTarget`, from
  the `GitlabMr` it drew the row from — and the preview shapes them (project path and iid as today; `mrUrl` an `https://` URL; the branches pass the §6 name
  checks) and composes from them. No GitLab read.
- **Dispatch re-checks against the cache:** the body carries the same five; dispatch resolves the MR from the cache as today and, if any of `webUrl`,
  `sourceBranch`, `targetBranch` differs from what was sent, refuses with 409 `!<iid> changed since the sheet opened — reopen the sheet` (the bot's
  `moved on` pattern). It then composes from the cache values, which equal the sent ones — the preview is the spawn, byte for byte. (My call.)
- **Wire plumbing the build must touch:** `jira-agents.controller.ts` today drops `mr` for any action but `review` — keep it for a skill action too; the
  branch lock in `JiraBranchSection` and `parseBranchChoice` keys on `action === 'review'` — it must also lock for a review skill (a `review` flag beside the
  action, or the sheet's review variant, the builder's pick).
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

- Switch: `Run <n>` / `Review <n>`
- Explainers: `Run skills show in a ticket's Run ▾.` / `Review skills show in an MR's Review ▾ and start on that MR's source branch, never a new one.`
- Heads: `BUILT IN`, `YOUR RUN SKILLS`, `YOUR REVIEW SKILLS`, hint `↑↓ to reorder · order = menu order`
- Built-in review row: `Review bot` / `request a review, or fix what it found`
- Buttons: `+ Add run skill`, `+ Add review skill`
- Edit sheet: `Group`, `Run`, `Review`, `Review: shows on an open MR, works on its source branch`, `Fills in:`
- Menu: `Review bot — request review` / `Review bot — fix findings`, `default`, `YOUR REVIEW SKILLS · <n>`
- 409: `!<iid> changed since the sheet opened — reopen the sheet`
- 400s: `group must be run or review`, `<name> is a review skill and needs an MR`, `<name> is a run skill and takes no MR`, `half is the review bot's only`
- Label: `Review the MR · <skill name>`

## Testing

- `config.util`: `group` absent → run; `review` round-trips; bad group dropped on read, 400 on write; update changes group, keeps id and position; order route
  unchanged across mixed groups.
- `prompt.util`: review skill fills all `{mr.*}` and `{branch}`; run skill leaves `{mr.url}` literal; key appended when unnamed in both.
- Preview + dispatch routes: the two group/MR 400s, `half` with a skill 400, review skill on a closed or foreign MR refused with today's sentences, review skill
  accepted on an MR with no review state and on a `clean` one, strict gate and branch hold apply, bot review path unchanged (existing tests stay green).
- Client: Skills card switch counts and per-group ↑/↓ edges, Add presets group, sheet Group toggle and `Fills in:` swap, `Make default` run-only; Run ▾
  hides review skills; `resolveJiraAction` falls back for a review id; `Review ▾` chevron present only with ≥1 review skill, gated with the split, ghost menu
  on non-review next kinds; launch sheet for a skill locks the branch; link labels.
- Source guards: grep `test/` for each symbol gaining a caller (`reviewGate`, `ReviewSplit`, `resolveJiraAction`, `skillCommand`) per CLAUDE.md.
- Last task: `/ui-verify` against the three mocks (Setup › Skills both segments, a target row's open menu, the live card label).

## Rule and doc updates

- `.claude/rules/jira.md`: skill group, the two placeholder sets, review-skill dispatch checks (which of `reviewOrThrow`'s run, which don't), label rule.
- `.claude/DESIGN.md` §8.9.3 (Setup › Skills) and §8.9.6 (Delivery next row) for the switch, the chevron and the ghost `Review ▾`.
- `docs/subsystems/` Jira page for the `jira.json` `group` key.
- The detail-tabs spec's §4.4 "Reserved slot" sentence gains a pointer to this spec.

## Left to the builder

- Component split for the menu (extend `ReviewSplit` or a sibling `ReviewMenu`), and whether the menu reuses `JiraRunMenu`'s row renderer.
- Exact placement and skin of the ghost `Review ▾` beside each next-row kind, within DESIGN.md's row language.
- The preview's source for `{mr.*}` (cache read vs query + dispatch re-check), per §6.
