# Jira › Mentions — design

Status: full design (project). Date: 2026-11-16. Branch `feat/jira-mentions`.

## Intent

People ask the user questions by @-mentioning them in comments on Jira tickets that sit on none of the boards the Jira section tracks — a support ticket, a
colleague's story, an old bug. Jira's bell is the only place those surface, and they get missed. The user wants one page in the board that lists **every
comment that @-mentions them and that they have not answered yet**, wherever the ticket lives, with a count on the rail so the page does not have to be opened
to learn that someone is waiting.

Success: a question asked of the user on any ticket shows up on the page within a few minutes, and leaves it when they reply on that ticket or click Dismiss.

## What the probe established (2026-11-16, against the real site, scoped token)

- **Jira's notification feed is not reachable.** The bell's `notification-log` API is internal; `https://<site>/gateway/api/notification-log/api/{2,3}/…`
  answers 404 to the scoped token. There is no public "unread notifications" API, so "unread" is not a state this app can read.
- **JQL finds mentions.** Jira indexes an ADF mention node by account id: `comment ~ "<accountId>" AND updated >= -30d` returned 20 tickets, `-60d` 41 —
  many on no tracked board. A display-name search (`comment ~ "\"First Last\""`) returns nothing and is not a substitute.
- **The comment body pins the exact mention.** A comment mentions the user when its ADF `body` holds a node `{ type: 'mention', attrs: { id: <accountId> } }`.
- **One search carries the comments.** `POST search/jql` with `fields: ['comment', …]` returns each issue's comments inline: the NEWEST 20 (`startAt` is
  `total − 20` when there are more), plus `total`. 2 of the 41 tickets had more than 20.
- **"Answered" is readable from the same list.** On TIMIFY-28575 the user replied 4 minutes after the mention (answered); on TIMIFY-27892 and TIMIFY-25324 the
  mention is newer than the user's last comment (waiting).

## Goals

- A fourth Jira page, **Mentions**, between Sessions and Setup (`JIRA_PAGES` order: board, sessions, mentions, setup).
- An **open mention** is a comment that (a) @-mentions the user's account id, (b) was not written by the user, (c) was created after the user's own latest
  comment on that same issue, (d) was created inside the lookback window, and (e) has not been dismissed.
- **One row per issue**, carrying that issue's newest open mention; earlier open mentions on the same issue show as `+N earlier`. A reply on the issue clears
  them all, which is the point: the user answers a thread, not a comment.
- A row shows: the issue key and summary, its status, who mentioned the user, how long ago, a plain-text excerpt of the comment, and an **Open in Jira** link
  that lands on the comment (`https://<site>/browse/<KEY>?focusedCommentId=<id>`).
- **Dismiss** on a row hides that issue's currently open mentions. A NEW mention on the same issue later brings the row back. A `Show dismissed` toggle lists
  the dismissed rows still inside the window, each with **Restore** — the one undo.
- The page band says how many are waiting and how old the answer is (`3 waiting · checked 2m ago`), and the failure reason when the last check failed.
- The rail shows the waiting count on **Jira › Mentions**, amber, through the pending-counts map that `feat/rail-pending-counts` introduces (see Constraints).
- The server checks in the background, on its own slower cadence, while Jira is configured — the user notices without opening the page.

## Non-goals

- Jira's own read/unread state, or marking anything read in Jira. Dismiss is local to this machine.
- Mentions in an issue's **description** or in Confluence — comments only.
- Replying, reacting or assigning from the page. Open in Jira is the way to answer.
- Phone or desktop push notifications. A later step if the rail count is not enough.
- Comments that ask the user something without @-mentioning them, and comments on tickets merely watched or assigned. The page is "someone named me".

## Anti-goals

- **A list that never empties.** A page full of FYI mentions the user already handled teaches them to ignore it — which is the failure we are fixing. Hence
  the reply rule plus Dismiss, and the window.
- **A list that empties on a blip.** A failed check must keep the last rows and their age, never show "Nothing waiting" — that is a claim the cache cannot make.
- **A Jira bill that grows with history.** Calls grow with tickets mentioning the user inside the window, not with all comments ever.
- **The token anywhere but the one header.** No new path for it; every call goes through `JiraClient`.

## Constraints

- **Scoped API token, gateway only.** Every read is `JiraClient` through `api.atlassian.com/ex/jira/<cloudId>`. The token's existing `read:jira-work` and
  `read:jira-user` cover search and comments; no new scope.
- **This is a fifth cache whose age is a rendered value.** CLAUDE.md's invariant says there are four (tracker, Jira board, pull-request, GitLab). The mentions
  cache is allowed for their reason — a per-request read would be a Jira call per page render and per rail poll — and is kept honest their way: `polledAt`
  rides on the payload and the page renders it; it moves only on a successful check; a failure keeps the last rows beside `access`/`detail`. The invariant's
  line in CLAUDE.md, its section in `docs/subsystems/invariants.md` and the mechanism in `.claude/rules/tracker.md` all say "five" when this lands.
