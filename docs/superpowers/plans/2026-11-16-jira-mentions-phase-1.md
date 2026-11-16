# Jira › Mentions, phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour and exact test cases, never literal code** (the user's standing rule, which overrides the writing-plans template's code
> blocks). Each task gives files, signatures, exact values and the test cases with their expected values; the implementer writes the bodies and may disagree
> with a choice here when the code shows a better one — say so in the task's report. Sizes in this plan are soft.

**Goal:** A fourth Jira page, Mentions, that lists every comment @-mentioning the user that they have not answered, with Dismiss, a thread-first modal, a
Sync now, a popover row and a rail count — phase 1 of the spec (read and dismiss; no Draft a reply).

**Architecture:** The Jira poller gains a mentions step on its existing `setTimeout` chain (one search JQL plus a comment read for long threads, every 3
min), caching every candidate mention in memory; dismissals live in a new server-owned store under `~/.backlog-manager/settings/` and are applied when a
payload is built, never baked into the cache. A new controller serves the list, the manual check, dismiss/restore and the modal's thread read. The client
adds the page from the Board page's own parts, a modal over `ui/Modal.tsx`, a row in the `JiraChip` popover and a rail entry through
`feat/rail-pending-counts`' map.

**Tech Stack:** NestJS (server), React + Vite (client), jest (all suites here sit in `test/jira/` or `test/ui/`), TypeScript shared types.

