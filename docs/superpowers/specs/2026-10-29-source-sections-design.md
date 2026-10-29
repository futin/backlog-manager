# Source sections: Files, GitHub and Jira at the rail's root

Status: draft, awaiting approval. Date: 2026-10-29.

## Intent

The rail is organised by *what kind of page* (Board, Runs, Archive, Jira, Settings), but the work on this machine comes from *sources* that behave differently: a
files project's items live in its `backlog/` directory, a tracker project's items are GitHub issues, and a Jira ticket is outside work with its own Run flow.
Today the main Board mixes files and GitHub projects, Archive mixes them too, and Jira already stands apart as a section of its own. The person wants every source
to be a root-level row with the same shape — one click to each source's board, its own settings, and room for GitLab (or more) later — because different
sources carry different actions (Jira Run vs execute/groom on a tracker issue) and a page that mixes them has to explain which action applies where.

They also want a place to *manage open pull requests* (merge, auto-merge, update branch) without leaving the board, and a single read-out of which sources this
machine has configured.

## The rail after the change

```
Files       ▸ Board · Archive                drawn while ≥1 registered project has source `files`, `unsupported` or `null`
GitHub      ▸ Board · PRs · Archive · Settings  drawn while ≥1 registered project has source `github`
Jira        ▸ Board · Setup                  unchanged save its fall target; drawn while GET /api/jira says configured
──────
Runs        ▸ History · Watchdog · Ticks      unchanged
──────
Settings    ▸ Local · Shared · Dashboards     pages unchanged; Shared gains a Sources card
```

The root-level `Board` and `Archive` sections go away; their content moves into the source rows. Order: sources first (Files, GitHub, Jira), then Runs, then
Settings — the existing "work first, Settings last" ordering in `client/src/lib/sections.ts`, with Archive no longer a root member.

Each source row follows the rules the Jira row already follows: its sub-pages are switched by the rail's tree alone, never by an in-page control (the "tree rule"
in `docs/subsystems/invariants.md`), and its row is drawn conditionally without flicker (the Jira row's hold-and-fall: a stored section is held while the answer
is unknown and the shell falls to another section only on an answer that says the row is gone). For Files and GitHub the answer is the registered projects'
`ProjectSummary.source`, read from `GET /api/projects` (`server/src/items/items.controller.ts`) through ONE shell-level provider beside `TrackersProvider` and
`JiraProvider` — not `TrackersPayload.projects`, which `useTrackers` fetches once and never again on a machine with no syncing GitHub row. The three states, as
the Jira rule states them: **unknown** (no answer yet, or every read failed) draws a source row only if that section is the one on screen, and keeps it;
**answered, row present** draws it; **answered, row absent** hides it, and if it was on screen the shell falls (see Fallback below) on that same answer.

## Decided by the person

- **Each source is a root-level row**, not grouped under a "Plugins"/"Integrations" parent. GitLab, if it comes, is another row of the same shape.
- **Today's Board moves to GitHub › Board** for tracker projects; **files projects get their own Files section**, named `Files` (not `Local`, which Settings'
  this-device page already uses). Files has Board and Archive — no Settings page until there is a setting to put on it.
- **The Files row is drawn only while at least one registered project is a files project** — counting, as the builder's call below explains, projects whose
  source is `unsupported` or `null`, since their warnings land on Files › Board.
- **Archive is per source**: GitHub › Archive and Files › Archive, each today's `ArchiveView` filtered to its source. Sources are not mixed on one page because
  their actions differ (Jira Run vs execute/groom). The `leavesBoard` split between Board and Archive is unchanged within each source.
- **GitHub › PRs lists all open PRs** on the registered GitHub repos — forks and other authors included.
- **A PR whose branch a live or paused run, a starting entry or a live claim is still working is warned about, not refused**: the row shows a run-in-progress
  chip and the actions stay enabled. Run files carry no PR branch and claims carry no branch, so the link is derived by ONE `lib/` function from the branch
  naming conventions: `backlog/<id>` (an orchestrator item branch) and `execute/<id>` (an execute or tick PR) name an item — warned while a live or paused run
  holds that item, a starting entry names it, or a live claim is on it; `backlog/run-*` (a PR-mode run branch) is warned while that repo's run is live or
  paused. Any other head is never warned.
