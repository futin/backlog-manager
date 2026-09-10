---
id: idea-12
title: Re-platform as a Jira-like service: one DB owns every project's issues and runs
created: 2026-09-09
tags: architecture, multi-user, multi-machine
---

## Problem

Every project tracks its own items as files under `backlog/`, and the
orchestrator's run state is a file under one machine's home directory
(`~/.backlog-manager/orchestrator/<project key>/run.json`). That model has one
writer per file and no server dependency, which is exactly why it has worked
for one person on one machine — but it does not scale past that:

- **A second machine sees nothing.** The same repo cloned on a Linux PC and
  orchestrated from there (board published over the tailnet) leaves the Mac's
  board blind: its `run.json` is a different file, and its `backlog/` working
  tree only catches up on a hand `git pull`. Project identity is the absolute
  host path (`/Users/...` vs `/home/...`), so even a synced run-state directory
  would not match projects up.
- **"One run per project" is only enforced per machine.** `init`'s exit `4`
  and the server's `RUN_IN_PROGRESS_CODE` 409 both read a local file.
- **Multiple users would need a sync layer that git was never built to be.**
  The alternative explored in the same session — a lease on a custom ref in
  the project's git remote, `push --force-with-lease` as compare-and-swap,
  `main` pushed after every merge, a fenced `git pull --ff-only` on the idle
  machine — works (spike passed against a bare `file://` remote) but bolts
  locking, polling and file sync onto a substrate that has no lock primitive.
  It is the right answer for "two machines, one person, no new infra" and the
  wrong foundation for N users.

## Rough shape

A **new project**, not a refactor of this one — the file-coupled surface here
is ~7.1k lines of tool code, ~9.2k lines of tests on it, ~2.5k lines of server
file readers and ~3k lines of SKILL.md prose about files and worktrees, plus
229 items across five registered projects to import. Cheaper to build the
Jira-shaped thing fresh and let this repo stay the file-based edition.

- **Postgres owns items, projects and runs.** Items stop being files in the
  project repo; `backlog/` directories go away. An item's plan, cause/fix and
  `## Outcome` are columns/text on a row. Sections, status and groomed-ness
  become columns or derivations over columns — status stops being "which
  directory".
- **Locks are DB primitives.** One-run-per-project = a unique partial index on
  `runs (project_id) WHERE status IN ('running','paused')`. Queue claim =
  `SELECT … FOR UPDATE SKIP LOCKED`. Driver lease, pause request, `started:`
  stamps — all rows with `host`, `user`, `session_id`, `heartbeat_at`.
  Race conditions become transactions instead of atomic-rename discipline.
- **Topology (open, see below).** Preferred: one Postgres reachable by every
  machine (compose on the Linux PC over the tailnet, or managed), and a
  **stateless API per machine** against it, each with its own dashboard so an
  Orchestrate click still spawns locally on the clicking machine. Any board
  sees every run.
- **Skills become API clients.** `backlog.mjs`, `orchestrate.mjs`, `retro.mjs`
  call the local API (single writer of the DB) instead of reading and writing
  files. Execution still happens in a per-item git worktree — code stays in
  git; only *items* move. The executor writes its outcome through the API.
- **Board survives mostly intact.** It reads shapes (`BacklogItem`,
  `OrchestratorRun`, `starting`), not files; the derivations in `client/src/lib`
  keep their inputs. Settings gain a DB/API endpoint.
- **Identity now, auth later.** Every write records `user` + `host`. v1 can
  keep the tailnet as the perimeter (the app has no auth today; loopback is
  the access control), but the API must leave exactly one guard slot where a
  token check goes so multi-user does not mean a second redesign.
- **Import, then retire.** A one-shot `import` reads each registered
  project's `backlog/` into the DB; the directories are deleted in a final
  commit per project.

Decomposition, each its own spec → plan → build:

1. Schema + items API (replaces `items/` scan, `registry/`, allowlist).
2. Skills as API clients (`backlog.mjs` first — it is the registry's and the
   item files' writer today).
3. Run state + locks in DB (`orchestrate.mjs`, watchdog, pause, starting
   entries, driver lease).
4. Import + retire `backlog/` directories.
5. Board/settings: endpoint config, multi-host rendering (who/where on the
   run strip).

## Open questions

- **Topology.** Shared DB + API per machine (runs from anywhere, DB does the
  locking) vs one hosted API + thin clients (runs only on the host) vs skills
  talking to Postgres directly (no API dependency for a terminal capture, but
  DB creds on every machine and two writer processes).
- **Offline.** Today every skill works with nothing running. With a DB,
  capture/groom/execute need the DB (or API) reachable. Acceptable, or is a
  local queue-and-replay needed?
- **Provenance.** Items leave git: no item in a PR, no outcome merged beside
  its code, no `git log` on an item. Jira makes the same trade. Anything worth
  keeping — a read-only export into the repo on merge?
- **Where does Postgres live** for the first two machines — compose on the
  Linux PC published over the tailnet, or a managed instance?
- **Auth v1 or v2.** Tailnet perimeter first, tokens later — or tokens from
  day one because "multiple users" is the stated goal?
- **Retro.** Driver transcripts stay in `~/.claude/projects` on the machine
  that ran; a cross-machine retro can only read the DB half unless transcripts
  (or their summaries) are uploaded.
- **Migration of ids.** `task-31` style ids are per-project sequences minted
  from the filesystem; the DB needs project-scoped sequences or global ids,
  and every existing `from:` citation must survive the import.
