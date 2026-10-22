# Multi-dashboard: one board, several machines to run on

Date: 2026-10-22. Status: draft, awaiting approval.

## Why

The user runs two machines, each with its own Claude account: this one on the company account (Max x5), and a second on a personal Pro account. Each machine
runs its own backlog-manager board and its own `claude-agents-dashboard`. Today one board talks to exactly one dashboard — `BM_AGENTS_URL` / `BM_AGENTS_TOKEN`
(`server/src/agents/config.util.ts`) — so using the Pro budget means opening the other board, and in practice the user keeps switching boards, switching
between run histories, and often forgets the second machine exists. The Pro budget goes unused.

The ask, in the user's words: give a single board "a choice" of dashboards to run work on, and let the board suggest which one "based on the usage, because
that would help me decide too."

## What success looks like

The user opens one board (this machine's) for everything on the shared projects. Every launch shows which machine the work will run on, pre-filled with the
board's suggestion and the usage figures behind it, and the user can change it before Start. Work that ran on the Pro machine comes back as a PR on GitHub, and
its run shows up in this board's history (as a `remote` row, which carries no PR link — see Goals). The Pro board only needs opening for the projects that live there alone.

## Goals

- **A list of dashboards instead of one.** This machine's dashboard stays the default ("home"); one or more others ("remote") are added. Each has a name the
  user sees ("Max", "Pro"), its dashboard's URL and token, its backlog-manager's URL (read for "offered", below), and the `host` value that machine's claims
  carry — so a claim alone (with no dispatch record in memory) resolves which dashboard holds its session. A claim's `host` is `BM_MACHINE_NAME` when set and
  `<user>@<hostname>` otherwise (`hostIdentity`, `backlog.mjs` / `orchestrate.mjs`), so each remote machine must set `BM_MACHINE_NAME` in its shell env, and the
  entry records that name.
- **A machine picker on the board's two launch surfaces for shared projects:** a card's dispatch (groom / execute / capture) and the Orchestrate sheet.
  Pre-filled with the suggestion; the user can override. (Hand resume and the Jira board's Start get no picker — see Non-goals.)
- **A card dispatched to a remote machine is visible and stoppable here** (user's answer): the card shows that it is running and on which machine, and Stop &
  release works from this board, routed to the dashboard the session runs on. This means the dispatch records and the abort path learn which machine a session
  is on. No history row (my call, narrowing the answer): a card dispatch has no Runs history row today, local or remote, and `remote` rows are derived only
  from claims that carry a `run` — adding a dispatch history row is its own feature. Stop must keep working
  after this server restarts and has forgotten its in-memory dispatch record: today that case refuses any claim whose `host` is not this machine
  (`items-abort.service.ts`, "held on <host>, not this one"); it instead looks the claim's `host` up in the dashboard list and, for a remote one, does what
  the with-record path does: asks that dashboard to stop `holder.session`, then releases the claim. A `host` matching no listed dashboard keeps today's
  refusal.
- **The suggestion is driven by each dashboard's own usage numbers** — the 5-hour and weekly utilization (and their reset times, and the weekly projection) the
  dashboard already reads. The picker shows those figures beside each choice, so the suggestion explains itself.
- **The suggestion rule is a setting with three strategies**, so the user can try each and keep the one that works:
  1. **Prefer order** — the user orders the dashboards (e.g. Pro first). Suggest the first one in that order whose 5-hour and weekly utilization are both
     below a headroom threshold; if none is, the one with the most headroom (strategy 2's measure).
  2. **Most headroom** — suggest the dashboard with the most headroom, where a dashboard's *used* figure is the higher of its 5-hour and weekly percentages and
     headroom is 100 minus that (each account against its own limits, so Pro at 30% used beats Max at 50% used even though Max has more absolute budget left).
  3. **Least likely to run out** — use each dashboard's weekly projection: prefer a dashboard whose projection does not run out before its reset; among those
     (or if none qualifies), fall back to strategy 1's order.

  The prefer order defaults to the configured order with home first, until the user sets one. Partial data, for every strategy:

  | A dashboard's usage is…                                                        | It is…                                                          |
  | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
  | reachable with 5-hour and weekly figures                                       | ranked normally                                                 |
  | unreachable                                                                    | not offered (drawn disabled with its reason)                    |
  | reachable but with no usage (fetch failed, signed out, or `SHOW_USAGE` off)    | offered, never suggested on usage, drawn "usage unknown"        |
  | older than the cache's freshness limit                                         | treated as no usage, its age shown                              |
  | for strategy 3 only: no projection (`exhaustAt` null for a `walkAbsent` reason) | ranked as "projection unknown", after every dashboard that has one |
  | for strategy 3 only: weekly `resetsAt` already in the past                      | ranked as "projection unknown" (the walk returns `exhaustAt: null` for a past reset, which must not read as "does not run out") |

  When no offered dashboard has usage, the suggestion is home if home is offered, else the first offered in prefer order — labelled as a default rather than a
  usage pick. When nothing is offered, there is no suggestion and the launch is disabled with each machine's reason.
- **Work sent to a remote machine always comes back as a PR.** Remote execute is forced to `--finish pr`; remote orchestrate is forced to PR merge mode (one
  PR per run). The in-place and direct-merge choices are not offered when a remote machine is picked, and the server refuses them if a body asks anyway.
- **Remote runs appear in this board's history** through the existing `remote` array (`RemoteRunsService`, derived from tracker claim comments) — no new
  history mechanism. A claim carries no PR fields, so a remote PR-mode run's row has `prUrl: null` (`remote-runs.util.ts`): the row says it is a PR run (from
  `mergeMode`) but does not link the PR. Accepted for v1; the PR is on GitHub.

## Non-goals

- **Files-backed projects.** Only tracker-backed projects are routable. The user confirmed every project they would share is tracker-backed; a files project's
  edits would land in the other machine's checkout. For a files project the picker is not drawn — as it is not whenever only one machine is offered, which also covers the zero-remotes setup.
- **The remote machine's own projects** (cloned only there) stay on its own board. This board does not list, show or drive them.
- **Ticks.** A tick is fired by a dashboard's own scheduled job, not by the board, so it runs on whichever machine holds the job. Out of scope here. (The user
  wants to move the tick scheduler into backlog-manager itself — a separate project, below under Follow-ups.)
- **Fully automatic routing with no picker.** The board suggests; the person decides.
- **A proxy process.** The choice is made in this server, which already holds the dispatch gates.
- **Pausing, stopping or resuming a remote orchestrator run from this board** (my call, v1). Those controls write a server-owned file on the machine the run
  lives on; this board can't reach that file. The remote run is shown read-only, as `remote` runs are today. A run is resumed only on the machine it lives on,
  by that machine's own board and watchdog, so the hand-resume control gets no picker (my call). A single card dispatch is different — its Stop works from here
  (Goals).
- **Remote Jira Start** (user's answer: home only in v1). A Jira repo is not a tracker project: it has no claim protocol, `jira.mjs` on Pro would need Pro's
  board to hold the company Jira credentials, and the Jira live map and reconciler only see this machine's dashboard. Jira Start keeps running here.
- **Splitting one project's queue across two machines in one run.** One run is one machine.

## Anti-goals (failure even if it technically works)

- Code changes stranded uncommitted on the Pro machine — the "forgot the other box" problem in a new form.
- A suggestion that looks confident when the usage numbers are missing or stale. No usage means no usage-based suggestion, said plainly, never a guess dressed as
  a figure.
- A dashboard token reaching the browser, or the browser calling a dashboard directly.
- The watchdog on this machine trying to resume a run that lives on another machine.
- Two machines working the same item at once.
- The home-only setup (one dashboard, no remotes) behaving any differently from today.

## Constraints from the existing system

These are invariants in `CLAUDE.md` / `docs/subsystems/invariants.md`; the design must keep each.

- **A remote backlog-manager is reached over the tailnet, unauthenticated.** It binds loopback and is published only by `pnpm run tailnet` on its web port
  (Vite proxies `/api`); its Host allowlist admits `.ts.net`. Its reads here are read-only (health, registry, sync state), and the remote machine must run
  `pnpm run tailnet` for it to be offered.
- **Dashboard tokens never leave the server**, same as the GitHub and Jira tokens — and are env-only, as `BM_AGENTS_TOKEN` is today, never entered on a
  Settings page. Remote dashboards' URLs and tokens live server-side; the client sees names,
  reachability and usage figures only.
- **The browser never talks to the dashboard.** Usage is fetched server-to-server and served to the client from `/api`.
- **Every agents POST stays guarded** by content-type and origin; every route stays under `/api` and behind the Host allowlist.
- **Dispatch derives the action, never accepts one**; the spawn prompts stay composed server-side. The machine choice is a new input but the action still comes
  from the item.
- **"A project the dashboard cannot see cannot be dispatched to"** becomes per dashboard: each dashboard's gate is checked against that dashboard's own project
  list and path.
- **Remote runs ride beside `runs`, never in it.** A run started on the Pro machine writes its run file there; here it is a `remote` run, never a member of
  `runs`, so it never trips this machine's one-run-per-project lock or watchdog. The Pro machine's own backlog-manager (which the user keeps running for its own
  projects) is what watches and resumes it there.
- **The tracker claim protocol keeps the two machines disjoint** at the item level — unchanged.
- **The usage the dashboard reads comes from a private, undocumented Anthropic endpoint** (`claude-agents-dashboard/server/lib/usage.ts`), and the dashboard
  fails open to `null`. The suggestion must
  fail the same way.
- **Both processes bind loopback by default.** A remote dashboard is reached over the tailnet; that dashboard's own Host allowlist and token must admit this
  board's server.

## How it fits the existing pieces (decided)

- **Where the usage comes from.** The dashboard already has the live 5-hour and weekly utilization with reset times (in its `GET /api/sessions` snapshot and the
  hub usage gauge), and the weekly projection with `exhaustAt` (`GET /api/usage/profile`). This server reads those per dashboard, on its own schedule, and
  caches the answer with its age (the client shows the age, like the tracker and Jira caches).
- **Which machines are offered for a project.** A dashboard is offered for a project when it is reachable and its gate passes for that project on that machine.
  An unreachable one is drawn disabled with its reason, not hidden.
- **Project identity across machines** is the tracker repo (`owner/name`), not a disk path — the path differs per machine.
- **Settings** (user's answer: the Jira split). The dashboard list is added and edited on Shared Settings — name, dashboard URL, backlog-manager URL, machine
  name, model and effort lists — and saved to a server-owned settings file under `~/.backlog-manager/settings/`, with exactly one writer (the server) and the
  never-replace-an-unreadable-file rule `jira.json` and `tick.json` follow; it gets a CLAUDE.md headline and a `.claude/rules/` home like them. Each token is an
  env var named after its dashboard (e.g. `BM_AGENTS_TOKEN_PRO`), never entered on Settings and never in the file; the card shows only whether that token is
  set. The home dashboard keeps today's `BM_AGENTS_URL` / `BM_AGENTS_TOKEN`, so the home-only setup needs no file at all. The strategy, the prefer order and
  the headroom threshold sit on the same Settings card.

- **What "offered" checks on a remote machine** (my call). A remote session on a tracker project writes its items through the REMOTE machine's own
  backlog-manager (`backlog.mjs` needs the stack up there). So a remote machine is offered for a project only when its dashboard is reachable and its gate
  passes, AND its backlog-manager is up, has the repo registered and has the repo's sync on. This server reads that read-only; it is a new outbound
  destination, so the outbound-calling-modules list in `CLAUDE.md` / `api.md` must name it.
- **Models and efforts are per machine** (my call). No dashboard reports what its account can run, and a dashboard's spawn silently DROPS a model or effort
  outside its own fixed list (`claude-agents-dashboard/server/lib/spawn.ts`) — the session then runs on that account's default, with no error. So each
  dashboard entry in this server's configuration lists the models and efforts it may run (default: all of `MODELS` / `EFFORTS`); the picker offers only those
  for the picked machine, and the server refuses (400) a body naming one outside the list.
- **"Starting on <machine>" between a remote launch and its first claim** (my call). Held in server memory — never on disk, like the local starting entry —
  and shown on the board. Keyed by launch kind: a remote card dispatch by item, blocking a second launch of that item to any machine; a remote orchestrate by
  project and machine, blocking a second remote orchestrate of that project to that machine. It never blocks this machine's own
  Orchestrate (remote runs must not block local ones). It clears when the run's first claim appears in the tracker cache, or after a timeout (a `capture` claims nothing, so for it only the timeout applies). It
  rides in a sibling field of the runs payload, never in `starting`, which `runClaimBlock` and the local expiry read. After it clears, a live `remote` run for
  that repo whose claims carry that machine's `host` blocks a second remote orchestrate of the project to that machine, so the remote `init` never has to refuse
  after a wasted spawn.

- **The picker's look** (user's pick from the mocks, https://claude.ai/artifact/BYAn4vihad2VtVtr7yZnaH — option A, "Machine cards"). The picker is a "Run on"
  group at the top of the sheet, above every other field: one card-sized toggle button per offered machine, side by side, each with its name, the machine and
  account line, a 5 h and a weekly bar with their percentages, and the 5 h reset time. The suggested machine carries a "Suggested" tag and starts selected; the
  home machine carries a "home" tag. One line under the cards says which strategy suggested it and why, and links to the Settings card; the cache's age sits
  at the group's top right. An unreachable machine's card is drawn disabled with its reason. Picking a remote machine locks merge mode (or Finish) to PR with
  "Required when running on <machine>" under it, narrows Model and Effort to that machine's lists with a hint naming them, and the primary button reads
  "Start on <machine>". The card dispatch's picker is the same group, sized to that sheet. The same canvas also draws the Settings card (an ordered list of
  dashboards, home read-only from env, a token shown only as set or not set, the three strategies as a radio group, the threshold) and the board surfaces (a
  "running on <machine>" badge with Stop & release on the card; a `remote` history row naming the machine and PR mode, with no PR link) — those two are
  sketches the builder may adapt within `.claude/DESIGN.md`; the picker is the decided one.

## Left to the builder

- The settings file's name and shape, the token env var's naming rule (how a dashboard name becomes a variable name), and where the strategy settings live
  (that file, or the client's settings like other Shared Settings).
- How the server learns a shared project's path on the remote machine: the remote dashboard's project list, a mapping the user enters once in Settings, or the
  remote machine's backlog-manager. Must be keyed by tracker repo, and must fail closed (no path → that machine not offered).
- Which dashboard routes to read usage from, and the poll cadence. If no existing route is cheap enough, a small read-only usage route on the dashboard is in
  scope as a change to `claude-agents-dashboard`.
- The base proof for a remote launch — both a remote execute and a remote orchestrate, which reach the same local `show-ref` through `proveBaseBranch`
  (`server/src/items/base-branch.util.ts`). Checking this machine's clone of the same repo, or `refs/remotes/origin/<base>` as of its last fetch (the server
  never fetches), are both acceptable; say which.
- The default headroom threshold for strategy 1, the cache's freshness limit, and how ties rank in strategy 2.
- Where the machine shows on a run row, a card's live badge and the run's detail sheet, within `.claude/DESIGN.md` (the mocks above are a starting point).

## Open for the user

- None left. Answered after the builder check: Jira stays home-only in v1; a remote card dispatch gets a badge and Stop here (no history row — see Goals).

## Follow-ups (separate projects)

- **Remote Jira Start**, once Pro's board can hold Jira credentials and the live map can see more than one dashboard.

- **Move the tick scheduler into backlog-manager.** Today a dashboard job fires the tick, and the tick then reads backlog-manager's items: each depends on the
  other. Owning the schedule here would also let ticks use this machine picker.
