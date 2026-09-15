---
id: idea-12
title: Tracker-backed backlog: GitHub, GitLab or Jira issues own items and claims; files stay one adapter
created: 2026-09-09
tags: architecture, multi-user, multi-machine, tracker, github
---

## Problem

Every project tracks its own items as files under `backlog/`, and the orchestrator's run state is a file under one machine's home directory
(`~/.backlog-manager/orchestrator/<project key>/run.json`). That model has one writer per file and no server dependency, which is exactly why it
has worked for one person on one machine — but it does not scale past that:

- **A second machine sees nothing.** The same repo cloned on a Linux PC and orchestrated from there (board published over the tailnet) leaves
  the Mac's board blind: its `run.json` is a different file, and its `backlog/` working tree only catches up on a hand `git pull`. Project
  identity is the absolute host path (`/Users/...` vs `/home/...`), so even a synced run-state directory would not match projects up.
- **"One run per project" is only enforced per machine.** `init`'s exit `4` and the server's `RUN_IN_PROGRESS_CODE` 409 both read a local file.
- **Multiple users would need a sync layer that git was never built to be.** A lease on a custom ref in the project's git remote,
  `push --force-with-lease` as compare-and-swap, `main` pushed after every merge, a fenced `git pull --ff-only` on the idle machine — designed
  and rejected on 2026-09-10: it bolts locking, polling and file sync onto a substrate with no lock primitive, and the compose stacks mount
  projects read-only so the pull half could never run there.
- **It also stops at one person.** Nobody who has not installed the plugin can see or file work.

## Direction (2026-09-15): the tracker is the database

Supersedes the Postgres re-platform this idea first proposed on 2026-09-09 (`git log` on this file has that version). Instead of a store we
host, the projects' own issue trackers own the items — GitHub Issues first (four of the five registered projects live under
`github.com/futin`), GitLab and Jira behind the same adapter interface later. backlog-manager becomes an aggregator over N trackers plus a
write-back client for the lifecycle stamps, behind a **connections page** in Settings where a user registers a repo or a Jira project and a
token, MCP-connector style, and the board merges every connected source into the one kanban.

What that buys over a custom DB:

- **Nothing to host.** No Postgres on the Linux PC over the tailnet, no managed instance, no backup story.
- **Identity, permissions, notifications, mobile apps and search** come with the tracker. The old "auth v1 or v2" question dissolves.
- **Colleagues participate with zero install**: file a bug in the GitHub UI, groom it there, see who took it. "Many devs" is met on day one.
- **Provenance returns beside the code.** `Fixes #31` in a commit closes the item; `## Outcome` becomes the closing comment; the branch's
  `git log` and the issue timeline tell one story. The Postgres design had to invent an export for this.
- **Work repos managed in Jira become readable** through the Jira adapter without the skills writing files into them, which today's rule forbids.

What it costs versus a custom DB: no transactions or locks (closed below), no first-class run object (closed below), a poll interval instead of
sub-second latency, a schema made of labels and comment conventions, and a dependency on a third party's uptime and rate limits.

The example the direction was tested against:

1. A session takes an issue from the backlog-manager project on GitHub and marks it in progress (assignee, stage label and a claim — below).
2. Every board polls every connected tracker every N seconds and shows the state near-real-time; the poll age is shown, never hidden.
3. A second session that tries to start the same item re-fetches, sees the claim, and stops — and the claim protocol makes that safe even when
   both start inside one poll window.
4. Everyone, on every machine, sees the same picture.

## What maps to an issue

| Today | Tracker |
|---|---|
| Section (`bugs/ideas/tasks/refactors`) | Label `type:bug` etc.; `kind:chore\|debt` and `runner-fix` are labels too |
| Status = directory (`open/`, `done/`, `out-of-scope/`) | Issue state open/closed; GitHub `state_reason: not_planned` is out-of-scope exactly; GitLab and Jira use a label or resolution |
| Groomed, derived from body headings | Unchanged: the body keeps `## Cause` / `## Fix` / `## Plan`; a colleague grooms in the web UI and the board sees it next poll |
| `started:` / `phase:` | Assignee + stage label + the claim comment |
| `from: <id>` | `#12` reference — native cross-links |
| `## Outcome` in the body | Closing comment |
| `groom-tokens:` and the other four counters | Fields in the per-item bot comment (below) |
| `task-31` | URN `gh:futin/backlog-manager#31`, shown as `#31` inside a project; every existing `from:` maps to `#n` on import |
| `lastCommit` (middle rung of last-touched) | The issue's `updated_at` |
| `uncommitted` | Gone for tracker projects — items are not in git |