- **GitHub › Settings** takes the `Trackers` card (each repo's sync interval) off Shared Settings.
- **GitHub › PRs** lists open pull requests of **GitHub-registered projects only** (repos whose project has `source: github`). Actions: **merge**, **enable /
  disable auto-merge**, **update branch**. PRs for Jira-related work may come later; not now.
- **Settings keeps its three pages** (Local, Shared, Dashboards — "the page is the scope" holds). Shared gains a **Sources · this machine** card at its top
  showing which sources are configured — Files, GitHub, Jira, and later others — based on the server's environment (`.env`) and what the token can reach.

## Goals

1. A person reaches any source's board in one click from the rail, and never sees a source's items on another source's page.
2. GitHub › PRs lets a person merge, arm or disarm auto-merge, and update the branch of an open PR on a registered GitHub project, with the PR's state (draft,
   review decision, checks, mergeable, behind base, auto-merge armed) visible before acting.
3. Shared Settings answers "what is connected on this machine, and is it working" in one card.
4. Adding a fourth source later means adding a row of the same shape, not reshaping the rail again.

## Non-goals

- GitLab, or any source beyond the three, in this change.
- PRs for Jira-mapped repos or for files projects.
- Creating, reviewing, commenting on, closing or labelling PRs. Only merge, auto-merge and update branch.
- A generic plugin framework or plugin registry. A shared *shape* (row, tree pages, conditional drawing, settings card) is enough; a source is still code in
  this repo.
- Changing Runs, the orchestrator, dispatch, or the skills.

## Anti-goals (would make this a failure even if it works)

- A files project's item showing on GitHub's board, or a tracker issue on Files' — mixing is the problem being solved.
- A rail row that appears on a guess and vanishes on the answer (flicker on every load).
- A PR action that writes something other than the three named writes, or that bypasses the guards every other write route has.
- A stored section, deep link (`lib/deep-link.ts`) or `Opens on` preference from before the change landing on a blank page or throwing.

## Constraints from the repo (each is an existing invariant; read its entry in `docs/subsystems/invariants.md` before changing it)

- **Outbound calls.** GitHub calls belong to `server/src/tracker/` — one of the only three outbound-calling modules. The PR reads and writes live there too; no
  fourth outbound module.
- **The server's writes are enumerated.** CLAUDE.md lists exactly what the server writes to other people's data (its own settings files aside): tracker items
  through eleven `/api/items/*` routes, Jira assign and transition. PR merge / auto-merge / update-branch are a **new write surface** and must be added to that list and to `invariants.md` as their own entry, in
  the shape of "The board's Jira writes are assign and transition, nothing else": the three writes, nothing else, each re-reads the PR afterwards. Its headline
  lives in three homes, byte-equal: CLAUDE.md, the `invariants.md` heading, and a bullet in `.claude/rules/tracker.md` anchored to that heading —
  `test/claude-rules.test.ts` holds tier one and tier two to the same multiset of (anchor, headline), so a headline in only two homes fails CI.
- **Guarded POSTs.** Every write route is guarded by content-type and origin (the agents-POST guard) and the Host allowlist. The PR writes are serialised per PR
  the way item writes are serialised per item.
- **The GitHub token never leaves the server** (`BM_GITHUB_TOKEN`, `server/src/tracker/token.util.ts`). The browser asks `/api/...`; the Sources card reports
  whether the token is set and what it can reach, never the token.
- **The poller is armed only while something is connected.** Whatever reads the PR list must not keep a poll running when no GitHub project is registered or
  nobody is on the PRs page.
- **Rendered cache ages.** "The tracker and Jira caches are the two caches whose age is a rendered value" becomes three: the PR list is a server-side,
  per-repo, on-demand cache with a `polledAt` the PRs page renders (decided below under PR list freshness), and the invariant's headline is edited in its three
  homes.
