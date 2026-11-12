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
   Settings › Sources.
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
  only decides *whether* a repo is on that site; it is never dialled.
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
- States, as drawn in `Settings.dc.html`:
  - **connected** — the username, `<site> · read_api`, and `N repos mapped via Jira › Repositories`;
  - **no token** — `set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart`;
  - **rejected** — GitLab answered 401, with the site named;
  - **no access** — per repo: the token reads the site but gets 403/404 on one mapped project; the row names the project path;
  - **unreachable** — the site did not answer (DNS, TLS, timeout, 5xx), with the site named (my call; not in the mock — drawn in the `rejected` row's shape
    with its own sentence);
  - **idle** — connected, but no `jira.json` repo resolves to the site: the connected line plus `no mapped repository is on <site>`, and the poller does not
    arm (my call; not in the mock).
- A token whose scope is too narrow for a read reads as `rejected` with GitLab's own message; the server does not guess scopes.

## 6. Linking tickets to merge requests

### 6.1 Repository → GitLab project

- Source: the repo paths in `jira.json`'s `repos`, per Jira project key. No new configuration file and no new Settings field.
- For each path, read `origin` through `runGit` (async, 10 s bound, the server-wide rule) — a git READ, so "the server never writes git" holds.
- Parse SSH (`git@host:ns/repo.git`, `ssh://...`) and HTTPS remotes, with or without userinfo. Keep `host` and the namespace path, drop `.git`, drop userinfo
  at once (§4).
- A repo whose host is not `BM_GITLAB_SITE` (a GitHub repo, another GitLab) is skipped silently for GitLab purposes. A repo with no `origin`, or one whose
  read fails, is a per-repo note on the Sources row, never an error on a card.
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
  MRs of its own shows those and not the parent's. The parent key is the issue's `parent`, which the board already holds; no extra Jira read.

### 6.3 What is read, and how often

- **Which MRs**: per mapped GitLab project, every MR in state `opened`, plus `merged` and `closed` ones updated in the last 30 days (my call — enough to
  show a recently finished ticket as merged without paging all history). Paged until done; a cap with a visible `first N shown` note if a project exceeds it.
- **Per MR**: iid, title, web URL, state, draft flag, source and target branch, updated-at, merged-at, and the **head pipeline status** (`success`, `failed`,
  `running`/`pending`, `canceled`, none). Pipeline status is read only for open MRs; how (MR detail vs pipelines endpoint) is the builder's call, bounded so
  one sweep's request count grows with open MRs, not all MRs.
- **Cadence**: one sweep every 2 minutes by default (my call), plus an immediate sweep when the poller arms. Respect `429` / `Retry-After` the way the Jira
  poller does (one stored window every caller checks).
- **Armed only while** the connection is configured **and** at least one `jira.json` repo resolves to the site. Otherwise no timer runs and nothing is
  asked of GitLab (the identity read of §5.2 aside). It does **not** depend on the Jira boards or the Jira poller (my call): the payload is keyed by every
  ticket key found in the mapped projects' MRs, not by the keys on a board, so Detail works for an off-board ticket (Sessions › All tickets, a parent
  reached through `Run on`) and `gitlab/` never imports from `jira/`'s poller. Whether it also follows the GitHub poller's "armed only while a client is
  connected" rule is the builder's call, matching that precedent if it applies cleanly.
- **Failure keeps the last good answer**: a failed sweep leaves the cached MRs and their `polledAt` as they were, and records the failure for the Sources
  row. The Jira poller's reasoning: a list that empties on a blip makes every chip vanish and flash back.

### 6.4 The cache and the invariants it touches

- This is a **fourth cache whose age is a rendered value** (the board shows `polled 2m`). `docs/subsystems/invariants.md`
  ("The tracker, Jira and pull-request caches are the three caches...") and the matching CLAUDE.md headline must be amended to four, with this cache kept
  honest the same way: in memory, lost on restart, `polledAt` per GitLab project.
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
  own, or its parent's for a sub-task with none). Others are "also" MRs.