- **It rides the Jira poller, not a second chain.** Same `setTimeout` chain, same boot state (`me.accountId` is needed and only exists after boot), same 429
  window and read gate, same call counter (the chip's CALLS meter must include these calls). Mentions are due every `JIRA_MENTIONS_POLL_MS` (3 min) since
  the last attempt, and at once after boot. The poller's arming rule widens: armed while the site is configured and not `unsupported` — mentions are owed
  even when every board is `off` or there are no boards.
- **`jira/` stays the outbound module.** Nothing new calls out from elsewhere.
- **The dismiss list is the server's own file**, the link store's pattern (`links.store.ts`): `~/.backlog-manager/jira-mentions.json`, overridable by
  `BM_JIRA_MENTIONS_FILE`, `version: 1`, written whole and atomically (`writeJsonAtomic`), the server its one writer. An unreadable file loads empty and is set
  aside as `.bad-<ISO>` on the first save. It holds dismissed comment ids with the issue key and the dismissal time; entries older than the window are pruned
  on save. It is not an item file and not `registry.json`, so neither single-writer invariant is touched.
- **The rail count depends on `feat/rail-pending-counts`** (spec `2026-11-16-rail-pending-counts-design.md`, unmerged on 2026-11-16), which makes a sub-page
  count "one entry in one map". This work lands after it and adds the entry; it does not build a second badge mechanism.
- Wrap new prose at 160; comments explain why at the repo's density; tests sit where `.claude/rules/tests.md` says.

## Approaches

1. **Background check on the Jira poller (picked).** One search per check, comments inline, a per-issue comment read only for the rare issue with more than
   20 comments; an in-memory cache; a rail count that is always current. A few dozen calls an hour. Picked because the problem is *noticing* — anything the
   user has to remember to open repeats today's failure.
2. **On open only.** Fetch when the page opens or on Refresh. No background calls, but no trustworthy rail count, so the user has to remember to look.
   Rejected: it is today's bell with extra steps.
3. **Background check plus a phone push per new mention.** Most noticeable, but the app has no notification channel of its own. Deferred as a later step
   (Non-goals), not rejected.

## How a check works

1. JQL `comment ~ <jqlString(me.accountId)> AND updated >= -<JIRA_MENTIONS_WINDOW_DAYS>d ORDER BY updated DESC`, fields `summary`, `status`, `comment`,
   `updated`, paged by `nextPageToken` at 100, capped at `JIRA_MENTIONS_ISSUE_CAP` (100 issues; `truncated` on the payload when it bites, shown in the band).
2. For an issue whose inline `comment.total` is larger than the comments returned, read the rest with `GET issue/{key}/comment` (paged) before judging it — an
   older unanswered mention or the user's own older reply could be in the part the search left out.
3. Per issue: find the user's latest own comment; collect comments that mention the user, are not the user's, were created after that and inside the window;
   drop dismissed ids. Comments are judged by `created`, not `updated` — an edit that adds a mention after the user replied is missed, and a typo fix to an
   old mention does not resurface it. That trade is deliberate: edits are rare, and resurfacing answered threads breaks the anti-goal.
4. Swap the whole result into the cache with `polledAt = now`. A 401, 429, 5xx or transport failure keeps the previous result and records the reason; a 400
   from the JQL (it is built from the account id, so it should never happen) is recorded as a failure too, never as an empty list.

`JIRA_MENTIONS_WINDOW_DAYS` is 30: long enough to cover a holiday, short enough that the list and the dismiss file stay small.

## Routes and shapes

- `GET /api/jira/mentions` → `{ access, detail, polledAt, truncated, window: days, rows: JiraMentionRow[], dismissed: JiraMentionRow[] }`, served from the
  cache, no Jira call. `rows` newest mention first. With Jira unconfigured it answers the same `unconfigured` shape `GET /api/jira` uses.
- `JiraMentionRow`: `key`, `summary`, `status` (name and category, as the board's issues carry it), `url` (the comment link), `mention`: `{ commentId, author:
  { accountId, name }, created, excerpt }`, `earlier: number`.
- `POST /api/jira/mentions/dismiss` `{ key, commentIds }` and `POST /api/jira/mentions/restore` `{ key }` — validate the key with `isJiraKey` and the ids as
  Jira's numeric ids, write the store, move the row in the cache at once (no Jira call), answer the new payload. Both under `/api` (the Vite proxy is
  untouched); both refused like every other write while the dashboard's security rules say so (`security.ts`).
- The excerpt is the comment's ADF rendered to plain text (the `adf.ts` markdown renderer, markup stripped), whitespace collapsed, cut at
  `JIRA_MENTIONS_EXCERPT_CHARS` (280) on a word boundary. Mentions inside it read as `@Name`.
- The shapes go in `shared/types.ts` beside the other Jira shapes.

## The page

- Built in `client/src/components/jira/`, drawn with `.claude/DESIGN.md`'s list language — the Sessions page's row (`JiraSessionCard`) is the nearest model
  and the builder should start there, not invent a new row.
- Band: `N waiting · checked 2m ago`, plus `truncated` and the failure reason when present; a Refresh is not offered (the server owns the cadence).
- Empty, healthy: "Nothing waiting on you" with the window ("in the last 30 days"). Empty because Jira is not set up: the same pointer to Setup the other
  pages use.
- Polled by the client on the same cadence the Jira status payload is (no faster than the server can change it).
- The rail count is `rows.length`, amber when > 0, absent at 0, through the pending-counts map.

## Left to the builder

- Where in `poller.service.ts` the mentions step sits, and whether it is a method there or a small service the poller calls — as long as it shares the chain,
  the gate, the window and the counter.
- Whether to skip re-judging an issue whose `updated` has not moved since the last check (an optimisation; correctness must not depend on it).
- Exact copy, icon, and the row's layout inside DESIGN.md's rules; the `Show dismissed` control's form.
- Test layout: server units over `FakeJira` (mention found, answered by a later own comment, self-mention ignored, window edge, >20 comments fetch, dismiss
  and a later new mention, failure keeps rows, 429 window respected, accountId quoted), the store's set-aside path, and the client page's states. The last
  plan task is `/ui-verify` against live data — the user has real waiting mentions today, so the page will not be empty.
