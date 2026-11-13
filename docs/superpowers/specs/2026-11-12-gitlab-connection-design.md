# GitLab connection — every Jira ticket's merge request, on the board

Status: draft, 2026-11-12. Mocks: `2026-11-12-gitlab-connection-mockups/` (canvas `canvas.json`; live copy https://claude.ai/artifact/9ExNThxnFRYmXzsfF6f1Qr).
Picked: `OptionC.dc.html` (Detail), `Cards.dc.html`, `List.dc.html`, `Settings.dc.html`. Rejected and kept for the record: `Main.dc.html` (A, an MR section
in the Ticket column), `OptionB.dc.html` (B, one fact row).

This is project 1 of 2. Project 2 — CodeRabbit findings on the board and a **Fix review** button that starts a session running the `mr-review-loop` skill —
builds on this one and is out of scope here (§9 says what this project must leave room for).

## 1. Intent

The user's work lands on a self-hosted GitLab (`www.gitlab.timify.io`): both repositories mapped to the `TIMIFY` Jira project in `jira.json`
(`microservice`, `dev-api-graphql-proxy`) are GitLab projects. Today the board knows a ticket's sessions and worktrees but nothing about what happened after
the push — whether an MR exists, whether its pipeline passed, whether it merged. The user follows that by opening GitLab per ticket.

The user's current loop, in their words: push and open the MR, comment `@coderabbitai review`, paste the MR link into a Claude session, have it wait for the
review, have it propose fixes and whether to resolve, then fix, push and resolve. The glue between those steps is manual. Project 1 gives the board the
missing half of that picture — **the delivery state of every ticket at a glance**, not only in the detail view (the user asked for this explicitly) — and is
the foundation project 2 hangs the review loop on.

## 2. Goals

1. **Connect** this machine's board to one GitLab site with a read-only token, configured like Jira and GitHub: per-machine env, never committed, status in
   Settings › Shared › Sources.
2. **Link tickets to MRs with no new configuration**: ticket key → the repos `jira.json` maps for its project → each repo's `origin` → the GitLab project →
   the MRs that carry the key.
3. **Show every ticket's delivery state** in three places:
   - **Detail**: a Delivery band in the Agent column (`OptionC.dc.html`).
   - **Board cards**: an MR chip in the card's foot, plus GitLab totals on the board's band line (`Cards.dc.html`).
   - **List**: a Delivery column (`List.dc.html`).
4. **Quick filters** over that state: `Has MR`, `Pipeline failing`, `Done, not merged`.
5. Keep it fresh in the background: a poller, so cards and the list are current without opening each ticket.

## 3. Non-goals

- CodeRabbit: reading its notes or threads, counting findings, the Review step's content, and any Fix button. That is project 2.
- Any GitLab write from the server: no MR creation, no notes, no resolve, no merge, no approve. The token is `read_api`, so it can't write anyway.
- GitLab for registry (`backlog/`) projects or a tracker backend on GitLab. Only Jira-mapped repositories are read.
- More than one GitLab site per machine.
- Changes to the GitHub PRs page or the GitHub token.
- Changes to how a Jira Run opens its MR (`closingRule` in `server/src/jira/prompt.util.ts` stays as is).

## 4. Anti-goals — failure even if it works

- **The token leaves the server.** No route, payload, log line, error message or URL carries it; the browser never talks to GitLab; a spawned session never
  receives it. Same rule as `githubToken()` and `jiraEnv()`.
- **The token goes to a host the operator didn't name.** The server builds every GitLab URL from `BM_GITLAB_SITE`. A host read from a repository's remote
  only decides *whether* a repo is on that site; it is never dialled. Two ways a URL the server did not build could still be dialled are closed: **redirects
  are refused, never followed** (a followed redirect would carry the `PRIVATE-TOKEN` header to wherever it points — `https://gitlab.timify.io` itself answers
  301), so a 3xx is a failed call; and **paging asks for the next page by number** (`page=N`) on a URL built from the site, never by following a response's
  `Link` header or `next` URL.
- **A remote's embedded credential leaks.** Remotes on this machine can be `https://oauth2:<PAT>@host/...`. The parsed host and path are kept; userinfo is
  dropped at parse time and never stored, logged or returned.
- **The wrong MR on a ticket.** `TIMIFY-12` must never match an MR for `TIMIFY-123`. A false link is worse than a missing one.
- **GitLab trouble takes the Jira board down.** A GitLab outage, a 401 or a slow site leaves every Jira view as it is today, minus or with stale delivery
  marks. Nothing Jira draws waits on GitLab.
- **Background traffic for nothing.** The poller is armed only while there is something to poll (§6.3).

## 5. Connection

### 5.1 Configuration

- `BM_GITLAB_SITE` — a hostname only (`www.gitlab.timify.io`): no scheme, path, port or query, the `BM_JIRA_SITE` rule. The server always speaks `https://`.
  Anything else reads as not configured, with the reason on the status payload.
- `BM_GITLAB_TOKEN` — a personal access token with **`read_api`** scope, from the user's own GitLab account. Both or neither: one missing is "not
  configured".
- Read from `process.env` per call, never cached, trimmed, whitespace-only counts as absent — the `githubToken()` / `jiraEnv()` reasoning.
- `.env.example` documents both, in the house style of the GitHub and Jira blocks, including: scope, where to create the token, that it is per machine,
  and that absent is a supported state.
- `docker-compose.yml` passes both through the way it passes `BM_JIRA_*`.
- The same `.env.example` block says, separately, that the `mr-review-loop` skill a session runs needs its **own** token with `api` scope (it pushes, posts
  notes and resolves threads), set as `GITLAB_TOKEN` in `~/.zshenv`. The server's token is never handed to it.

### 5.2 Status and identity

- `GET /api/gitlab` (or a field on an existing status payload — the builder's call) answers the connection state from memory and env, with no outbound call
  on the request path. It carries the site and the identity only (username, display name), never the token.
- Identity comes from GitLab's current-user endpoint, read at server start and again when the configured token or site changes (noticed on the next
  status read or sweep), never per request, and **independent of whether the poller arms** (my call) — so a bad token shows on the Sources row even when no
  mapped repo is on the site yet.
- States. `Settings.dc.html` shows what each state says; the row itself takes the **live** Sources shape — a `SettingsRow` named `GitLab` with a `StatusPill`
  whose word is the card's own `CARD_WORD` for its tone, and a hint of one or more lines (`client/src/components/settings/SourcesGroup.tsx`, the Jira row's
  shape). Where the mock's row shape or words differ, the live shape wins.

  | State | Decided by | Pill (tone → word) | Hint lines |
  | ----- | ---------- | ------------------ | ---------- |
  | not configured | site or token absent, or site not a bare hostname | grey → `not configured` | `set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart`; for a malformed site, `BM_GITLAB_SITE must be a hostname, like gitlab.example.com` instead |
  | rejected | the identity read answers 401, or 403 (GitLab's answer to a token whose scope cannot read the user) | red → `down` | `<site> refused the token (<status>) — <GitLab's message, if any>` |
  | unreachable | the identity read or a sweep gets no HTTP answer (DNS, TLS, timeout), a 5xx, or a 3xx (refused, §4) | red → `down` | `<site> did not answer — <short reason>` |
  | checking | configured, identity read not answered yet (boot, or just after a config change) | grey → `checking…` | `<site>` |
  | idle | identity read, but no `jira.json` repo resolves to the site; the poller does not arm | grey → `not polled yet` | `<username> · <site>`; `no mapped repository is on <site>` plus, when repos resolved elsewhere, ` — found <host>, <host>` |
  | connected | identity read and at least one repo resolves | green → `connected` | `<username> · <site>`; `N repos mapped via Jira › Setup › Repositories`; then one line per repo problem (below) |
  | rate-limited | connected, inside a stored 429 window | amber → `late` | the connected lines, then `rate limited — next read in <age>` |

  The hint names no scope: the server never reads a token's scopes, and the Jira banner's rule is that scopes are not served and not drawn (DESIGN.md
  §8.9). The mock's `· read_api` and `Jira › Repositories` are mock differences. Per-repo problem lines, under a `connected` row only (the pill stays green — one unreadable project
  does not make the source down): `cannot read <namespace/path> (<403|404>)` when that project's MR list answers 403 or 404; `<repo basename>: could not
  read origin` for every §6.1 git failure — `runGit` answers `null` for a missing remote, a failed read and a timeout alike, and the server adds no branch
  to tell them apart; `<namespace/path>: first <N> shown` past the page cap (§6.3).
- Which call decides what: the **identity read** (current-user endpoint) decides `rejected` versus a working token; a **project's MR list** call decides
  that project's `cannot read` line. A 403 on the identity read is `rejected`; a 403 on a project call is that project's line. A **401 on any call** — a
  token revoked after a good identity read — re-runs the identity read at once, so the row turns `rejected` within one sweep rather than waiting for a
  restart. The server does not guess scopes.
- **Read again** (the card's foot) sweeps GitLab too, beside GitHub and Jira (my call): its sweep route answers 409 when the poller is not armed, which the
  foot already treats as "nothing to sweep", not an error.

## 6. Linking tickets to merge requests

### 6.1 Repository → GitLab project

- Source: the repo paths in `jira.json`'s `repos`, per Jira project key. No new configuration file and no new Settings field.
- For each path, read `origin` through `runGit` (async, 10 s bound, the server-wide rule) — a git READ, so "the server never writes git" holds.
- Parse SSH (`git@host:ns/repo.git`, `ssh://...`) and HTTPS remotes, with or without userinfo. Keep `host` and the namespace path, drop `.git`, drop userinfo
  at once (§4).
- A repo is on the site when its remote's hostname equals `BM_GITLAB_SITE`, compared case-insensitively and exactly — no alias, no `www.` stripping, and
  for an `https://` remote only with no port or port 443. A repo on another host (a GitHub repo, another GitLab, a non-`www` spelling of the same server)
  is skipped for GitLab purposes; the `idle` row names the hosts that were found, so a near-miss spelling is visible rather than silent (§5.2). A repo with
  no `origin`, or one whose read fails, is a per-repo line on the Sources row, never an error on a card.
- The namespace path, URL-encoded, is the project id in every call (`development%2Fbackend%2Fmicroservice`) — no numeric id lookup, the same trick
  `mr-review-loop` uses.
- Re-derived on every sweep, so a `jira.json` edit or a changed remote takes effect on the next poll without a restart.

### 6.2 Ticket key → MRs

- **Reuse the existing matcher** — `branchCarriesKey` / `keysInBranch` in `shared/jira-branch.ts` — and write no new one. It is the rule the board already
  uses to find a ticket's sessions and worktrees by branch: case-insensitive, the key bounded on both sides by a non-alphanumeric character or the string's
  edge, anywhere in the name. So `timify-123-export`, `feature/TIMIFY-123` and `hotfix/timify-123` match `TIMIFY-123`; `timify-1234-x` and `xtimify-123` do
  not. (The real `microservice` repo has `hotfix/` and `fix/` Timify branches a prefix-only rule would miss.) An MR and a session agreeing on which ticket a
  branch belongs to is worth more than any narrower rule.
- An MR's keys are `keysInBranch(source branch)` united with the same scan over its **title** (the Timify title convention `timify-123 | summary`), over
  the Jira project keys `jira.json` maps the repo to. An MR may carry more than one key; it is shown on each.
- **A sub-task inherits its parent's MRs** (the user's pick). The user's team is assigned sub-tasks while the parent story owns the branch (DESIGN.md
  §8.9.1 `Run on`), so a sub-task with no MR of its own shows its parent's MRs, each marked `via <PARENT-KEY>` wherever the MR is drawn. A sub-task with
  MRs of its own shows those and not the parent's. "Sub-task" means `type.subtask === true` with `parent` set — a story under an epic has a `parent` too
  and inherits nothing — and inheritance is one level: the parent's own MRs, never the grandparent's. The parent key is the issue's `parent`, which the
  board already holds; no extra Jira read. An MR a sub-task shows through its parent is an **inherited** MR below.