**Spec:** [docs/superpowers/specs/2026-11-16-jira-mentions-design.md](../specs/2026-11-16-jira-mentions-design.md) — read it whole before Task 1. Mocks:
[`2026-11-16-jira-mentions-mockups/canvas/`](../specs/2026-11-16-jira-mentions-mockups/canvas/) (open a `.dc.html` in a browser, or the canvas artifact
https://claude.ai/artifact/2uoCrFpdE3hYmCn3TpHGnP).

## Global Constraints

- Work only in `.worktrees/jira-mentions` on `feat/jira-mentions`; `git add <files>` by path, never `-A`. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before editing any file under a `.claude/rules/` glob (CLAUDE.md's Rule files table), `Read` that file first so its rule file is injected — `board.md`
  for `client/src/**`, `jira.md` + `security.md` for `server/src/jira/**`, `items.md` for `shared/types.ts`, `tests.md` for `test/**`.
- Every outbound Jira call goes through `JiraClient` in `server/src/jira/`; the token never appears anywhere else.
- Constants, exact: `JIRA_MENTIONS_POLL_MS = 180_000`, `JIRA_MENTIONS_WINDOW_DAYS = 30`, `JIRA_MENTIONS_ISSUE_CAP = 100`, `JIRA_THREAD_MAX = 100`,
  `JIRA_MENTIONS_EXCERPT_CHARS = 280`, dismiss batch 1–50 ids. The mention sweep reuses `SWEEP_FLOOR_MS` (5 000) from `poller.service.ts`.
- Store: `~/.backlog-manager/settings/jira-mentions.json`, override `BM_JIRA_MENTIONS_FILE`, `version: 1`, written with `writeJsonAtomic`.
- Error bodies follow `jira-write.controller.ts`: the mentions sweep's 409 `Jira is not being polled` and 429 `rate limited` + `retryAt` use `{ message }`
  exactly as the site sweep does (:111-112); every other sentence uses `{ error }` (:79, :133), which is the only key the client's `errorOf`
  (`client/src/lib/http.ts:17`) shows — `<id> is not an open mention on <KEY>` (400), `could not save — nothing changed` (500), `<KEY> is not readable`
  (404). Route tests assert the whole body.
- jsdom fixtures (Tasks 7-11) take `created`/`polledAt`/`retryAt` from `test/helpers/dates.ts` or a faked clock, never a literal date —
  `test/guards/fixture-clock.test.ts` fails literal ones, and `checked 1 min ago`, `2 h ago` and `14:32` need a controlled clock.
- Copy, exact: `N waiting · last 30 days · checked <age>` (List), `N tickets waiting · …` / `1 ticket waiting · …` (Cards), suffix
  ` · newest 100 tickets checked`, `checking…`, `Nothing waiting on you in the last 30 days.`, `Show dismissed · N`, `Restore`, `Dismiss`,
  `Open in Jira` (List) / `Reply in Jira` (Cards), `You have not commented since this mention.`,
  `Dismissed. It comes back if someone mentions you on <KEY> again.`, `Undo`, `on none of your boards`,
  `This ticket is on none of your boards, so the board cannot open it.`, `Mentions · N` with `checked <age> · every 3m`, `Jira asked to wait until HH:MM`,
  rail `1 ticket mentions you` / `<n> tickets mention you`.
- A diff that adds a caller of a shared hook, poller or helper: `grep -l <symbol> test/` and run every hit (CLAUDE.md, source guards). Run only the suites a
  task touches; CI runs the rest.
- Wrap new prose and comments at 160 columns; comments explain why, at this repo's density.

## Review Focus

1. **A check in flight across a Dismiss/Restore** must not undo the click when it swaps — pinned by deriving `issues`/`dismissed` at read time (Task 5 test
   "dismiss during an in-flight check survives the swap").
2. **A failed check after a good one** must keep the rows and `polledAt` and never read as "Nothing waiting" (Task 5 "5xx keeps rows", Task 8 "failed band
   keeps rows").
3. **A site with no boards, or every board `off`**, must still arm the poller and check mentions; the site Sync now must answer 200, not 409 (Task 5
   "arming with no boards", Task 6 "site sweep with all boards off").
4. **A comment edited to add a mention after the user replied** stays answered (judged by `created`) — Task 2 "edit after reply is not resurfaced".
5. **The user's own `@` of themselves** and a mention by the user in their own comment are never open — Task 2 "self-mention ignored".

---

### Task 1: Shared shapes, constants and `adfToText`

**Files:**
- Modify: `shared/types.ts` (beside the other Jira shapes, after `JiraStatusPayload` ~1152)
- Modify: `server/src/jira/adf.ts` (new export beside `adfToMarkdown`, line 265)
- Test: `test/jira/jira-adf.test.ts` (extend)

**Interfaces — Produces:**
- Constants above, exported from `shared/types.ts`.
- `JiraMention { commentId: string; author: { accountId: string; name: string; avatarUrl?: string }; created: string; excerpt: string; url: string }`
- `JiraMentionIssue { key; summary; type: string; status: { name: string; category: <the board issue's status category type> }; boards: string[];
  mentions: JiraMention[] }` — `mentions` newest first.
- `JiraMentionsPayload { configured: true; polledAt: string | null; detail: string | null; truncated: boolean; retryAt: string | null; window: number;
  me: string | null /* display name, for the @chip */; issues: JiraMentionIssue[]; dismissed: JiraMentionIssue[] }`, or the same `unconfigured` shape
  `GET /api/jira` answers.
- `JiraMentionsSummary { polledAt: string | null; count: number | null; detail: string | null; truncated: boolean; retryAt: string | null }`; and
  `JiraStatusPayload.mentions: JiraMentionsSummary | null` (`null` while unconfigured).
- `JiraThreadComment { id; author: { accountId; name; avatarUrl? }; created; markdown: string; mine: boolean; mentionsMe: boolean; open: boolean }`,
  `JiraThreadPayload { key; total: number; truncated: boolean; comments: JiraThreadComment[] }` (time order, oldest first).
- `adfToText(doc: unknown): string` in `adf.ts` — whitespace-collapsed plain text, NOT cut (Task 2 cuts).

- [ ] **Step 1: Failing tests in `jira-adf.test.ts`, `describe('adfToText')`:**
  - text nodes as written: `Hi *there*` stays `Hi *there*` (no markdown escaping — the contrast with `adfToMarkdown`).
  - mention `{type:'mention',attrs:{id:'a1',text:'@Mara Ilić'}}` → `@Mara Ilić`; `attrs.text: 'Mara Ilić'` (no `@`) → `@Mara Ilić`; never `@@`.
  - emoji `{attrs:{text:':)'}}` → `:)`; `hardBreak` between `a` and `b` → `a b`; two paragraphs `a`,`b` → `a b`.
  - `inlineCard {attrs:{url:'https://x.test/1'}}` → `https://x.test/1`; `mediaSingle`/unknown node types dropped; `null`/non-object → `''`.
  - runs of spaces/newlines collapse to one space, trimmed.
- [ ] **Step 2:** `pnpm exec jest test/jira/jira-adf.test.ts` → FAIL (`adfToText` not exported).
- [ ] **Step 3:** Implement `adfToText` and add the shared shapes/constants. Add `mentions` to `JiraStatusPayload`; `status()` returns `mentions: null` for
  now in both branches so typecheck passes (Task 6 fills it).
- [ ] **Step 4:** Tests PASS; `pnpm run typecheck` clean; `grep -l JiraStatusPayload test/` hits that build literal payloads gain `mentions: null` and pass.
- [ ] **Step 5:** Commit `feat(jira): mention shapes and adfToText`.

### Task 2: Mention judgement (pure)

**Files:**
- Create: `server/src/jira/mentions.util.ts`
- Test: `test/jira/jira-mentions-judge.test.ts`

**Interfaces — Consumes:** `adfToText`, `jqlString` (`jira.client.ts:71`), the Task 1 shapes. **Produces:**
- `mentionsJql(accountId: string, days: number): string` → `comment ~ <jqlString(accountId)> AND updated >= -<days>d ORDER BY updated DESC`.
- `MENTION_SEARCH_FIELDS = ['summary','status','issuetype','comment','updated']`.
- `mentionsUser(body: unknown, accountId: string): boolean` — true when the ADF holds a `mention` node whose `attrs.id === accountId`, at any depth.
- `RawComment { id: string; author?: { accountId?: string; displayName?: string; avatarUrls?: Record<string,string> }; created: string; body: unknown }`.
- `judgeComments(input: { comments: RawComment[]; me: string; site: string; key: string; now: number; windowDays: number; answeredAfter?: string | null }):
  JiraMention[]` — every CANDIDATE mention (open before dismissals), newest first; `url` = `https://<site>/browse/<KEY>?focusedCommentId=<id>` (spec "The
  page"); `site` is the configured host as the existing browse links use it.
- `excerptOf(body: unknown): string` — `adfToText`, cut at 280 on a word boundary with `…` (no cut when ≤ 280).

- [ ] **Step 1: Failing tests** (fixtures: me `acc-me`, Mara `acc-m`, Ivo `acc-i`; `now` fixed at `2026-11-16T12:00:00Z`; every comment a distinct id and time):
  - "mention found": Mara at 10:00 mentions me, no own comment → one mention, `commentId` hers, `author.name 'Mara Ilić'`, `url`
    `https://acme.atlassian.net/browse/SUP-208?focusedCommentId=<her id>` (site `acme.atlassian.net`, key `SUP-208`).
  - "answered by a later own comment": Mara 10:00 mentions me, mine 10:04 → `[]`.
  - "only mentions after my latest own comment": Mara 08:00, mine 09:00, Ivo 11:00 → only Ivo's; my earlier 07:00 comment does not count as latest.
  - "self-mention ignored": my own comment mentioning `acc-me` → `[]`, and it still counts as my latest comment.
  - "window edge": created exactly 30 days before `now` → kept; 30 days + 1 s → dropped.
  - "edit after reply is not resurfaced": Mara's comment `created` 08:00 (mentions me), `updated` 11:00, mine at 09:00 → `[]`.
  - "answeredAfter wins over an older own comment": mine 09:00, Mara 10:00, `answeredAfter` 10:30 → `[]`.
  - "mention of someone else": Mara mentions `acc-i` only → `[]`.
  - `mentionsJql('acc-"x', 30)` quotes through `jqlString` (assert the exact string); `excerptOf` of 300 words cuts ≤ 281 chars, ends `…`, breaks at a space.
- [ ] **Step 2:** `pnpm exec jest test/jira/jira-mentions-judge.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement. Judge by `created` only; a comment with no author id is never mine and never a candidate's author name `''` → `'Someone'`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(jira): judge open mentions from a comment list`.

### Task 3: The mentions store

**Files:**
- Create: `server/src/jira/mentions.store.ts`
- Modify: `docker-compose.yml` (the comment listing what the server writes under `settings/`, ~173-184: add `jira-mentions.json`)
- Modify: `test/helpers/jira-links-env.ts` (registered in `jest.config.ts:25`) — its `beforeEach` also points `BM_JIRA_MENTIONS_FILE` at a per-case temp
  path, so the poller and route suites of Tasks 5-6, which build the real store, never write the developer's `~/.backlog-manager/settings/`
- Modify: `test/guards/server-write-paths.test.ts` — `WRITERS` (:28) gains `'jira/mentions.store.ts': [jiraMentionsFile({})]`; run it in Step 4
- Test: `test/jira/jira-mentions-store.test.ts` (use a temp file via `BM_JIRA_MENTIONS_FILE`)

**Interfaces — Produces:** `jiraMentionsFile(env = process.env): string`; `class JiraMentionsStore` (Nest provider) with
`dismissed(): readonly JiraDismissal[]`, `dismiss(entries: JiraDismissal[]): void`, `restore(key: string): number` (how many dropped),
`isDismissed(commentId: string): boolean`; `JiraDismissal { commentId; key; created; dismissedAt }`. Writes throw on failure and leave memory unchanged.
Model it on `links.store.ts` (load once, per-entry fallback, `.bad-<ISO>` set-aside on the first save after an unreadable load).

- [ ] **Step 1: Failing tests:** default path ends `/.backlog-manager/settings/jira-mentions.json`; env override wins; missing file → empty; unreadable JSON
  → empty, and the first `dismiss` renames it to `jira-mentions.json.bad-<ISO>` then writes `version: 1`; an entry missing `commentId` is dropped, its
  siblings kept; save prunes a dismissal whose `created` is more than 30 days old; `restore('ABC-1')` with none → `0`, no write; a write that fails
  (directory made read-only, or `writeJsonAtomic` mocked to throw) throws and `dismissed()` is unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; register the provider in `jira.module.ts`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(jira): server-owned mentions store under settings/`.

### Task 4: `JiraClient.comments` and FakeJira support

**Files:**
- Modify: `server/src/jira/jira.client.ts` (after `issue`, ~132)
- Modify: `test/helpers/jira.ts` (`FakeJira`, line 100: inline `comment` field in search results, and the comment endpoint)
- Test: `test/jira/jira-client.test.ts` (extend)

**Interfaces — Produces:** `comments(auth, key, maxResults: number): Promise<JiraResponse<{ comments: unknown[]; total: number }>>` →
`GET issue/{key}/comment?orderBy=-created&maxResults=<n>`, counted by `takeCalls()` like every call. FakeJira: seed comments per issue
(`addComments(key, RawComment[])`), search returns the NEWEST 20 inline with `total`/`startAt`, and the endpoint honours `orderBy=-created` + `maxResults`.

- [ ] **Step 1:** Failing tests: the request URL (key encoded, `orderBy=-created`, `maxResults=100`); a call bumps `takeCalls()` by 1; FakeJira inline
  comments cap at 20 with `total` 23 for a 23-comment issue.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(jira): read an issue's newest comments`.

### Task 5: The poller's mentions step and arming

**Files:**
- Modify: `server/src/jira/poller.service.ts` — `owed()` (614), `sweep()`/`run()` (660-720), plus a mentions cache and step (a private method here, or a small
  `mentions.service.ts` the poller calls — builder's choice per the spec, as long as it shares the chain, `gate`/window, boot state and call counter).
- Test: `test/jira/jira-mentions-poller.test.ts` (FakeJira, fake timers as `jira-poller.test.ts` does)

**Interfaces — Consumes:** Tasks 2-4. **Produces** on `JiraPollerService`: `mentionsCache(): { polledAt: string | null; detail: string | null; truncated:
boolean; issues: (JiraMentionIssue & { candidates: JiraMention[] })[] }` (candidates, NOT dismissal-filtered) and `mentionsArmed(): boolean` (configured,
boot not `unsupported`).

Behaviour:
- **Arming:** `owed()` is true whenever the boot is not `unsupported` (mentions are always owed while configured) — the chain runs with no boards.
- **Due:** at once after boot, then `JIRA_MENTIONS_POLL_MS` after the last ATTEMPT. Runs inside the tick, after the board loop, so its calls land in
  `sweepCalls`. A board's 5xx/whole-board failure no longer `return`s past it: the mentions step still runs unless a 429 window is open or the boot is not
  answered (401).
- **Check:** one search page (`maxResults` 100, `JIRA_MENTIONS_ISSUE_CAP`), `truncated` when `isLast` is false. Per issue whose inline `total` > returned
  count: `comments(auth, key, JIRA_THREAD_MAX)`; 403/404 drops that issue; any other failure fails the whole check. `boards` holds the NAMES of the boards
  whose cache holds the key (`boardsHolding` answers ids, poller.service.ts:399 — map them to names, or add a names sibling).
  Issues ordered by newest candidate, newest first; issues with no candidate dropped.
- **Failure:** 401 → `boardFailed`'s 401 path (boot reset, `unauthorized`); 429 → `openWindow`; 403/404 on the search, 5xx, transport, 400 → mentions
  `detail` (the response's detail sentence), rows and `polledAt` kept, site `access` untouched.
- **Swap:** whole result replaces the cache with `polledAt = now`; dismissals are NOT applied here (Task 6 applies them on read).

- [ ] **Step 1: Failing tests:**
  - "arming with no boards": configured, `boards: []` → after boot the poller is `armed` and one search with the mentions JQL ran.
  - "arming with every board off": two `off` boards, swept once → still armed; a mentions search runs again after 180 000 ms, not before (advance 179 999 →
    no new search).
  - "mention found end to end": FakeJira issue `SUP-208` with Mara's mention → cache has one issue, one candidate, `boards: []`.
  - "board names": `PAY-131` held by board `Payments Q4` (id distinct from the name), `SUP-208` on none → `boards` `['Payments Q4']` and `[]`.
  - ">20 comments fetch": two 23-comment issues, each with Mara's mention at #2 (oldest three are outside the inline 20). `SUP-208` has my reply only at
    #3 (also outside) → `[]`; `PAY-131` has no own comment → one open mention. Two `comments` calls. A build that ignored the fetched page would open
    `SUP-208` and miss `PAY-131`.
  - "comment read 404 drops the issue": two issues, one 404s → cache holds the other, no `detail`.
  - "5xx keeps rows": good check, then search 503 → `issues` unchanged, `polledAt` unchanged, `detail` set, status `access` still `ok`.
  - "401 moves access": search 401 → status `access: 'unauthorized'`.
  - "429 window respected": search 429 `Retry-After: 60` → no mentions call until the window ends.
  - "board 5xx does not starve mentions": board search 503 and mentions due on the same tick → mentions search still runs.
  - "calls counted": a tick with one board page and a mentions search with one comment read → status `calls.sweep` 3.
  - "truncated": search answers `isLast: false` → `truncated: true`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `pnpm exec jest test/jira/jira-poller.test.ts test/jira/jira-sweep-route.test.ts`
  (arming changed — update any test that asserted "not armed without a syncing board" to the new rule, naming the spec section in the test). This task
  also lands the site sweep's half: beside forcing every non-`off` board (poller.service.ts:321), `sweepNow()` sets a `mentionsForced` flag that the
  mentions step's due test honours and clears, under the same in-flight join and floor. Rewrite `test/jira/jira-sweep-route.test.ts:90-96` ("409 when
  only off boards remain") to the new rule here, and make that suite's `onSearches` (:58) exclude the mentions JQL so its `onSearches() - cold` counts
  (:106, :115) stay board-only.
- [ ] **Step 5:** Commit `feat(jira): check mentions on the poller's chain`.

### Task 6: Payload, summary, manual check, dismiss/restore, thread — the routes

**Files:**
- Create: `server/src/jira/mentions.controller.ts` (register in `jira.module.ts`)
- Modify: `server/src/jira/poller.service.ts` — `status()` (333) fills `mentions`; `mentionsSweepNow()`; `thread(key)`
- Test: `test/jira/jira-mentions-routes.test.ts` (the app helper `test/helpers/app.ts`, as `jira-sweep-route.test.ts` does)

**Interfaces — Consumes:** Tasks 3-5. **Produces:** the five routes below (all `SameOriginPostGuard` on POSTs; key validated with `isJiraKey`).
- `GET /api/jira/mentions` → `JiraMentionsPayload`: `issues` = cache issues with their non-dismissed candidates (issues left with none move to `dismissed`,
  carrying their dismissed candidates); `polledAt: null` before the first check; `me` the boot's display name; unconfigured → the unconfigured shape.
- Status `mentions` summary: `count` = `issues.length` of that same derivation (tickets), `null` before the first check; `retryAt` the open window's end.
- `POST /api/jira/mentions/sweep` (no body) → `mentionsSweepNow()`: 409 `Jira is not being polled` when not `mentionsArmed()`; 429 `rate limited` +
  `retryAt` in a window; joins a check in flight; within `SWEEP_FLOOR_MS` of the last check's end answers the cache without a call; otherwise checks now
  and resets the 3-minute cadence. A 401/5xx inside is a 200.
- `POST /api/jira/mentions/dismiss` `{ key, commentIds }`: 1–50 ids, each a string of digits (400 otherwise); each must be a candidate on that key and not
  already dismissed (400 `<id> is not an open mention on <KEY>`); `created` from the cache; store write failure → 500 `could not save — nothing changed`;
  answers the new payload.
- `POST /api/jira/mentions/restore` `{ key }`: drops every dismissal for the key; none → 200 no-op; answers the new payload.
- `GET /api/jira/issue/:key/thread` → `JiraThreadPayload` from `comments(auth, key, JIRA_THREAD_MAX)` reversed to time order; `markdown` via
  `adfToMarkdown`; `open` = the Task 2 judgement minus dismissed ids; 403/404 → 404 `<KEY> is not readable`; other failures through the existing
  `routeFailed` mapping. Its calls are a route's (discarded by the next `takeCalls()`).
- The site sweep `POST /api/jira/sweep`: `sweepNow()`'s `not-armed` follows the widened arming — a site with every board `off` answers 200 and checks
  mentions in that press, through Task 5's `mentionsForced` flag. `mentionsSweepNow()` does NOT go through `tick()`: it calls the mentions check directly,
  outside the tick (spec "Sync now, two ways": boards are not swept; spec "It rides the Jira poller": a manual check's calls are a route's), sharing only
  the mentions check's own in-flight join, the `SWEEP_FLOOR_MS` floor and the cadence reset.

- [ ] **Step 1: Failing tests:**
  - "dismiss during an in-flight check survives the swap": hold the FakeJira search open, dismiss Mara's mention, release → payload `dismissed` holds
    `SUP-208`, `issues` does not.
  - "dismiss then a later new mention": dismiss on `SUP-208`, next check adds Ivo's newer mention → `issues` has `SUP-208` with only Ivo's; `dismissed` does
    not list it.
  - "restore merges back": after the above, restore → `SUP-208` carries both, newest first.
  - dismiss 400s: `[]`, 51 ids, `'12a'`, an id on another key (`<id> is not an open mention on SUP-208`), an already-dismissed id; 500 when the store
    throws, and a following GET still shows the ticket in `issues`.
  - restore with nothing dismissed → 200, payload unchanged.
  - sweep: unconfigured → 409 `Jira is not being polled`; inside a 429 window → 429 with `retryAt`; two presses within 5 s → one search; a press resets the
    cadence (the next background search is 180 000 ms after it); a board due at the moment of a mentions-only press is not searched by it; status
    `calls.sweep` is unchanged by the press.
  - "site sweep with all boards off": boot, let the boot's own mentions check finish (searches = 1), move past the floor, `POST /api/jira/sweep` → 200 and
    mentions searches = 2, board searches unchanged.
  - summary: before the first check `count: null`; after one with two waiting tickets and one dismissed `count: 2`; cross-origin POST → 403.
  - thread: time order, `mine` on my comment, `open` true only on Mara's undismissed mention after my latest comment; 404 → 404 `SUP-208 is not readable`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `test/jira/jira-routes.test.ts` (status shape).
- [ ] **Step 5:** Commit `feat(jira): mentions routes — list, check now, dismiss, restore, thread`.

### Task 7: The Mentions page slot, `useJiraMentions` and `useJira`'s timer

**Files:**
- Modify: `client/src/lib/jira-page.ts` (`JiraPage` + `JIRA_PAGES` = board, sessions, mentions, setup; header comment "four pages")
- Modify: `client/src/components/jira/JiraView.tsx` (101-110: draw the new page), `client/src/components/SideRail.tsx` (the Jira tree's page label `Mentions`)
- Create: `client/src/hooks/useJiraMentions.ts`, `client/src/lib/jira-mentions.ts` (fetch/post helpers, the derivations below)
- Modify: `client/src/hooks/useJira.ts` (`nextDelay`, 44-53)
- Test: `test/jira/jira-lib.test.ts` (extend — `JIRA_PAGES`/`isJiraPage`), `test/ui/rail.test.tsx` (extend — the Jira tree), `test/jira/use-jira.test.tsx`
  (extend), `test/jira/use-jira-mentions.test.tsx` (new)

**Interfaces — Produces:** `useJiraMentions(): { data: JiraMentionsPayload | null; loading; error; reload; sweep(): Promise<void>; checking: boolean;
dismiss(key, ids); restore(key) }` — one timer at `polledAt + JIRA_MENTIONS_POLL_MS + TRACKER_FETCH_SLACK_MS`, floor `JIRA_STATUS_FLOOR_MS`, focus
refetch, newest read wins, no timer while unconfigured; a POST answer replaces `data`. `checking` is true while its own sweep is out or `polledAt` is null
and no blocking `access`/`retryAt`. `nextDelay` takes the sooner of the board deadline and `mentions.polledAt + JIRA_MENTIONS_POLL_MS + slack` (floor
15 000) when `data.mentions` is non-null.

- [ ] **Step 1: Failing tests:**
  - `isJiraPage('mentions')` true; `JIRA_PAGES` order exactly `['board','sessions','mentions','setup']`; the rail tree shows `Mentions` between Sessions
    and Setup and picking it draws the page.
  - `nextDelay`: no boards, `mentions.polledAt` = now − 60 000 → 120 500; all boards `off` + `mentions: null` → `null` (unchanged); a board due in 10 000
    and mentions in 120 500 → 15 000 (floor).
  - `useJiraMentions`: unconfigured → no timer; `polledAt` now − 179 000 → refetch at 15 000 (floor), not at 1 500; a slower first read answering after a
    faster second does not overwrite it.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (the page body may be a placeholder until Task 8). **Step 4:** PASS, plus every `grep -l useJira test/` hit.
- [ ] **Step 5:** Commit `feat(client): Jira › Mentions page slot and its poller`.

### Task 8: List view, band and the page's states — mock `Main.dc.html` (band states: `Sync.dc.html`)

**Files:**
- Create: `client/src/components/jira/JiraMentionsView.tsx`, `client/src/components/jira/JiraMentionList.tsx`
- Modify: `client/src/components/jira/JiraIssueList.tsx` only if lifting its frame/row shell into a shared piece (spec "The page"), with its existing
  tests (`test/jira/jira-list.test.tsx`) green and unchanged
- Create: `client/src/hooks/useJiraMentionsView.ts` (persisted `'list' | 'cards'`, key `backlog-manager.jira-mentions-view`; Show dismissed key
  `backlog-manager.jira-mentions-dismissed`, both through `persistedStore` as `useJiraView` does)
- Modify: `client/src/styles.css` only for the new columns and the `@name` chip, in DESIGN.md's tokens
- Test: `test/jira/jira-mentions-page.test.tsx`

Draw it from `Main.dc.html`: `Band` with title `Mentions`, the sub-line, the `Segmented` track switch as `JiraViewSwitch` draws it, a `.board-band-search`
input (placeholder `search mentions`), the `Show dismissed · N` chip and a `Sync now` chip; the `.jira-issues-*` table with columns Key, Summary (type icon),
Asked by (avatar disc + name), Comment (excerpt, title = full excerpt, the user's own `@<me>` as a tinted chip in place), Status (dot + name), Boards
(names, or muted `none`), When, and the hover-faded actions (Open in Jira → `url`, Dismiss). One row per candidate; dismissed rows dimmed with Restore.

- [ ] **Step 1: Failing tests** (fixture: `SUP-208` with two mentions, `PAY-131` with one on board `Payments Q4`, one dismissed `OPS-9`; me `Andreja`):
  - sub-line `3 waiting · last 30 days · checked 1 min ago`; with `truncated` → ends ` · newest 100 tickets checked`.
  - 3 rows; `SUP-208` twice; Boards cell `none` muted for it and `Payments Q4` for `PAY-131`; the excerpt `ask @Andreja about it` renders `@Andreja` as the
    chip element.
  - search `mara` keeps only Mara's rows (matches author, key, summary, excerpt case-insensitively).
  - `Show dismissed · 1` toggles a dimmed `OPS-9` row with `Restore`; Restore calls `POST /api/jira/mentions/restore` `{ key: 'OPS-9' }`.
  - Dismiss on a `SUP-208` row posts both its ids.
  - `polledAt: null` → sub-line `checking…`, chip disabled, no "Nothing waiting".
  - healthy empty → `Nothing waiting on you in the last 30 days.`; unconfigured → the other pages' Setup pointer.
  - "failed band keeps rows": `detail: 'Jira answered 503'` with rows → rows drawn and the reason in the sub-line's red span.
  - `access: 'unauthorized'` before a first check → the Board band's access sentence, not `checking…`; `retryAt` 14:32 future → `Jira asked to wait until
    14:32` and the chip's tooltip says the same.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `test/jira/jira-list.test.tsx`.
- [ ] **Step 5:** Commit `feat(client): Mentions list view`.

### Task 9: Cards view — mock `ListB.dc.html`

**Files:** Create `client/src/components/jira/JiraMentionCards.tsx` (from `JiraCard`'s look); Test: extend `test/jira/jira-mentions-page.test.tsx`.

One card per ticket: key, summary, status, the NEWEST candidate quoted (`Mara Ilić asked you · 2 h ago` over the excerpt), `+N earlier mention` /
`+N earlier mentions`, the boards line, actions `Reply in Jira`, `Dismiss`. Two columns, one below 1000 px (`useNarrow` or a CSS rule — match how the Board
does it). The sub-line counts tickets.

- [ ] **Step 1: Failing tests:** switch to Cards → 2 cards; `SUP-208`'s card quotes the newer mention and reads `+1 earlier mention`; sub-line
  `2 tickets waiting · last 30 days · checked 1 min ago`; one ticket → `1 ticket waiting · …`; the pick survives a remount.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(client): Mentions cards view`.

### Task 10: The mention modal — mock `ModalA.dc.html`

**Files:** Create `client/src/components/jira/JiraMentionModal.tsx` (composes `client/src/components/ui/Modal.tsx`, line 53); Test
`test/jira/jira-mention-modal.test.tsx`.

Opens from a row's key/excerpt or a card. Reads `GET /api/jira/issue/:key/thread` and `GET /api/jira/issue/:key` fresh on open. Header: type swatch, key,
type, project, `on none of your boards` when `boards` is empty, summary, `Mention i of N` with prev/next over the view's visible order (dismissed only while
Show dismissed is on), Close. Left: `Comments · <total>`, comments in time order, those before my latest own comment folded under
`Show N earlier comments`, each `open` comment with the amber strip `Asks you · <age>`, mine labelled `You`, `@Name` chips; markdown through the same safe
renderer `JiraDetail` uses. Footer: `You have not commented since this mention.`, `Dismiss`, `Reply in Jira` (primary, the focused-comment `url`); after
Dismiss `Dismissed. It comes back if someone mentions you on <KEY> again.` + `Undo` (restore). For a dismissed ticket: `Restore` + `Open in Jira`. Right:
Ticket facts (status, assignee, reporter, priority, parent, updated, description's first lines, `Open ticket in Jira`) and, for no board, the note
`This ticket is on none of your boards, so the board cannot open it.`

- [ ] **Step 1: Failing tests** (Task 8's fixture with times: `SUP-208` Ivo 3 h ago and Mara 5 h ago, `PAY-131` 4 h ago — so the payload orders
  `SUP-208`, `PAY-131`; List rows run ticket by ticket in payload order, each ticket's mentions newest first): in List, opening `SUP-208`'s first row
  fetches both routes once; header shows `on none of your boards` and `Mention 1 of 3`; next → `Mention 2 of 3`, still `SUP-208` (Mara's comment
  focused, no refetch); next → `Mention 3 of 3`, `PAY-131` (no badge, no note). In Cards, `SUP-208` opens as `Mention 1 of 2`; next → `PAY-131`; two earlier comments fold under `Show 2 earlier comments`; the open comment carries `Asks you`; Dismiss posts, footer swaps, Undo
  restores; thread 404 → `SUP-208 is not readable` in the modal; Escape closes it (the Escape stack); a dismissed `OPS-9` opens with `Restore`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `test/guards/dialog-count-docs.test.ts` and every `grep -l "Modal" test/ui test/guards` hit. Update
  board.md, invariants.md's Escape entry, `useDialogEscape.ts`'s header and `dialog-count-docs.test.ts` (eight → nine) together in this task, then run it.
- [ ] **Step 5:** Commit `feat(client): the mention modal, thread first`.

### Task 11: Popover Mentions row and band Sync now — mock `Sync.dc.html`

**Files:** Modify `client/src/components/JiraChip.tsx` (board rows ~206); Test `test/jira/jira-chip.test.tsx` (extend).

Under the board rows: a `tracker-row` `Mentions · <count>` (`—` while `count` is null), sub-line `checked <age> · every 3m`, the failure in red, a
`tracker-sync` icon that posts `/api/jira/mentions/sweep` and spins while out. The head's site-wide Sync now is unchanged in code (the server now checks
mentions in that press). Hidden while `mentions` is null (unconfigured).

- [ ] **Step 1: Failing tests:** `Mentions · 3` with `checked 1 min ago · every 3m`; `count: null` → `Mentions · —`; `detail` → red text; the icon posts the
  mentions sweep once and is disabled while out; a 429 answer shows `Jira asked to wait until 14:32`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(client): Mentions row in the Jira pill's popover`.

### Task 12: Rail entry — mock `Rail.dc.html`

**Files:** Modify `client/src/lib/rail-counts.ts` (`RailCountsInput` gains `jiraMentions: number`, `openJiraMentions?: () => void`; `out.jira.mentions`),
`client/src/components/SideRail.tsx` (feed it from `useJiraContext().data?.mentions?.count ?? 0`; `openJiraMentions` sets the Jira page to `mentions` and
the section to `jira`); Test `test/ui/rail-counts-lib.test.ts`, `test/ui/rail.test.tsx`.

PR #528 (`rail-counts.ts`, `railCounts()` at `SideRail.tsx:201`) is already merged into this branch (merge of `origin/main`, b3dd6a58).

- [ ] **Step 1: Failing tests:** `railCounts({ …, jiraMentions: 1 })` → `jira.mentions` `{ n: 1, tone: 'warn', label: '1 ticket mentions you' }`; 3 →
  `3 tickets mention you`; 0 → no entry. `sectionTotal` with only mentions → `onOpen` opens Mentions; with sessions and mentions both non-zero → no
  `onOpen` (a span), label `1 session needs you; 2 tickets mention you` in tree order.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(client): rail count for Jira › Mentions`.

### Task 13: Rules and docs that change with phase 1

**Files:** `CLAUDE.md` (the caches invariant: "four caches" → five, naming mentions); `docs/subsystems/invariants.md` (that section, ~3608 — its heading
is an anchor that `CLAUDE.md`, `.claude/rules/tracker.md` and `docs/subsystems/gitlab.md` link, so a renamed heading updates all three links);
`.claude/rules/tracker.md` (its cache mechanism count); `.claude/rules/board.md` ("The Jira section's three pages" → four; eight dialogs on the Escape
stack → nine and the `Modal` composer list — together with the other places that pin the count: `test/guards/dialog-count-docs.test.ts` (:50-52, :63,
:93), `docs/subsystems/invariants.md`'s Escape entry (~2228) and `client/src/hooks/useDialogEscape.ts`'s header (~36), all landed in Task 10; the
client-poller bullet gains `useJiraMentions` and `useJira`'s widened `nextDelay`); `.claude/rules/jira.md`
("armed only while a board syncs" headline and mechanism → armed while configured and not `unsupported`); `docs/subsystems/` Jira/board/api docs where they
list Jira routes or pages; `docs/superpowers/specs/2026-11-16-jira-mentions-design.md` status line ("phase 1 built").

- [ ] **Step 1:** `grep -rn "four caches\|three pages\|eight dialogs\|armed only while a board\|[Ee]ight dialogs\|[Ee]ight since" CLAUDE.md docs .claude/rules client/src test` — every hit is in this list or
  is fixed. **Step 2:** Edit each (one sentence per rule; keep each rule file's mechanism-only shape and its `Why:` link). **Step 3:** run
  `pnpm exec jest test/guards` (rule-file guards). **Step 4:** Commit `docs: rules and docs for Jira mentions phase 1`.

### Task 14: `/ui-verify` against the mocks

- [ ] Run `/ui-verify` with the mock files `Main.dc.html`, `ListB.dc.html`, `ModalA.dc.html`, `Sync.dc.html` (and `Rail.dc.html` if Task 12 landed) against
  the live app (`pnpm run docker:up` or `dev` + `dev:web`) on real data — the user has waiting mentions today, so the page is not empty. Fix its defects on
  the branch, re-run the touched suites, commit `fix(client): ui-verify findings for Jira mentions`.
