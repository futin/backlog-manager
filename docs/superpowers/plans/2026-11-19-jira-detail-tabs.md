# Jira Detail Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jira Detail becomes a heading, a summary strip and four tabs (Ticket · Delivery · Agent · Children & comments), drawn by one body component that
both the modal and a new fifth Jira page, `ticket`, frame. The Delivery tab shows every MR as one row per (project, target branch) with older MRs folded
under it, and a next-step marker with a per-browser `Ignore`. History folds, Stop leaves review sessions, and no drawn string or prompt names the review bot.

**Architecture:** Two pure helpers in `client/src/lib/delivery.ts` (`deliveryTargets`, `deliveryNext`) and one pure module for the ignore entries carry
every decision the Delivery tab draws (Tasks 1–2). Three module stores hold the tab, the ticket key and the ignore entries (Task 3). `JiraTicketBody` draws
the heading, strip, tabs and panes from props (Tasks 4–6); `JiraDetail` becomes its modal frame (Task 7) and `JiraTicketPage` its page frame (Task 8). The
copy and prompt change is independent (Task 9). Docs (Task 10), then `/ui-verify` (Task 11). Every task ends green; the old `DeliveryPane` `Also:` line and
`ReviewRow`'s lead-only placement go in Task 5, not before.

**Tech Stack:** React 18 + Vite (client), NestJS (one prompt string), TypeScript, jest + Testing Library (jsdom), pnpm.

**Spec:** [docs/superpowers/specs/2026-11-19-jira-detail-tabs-design.md](../specs/2026-11-19-jira-detail-tabs-design.md) — section numbers below (§) and
test numbers (T1–T30) are the spec's (§9). Mocks: `docs/superpowers/specs/2026-11-19-jira-detail-tabs-mockups/` — standalone copies under `html/`
(`Main.html`, `B-Modal.html`, `States.html`, `Review-Skills.html`, `index.html`; open in any browser, no scripts) and the canvas originals
(`Main.dc.html`, `B-Modal.dc.html`, `States.dc.html`), plus `00-mock-audit.md`. The mock files are large: grep them for the class a step names
(`.strip`, `.topbar`, `details.tgt`, `.next-row`), never read one whole. `Review-Skills` is a later spec's: build nothing from it.