### 6.3 What is read, and how often

- **Which MRs**: per mapped GitLab project, every MR in state `opened`, plus `merged` and `closed` ones updated in the last 30 days (my call — enough to
  show a recently finished ticket as merged without paging all history). Paged until done; a cap with a visible `first N shown` note if a project exceeds it.
  So a ticket whose MR merged or closed more than 30 days ago reads as having no MR; §7's no-MR copy says `in the last 30 days` for that reason.
  **Read order**: opened MRs first, then merged and closed, each by `updated_at` descending — so the cap cuts the oldest finished MRs, never an open one
  while finished ones are kept. A project that hit the cap is **capped**: §7 treats a no-MR ticket in a capped project as unknown, not none.
- **Per MR**: iid, title, web URL, state, draft flag, source and target branch, created-at, updated-at, merged-at, and the **head pipeline status**.
  GitLab's MR state `locked` reads as `opened`. Pipeline statuses fold into five: `success`; `failed`; **running** = `running`, `pending`, `created`,
  `waiting_for_resource`, `preparing`, `canceling`; `canceled`; and **none** = no pipeline, `skipped`, `manual`, `scheduled`, and any other value GitLab
  adds later. Pipeline status is read only for open MRs; how (MR detail vs pipelines endpoint) is the builder's call, bounded so one sweep's request count
  grows with open MRs, not all MRs.
