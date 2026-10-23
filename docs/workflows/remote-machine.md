# Setting up a remote machine

Run this once per extra machine you want a card or an Orchestrate run to start on from this board (multi-dashboard). A remote machine is a second computer that
already runs its own `claude-agents-dashboard` and its own backlog-manager board; this board never spawns anything there itself — it asks that machine's
dashboard to, and reads that machine's board for where the project lives. Nothing is needed for a single-machine setup: with no `dashboards.json` the board is
home-only, draws no picker and makes no request to anywhere else.

The design is [the multi-dashboard spec](../superpowers/specs/2026-10-22-multi-dashboard-design.md); the reasoning for the file's single writer and for tokens
living in the environment is in
[invariants.md](../subsystems/invariants.md#dashboardsjson-has-exactly-one-writer-the-server-and-a-file-that-cannot-be-read-is-never-replaced), and the routes
in [api.md](../subsystems/api.md#launching-on-another-machine).

## On a tailnet: the short path

When both machines are on one tailnet, the remote's dashboard trusts tailnet devices, and both apps run on their default ports (dashboard 4173, board 5177),
this is the whole setup — no token and nothing in this machine's `.env`:

1. **On the remote:** `BM_MACHINE_NAME=<name>` in `~/.zshenv` and in its board's `.env`, a restart of its stack, and `pnpm run tailnet` once so its board is
   reachable (Vite listens on `127.0.0.1` otherwise).
2. **Here:** Settings › Dashboards › Add dashboard, with the Name the same as that `BM_MACHINE_NAME` and the Dashboard URL
   `http://<name>.<tailnet>.ts.net:4173`. Leave Board URL and Machine name blank: they are stored as the same host on `:5177` and the name, and the fields show
   those defaults as their placeholders.

The token line reads `not set — needed only if that dashboard does not trust this machine`, which is the expected state here. Anything off that path — another
port, a dashboard that does not trust the tailnet, a machine name that differs from the entry's name — is the full list below.

## What a remote needs

- Its dashboard running with dispatch enabled, and reachable from THIS board's API host (the server calls it — the browser never does).
- Its own board running, reachable the same way. This board reads `GET <bmUrl>/api/projects` there, with no `Authorization`, to learn the project's path on that
  machine; the repo is matched by its identity (the `origin`, case-insensitive), so the same repo must be registered on both boards, and it must be a tracker
  project — a `files` project is refused for a remote launch.
- A name for the machine, set the same way on both sides of its own claims: **`BM_MACHINE_NAME` on the remote must equal the `host` you enter here** (blank
  means the entry's name), because a claim comment records the name the session ran under and the board decides "this card is running over there" by comparing
  that `host` to a configured remote's. Set it in the remote's shell environment (`~/.zshenv`, which `backlog.mjs` and `orchestrate.mjs` read) and in that
  board's `.env` (which compose passes to its server). Choose a name rather than publish an OS username and hostname: on a public repo the claim comment
  carries it.

## Steps

1. **On the remote, set the name** in `~/.zshenv` and in its board's `.env` (`BM_MACHINE_NAME=pro`), then restart its stack so the server reads it.
2. **On the remote, publish the web port to the tailnet:** `pnpm run tailnet` (it serves the port in that board's `.env`, `BM_WEB_PORT`, on the same number).
   That is the `bmUrl` — `http://<name>.<tailnet>.ts.net:<web port>` — and the dashboard's own port (4173 by default) is the `url`.
3. **Let this board in.** Both remote processes refuse a request whose `Host` is not one they recognise (DNS-rebinding defence), and the two do not accept the
   same names. The remote **board's** `bmUrl` goes to its web port, whose Vite server admits only an IP, `localhost` and a `.ts.net` name — `BM_ALLOWED_HOSTS`
   is read by the board's API port and does not widen it — so write `bmUrl` with the remote's `.ts.net` name (what `pnpm run tailnet` prints) or its IP, never a
   bare machine name or a custom domain. The remote **dashboard's** `url` is judged by the dashboard's own rule, which also admits a single-label name,
   `*.local` and `*.localhost`; anything beyond those goes in that dashboard's `ALLOWED_HOSTS` (its `.env.example` documents the rule — it is the dashboard's
   setting, not this board's). The dashboard's write gate admits this machine, and a tailnet device while its "Trust tailnet devices" setting is on; a client it
   does not trust needs the dashboard's `ANSWER_TOKEN` — set one on the remote if you reach it any other way, and note its value for the next step.
4. **Only if step 3 needed a token — put it in THIS board's `.env`:** `BM_AGENTS_TOKEN_<NAME>=<the remote's ANSWER_TOKEN>` with the NAME the entry will have,
   upper-cased (`BM_AGENTS_TOKEN_PRO` for `pro`). Home's own token is `BM_AGENTS_TOKEN`. Then restart the stack — compose's container reads the bind-mounted
   `.env`, not your shell, and compose passes `BM_MACHINE_NAME` through but no token. With no token the server sends no `Authorization` header at all. The token
   is never typed into the board: Settings only reports `✓ set` or `not set`.
5. **Add the entry:** Settings › Dashboards › Add dashboard. Name (a letter, then letters and digits, at most 24, unique ignoring case, never `home`)
   and the dashboard `url` are required. The board `bmUrl` and the `host` from step 1 are optional: blank stores `http://<url's host>:5177` and the name. An
   account label, and a models or efforts list if the remote should run only some of them (leave every box ticked for "all"), are optional too. At most eight
   remotes. Save writes `~/.backlog-manager/settings/dashboards.json` (or `$BM_DASHBOARDS_FILE`).

## Verification

- The Dashboards page (Settings › Dashboards) draws the new row, with a health dot once the status read lands. Its token line reads `✓ set` if you did step 4; if you did and it reads `not set`, step 4 did not reach the server —
  check the variable's exact name and that the stack was restarted.
- Open any launch sheet for a tracker project that is registered on both boards: a `Run on` group appears at the top with a card per machine. The remote card is
  enabled and shows its usage; if it is disabled the reason is printed in the card — that is the one place the refusal is read.
- Launch a small card on the remote. The card reads `Starting on <name>`, then `running on <name>` once the remote's session claims it; Stop & release stops it
  there.

## Failure modes

**Every write on the card answers 409.** `dashboards.json` exists and cannot be read — a hand edit left it malformed or unreadable. The board treats the remotes
as absent (home-only) and refuses to overwrite the file; fix or remove it by hand. A missing file is not this: it is just home-only.

**The remote card is disabled with a reason.** The offers read is judged afresh each time, with a 5 s timeout per remote: a dashboard that is unreachable or has
dispatch off, a board that is unreachable, a repo not registered on the remote's board, a files project, and a repo whose sync is off there each read as that
card's reason. The launch is judged again at click time, so a card that was offered a minute ago can still answer 409
`<name> is not offered for <project>: <reason>`, and a remote that is already running that repo answers 409 `a run of <repo> is live on <name>`.

**A remote card never reads `running on <name>`, or Stop & release is a plain Release.** The claim's `host` does not equal the entry's `host`, so the board
cannot tell the claim is the remote's, and the stop takes today's home-only path. Make `BM_MACHINE_NAME` on the remote and the entry's `host` the same string.

**A launch is refused `finish must be pr on <name>` or `merge mode must be pr on <name>`.** A remote run is PR-only; the sheet locks both pickers for it, so
this means a request was sent by hand.

**Resume, pause and run Stop do nothing for a remote run.** They are home-only: the board draws a remote run read-only, and a stop for a card's session goes
through the card (`Stop & release`).