- **A folded top shows its own lead MR only** (the user's pick): the chip, the List cell and the band totals use the top issue's lead MR, never one picked
  across the issues folded under it. A folded sub-task's MR shows on that sub-task and in Detail.
- **Delivery track**, four steps in v1: **Pushed** (an MR exists, so its branch was pushed) → **MR open** → **Pipeline** → **Merged**. A draft MR is
  `draft` at MR open. A closed-unmerged MR stops the track at a `Closed` end. The mocks draw a fifth, dashed **Review** step labelled `CodeRabbit · later`:
  v1 does **not** draw it (my call — a placeholder for an unbuilt feature reads as broken); project 2 inserts it between Pipeline and Merged.
- **Tones**, from the existing palette and DESIGN.md: pipeline passed = green, failed = red, running/pending = amber, merged = magenta, draft and no
  pipeline = neutral grey. Uppercase stays out (design guard 4); the mocks' type sizes give way to DESIGN.md where they differ.

### 7.1 Detail — the Delivery band (`OptionC.dc.html`)

- A `Delivery` pane in the Agent column, under the sessions band and above History. Head: `Delivery`, the lead MR's `!iid ↗` link (new tab, no referrer),
  `<repo basename> → <target branch>`, and `polled <age>` pushed right.
- The track with each step's word and, where known, its age or pipeline word.
- An `Also:` line listing the other MRs: `!iid ↗`, state pill, `<repo basename> · <age>`.
- On a sub-task showing its parent's MRs (§6.2), the head reads `via <PARENT-KEY>` after the link.
- No MR: one line, `no merge request for <KEY> in <repo basenames>`. No GitLab configured, or no mapped repo on the site: the pane is not drawn.
- The mock's widened Agent column (480 px) is a mock artefact; the column width follows the existing Detail layout unless the band genuinely needs more —
  the builder checks it at 1440 px with `/ui-verify`.

### 7.2 Board cards (`Cards.dc.html`)

- The mock draws three status columns for brevity; the live Board is the agent deck over shelves (`JiraBoardView.tsx`, `JiraShelves.tsx`, DESIGN.md
  §8.9.1), and that layout stays. The mock is the reference for the **chip and the band line only**.
- One chip in the card foot, before `Run ▾`, after the worktree chip, for the lead MR: `!iid · <state word>` in the lead MR's tone (`✓ pipeline`,
  `✕ pipeline failed`, `◷ running`, `draft`, `merged`), with `via <PARENT-KEY>` in its `title` when inherited. It ellipsises before `Run ▾` gives any width
  (the worktree chip's rule).
- Drawn on **both** shelf cards and agent-deck cards (my call): a ticket with a live session is the one most likely to have an open MR.
- **Done, not merged**: a ticket whose Jira category is `done` while its lead MR is still `opened` gets a second, amber `not merged` chip. An inherited MR
  never raises it (the user's pick in effect: a done sub-task under an open story is normal, not a mismatch) — only the ticket whose own key the MR
  carries. This is the one cross-system mismatch the user most needs to see.
- No MR: nothing extra (the mock's `· no MR` text is not drawn — an empty foot already says it; my call).
- Board band line gains `GitLab: N open · N failing · N merged · polled <age>`, counts over the board's tickets' lead MRs; a zero part is omitted, the
  existing band-line rule. Not drawn while GitLab is not configured.

### 7.3 List — the Delivery column (`List.dc.html`)

- A `Delivery` column after `Status`: a mini track (one small dot per step, in the step's tone), the lead MR's `!iid` link and its one status word;
  `+N MR` when there are others; `no MR` at `--ink3` when none. Not drawn while GitLab is not configured.
- The list's existing sideways scroll box takes the extra width; the page never scrolls sideways (ui-verify at 1440 px).

### 7.4 Quick filters

- Three filters: `Has MR`, `Pipeline failing` (lead MR open with a failed pipeline), `Done, not merged` (§7.2).
- One filter value, `all` by default, single-select, added to the panel filters and **persisted with them** under `JIRA_FILTERS_KEY` (clamped on read like
  the rest), since the board and list share that state. It is drawn twice, both controls driving the same value (my call): a `Delivery` section in the
  existing Filters panel, and in List the segmented control above the table as drawn in `List.dc.html`, because the user picked quick filters as a surface
  of their own. Not drawn while GitLab is not configured; a stored value then reads as `all`.
- A filter reaches folded issues the way F1 does today: a top is shown when it, or anything folded under it, matches.

### 7.5 Settings › Sources

- A `GitLab` row in the Sources card, in the states of §5.2, as drawn in `Settings.dc.html` (the `new` tag in the mock is not drawn).

## 8. Constraints

- All rules of CLAUDE.md apply; the ones this change meets most: server git is `runGit` and read-only; every route under `/api`; the CSP (no inline style
  in markup — CSSOM only); comments explain why, at the existing density; tests flat in `test/` for jest.
- DESIGN.md gains a section for the Delivery band, the MR chip, the Delivery column and the Sources row, written the way §8.9 and §8.11 are.
- `docs/subsystems/` gains a GitLab page (or a section of `jira.md`, the builder's call) and `docs/overview.md` lists the new seam.
- Every plan task that draws a view cites its mock file; the plan's last task is `/ui-verify` against the four picked mocks with fixture data (live data
  may hold no MRs), asserting no sideways page scroll at 1440 px (global CLAUDE.md learning, #448).

## 9. Room for project 2 (not built here)

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
- Identity read independent of the poller; `unreachable` and `idle` Sources states added (§5.2).
- Poller and payload decoupled from the Jira boards: keyed by every key found in MRs (§6.3).
- MR chip on agent-deck cards as well as shelf cards; the board keeps its deck + shelves layout (§7.2).
- Delivery filter persisted with the panel, drawn both in the panel and as List's segmented control (§7.4).

## Decided by the user

- A sub-task with no MR of its own shows its parent story's MRs, marked `via <PARENT-KEY>` (§6.2).
- A folded card shows its top's own lead MR only; totals count tops' lead MRs (§7).