- **Cadence**: one sweep every 2 minutes by default (my call), plus an immediate sweep when the poller arms. A `setTimeout` chain in the tracker poller's
  shape, never a `setInterval`. Respect `429` / `Retry-After` the way the Jira poller does (one stored window every caller checks).
- **One sweep in flight.** The timer, Read again's route and an `arm()` after a repos save all go through one sweep function; a call while a sweep runs
  starts nothing and joins the running sweep's promise, so an older sweep can never write the cache after a newer one. The sweep route awaits that promise,
  bounded (the Jira sweep route's `JIRA_SAVE_SWEEP_WAIT_MS` precedent), so the foot's re-read sees the fresh answer; past the bound it answers anyway and
  the sweep finishes behind it.
- **Armed only while** the connection is configured **and** at least one `jira.json` repo resolves to the site. Otherwise no timer runs and nothing is
  asked of GitLab (the identity read of §5.2 aside). It does **not** depend on the Jira boards or the Jira poller (my call): the payload is keyed by every
  ticket key found in the mapped projects' MRs, not by the keys on a board, so Detail works for an off-board ticket (Sessions › All tickets, a parent
  reached through `Run on`) and `gitlab/` never imports from `jira/`'s poller. This is the tracker poller's shape (armed on configuration plus something to
  poll, disarmed on the tick that finds either missing — `.claude/rules/tracker.md`).