- **A repo whose sync is off refuses every write path.** PR writes on that repo are refused too (they go through `syncOffBlock`); the PR list is still read, with
  the actions disabled and labelled `sync off`. Reading on demand while the page is open means an `off` repo needs no cadence of its own. `syncOffBlock` is
  keyed by project path, so a PR write reads `intervalFor(repo) === 'off'` directly; its serialisation key is `<repo>#<number>`, not an item urn. The new
  routes join the guarded set in `test/agents-origin-guard.test.ts`.
- **Token permissions.** Today's docs (`.env.example`) understate even the current token, which writes issues since task-46. PRs need Pull requests and Contents write (merge, update-branch), Checks and
  Statuses read (the checks chip), and arming auto-merge goes through GraphQL. The person widens the token; `docs/` and `.env.example` say what it needs. A
  fine-grained token's write permissions cannot be read back, so the Sources card reports what it can read and a write that lacks permission fails with
  GitHub's reason in the row — actions are not disabled on a guess.
- **Tailnet.** PR writes are allowed from any host the allowlist admits, like every other guarded write — no loopback-only rule.
- **`server never writes git`.** Merge and update-branch are GitHub API calls, not local git, so this holds — say so in the new invariant entry.
- **Settings is three pages, the page is the scope.** The Sources card is host-scoped and lives on Shared; the Trackers card moving to GitHub › Settings is a
  host-scoped card on a non-Settings page, which `invariants.md` must now allow (the Jira Setup page is the precedent). The rewritten headline (and any
  changed tree-rule headline) is edited byte-equal in CLAUDE.md, `invariants.md` and its `.claude/rules/board.md` bullet, for the same test.
- **The sync-off sentence names the card's old home.** `sync is off for <repo> — turn it on in Settings › Shared › Trackers` is a literal in
  `server/src/tracker/poller.service.ts` (`syncOffBlock`) with a hand copy in `client/src/lib/tracker.ts`, pinned by five suites (`tracker-sync-interval`,
  `tracker-lib`, `tracker-sync-refusals`, `tracker-board`, `tracker-abort`) and described in `.env.example`. It becomes
  `sync is off for <repo> — turn it on in GitHub › Settings`, and the server literal, the client copy, the five suites and `.env.example` change together.
- **`.claude/DESIGN.md`**: every new component cites its subsection; new looks that more than one surface draws go in `components/ui/`, derivations in `lib/`.
- **`contentWidth`/CSP, Escape ownership, `--main-gap`**: unchanged, but a new page must respect them (one Escape owner, strip height via `--main-gap`).

## Parts of the how, as decided

- Section list: `lib/sections.ts` replaces `board` and `archive` with `files` and `github`, keeps `jira`, `runs`, `settings`. Each source's sub-pages are its
  own tree value (like `jira-page.ts`, `runs-mode.ts`).
- Files › Board and GitHub › Board are today's `BoardView`, each filtered to one source by `ProjectSummary.source`. Their toolbars, run chip and Orchestrate
  sheet stay; the project picker lists only that source's projects.
- GitHub › Archive and Files › Archive are today's `ArchiveView`, each filtered to its source.
- The `Trackers` card is split by subject: each repo's sync interval moves to GitHub › Settings; the token / login / rate-limit row becomes the Sources card's
  GitHub row; each files project's `backlog.mjs connect` command moves to the Sources card's Files row (so how to connect is visible before any GitHub project
  exists); the Jira row becomes the Sources card's Jira row. Nothing of the card stays on Shared under the name `Trackers`.
- Shared Settings gets `Sources · this machine`: one row per source — Files (n projects registered), GitHub (token set or not; the login and whether the token
  can reach each registered repo; n projects), Jira (configured or not, site, n boards). Read-only. Each row may carry a link to its source's settings page
  only as an `onOpen<Source>Page` callback built once in `App` and threaded down — the one allowance the tree rule already makes (the Board's `Set up` chip,
  `onOpenJiraPage`); without that pair the destination is text, as `TrackersGroup`'s `Jira › Setup` is today.

## Left to the builder (my calls, overridable)

- **The GitHub row's draw rule** is "≥1 registered `github` project", symmetric with Files — not "token set". A token with no GitHub project has nothing to show
  on Board, PRs or Archive; the Sources card is where a token-without-projects is visible.