## Locking: claim by comment

None of the three trackers supports compare-and-swap on an issue (no `If-Match`). "Assign yourself if unassigned" is therefore check-then-act:
two sessions that both read *unassigned* inside one poll window both assign, both get 200, and nothing tells either that it lost — GitHub keeps
both assignees, Jira silently overwrites. Re-fetching right before the write shrinks the window to one round trip; it never closes it. The
"assign, re-read, back off if it is not me" variant fails too: on a last-write-wins field the *later* writer always looks like the owner, so an
earlier writer's check is never trustworthy.

Protocol: post a claim comment (`<!-- bm:claim session=<id> at=<ts> -->`), then list the issue's comments. **Lowest comment id wins.** The
loser deletes its own comment and backs off. Comments are append-only and server-ordered, so both writes survive with a server-assigned
sequence; the lowest id is fixed the moment it exists and cannot be undercut; and the loser's list call, made after its own later post,
necessarily includes the winner's. Two comments landing in the same millisecond do not tie. Client clocks, latency and the poll interval do not
enter into it.

Chosen on 2026-09-15 "for now" over the stronger GitHub/GitLab primitive — create the `backlog/<id>` branch ref through the API, 422 if it
already exists, a true CAS with no second read and no lag hole. That one is a git ref, which brushes against the rejected lease design, and
Jira has no equivalent, so a Jira adapter would need the comment protocol regardless. Revisit only if replica lag bites in practice.

Caveats the design must state:

- **Read-replica lag** is the one remaining hole: a list call served by a replica that has not yet seen the winner's comment lets the loser
  proceed. Milliseconds, not the poll interval. Mitigate with a short settle before the list call, or two reads; downstream, two heartbeating
  drivers in one item's bot comment is an attention entry, and a second merge of the same item conflicts or parks.
- **Lowest *live* claim wins.** A dead winner's comment has no heartbeat; past the stale window it is ignored or swept — the `RUN_STALE_MS`
  rule, relocated.
- **Every claim notifies watchers.** Acceptable — "a session started task 31" is a human event — but it is noise on a busy repo.

## Run state: a run is derived from claims

`run.json` today holds status, queue stages, heartbeat, driver lease, merge mode, question mode, assumptions, usage and attention. Issues hold
none of it, and encoding it as labels would be lossy and chatty. Instead:

- **One bot comment per claimed item, edited in place**, holding a JSON block: stage, heartbeat, driver session, worktree and branch, usage,
  the five counters. GitHub comment edits do not notify watchers, so machine state is silent; new comments are reserved for human events
  (claim, attention, outcome).
- **"One run per project" becomes "one executor per item".** Two machines draining the same project take disjoint items — parallelism, not
  conflict. Code sync is ordinary `git push` after each merge and `git pull` before the next item, done by the orchestrator session on the
  host; the server never touches git. That is not the rejected lease design: nothing locks through git and nothing syncs server-side.
- **`OrchestratorRun` stays a shape — derived, never stored.** The server assembles it from claims grouped by driver session, so the Runs
  view's input contract survives; a run is "what this driver session did". Merge mode, question mode and assumptions ride in the driver's bot
  comments.
- **Attention = @mention.** A parked item mentions the user on the issue; a phone notification beats a strip badge.
- **The local `run.json` stays as a journal**, non-authoritative, for the machine that ran. Retro reads bot comments cross-machine; driver
  transcripts stay local, as in every earlier version of this idea.

## Migration: files become the first adapter

The 2026-09-09 verdict was "a new project, not a refactor", because Postgres replaced files wholesale and every file-coupled line became dead
weight. That no longer holds: `backlog/` is one item source among four. finance-manager has no remote and can stay on files; any project can;
offline capture keeps working for file projects. So this is a strangler migration inside this repo, one spec → plan → orchestrator run per
phase:

| Phase | Changes | Visible result |
|---|---|---|
| 1 | Item-source adapter interface on the server; today's scanner becomes the `files` adapter; registry gains a per-project `source`, default `files` | Nothing — a seam |
| 2 | Connections section in Settings; token custody; GitHub adapter read-only; ETag polling; cache with poll age | GitHub issues on the board beside file items; multi-machine visibility of items |
| 3 | Write-back through the API: claim protocol, labels, state, comments; `backlog.mjs` gains an API mode for tracker projects | Capture, groom, start, stop work against GitHub |
| 4 | Per-item bot comment; `orchestrate.mjs` reports stages and heartbeats through the API for tracker projects; server derives runs from claims | Orchestrator runs visible from every machine |
| 5 | One-shot `import` per project, files → issues, `from:` → `#n`; the `files` adapter stays | Projects move one at a time |
| 6 | GitLab and Jira adapters | Work repos readable |