- **What arms it**: `arm()` is called from the bootstrap hook, from the Jira repos save (beside the call that save already makes to
  `JiraLiveService.reposChanged`, so a repo mapped after boot arms the poller without a restart), and from GitLab's sweep route (Read again). `arm()`
  re-derives §6.1's mapping itself — off the request path's critical section, never awaited by the save's response — and a tick that finds nothing to
  poll disarms. An env change needs a restart anyway (§5.1).
- **Failure keeps the last good answer**: a failed sweep leaves the cached MRs and their `polledAt` as they were, and records the failure for the Sources
  row. The Jira poller's reasoning: a list that empties on a blip makes every chip vanish and flash back.

### 6.4 The cache and the invariants it touches

- This is a **fourth cache whose age is a rendered value** (the board shows `polled 2m`), kept honest the same way: in memory, lost on restart, `polledAt`
  per GitLab project. The headline "The tracker, Jira and pull-request caches are the three caches…" lives in three places that must change together:
  CLAUDE.md, its rule-file copy in `.claude/rules/tracker.md` (pinned byte-equal to CLAUDE.md's by `test/claude-rules.test.ts`), and the heading of
  `docs/subsystems/invariants.md` — whose heading is also the anchor every `Why:` link uses, so the anchor rename is followed in every link to it. The
  GitLab cache's own mechanism rules go in a new rule file, `.claude/rules/gitlab.md` (`paths:` `server/src/gitlab/**`), added to CLAUDE.md's rule-file
  table. `test/claude-rules.test.ts` allows one rule-file home per anchor (`.claude/rules/tests.md`), and the four-caches anchor's home stays
  `tracker.md`; so each `gitlab.md` bullet cites its own anchor — a new `invariants.md` section, **"The GitLab token never leaves the server, never
  follows a redirect, and the poller is armed only while a mapped repo is on the site"** — or stays unanchored and under 80 words. CLAUDE.md gets that new
  section's headline in its Invariants list, the GitHub token's headline beside it.
- **Module**: a new `server/src/gitlab/` module (my call — GitLab may later serve more than Jira, and burying it in `jira/` would make that a move). That
  makes a fourth outbound-calling module: the CLAUDE.md invariant "`agents/`, `tracker/` and `jira/` are the server's only outbound-calling modules" and
  its text in `invariants.md` (no `test/` guard pins that list today) are updated in the same change. `security.md`'s rule file applies to the new env
  reader; add `server/src/gitlab/**` to its `paths:` (and to the CLAUDE.md rule-file table).
- The client gets MR data through one read (shape and route are the builder's call; a payload keyed by issue key is the natural fit) consumed by one
  shell-level provider, so the board, the list and Detail share one fetch — the `PullRequestsProvider` precedent. Mind `test/` guards that pin callers of
  shared hooks (CLAUDE.md, "Touched includes the source guards").

## 7. What the board draws

Common vocabulary, used by all three surfaces:

- **Lead MR** of a ticket: the newest `opened` MR, else the newest `merged`, else the newest `closed`, among the ticket's MRs as §6.2 resolves them (its
  own, or its parent's for a sub-task with none). "Newest" is the latest `updated_at`; a tie goes to the project path, then the higher iid, so the pick
  is stable across sweeps. Others are "also" MRs.
- **Known versus none.** A ticket's MRs are *known* once every GitLab project its Jira project maps has had at least one successful sweep and none of
  them is capped (§6.3). Until then — before the first sweep, when a project has never been read (`cannot read`, `rejected`, `unreachable` from the
  start), or when a project is capped — a ticket with no MR found is *unknown*, not *none*: Detail draws `GitLab not read yet` (or `GitLab could not be
  read — Settings › Shared › Sources` once a sweep has failed, or `more merge requests than were read — some may be missing` for a capped project), the
  List cell draws `—` at `--ink3`, and a card draws nothing. Only a known ticket draws the no-MR copy. A later failed sweep keeps the last good answer
  (§6.3), so a known ticket stays known.
- **Which tickets draw delivery at all.** The surfaces exist (band line, List column, both filter controls, and their stored value's effect) while GitLab
  is configured and the poller is armed; the Sources row always exists. Per ticket, delivery is drawn only when the ticket's Jira project maps at least one repo on the site: for any other ticket the List cell is
  empty, Detail has no Delivery pane, and its card gets nothing. One rule for all four surfaces.
- **A folded top shows its own lead MR only** (the user's pick): the chip, the List cell and the band totals use the top issue's lead MR, never one picked
  across the issues folded under it. A folded sub-task's MR shows on that sub-task and in Detail.
- **Delivery track**, four steps in v1: **Pushed** (an MR exists, so its branch was pushed) → **MR open** → **Pipeline** → **Merged**. A draft MR is
  `draft` at MR open. A closed-unmerged MR stops the track at a `Closed` end. The mocks draw a fifth, dashed **Review** step labelled `CodeRabbit · later`:
  v1 does **not** draw it (my call — a placeholder for an unbuilt feature reads as broken); project 2 inserts it between Pipeline and Merged.
- **Tones**, from the existing palette and DESIGN.md: pipeline passed = green, failed = red, running/pending = amber, merged = magenta, draft and no
  pipeline = neutral grey. Uppercase stays out (design guard 4); the mocks' type sizes give way to DESIGN.md where they differ.
- **The one table** every surface reads its words, tone and track from (the lead MR's state × its head pipeline). Track steps are Pushed · MR open ·
  Pipeline · Merged, each `on` (done), `off` (not reached), or toned. Pipeline status is not read for merged or closed MRs (§6.3): a merged MR's
  Pipeline step is drawn as reached without a word; a closed MR's is `off`.
- **A draft is never failing.** A draft MR draws grey `draft` whatever its pipeline, and counts in neither the band's `failing` nor the `Pipeline
  failing` filter (my call — a draft's red pipeline is work in progress, not a signal).

  | MR state | Head pipeline | Card chip | List / Detail word | Tone | Track |
  | -------- | ------------- | --------- | ------------------ | ---- | ----- |
  | opened, draft | any | `!iid · draft` | `draft` | grey | on · grey · off · off |
  | opened | success | `!iid · ✓ pipeline` | `pipeline passed` | green | on · on · green · off |
  | opened | failed | `!iid · ✕ pipeline failed` | `pipeline failed` | red | on · on · red · off |
  | opened | running or pending | `!iid · ◷ running` | `pipeline running` | amber | on · on · amber · off |
  | opened | canceled | `!iid · pipeline canceled` | `pipeline canceled` | grey | on · on · grey · off |
  | opened | none | `!iid · open` | `open, no pipeline` | grey | on · on · off · off |
  | merged | not read | `!iid · merged` | `merged` | magenta | all four magenta |
  | closed (not merged) | not read | `!iid · closed` | `closed` | grey | on · on · off · `Closed` end, grey |

  The mock's `not merged` word in the List's status slot (`List.dc.html`, the TIMIFY-112 row) is not used there: `Done, not merged` is a separate amber mark
  (§7.2), drawn in the List cell after the status word, as on the card.

### 7.1 Detail — the Delivery band (`OptionC.dc.html`)

- A `Delivery` pane in the Agent column, under the sessions band and above History. Head: `Delivery`, the lead MR's `!iid ↗` link (new tab, no referrer),
  `<repo basename> → <target branch>`, and `polled <age>` pushed right — the `polledAt` of the lead MR's project.
- The track with each step's word and, where known, its age or pipeline word: Pushed and MR open carry the MR's created-at age, Merged its merged-at
  age, Pipeline its word from §7's table.
- An `Also:` line listing the other MRs: `!iid ↗`, state pill, `<repo basename> · <age>`.
- On a sub-task showing its parent's MRs (§6.2), the head reads `via <PARENT-KEY>` after the link.
- No MR (known, §7): one line, `no merge request for <KEY> in <repo basenames> in the last 30 days`. Unknown: §7's unknown lines. A ticket that draws
  no delivery (§7, "Which tickets draw delivery at all"): the pane is not drawn.
- The mock's widened Agent column (480 px) is a mock artefact; the column width follows the existing Detail layout unless the band genuinely needs more —
  the builder checks it at 1440 px with `/ui-verify`.

### 7.2 Board cards (`Cards.dc.html`)

- The mock draws three status columns for brevity; the live Board is the agent deck over shelves (`JiraBoardView.tsx`, `JiraShelves.tsx`, DESIGN.md
  §8.9.1), and that layout stays. The mock is the reference for the **chip and the band line only**.
- On a **shelf card**, one chip in the card foot, before `Run ▾`, after the worktree chip, for the top's lead MR: the card-chip text and tone of §7's
  table, with `via <PARENT-KEY>` in its `title` when inherited. It ellipsises before `Run ▾` gives any width (the worktree chip's rule).
- On an **agent-deck card** too (my call: a ticket with a live session is the one most likely to have an open MR). A deck card has no foot, Run menu or
  worktree chip (`JiraAgentDeck.tsx`), so the chip takes its own line under the title and crumb, above the context meter. It shows the lead MR of the
  issue the card is about — the session's issue, which may be a folded child of the top — not the top's.
- **Done, not merged**: a ticket whose Jira category is `done` while its lead MR is still `opened` gets a second, amber `not merged` chip. An inherited MR
  never raises it (the user's pick in effect: a done sub-task under an open story is normal, not a mismatch) — only the ticket whose own key the MR
  carries. This is the one cross-system mismatch the user most needs to see.
- No MR: nothing extra (the mock's `· no MR` text is not drawn — an empty foot already says it; my call).
- Board band line gains `GitLab: N open · N failing · N merged · polled <age>`. Counts are over the **tops** on the board (shelves and deck alike, after
  the panel filters), each top's lead MR as §7 resolves it — inherited ones included — with each distinct MR counted once however many tops lead with it:
  `open` counts opened MRs (drafts and failing ones included), `failing` the opened, non-draft ones whose pipeline failed (a subset of `open`, so the
  numbers do not add up to a total), `merged` the merged ones; closed MRs are not counted. A zero part is omitted, the existing band-line rule; when all
  three are zero the line reads `GitLab: no merge requests · polled <age>`. `<age>` is the age of the **oldest** `polledAt` among the projects the board's
  tickets map, so the line never claims fresher data than its stalest part; while any of those projects has never been read the line reads
  `GitLab: not read yet` instead. Not drawn while the poller is not armed (§7).

### 7.3 List — the Delivery column (`List.dc.html`)

- A `Delivery` column after `Status`: a mini track (one dot per step of §7's table, in that row's tones), the lead MR's `!iid` link and its List word;
  then the amber `not merged` mark when §7.2's rule fires; `+N MR` when there are others; `no MR` at `--ink3` when known and none; `—` when unknown (§7).
  Not drawn while the poller is not armed.
- The list's existing sideways scroll box takes the extra width; the page never scrolls sideways (ui-verify at 1440 px).

### 7.4 Quick filters

- Three filters, each over the ticket's MRs as §6.2 resolves them:
  - `Has MR` — the ticket has at least one opened or merged MR, its own or inherited; a closed-only ticket does not match;
  - `Pipeline failing` — the lead MR, own or inherited, is opened, not a draft, with a failed pipeline;
  - `Done, not merged` — §7.2's rule exactly: Jira category `done` and the lead MR opened and the ticket's **own** (inherited never matches).
  An unknown ticket (§7) matches none of the three.
- One filter value, `all` by default, single-select, added to the panel filters and **persisted with them** under `JIRA_FILTERS_KEY` (clamped on read like
  the rest), since the board and list share that state. It is drawn twice, both controls driving the same value (my call): a `Delivery` section in the
  existing Filters panel, and in List the segmented control above the table as drawn in `List.dc.html`, because the user picked quick filters as a surface
  of their own. Both controls are drawn under §7's condition (configured and armed); whenever they are not drawn, a stored value reads as `all`, so a
  filter the user cannot see or clear never empties the board.
- A filter reaches folded issues the way F1 does today: a top is shown when it, or anything folded under it, matches.

### 7.5 Settings › Shared › Sources

- A `GitLab` row in the Sources card, in the states and the live row shape of §5.2's table (`Settings.dc.html` for the words; the `new` tag in the mock
  is not drawn).

## 8. Constraints

- All rules of CLAUDE.md apply; the ones this change meets most: server git is `runGit` and read-only; every route under `/api`; the CSP (no inline style
  in markup — CSSOM only); comments explain why, at the existing density; tests flat in `test/` for jest.
- DESIGN.md gains a section for the Delivery band, the MR chip, the Delivery column and the Sources row, written the way §8.9 and §8.11 are.
- `docs/subsystems/` gains a GitLab page (or a section of `jira.md`, the builder's call) and `docs/overview.md` lists the new seam.
- Every plan task that draws a view cites its mock file; the plan's last task is `/ui-verify` against the four picked mocks with fixture data (live data
  may hold no MRs), asserting no sideways page scroll at 1440 px (global CLAUDE.md learning, #448).

## 9. Room for project 2 (not built here)

> Built since: see [the CodeRabbit review design](2026-11-13-coderabbit-review-design.md), which kept to the three constraints below.

Project 2 will read CodeRabbit's notes and unresolved threads per MR and add a **Review** step and a **Fix review** button that starts a session running
`mr-review-loop` from its "pull findings" step on the lead MR. So this project should: keep per-MR data in a shape that can grow review fields; keep the
track's step list data-driven so a step can be inserted; and keep the server strictly read-only toward GitLab, because project 2's writes (notes, resolve)
belong to the session and its own `api` token, not the server.

## 10. Left to the builder

- Route names and payload shapes; whether status rides on its own route or an existing one.
- How pipeline status is read for open MRs, within §6.3's request bound.
- The page cap per project and its note wording.
- Whether the GitLab docs are a new subsystem page or a `jira.md` section.
- Exact component split on the client, within DESIGN.md's guards (no restyled primitives, no inline style).

## Calls I made (for review)

- `server/src/gitlab/` as a new, fourth outbound module, with the invariant text updated (§6.4).
- 2-minute sweep; 30-day window for merged/closed MRs (§6.3).
- Lead-MR rule (§7).
- v1 track has four steps; the dashed Review step from the mocks is not drawn (§7).
- No `· no MR` text on cards; the `new` tag in the Settings mock is not drawn (§7.2, §7.5).
- Matching reuses `branchCarriesKey` / `keysInBranch`, over branch and title (§6.2).
- Identity read independent of the poller; `unreachable` and `idle` Sources states added; per-repo problems as lines under a green row (§5.2).
- Read again sweeps GitLab too (§5.2).
- Exact, case-insensitive host match; the idle row names the hosts found (§6.1).
- Redirects refused; pages requested by number (§4).
- A new `.claude/rules/gitlab.md` rule file (§6.4).
- The state × pipeline table, including words for canceled, no-pipeline and closed (§7).
- Known versus unknown, and the copy for each (§7).
- Band totals over tops, distinct MRs, failing ⊂ open, oldest `polledAt` (§7.2).
- Deck-card chip on its own line, for the session's issue (§7.2).
- Poller and payload decoupled from the Jira boards: keyed by every key found in MRs (§6.3).
- MR chip on agent-deck cards as well as shelf cards; the board keeps its deck + shelves layout (§7.2).
- Delivery filter persisted with the panel, drawn both in the panel and as List's segmented control (§7.4).

## Decided by the user

- A sub-task with no MR of its own shows its parent story's MRs, marked `via <PARENT-KEY>` (§6.2).
- A folded card shows its top's own lead MR only; totals count tops' lead MRs (§7).