**How to read this plan (overrides the template's "tests as code" habit).** Tasks specify behaviour, signatures and exact test cases — fixture, input,
expected value — and no literal implementation or test code. Write the code and the test bodies yourself from them; if a signature here is wrong for the
code you find, say so in the task's commit body and use what is right. No size budget in this plan is hard. Where a mock and the spec differ, the spec wins
(`00-mock-audit.md`). Component and file names marked *(name)* are this plan's picks for the spec's "left to the builder" — keep them unless the code you
find argues otherwise, and then say so in the commit body.

## Global Constraints

- **pnpm only.** Tests: `pnpm exec jest <paths>`; types: `pnpm run typecheck`. Never run the whole `pnpm test` locally — CI is the full-suite gate. Each
  task runs the suites it touched plus the source guards: before the commit, `grep -l <symbol> test/` for every symbol the task adds a caller of
  (`useJiraPage`, `setJiraPage`, `persistedStore`, `fetchJiraDetail`, `JiraRunMenu`, `SessionOpen`, `useGitlabContext`, `ticketDelivery`, `leadMr` at
  least) and add each hit to the run (CLAUDE.md, "Touched includes the source guards"). Known hits today: `persistedStore` / `useJiraPage` /
  `fetchJiraDetail` → `test/ui/persisted-store.test.tsx`, `test/ui/rail.test.tsx`, `test/jira/jira-lib.test.ts`, `test/jira/jira-detail.test.tsx`,
  `test/jira/jira-launch.test.tsx`, `test/jira/jira-view-store.test.tsx`, `test/jira/jira-list.test.tsx`, `test/jira/jira-setup.test.tsx`,
  `test/jira/jira-board.test.tsx`.
- **Read the rule file before the first edit under its glob:** `.claude/rules/board.md` (`client/src/**`, `shared/agent.ts`), `.claude/rules/jira.md`
  (`server/src/jira/**`), `.claude/rules/tests.md` (`test/**`, `.claude/rules/**`). `.claude/DESIGN.md` §8.0, §8.9.2, §8.9.5, §8.9.6 before any view task.
- **This repository is public.** Fixtures, comments and docs use invented data only: keys `PAY-<n>`, site `acme.atlassian.net`, person `Dana Novak`,
  GitLab project `acme/pay-api`, `acme/pay-web`, target branches `develop`, `demo`.
- **CSP `style-src 'self'`:** no `style=` attribute and no inline style object. Tone, state, ring and fold reach CSS through classes and `data-*`.
- **No server change but one string** (§8, §4.7): no route, no type in `shared/types.ts`, no request, no poller. The page reads `fetchJiraDetail` and
  nothing else new.
- **`Run ▾` is never hidden on an on-board issue**, and `JiraRunMenu` keeps reading `runChipState` alone. The second `JiraRunMenu` in the `run` next row is
  the same component with the same props shape (`home="modal"`), never a re-implementation.
- **`deliveryLook` does not change** (byte-identical output, T7). The card, the List, the band, the filters and the strip's Delivery pill keep reading it;
  only Detail's Delivery tab reads `deliveryNext`.
- **Escape stack and dialog count unchanged:** `JiraDetail` stays a `ui/Modal` composer; the page is not a dialog and joins no stack. `test/guards/
  dialog-count-docs.test.ts` and `test/board/dialog-escape.test.tsx` stay green.
- **Every new or rewritten component cites its `.claude/DESIGN.md` subsection in its header comment** (§8.9.2 for the body, strip, tabs and frames; §8.9.6
  for the Delivery tab); comments explain why, at the density of the file they sit in.
- **A jsdom suite's fixture dates are relative to the clock** — `daysAgoDate` / `daysAgoStamp` from `test/helpers/dates.ts` for every `created`,
  `updated`, `updatedAt`, `landedAt`, `stateSince`, `startedAt` in a `*.test.tsx`. Jest suites sit one level down in `test/<feature>/`.
- **Fixtures discriminate.** Every asserted field gets its own value (two MRs never share `iid`, `updatedAt` or title; two targets never share a tone
  unless the test is about ties), and per-key logic (per MR in the ignore store, per target) is exercised with at least two keys.
- **Exact copy** (spec §1–§6; any other string is the current code's, unchanged):
  - Tabs: `Ticket`, `Delivery`, `Agent`, `Children & comments`; counts `N targets` / `1 target`, `N live`, the ended count, the child count.
  - Strip: `unassigned`, `no MR`, `unknown`, `+N`, `idle · N ended`, `no sessions`, `<STATE_LABEL[state]> · <age>`.
  - Delivery head: `Branch <source>`, `<N> targets · <M> MRs` (`1 target`, `1 MR`), `via <parent key>`; rows `into <target>`, `+N earlier`.
  - Older fold: `<N> earlier MRs into <target> · <x merged>, <y closed>` with `<z open>` when non-zero; `1 earlier MR`; a zero part drops with its comma.
  - Next words and pills: `next: review`, `next: fix <n>` / `next: fix <n>+`, `next: re-review`, `next: fix pipeline`, `next: merge`, `next: re-run`,
    `next: mark ready`; track label `next · <word>` or `next`; `ignored`, title `ignored in this browser — click to stop ignoring`; button `Ignore`.
  - Sentences: `The review has not been read yet.`, `The pipeline failed — fix it in a Run session.`, `Reviewed and green — merge happens in GitLab.`,
    `Reviewed, no pipeline — merge happens in GitLab.`, `The pipeline was canceled — re-run it in GitLab.`, `Still a draft — mark it ready in GitLab.`
  - Buttons: `Merge in GitLab ↗`, `GitLab ↗`, `Open session`, today's `Request review` / `Fix review` split.
  - Frames: `Open full page ↗`, `Open in Jira ↗`, `← <origin>` (`← Board`, `← Sessions`, `← Mentions`), `Retry`, `Forget <KEY>`, `loading…`,
    `could not read the ticket — <sentence>`; titles `⌘-click: full page` (macOS) / `Ctrl-click: full page`.
  - Folds: `Worktrees <count>`, `History` with `<N> ended · last <date, time>`, `Children <count>`, `Comments`, `No child tickets.`
  - Review copy: `reviewRowText` prefix `Review · ` (was `CodeRabbit · `).
- **New text wraps at 160 columns** (tables and code exempt); commit bodies at 72. Commits end with the executing model's `Co-Authored-By:` line. Stage by
  path, never `git add -A`. Nothing is pushed by the executor.

## Review Focus

Input classes the spec implies and no spec test names. Each has its test in the owning task.

1. **A GitLab poll that changes the target set while a row is expanded** — the open MR on `demo` merges and a new one opens on the same target. The
   expanded row is keyed by `(project, targetBranch)`, so it stays open and now shows the new representative, with the merged one under `1 earlier MR`;
   a row whose target vanished simply goes, and nothing throws. → Task 5.
2. **A modifier-click on a control inside a surface** — Cmd-click on the card's `!iid` link or its `Run ▾` chip. The inner control keeps its own behaviour
   (the link opens its tab, `Run ▾` opens its popover) and the ticket page does NOT open. → Task 8.
3. **A walk on the page followed by a reload** — two Children steps in, then remount: the page opens on the ticket last on screen (the key store was
   written per step) with an empty walk and `← Board`. → Task 8.
4. **More than three Delivery targets in the strip** — five open leads, updated 1 h (green), 2 h (grey), 3 h (amber), 4 h (amber), 5 h (red) ago, so
   `leadOrder` is green, grey, amber, amber, red: three pills drawn (red, amber 3 h, amber 4 h), then `+2` in green's tone — the first folded pill in the
   strip's own order (red, amber, then the rest in `leadOrder`). → Task 4.
5. **Storage that throws** (private mode, quota) on an ignore or tab write — the click still takes effect on screen (mounted readers update through the
   store's listeners; `persistedStore`'s existing `try`/`catch` shape), nothing throws to React. → Task 3.

## File map

| File | Action | What |
| ---- | ------ | ---- |
| `client/src/lib/delivery.ts` | Modify | `deliveryTargets`, `deliveryNext`, `olderMrsLine`, exported types; `deliveryLook` untouched |
| `client/src/lib/ignored-steps.ts` *(name)* | Create | ignore entry types, `isIgnoredSteps` guard, `ignoreHolds`, `pruneIgnored` — pure |
| `client/src/hooks/useIgnoredSteps.ts` *(name)* | Create | the `backlog-manager.jira-ignored-steps` store: read, `ignore`, `unignore` |
| `client/src/hooks/persistedStore.ts` | Modify | generalised to a JSON value (`persistedJsonStore`); header's user list |
| `client/src/lib/jira-page.ts`, `client/src/hooks/useJiraPage.ts` | Modify | `ticket` page; header comments |
| `client/src/hooks/useJiraTicketKey.ts` *(name)* | Create | `backlog-manager.jira-ticket-key` store, `useJiraTicketKey`, `setJiraTicketKey` |
| `client/src/hooks/useJiraDetailTab.ts` *(name)* | Create | `backlog-manager.jira-detail-tab` store |
| `client/src/lib/jira-strip.ts` *(name)* | Create | `stripDelivery`, `stripAgent` — pure |
| `client/src/components/jira/JiraTicketBody.tsx` *(name)* | Create | heading, strip, tab row, pane switch |
| `client/src/components/jira/JiraTicketStrip.tsx` *(name)* | Create | the strip |
| `client/src/components/jira/JiraTicketPane.tsx` *(name)* | Create | Ticket tab: description + Details |
| `client/src/components/jira/JiraDeliveryTab.tsx` *(name)* | Create | head line, target rows, worktrees fold |
| `client/src/components/jira/DeliveryTargetRow.tsx` *(name)* | Create | one `details` row: compact summary, expanded pane, older fold |
| `client/src/components/jira/NextRow.tsx` *(name)* | Create | the next row: sentence, button by kind, `Ignore` |
| `client/src/components/jira/DeliveryPane.tsx` | Modify | ring + `next · <word>` + `ignored` on the track; `Also:` line gone; ReviewRow slot replaced |
| `client/src/components/jira/ReviewRow.tsx` | Modify | becomes the next row's review-button branch (gate, split, reason line), or folds into `NextRow` |
| `client/src/components/jira/JiraAgentTab.tsx`, `JiraChildrenTab.tsx` *(names)* | Create | Agent and Children & comments panes |
| `client/src/components/jira/JiraSessionCard.tsx` | Modify | no Stop when `link.action === 'review'` |
| `client/src/components/jira/JiraDetail.tsx` | Modify | modal frame onto the body; regions moved out (779 lines today) |
| `client/src/components/ui/Modal.tsx` | Modify | a head + single-body shape (builder's call, §7.1) |
| `client/src/components/jira/JiraTicketPage.tsx` *(name)* | Create | the page frame |
| `client/src/lib/open-intent.ts` *(name)* | Create | `wantsPage(event)`, `fullPageTitle()` — pure |
| `client/src/components/jira/JiraView.tsx` | Modify | `ticket` page, empty-key fallback, origin, `openPage` |
| `client/src/components/SideRail.tsx` | Modify | conditional `<KEY>` row |
| `JiraCard.tsx`, `JiraIssueList.tsx`, `JiraAgentDeck.tsx`, `JiraSessionList.tsx`, `JiraBoardView.tsx` | Modify | modifier-click → page; titles |
| `client/src/lib/review-copy.ts` | Modify | `Review · ` prefix |
| `server/src/jira/prompt.util.ts` | Modify | `reviewText` request half wording (lines ~158–170) |
| `client/src/styles.css` (or the Jira sheet the code uses) | Modify | strip, tabs, rows, ring, folds |
| tests — see each task | Create/Modify | |
| docs — Task 10 | Modify | |

---

### Task 1: `deliveryTargets` and the older-MRs line

**Files:**
- Modify: `client/src/lib/delivery.ts` (beside `leadMr`, line 89)
- Test: `test/gitlab/delivery-lib.test.ts`

**Interfaces:**
- Consumes: `leadOrder` (module-private, line 76), `leadMr`, `GitlabMr`.
- Produces:
  - `interface DeliveryTarget { project: string; target: string; lead: GitlabMr; older: GitlabMr[] }` — `older` newest `updatedAt` first.
  - `deliveryTargets(mrs: readonly GitlabMr[]): DeliveryTarget[]` — groups by `(project, targetBranch)`, `lead` by `leadMr` within the group, groups
    ordered by `leadOrder` over their leads; `[]` for `[]` (no throw).
  - `olderMrsLine(t: DeliveryTarget): string | null` — §4.3's summary, `null` when `older` is empty.

- [ ] **Step 1: Write the failing tests** (spec T1–T6, plus the line):
  - T1: one MR → one group, `older` `[]`, `olderMrsLine` → `null`.
  - T2: two open MRs, same project, into `develop` (updated 1 day ago) and `demo` (2 days ago) → `['develop', 'demo']`; swap the stamps → `['demo',
    'develop']`.
  - T3: `develop`: 1 open + 2 merged; `demo`: 1 open + 3 merged + 1 closed → `demo`'s `older.length` 4; `olderMrsLine` →
    `4 earlier MRs into demo · 3 merged, 1 closed`; `develop` → `2 earlier MRs into develop · 2 merged`.
  - An older open MR: `demo` with 2 open + 1 merged → the lead is the newer open one, `older` = 1 open + 1 merged → `2 earlier MRs into demo · 1 merged,
    1 open` (the open part goes last — §4.3 names it as an addition). One older merged only → `1 earlier MR into demo · 1 merged`.
  - T4: `develop` in `acme/pay-api` and in `acme/pay-web` → two groups.
  - T5: a target with only merged MRs (3, distinct `updatedAt`) → `lead` is the newest.
  - `older` order: a target with an open lead, then merged `!11` (1 day ago), closed `!12` (2 days ago), merged `!13` (3 days ago) → `older` iids
    `[11, 12, 13]` (newest first, NOT `leadMr`'s state-ranked `also`, which would give `[11, 13, 12]`).
  - T6: for every fixture above, `deliveryTargets(mrs)[0].lead === leadMr(mrs).lead`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm exec jest test/gitlab/delivery-lib.test.ts` → `deliveryTargets is not a function`.
- [ ] **Step 3: Implement** the three exports. `leadOrder` stays private; reuse it, do not copy it.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jira): group a ticket's MRs per target branch`.

### Task 2: Ignore entries and `deliveryNext`

**Files:**
- Create: `client/src/lib/ignored-steps.ts`
- Modify: `client/src/lib/delivery.ts`
- Test: `test/gitlab/delivery-lib.test.ts`, `test/gitlab/ignored-steps.test.ts` (new)

**Interfaces:**
- Consumes: `reviewState` (`shared/review.ts`), `ReviewState`, `GitlabPipeline`, `deliveryLook`, `reviewStepWord` (`lib/review-copy.ts`).
- Produces (`lib/ignored-steps.ts`):
  - `type IgnoreEntry = { review?: { state: ReviewState | 'unread'; landedAt: string | null }; pipeline?: { status: GitlabPipeline; updatedAt: string } }`
  - `type IgnoredSteps = Record<string, IgnoreEntry>`; `ignoreKey(mr: GitlabMr): string` → `` `${mr.project}!${mr.iid}` ``.
  - `readIgnoredSteps(v: unknown): IgnoredSteps` — a repairing guard, not a yes/no one: it keeps the well-formed half of each entry (§4.5.1's rule) and
    drops the rest; a non-object → `{}`. Own-property keys only, built on a null-prototype or `Object.entries` copy (a key `__proto__` or `constructor`
    is data and never reaches the prototype).
  - `ignoreHolds(entry: IgnoreEntry | undefined, mr: GitlabMr, now: number): { review: boolean; pipeline: boolean }` — review holds while the current
    state (`'unread'` for `review === null`) equals `entry.review.state` AND `(mr.review?.landedAt ?? null) === entry.review.landedAt`; pipeline holds
    while `mr.pipeline === entry.pipeline.status` AND `mr.updatedAt === entry.pipeline.updatedAt`.
  - `pruneIgnored(all: IgnoredSteps, ticketMrs: readonly GitlabMr[] | null): IgnoredSteps` — `null` (payload `null` or delivery not `mrs`) → `all`
    unchanged (same reference); otherwise drops the keys of `ticketMrs` whose `state !== 'opened'`, touches no other key.
- Produces (`lib/delivery.ts`):
  - `type NextButton = 'request' | 'fix' | 'run' | 'merge' | 'gitlab' | null`
  - `interface DeliveryNext { step: 'review' | 'pipeline' | 'merged' | null; word: string | null; pill: string; sentence: string | null; button:
    NextButton; ignore: 'review' | 'pipeline' | null; ignored: { review: boolean; pipeline: boolean } }` — `step` names the `TrackStep.step` to ring
    (`null` = nothing ringed); `ignore` is which step `Ignore` would store (`null` = no Ignore); `ignored` says which steps draw `ignored`.
  - `deliveryNext(mr: GitlabMr, now: number, ignored: IgnoreEntry | undefined): DeliveryNext`.

The precedence, since the table alone does not fix it (code block allowed — the order is the decision):

```
merged/closed            → done: step null, pill deliveryLook.word, button null, ignore null
review null (unread)     → unless ignored: waiting, pill deliveryLook.word, sentence row 2, ignore 'review'
state none|stale|open    → unless ignored: step 'review', word review|re-review|fix <n>[+], button request|request|fix, ignore 'review'
state reviewing          → waiting: pill reviewStepWord, ignore null
state unknown            → unless ignored: waiting, pill reviewStepWord, ignore 'review'
(clean, or ignored)      → fall through
draft                    → step 'merged', word 'mark ready', button 'gitlab', ignore null   (pipeline is off on a draft)
pipeline failed          → unless ignored: step 'pipeline', 'fix pipeline', button 'run', ignore 'pipeline'
pipeline canceled        → unless ignored: step 'pipeline', 're-run', button 'gitlab', ignore 'pipeline'
pipeline running         → waiting: pill deliveryLook.word, ignore null
success                  → step 'merged', 'merge', sentence row 9, button 'merge'
null | 'none'            → step 'merged', 'merge', sentence row 10, button 'merge'
```

`pill` is `next: <word>` whenever `step` is set; `sentence` is `null` on Review rows (the caller draws `reviewRowText`). The next row draws when it has
a sentence, a button OR `ignore !== null`; for `unknown` that is `Ignore` alone, with no sentence (the spec gives none and `reviewRowText` has none for
`unknown`; invent no copy).

- [ ] **Step 1: Write the failing tests** (T7, T29's pure half, T30's pure half). Fixture MR: `acme/pay-api!41`, open, not draft, `updatedAt` 2 h ago;
  vary `review` (via `test/helpers/gitlab.ts`'s builders if present, else local ones) and `pipeline`. Assert `step`, `word`, `pill`, `sentence`,
  `button`, `ignore` for each of §4.5's fourteen rows exactly as the table, plus:
  - findings `open` (2) + pipeline `failed` → row 5 (`next: fix 2`, `fix`); capped review with 3 open → `next: fix 3+`.
  - clean draft → `mark ready`, `Still a draft — mark it ready in GitLab.`, `gitlab`; draft with review `none` → row 1.
  - `unknown` → waiting, pill = `reviewStepWord(review, now)`, `ignore: 'review'`; `reviewing` → `ignore: null`.
  - entry `{ pipeline: { status: 'failed', updatedAt: mr.updatedAt } }` under a clean review + failed pipeline → row 9, `ignored.pipeline` true.
  - entry `{ review: { state: 'none', landedAt: null } }` over pipeline `success` → row 9.
  - entry for `failed`, pipeline now `running` → row 7, `ignored.pipeline` false.
  - entry for `failed` with an older `updatedAt` → row 8.
  - entry `{ review: { state: 'unread', landedAt: null } }` with `review: null` → falls through to the pipeline rows.
  - entry `{ review: { state: 'open', landedAt: T1 } }` with the review now `open` but `landedAt` T2 → row 5, `ignored.review` false; entry
    `{ review: { state: 'none', landedAt: null } }` with the review now `open` → row 5, `ignored.review` false.
  - pipeline `'none'` and `null` → row 10.
  - `deliveryLook(mr, now)` deep-equals a snapshot taken from today's code for every fixture (write the expected objects literally from the current
    output before Step 3, so a change to `deliveryLook` fails).
  - `readIgnoredSteps`: `{ 'a!1': { review: { state: 'bogus', landedAt: null } } }` → `{}`; `landedAt: 5` → dropped; `'{'` (non-JSON, passed as the
    store's parse failure) → `{}`; an entry with a good `pipeline` and a bad `review` keeps the pipeline half; `__proto__` as a key does not pollute
    `Object.prototype`.
  - `pruneIgnored`: two keys, `acme/pay-api!41` (ticket A, open) and `acme/pay-web!7` (another ticket, merged); `ticketMrs` = A's group with `!41` open
    → both kept; `!41` merged → `!41` dropped, `!7` kept; `ticketMrs` `null` → same reference returned.
- [ ] **Step 2: Run, expect FAIL** — `pnpm exec jest test/gitlab/delivery-lib.test.ts test/gitlab/ignored-steps.test.ts`.
- [ ] **Step 3: Implement** both modules. `deliveryNext` reads `reviewState` from `shared/review.ts`, never re-derives it.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm exec jest test/gitlab/review-copy.test.ts test/gitlab/review-state.test.ts` and `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jira): derive each MR's next delivery step and its ignore`.

### Task 3: Stores — ignore, detail tab, ticket key, `ticket` page

**Files:**
- Create: `client/src/hooks/useIgnoredSteps.ts`, `client/src/hooks/useJiraDetailTab.ts`,
  `client/src/hooks/useJiraTicketKey.ts`
- Modify: `client/src/lib/jira-page.ts:15` (`JIRA_PAGES`), `client/src/hooks/useJiraPage.ts`, `client/src/hooks/persistedStore.ts` (header list)
- Modify: `client/src/components/SideRail.tsx:309` — filter `ticket` out of the tree's `items` for now (Task 8 draws it), so the rail never draws an
  empty `ticket` row in between.
- Test: `test/jira/jira-lib.test.ts` (782 pins the four-page `JIRA_PAGES` — T17 lives there), `test/ui/persisted-store.test.tsx`,
  `test/jira/jira-view-store.test.tsx`, `test/jira/ignored-steps-store.test.tsx` (new)

**Interfaces:**
- Consumes: `persistedStore`, `readIgnoredSteps`, `pruneIgnored`, `ignoreKey` (Task 2), `isJiraKey` (`shared/types.ts:1393`).
- Produces:
  - `persistedJsonStore<T>(key: string, read: (v: unknown) => T): { useValue(): T; set(next: T): void }` in `hooks/persistedStore.ts` — the same
    module listener set and the same "mounted readers, no cached value" rule (`persistedStore.ts:14-17`); `persistedStore` becomes a thin wrapper over it
    (guard + fallback as `read`). One file still holds `new Set<Listener>`, so `test/ui/persisted-store.test.tsx:130-136`'s source guard stays green
    unchanged — do not add a second holder. A write whose `setItem` throws still reaches every mounted reader through the listeners.
  - `useIgnoredSteps(): { entries: IgnoredSteps; ignore(mr: GitlabMr, step: 'review' | 'pipeline', ticketMrs: readonly GitlabMr[] | null): void;
    unignore(mr: GitlabMr, step: 'review' | 'pipeline', ticketMrs: readonly GitlabMr[] | null): void }` — each write records the current state and
    stamp (`'unread'` and `null` for a `null` review), drops the other half only if it is the one named, removes an emptied entry, and runs
    `pruneIgnored(…, ticketMrs)` first.
  - `type DetailTab = 'ticket' | 'delivery' | 'agent' | 'children'`; `DETAIL_TABS`; `useJiraDetailTab(): DetailTab`; `setJiraDetailTab(t)` — key
    `backlog-manager.jira-detail-tab`, fallback `ticket`.
  - `useJiraTicketKey(): string`; `setJiraTicketKey(k: string): void` — key `backlog-manager.jira-ticket-key`, guard `isJiraKey(v) || v === ''`,
    fallback `''`.
  - `JIRA_PAGES` = `['board', 'sessions', 'mentions', 'setup', 'ticket']`.

- [ ] **Step 1: Write the failing tests:**
  - T17 (`test/jira/jira-lib.test.ts:782`): `JIRA_PAGES` equals `['board', 'sessions', 'mentions', 'setup', 'ticket']`; `isJiraPage('ticket')` true.
  - T28 (guard half): stored `"foo"` under the key store reads `''`; stored `"PAY-12"` reads `PAY-12`.
  - Tab store: stored `"delivery"` reads `delivery`; `"bogus"` reads `ticket`; two mounted readers both re-render on one `setJiraDetailTab('agent')`.
  - T29 (store half): `{ review: { state: 'none', landedAt: null } }` and `{ review: { state: 'unread', landedAt: null } }` survive a write, an unmount
    and a remount (re-read from `localStorage`); a stored non-JSON string reads `{}`.
  - T30 (store half): through `ignore()` — A's `!41` ignored; a write for ticket B whose `ticketMrs` hold a merged `!7` leaves `!41`; A's write with
    `!41` merged drops it; a write with `ticketMrs` `null` drops nothing.
  - Review Focus 5: `localStorage.setItem` mocked to throw → after `ignore()` and `setJiraDetailTab()` the mounted readers show the new value; no error
    thrown.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Update the header comments: `persistedStore.ts`'s list of its users, `useJiraPage.ts`'s stale "board, sessions or setup"
  (now five pages), `jira-page.ts`'s list.
- [ ] **Step 4: Run, expect PASS** — the new suite, `test/jira/jira-lib.test.ts`, `test/ui/persisted-store.test.tsx`, `test/jira/jira-view-store.test.tsx`, `test/ui/rail.test.tsx`
  (the filtered tree), `test/jira/jira-sections.test.tsx`; typecheck. `JiraView` with `ticket` stored and no page component yet: Task 8 owns it; until
  then the `default` branch of `JiraView`'s page switch must draw the Board — check it does, and if not, make `ticket` draw the Board here.
- [ ] **Step 5: Commit** — `feat(jira): stores for the detail tab, the ticket key and ignored steps`.

### Task 4: `JiraTicketBody` — heading, strip, tabs, Ticket pane

Mocks: `html/Main.html` (`.strip`, the tab row, the Ticket pane), `html/B-Modal.html` (same body in the modal).

**Files:**
- Create: `client/src/lib/jira-strip.ts`, `client/src/components/jira/JiraTicketBody.tsx`, `JiraTicketStrip.tsx`, `JiraTicketPane.tsx`
- Modify: `client/src/components/jira/JiraDetail.tsx` — its module-private helpers the body needs (`WorktreesList` 592, the function at 615,
  `ChildrenTree` 656, `ChildSessionLine` 721, `ParentSessionLine` 735, `JiraMoveRows` 752) each move to their own file under `components/jira/`,
  exported, unchanged; `JiraDetail` imports them back. Tasks 5 and 6 consume them from those files.
- Modify: `client/src/styles.css` (or the sheet the Jira components use)
- Test: `test/jira/jira-strip-lib.test.ts` (new), `test/jira/jira-ticket-body.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `deliveryTargets`; `deliveryLook`, `ticketDelivery`, `deliveryShown`, `useGitlabContext`; `STATE_LABEL` (`shared/jira-sessions`),
  `pollAge`; Task 3 `useJiraDetailTab` / `setJiraDetailTab`; the facts and controls `JiraDetail.tsx` draws today (Status `Move to` popover and
  `JiraMoveRows` at 752, `Assign to me`, `issueDatesLine`, the `Fact` rule, `renderMarkdown` clamp + `Show more`).
- Produces:
  - `stripDelivery(targets: DeliveryTarget[], multiProject: boolean, now: number): { pills: { key: string; label: string; tone: DeliveryTone }[];
    more: { count: number; tone: DeliveryTone } | null }` — `key` = `` `${project}\u0000${target}` `` (the row id Task 5 opens).
  - `stripAgent(live: <the live rows the band reads today>, ended: number, now: number): { lead: …; more: number } | { idle: string }` — lead by
    `question` → `working` → `starting` → other, newest first within a state; `idle · N ended` or `no sessions`.
  - `JiraTicketBody` props: `{ issue: JiraIssue; detail: JiraIssueDetail | null; failure: string | null; back: … | null; onBack; onOpenIssue;
    onWrote; onRun; onReview?; tree: <children source>; worktrees: … }` — the builder settles the exact list from what `JiraDetail` passes its regions
    today. It draws no crumbs, no frame head and no `Run ▾`. **Ownership:** each frame owns the detail read and re-read (`JiraDetail.tsx:243-249` today;
    the page reads by key) and passes `detail` / `failure` / `onWrote` (re-read) down; the body owns the one `useAction` write guard
    (`JiraDetail.tsx:217`) and draws the write-error line (`role="alert"`, under the strip; today 311–339) because its strip holds the write controls. It renders the Agent, Delivery and Children panes as named slots that Tasks 5–6 fill; until
    then those tabs draw today's regions moved as they are (the agent band content, `DeliveryPane`, Children + Worktrees).

- [ ] **Step 1: Write the failing tests.** Fixtures: `PAY-12` Story, assignee `Dana Novak`, sprint `Sprint 40`, parent `PAY-3`, two targets
  (`develop` pipeline failed → red; `demo` open review `none`), sessions: one `working` 3 min, one `question` 10 min (older), five ended.
  - T8: tablist with `Ticket`, `Delivery 2 targets`, `Agent 2 live`, `Children & comments <n>`; a `hidden` delivery → three tabs.
  - T9: click `Agent` → store `agent`; rerender with `PAY-13` → Agent selected; `PAY-14` with `hidden` delivery under stored `delivery` → Ticket shown,
    store still `delivery`.
  - T10: focus on `Ticket`, ArrowRight → `Delivery` selected; ArrowLeft from `Ticket` wraps to the last.
  - T11: the Status chip opens `Move to`; `Assign to me` disabled with today's title (copy it from `test/jira/jira-detail.test.tsx`); the `develop` pill
    has the red tone on the Ticket tab; clicking the Agent pill selects `Agent`.
  - T27: the Agent pill reads `<STATE_LABEL.question> · 10m` (whatever `pollAge` prints) and `+1`, not the working one.
  - `stripAgent` with a `starting` reservation alone → age from `startedAt`.
  - Review Focus 4: the five-target fixture above → pills red, amber, amber in that order, then `+2` in green's tone.
  - `kind: 'none'` → one pill `no MR`; `kind: 'unknown'` → `unknown` with today's unknown title; `hidden` → no Delivery cell.
  - A failing `Assign to me` write draws its error in the `role="alert"` line under the strip, on every tab.
  - Ticket pane: `Resolved <date>` drawn when `resolved` is set, absent when `null`; a ticket with no labels draws no `Labels` fact; Details pane holds
    Reporter, Priority, Created · updated, On boards, Repository, Session and none of Status / Assignee / Sprint / Parent.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Tabs follow the WAI-ARIA tabs pattern (`role="tablist"`, `role="tab"` buttons with `aria-selected` and `aria-controls`,
  roving `tabIndex`). A fallback tab is computed per render, never written.
- [ ] **Step 4: Run, expect PASS**, plus `test/jira/jira-detail.test.tsx` still green (JiraDetail is not yet moved onto the body) and typecheck.
- [ ] **Step 5: Commit** — `feat(jira): ticket body with summary strip and tabs`.

### Task 5: Delivery tab — target rows, next row, older MRs, worktrees

Mocks: `html/Main.html` (`details.tgt`, the next row, the older fold, the Worktrees fold), `html/States.html` (one card per §4.5 row).

**Files:**
- Create: `JiraDeliveryTab.tsx`, `DeliveryTargetRow.tsx`, `NextRow.tsx` (under `client/src/components/jira/`)
- Modify: `DeliveryPane.tsx` (the track gains the ring, `next · <word>` / `next`, and `ignored`; the `Also:` block, ~118–133, goes; the `ReviewRow` at 117 becomes
  a `next` node), `ReviewRow.tsx` (its gate, split, hidden/disabled rules and reason line become `NextRow`'s `request`/`fix` branch — keep the rules,
  move or wrap the component), `JiraTicketBody.tsx` (fill the Delivery slot), styles
- Test: `test/jira/jira-delivery-tab.test.tsx` (new), `test/jira/jira-delivery-pane.test.tsx`, `test/jira/jira-delivery-surfaces.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 (`deliveryTargets`, `olderMrsLine`, `deliveryNext`, `useIgnoredSteps`), `reviewRowText`, `reviewGate` (`ReviewRow.tsx:45`), `reviewHalf`,
  `JiraRunMenu`, `SessionOpen`, `WorktreesList` (`JiraDetail.tsx:592`, drawing `WorktreeRow` from `./JiraWorktreeRow`); the strip's
  row id from Task 4.
- Produces: `DeliveryPane` props become `{ issue: JiraIssue; mr: GitlabMr; now: number; next: DeliveryNext; via: string | null; onUnignore(step:
  'review' | 'pipeline'): void; children: ReactNode }` — `mr` is one target's lead, `children` is the next row; it no longer resolves the ticket's
  delivery itself (`kind` handling moves to `JiraDeliveryTab`).
- Produces: `JiraDeliveryTab` props `{ issue; now; onReview?; onRun; openRows: ReadonlySet<string>; onToggleRow(id: string): void; onOpenRow(id: string): void; liveReviewLink: <the
  newest live link with action 'review', or null>; worktrees }`. The body holds `openRows` — independent folds, not an accordion (default: the first group's
  id alone; reset on ticket swap); a strip pill click adds its row and leaves the others as they are.

- [ ] **Step 1: Write the failing tests** (fixture of T3 on `PAY-12`, project `acme/pay-api`):
  - T12: two rows; `develop` open with the full track and a next row; `demo`'s summary shows `+4 earlier`; open it → `develop` stays open, and nested fold reads
    `4 earlier MRs into demo · 3 merged, 1 closed`; open that → four rows newest first, `from <branch>` only on the one whose source differs.
  - T13: strip `demo` pill click → Delivery selected and the `demo` row open.
  - T14: `demo` (open, review `none`) next-row button calls `onReview` with `demo`'s iid and `half: 'request'`; a target whose lead is merged draws no
    next row; the ringed dot carries the ring class/`data-next` and the label `next · review`.
  - T24: row 5 with a live link `action: 'review'` on the key → `Open session` (clicking opens that session via `SessionOpen`'s path); with only an ended
    review link → today's split, fix half preset.
  - T25: `develop` (clean review, pipeline failed): `Ignore` → `localStorage` `backlog-manager.jira-ignored-steps` holds `{ "acme/pay-api!<iid>": {
    pipeline: { status: 'failed', updatedAt: <the MR's updatedAt> } } }`; the Pipeline step reads `ignored` with the exact title; the compact pill reads
    `next: merge`; clicking `ignored` removes the entry; the strip's `develop` pill stays red throughout.
  - `unknown` review on the open row: the next row draws `Ignore` alone, no sentence, no button; clicking it stores `{ review: { state: 'unknown',
    landedAt: <the review's landedAt> } }` and the pill moves on to the pipeline rows.
  - T29 render half: `Ignore` on a `none` review (row 3) → the Review step reads `ignored`; unmount and remount the tab → still `ignored`.
  - Row 8: the next row draws a `JiraRunMenu` (find it by its accessible name, as `test/jira/jira-run-menu.test.tsx` does); row 9: `Merge in GitLab ↗`
    with the MR's `webUrl`, `target="_blank"`; row 12: `GitLab ↗`.
  - `kind: 'none'` and `kind: 'unknown'`: `JiraDeliveryTab` draws today's two sentences (`DeliveryPane.tsx:90-100`, copied unchanged) in place of rows,
    and the Delivery tab draws no count.
  - Head line: `Branch <source>` when both groups share it, absent otherwise; `2 targets · 8 MRs`; a sub-task inheriting → `via PAY-3`.
  - The repo basename shows in compact rows only when groups span two projects.
  - Worktrees fold: closed, `Worktrees 2`; an unmapped ticket (no Delivery tab) draws it at the bottom of Ticket.
  - Review Focus 1: rerender with `demo`'s open MR merged and a new open one on `demo` → the `demo` row is still open, shows the new lead, and its fold
    reads `5 earlier MRs into demo · 4 merged, 1 closed`; rerender with `demo` gone → one row, no error.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Until Task 7, the old modal's delivery region (`JiraDetail.tsx:414`) renders `JiraDeliveryTab` in place of `DeliveryPane`,
  so the modal stays green between Tasks 5 and 7. Each row is a `<details>` (or a button + region with `aria-expanded`); fold state lives in the body, keyed by row id.
  `Ignore` writes pass the ticket's delivery MRs (or `null` when the payload is `null` or the delivery is not `mrs`) as `ticketMrs`.
- [ ] **Step 4: Run, expect PASS**, plus `test/jira/jira-detail.test.tsx`, `test/jira/jira-delivery-pane.test.tsx` and `test/jira/jira-delivery-surfaces.test.tsx` (update the `Also:`
  and lead-only ReviewRow cases to the new placement — those cases are the old behaviour, so changing them is the task, not a regression) and typecheck.
- [ ] **Step 5: Commit** — `feat(jira): one delivery row per target with the next step`.

### Task 6: Agent tab, Children & comments tab, Stop off review sessions

Mocks: `html/B-Modal.html` (Agent tab with History open), `html/Main.html` (Children & comments).

**Files:**
- Create: `JiraAgentTab.tsx`, `JiraChildrenTab.tsx`
- Modify: `JiraSessionCard.tsx` (line 105 `stoppable` also requires `link.action !== 'review'`), `JiraTicketBody.tsx`
- Test: `test/jira/jira-ticket-body.test.tsx`, `test/jira/jira-session-open.test.tsx`

**Interfaces:**
- Consumes: the band regions of `JiraDetail.tsx` (365–425: `bandSub` 356, `nextLine` 361, `No session on this ticket` 401, History 417–420,
  `ChildSessionLine` / `ParentSessionLine` 721/735), `ChildrenTree` (562/656), `JiraHistoryLine`.
- Produces: the two panes filling Task 4's slots; their props are what those regions read today.

- [ ] **Step 1: Write the failing tests:**
  - T15: History fold closed with `5 ended · last <date, time>`; opened, five rows each with `Reopen`; a live card with `action: 'review'` and a
    `stopState` has no `Stop session` in its `Session actions` menu; an `execute` card with a `stopState` still has it.
  - Agent tab, no live session: `No session on this ticket`, the `default: <action> · last run <age>` line, and no `Run ▾` in the pane; the gate line
    (`Next Run can start once this one is quiet.` or `Quiet — a new Run can start now.`) sits above the cards.
  - T16: Children row click calls `onOpenIssue` with the child and the selected tab stays (e.g. Agent); `← PAY-12` returns.
  - Children states: detail loading → `loading…`; failed read → nothing in the fold; zero children → `No child tickets.` and the tab has no count.
  - Comments fold closed; opened, today's `Comments stay in Jira — v1 neither reads nor writes them.` and the issue's link.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Move the regions; change nothing in `JiraHistoryLine` or the session card beyond the Stop condition.
- [ ] **Step 4: Run, expect PASS**, plus `test/jira/jira-session-open.test.tsx`, `test/jira/jira-sessions-*.test.*` that render the card, typecheck.
- [ ] **Step 5: Commit** — `feat(jira): agent and children tabs; no Stop on a review session`.

### Task 7: The modal frame

Mock: `html/B-Modal.html`.

**Files:**
- Modify: `client/src/components/jira/JiraDetail.tsx` (head 430–455, `<Modal>` 460, facts 464–533, body 535+ — all moved onto the body), `client/src/
  components/ui/Modal.tsx` (head + single body shape)
- Test: `test/jira/jira-detail.test.tsx`, `test/ui/ui-modal.test.tsx`, `test/guards/dialog-count-docs.test.ts`, `test/board/dialog-escape.test.tsx`

**Interfaces:**
- Consumes: `JiraTicketBody` (Tasks 4–6); `setJiraTicketKey` (Task 3).
- Produces: `JiraDetail` gains `onOpenPage?: (key: string) => void` (Task 8 wires it; absent → the chip is not drawn). Its other props are unchanged.

- [ ] **Step 1: Write the failing tests:** the head holds today's crumb line, `Open full page ↗`, `Open in Jira ↗`, `Run ▾` and the close; the body is
  the tablist; no facts column (`.ui-modal` split class absent or the facts slot empty — whichever shape Step 3 picks, assert it); `Open full page ↗`
  calls `onOpenPage('PAY-12')`; Escape still closes the whole dialog; the walk's `← <key>` still pops. Re-point every existing `jira-detail.test.tsx`
  case that queried a fact or the band by its old column to the tab that now holds it — a case's assertion stays; only where it looks changes.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep the one `useAction` guard, the `shownKey` reset, `useParentRead`. If `Modal` gains a shape, its header comment says
  which composers use it; the `Mentions` modal's `lead` shape is untouched.
- [ ] **Shared cases:** move T8, T9, T11, T15 and T16 from `test/jira/jira-ticket-body.test.tsx` into a case table in `test/helpers/ticket-body-cases.ts`
  (`(mount: (fixture) => void) => void`, registering the `it`s), run here through the modal; Task 8 runs the same table through the page (spec §9, "in
  the modal and on the page with the same fixtures").
- [ ] **Step 4: Run, expect PASS** — the four suites above, `test/jira/jira-mention-modal.test.tsx`, `test/ui/ui-modal-scroll-style.test.ts`,
  `test/guards/design-guards.test.ts`, typecheck.
- [ ] **Step 5: Commit** — `feat(jira): detail modal draws the tabbed ticket body`.

### Task 8: The ticket page, the rail row, modifier clicks

Mock: `html/Main.html` (`.topbar`, the page body).

**Files:**
- Create: `client/src/components/jira/JiraTicketPage.tsx`, `client/src/lib/open-intent.ts`
- Modify: `JiraDetail.tsx` / the moved `ChildrenTree` (the Children row button, `JiraDetail.tsx:686` today) — a modifier-click surface too.
- Modify: `JiraView.tsx` (page switch at 103–113; the walk and launch reset on page change), `SideRail.tsx` (220 tree map, 309 `RailTree`), `JiraCard.tsx`,
  `JiraIssueList.tsx` (row 346), `JiraAgentDeck.tsx` (91), `JiraSessionList.tsx` (318), `JiraBoardView.tsx` (`openWithTree`), `JiraDetail.tsx` (wire
  `onOpenPage`)
- Test: `test/jira/jira-ticket-page.test.tsx` (new), `test/ui/rail.test.tsx`, `test/jira/jira-board.test.tsx`, `test/jira/jira-list.test.tsx`,
  `test/jira/jira-sections.test.tsx`

**Interfaces:**
- Consumes: Task 3 stores; `fetchJiraDetail` (`lib/jira.ts:1253`); `JiraTicketBody`; `JiraRunMenu`; `onOpenJiraPage` (`App.tsx:292`, type unchanged).
- Produces:
  - `wantsPage(e: { metaKey: boolean; ctrlKey: boolean; button: number }): boolean` — `metaKey || ctrlKey || button === 1`.
  - `fullPageTitle(platform: string): string` — `⌘-click: full page` on macOS (`/Mac/` in `navigator.platform` or `userAgentData`), else
    `Ctrl-click: full page`.
  - In `JiraView`: `openPage(issue | key, origin: 'board' | 'sessions' | 'mentions')` — sets the key, holds `origin` in state, calls
    `onOpenJiraPage('ticket')`. `onOpenIssue` callers gain a way to pass the click event (or a second callback); a plain click still opens the modal.

- [ ] **Step 1: Write the failing tests:**
  - T18: modal `Open full page ↗` → modal gone, key `PAY-12`, page `ticket`, page draws from `fetchJiraDetail` alone (mock it; no board fixture).
  - T19: stored key, no board poll → `loading…` then the body; a rejected read → `could not read the ticket — <sentence>` and `Retry`.
  - T20: page `ticket`, key `''` → the Board draws and the page store reads `board` after the effect.
  - T21: rail draws the `PAY-12` row only while the key is held; clicking it sets page `ticket`.
  - T22: entered from Sessions → `← Sessions` returns to Sessions; entered by the rail row, or after a remount → `← Board`.
  - T23: Cmd-click, Ctrl-click and middle-click (`auxclick`, `button: 1`) on a Board card, a List row, a deck card, a Sessions row and a Children row
    in the modal → no dialog, page
    `ticket`, key set, origin that page; a plain click on each → the dialog, page unchanged. Each surface's `title` contains the platform's text.
  - T28: failing read → `Retry` calls `fetchJiraDetail` again; `Forget PAY-12` → key `''`, back on the origin, rail row gone.
  - The shared case table from Task 7 (`test/helpers/ticket-body-cases.ts`), mounted through the page.
  - Pre-issue frame: before the read lands the top bar shows `Jira / PAY-12` and `← Board`, and no `Open in Jira ↗` or `Run ▾`; after it lands,
    `Jira / <board> / PAY-3 <summary> / PAY-12` (board crumb only when the ticket is on the picked board), `Open in Jira ↗` and `Run ▾`.
  - Page write: `Assign to me` on the page posts, then the page re-reads `fetchJiraDetail` (called twice) and draws the new assignee.
  - Page walk: a Children row click sets the key to the child and shows `← PAY-12`; Back sets it back. A later failed re-read keeps the drawn issue
    and shows the failure line under the strip.
  - Review Focus 2: Cmd-click AND middle-click on the card's `!iid` link and its `Run ▾`, and middle-click on a link or button inside a List row and a
    Sessions row → page unchanged, no dialog. Inner controls that stop `click` today (`JiraCard.tsx:139,158`) also stop `auxclick`.
  - Review Focus 3: two walk steps, unmount, remount → the page shows the last child, no `←` walk chip, `← Board`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The rail filter from Task 3 becomes "draw `ticket` only while a key is held, labelled with the key, with the ticket
  glyph". The page mounts no board poll; its Children tab shows the detail's direct children only. The walk is the page's own state, emptied when the
  page is left.
- [ ] **Step 4: Run, expect PASS** — the new suite, the suites in **Files**, `test/jira/jira-view-store.test.tsx`, `test/jira/jira-session-open.test.tsx`,
  the source-guard hits for `useJiraPage`, `setJiraPage`, `fetchJiraDetail`, typecheck.
- [ ] **Step 5: Commit** — `feat(jira): a full ticket page under the Jira section`.

### Task 9: Review copy and the review prompt

**Files:**
- Modify: `client/src/lib/review-copy.ts` (`reviewRowText`, line 72), `server/src/jira/prompt.util.ts` (`reviewText`, line 162; the strings at 158 and
  169)
- Test: `test/gitlab/review-copy.test.ts`, `test/jira/jira-prompt.test.ts`, `test/jira/agents-dispatch-jira.test.ts` (pins `` `@coderabbitai review` `` at
  963), `test/jira/jira-delivery-pane.test.tsx` (pins `CodeRabbit · …` at 344/347), `test/jira/jira-delivery-tab.test.tsx`

**Interfaces:** none new; `reviewText`'s signature and its callers are unchanged.

- [ ] **Step 1: Write the failing tests** (T26): `reviewRowText` for an `open` review starts `Review · `; the `request` prompt contains no
  `@coderabbitai`, still names the mr-review-loop skill and its trigger step, and says to mention the repository's review bot account with `review` when
  the skill names no trigger; the `fix` prompt is unchanged apart from any bot name. T26's render half, in `test/jira/jira-delivery-tab.test.tsx`: with
  an `open` review on the expanded row, no rendered text in the Delivery tab contains `CodeRabbit`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** First `grep -rln "coderabbitai\|CodeRabbit ·" test/` and update every pinned string it finds (today also
  `test/gitlab/gitlab-review-fold.test.ts`, `test/gitlab/gitlab-poller.test.ts`, `test/gitlab/gitlab-env.test.ts` — check each hit is a drawn string or
  a prompt, not a server-side identifier, before changing it). Then grep the client for any other drawn `CodeRabbit` string (`grep -rn "CodeRabbit" client/src --include='*.tsx' --include='*.ts'`)
  and change only drawn strings; identifiers, file names and comments keep their names (§4.7).
- [ ] **Step 4: Run, expect PASS** — every suite in **Files** and every grep hit from Step 3, plus `test/jira/jira-launch.test.tsx` (the preview text),
  typecheck.
- [ ] **Step 5: Commit** — `fix(jira): never name the review bot in copy or prompt`.

### Task 10: Docs

**Files:** exactly §10's list.
- `.claude/DESIGN.md` §8.9.2 (line 648) rewritten for strip / tabs / panes / page; §8.9.6 (745) Detail paragraph; "CodeRabbit row" → "Review row";
  §8.0 (166) the conditional `<KEY>` rail row; §8.9.5 (730) Review mode paragraph.
- `.claude/rules/board.md` line 62's Jira pages rule → five pages, `ticket`, `backlog-manager.jira-ticket-key`, `Open full page ↗` among the threaded
  links; the CodeRabbit button rule → "The review button is the MR's", ReviewRow for each expanded open target, `jira-ignored-steps` named; the `Run ▾`
  rule's "agent column" → the frame's head and the `run` next row; the Escape rule's Move-to home if it moved.
- `.claude/rules/jira.md` line 176's `review` bullet: the `request` half posts the skill's review trigger, no `@coderabbitai`.
- `docs/subsystems/invariants.md`: rename the two headings; update every anchor (`grep -rn "the-jira-sections-four-pages\|the-coderabbit-button-belongs"
  --include='*.md' .` → zero hits after, excluding `node_modules`).
- `docs/subsystems/board.md`, `docs/overview.md:219`, `docs/subsystems/jira.md:324`: four pages → five.
- `hooks/persistedStore.ts`, `lib/jira-page.ts`, `hooks/useJiraPage.ts` headers if Task 3 missed any.

- [ ] **Step 1:** Make the edits; new text wraps at 160.
- [ ] **Step 2:** `pnpm exec jest test/guards` (doc guards: dialog count, rules paths) → PASS; the anchor grep above → no hits.
- [ ] **Step 3: Commit** — `docs(jira): detail tabs, ticket page, per-target delivery`.

### Task 11: `/ui-verify`

- [ ] **Step 1:** Run `/ui-verify` with the mocks `html/Main.html` (page on Delivery), `html/B-Modal.html` (modal on Agent with History open) and
  `html/States.html` (the next-row states), against the running app (`pnpm run dev` + `pnpm run dev:web`, or the compose stack), with live data where a
  ticket has it and a fixture for a two-target ticket (the user's tickets mostly have one target). Light theme. Report overflow numbers at 1280 px and
  at 700 px.
- [ ] **Step 2:** Fix each defect it reports on the branch, one commit per fix, and re-run the touched suites.