Phases 3 and 4 are the expensive ones: the skills are file writers with a large suite behind them, and each carries two code paths (files,
API) until the last file project is gone. Still far cheaper than a fresh repo, and every single-writer invariant stays true for the `files`
adapter.

## Risks and costs

Polling budget — webhooks are out, since a tailnet-only server has no inbound URL and Funnel is never used:

| Platform | Authenticated limit | Free conditional GET |
|---|---|---|
| GitHub REST | 5,000 req/hr per user | yes — a 304 is not counted |
| GitLab.com | 2,000 req/min per user | no |
| Jira Cloud | cost-based, unpublished; 429 + `Retry-After` | no |

Five projects every 10 s on GitHub is 1,800 req/hr, fine even without 304s. Each adapter backs off on a rate-limit response, and the board
shows "rate limited until" rather than a silently stale board.

- **Body clobber.** A human editing the body in the web UI while the tool PATCHes it: last write wins, no `If-Match`. Rule: the tool
  *appends* comments; only groom edits the body, read-modify-write with an `updated_at` check, human-triggered and rare.
- **Notification noise.** Machine state only ever in the edited-in-place bot comment; new comments only for claim, attention, outcome.
- **Three adapters.** Each: list-since, get, create, set state, labels, assign, comment, edit comment, patch body, auth, backoff. The first is
  cheap; the third accumulates. Jira REST v3 bodies are ADF, not Markdown — a conversion layer.
- **Offline dies for tracker projects.** Capture and groom need the tracker; the cache renders the last poll with its age. File projects are
  unaffected. The same trade the Postgres version made.
- **Skills need the server.** Today every skill works with nothing running; a tracker project's skill calls go through the local API so the
  token lives in one process. Acceptable for tracker projects, never required for `files`.

Token custody changes the app's threat model. The server would hold personal access tokens for GitHub, GitLab and Jira, and today it has no
authentication: loopback plus the Host allowlist is the whole access control, and the board is published on the tailnet. Tokens must be stored
server-side only (`~/.backlog-manager/settings/connections.json`, mode 0600), never sent to the browser, never placed in a URL, entered through
a connections page whose POST is origin-guarded like the agents routes, and scoped as fine-grained tokens with issue read and write on the
chosen repos only. Headless skill sessions reach the tracker through the local API, never through a shared environment variable.

## Sequencing against the FE redesign

The FE redesign (`docs/superpowers/specs/2026-09-15-fe-redesign-design.md`) goes **first**, unchanged. It is a redraw whose non-goals pin the
data authority in place — no new derivations, no server change, no change to skills or the store — which is exactly the insulation a later
data-model change needs; it is spec'd and gated only on the orchestrator base-branch feature, while this direction still needs a brainstorm
and a spec; and one run per project rules out code parallelism anyway. Tracker code starts after `fe-redesign` merges to `main`; the tracker
brainstorm and spec may proceed docs-only in parallel.

The overlap to manage is the Runs view, run-centric today; the "derived from claims" rule above is what keeps it from being built twice.

One ask for the session executing the FE redesign, so phase 3 does not pay for every new component: key components on `id` + `project`; keep
`path` to the dispatch request and `projectPath` to links and the sheet, never as a component key; keep `uncommitted` in the sheet's chip as
the spec already has it; build no new UI on `lastCommit`. Today `path` is read in 7 client files, `projectPath` in 10, `uncommitted` in 4.

## Open questions

- **Claim visible to humans.** The claim comment is hidden HTML; the item should probably also get an `in-progress` label and an assignee so a
  colleague in the web UI sees who holds it without reading comments — label and assignee for humans, comment for the protocol. Confirm.
- **Poll interval per platform**, and whether only projects with a connection poll while file projects stay on the filesystem read.
- **Jira adapter scope.** Read-only at first, given that work repos are managed through Jira by others — or full write-back?
- **Base branch.** The FE spec's orchestrator base-branch feature makes `base` run-scoped; in the tracker model the item no longer has to
  exist at `<base>`, which removes one of that feature's stated costs. Confirm before the base-branch spec hardens it.
- **Retro.** Bot comments give usage per item cross-machine; transcripts stay on the machine that ran. Enough, or do summaries upload?
- **Id on the command line.** `#31` inside a project, URN everywhere else — and what the skills accept (`task 31` today).
- **Import fidelity.** Created timestamps become the import time unless the API allows setting them; `done/` imports closed; `out-of-scope/`
  imports as not-planned. What is lost, and does it matter?