- **Projects with source `unsupported` or `null`** belong to Files: their unreachable warnings and `ItemsIndex.errors` entries show on Files › Board, which is
  why they count toward drawing the Files row. This is display grouping only: "an `unsupported` source never falls back to `files`" is unchanged, and
  `ItemsService.writerFor` still refuses them.
- **A token without projects** shows `token set` on the Sources card, never a login: the login is read inside a poller sweep, and the poller is disarmed while
  no GitHub project is registered.
- **Old `?section=board` / `?section=archive` deep links** need no migration: `readDeepLink` ignores an unknown section and the load opens normally.
- **Docs that name the Trackers card's home** follow it: `.env.example`, `docs/subsystems/board.md`, and CLAUDE.md's Layout bullet.
- **Fallback**: `FALLBACK_SECTION` and the Jira row's fall (`change('board')` in `App.tsx`) go to the first drawn source row (Files, then GitHub), else Runs. A
  machine with nothing registered opens on Runs; the Sources card on Shared says what to connect.
- **Migrating stored values**: `resolveSection` runs in a `useState` initializer, before the projects answer exists, so it cannot pick a source. It maps a
  stored legacy `board` or `archive` to `github` provisionally, remembering which page (Board or Archive) was meant; on the FIRST projects answer the shell
  settles it — GitHub's page while the GitHub row is drawn, else Files' same page while the Files row is drawn, else the Fallback above — and writes the settled
  value back. The `Opens on` preference clamps the same way. A deep link to an item resolves to the section of that item's project's source, on the same
  first answer.
- **PR list freshness**: the server keeps a per-repo PR cache filled on demand — a `GET` for a repo whose entry is older than a 60 s TTL re-reads it, else
  serves the entry with its `polledAt`. No background sweep: nothing reads PRs while nobody is on the page, which is what keeps "the poller is armed only while
  something is connected" true. One read per repo is ONE GraphQL query (open PRs with head/base refs, author, draft, `mergeable`, `mergeStateStatus`,
  `reviewDecision`, the head commit's rollup check state, `autoMergeRequest`, and the repo's allowed merge methods and auto-merge setting) — REST would be N+1
  per PR, and review decision is GraphQL-only. `GithubClient` gains one GraphQL call beside its REST ones, under the same token and the same rate-limit
  handling (a 403/429 rate-limit answer sleeps until reset rather than retrying). The client polls the page through `useCoalescedFetch` at a fixed 60 s,
  armed only while the PRs page is mounted; a write re-reads the PR it touched.
- **Write outcomes** — each is one line in the PR's row, and the row re-reads after every outcome:
  - **update-branch** answers `202` and runs asynchronously: the immediate re-read can still show the old head and `mergeable: null`, so the row shows
    `updating…` until a read shows a new head SHA or 30 s pass. A fork head without maintainer edits answers `422`; that PR's Update branch is disabled with
    `fork does not allow edits` when the read says so, and a `422` otherwise shows GitHub's message.
  - **merge** `405` (protection, required checks) and `409` (head moved since the read) show GitHub's message; `409` also re-reads. A merged PR leaves the
    open list on the re-read. A second concurrent merge of the same PR — serialised per PR on this server, or raced from GitHub itself — reads as
    `already merged`, not as an error.
  - **auto-merge** enable on a repo with auto-merge off, or on a PR already clean to merge, shows GitHub's GraphQL error text; disable on a PR with none armed
    is a no-op success.
  - A `401`/`403` permission answer on any write shows `the token lacks permission for this` plus GitHub's message (the Token permissions constraint above).
- **Merge method**: offered from the repo's allowed methods (squash / merge / rebase), defaulting to the repo's first allowed one in that order.
- **What "update branch" means**: GitHub's update-branch (merge base into head), not a rebase.
- **Layout of the PRs page**: a list grouped by repo, newest update first, one row per PR with its state chips and the three actions; a disabled action says
  why (draft, checks failing, not mergeable, already up to date, auto-merge not enabled on the repo).

## Open questions

None. The builder check's questions are answered above: files-project archive (Files › Archive), which PRs (all open), run guard (warn only), sync off,
token permissions, tailnet, unsupported/null projects, fallback, and the Trackers card's split.
