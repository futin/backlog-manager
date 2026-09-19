# Phase 3 write-back — live verification

**2026-09-19.** Manual end-to-end test of task-46 (phase 3: write-back through the API for tracker projects) against a real GitHub repository, run
before and immediately after merging `feature/tracker` into `main`. Companion to
[2026-09-17-tracker-backed-backlog-design.md](2026-09-17-tracker-backed-backlog-design.md) §6–§7 and
[task-46](../../../backlog/tasks/done/task-46-tracker-backed-phase-3-write-back-through-the-api-seven-write-routes-the-claim-protocol-backlog-mjs-api-mode-dispatch-for-tracker-items-and-the-skills-prose.md).
Everything below is a claim checked against a live artifact (a GitHub issue, the board's `/api/items`, or a transcript file) — nothing here is asserted
from reading code.

## Setup

- **Test repo:** [futin/test-claude-issues](https://github.com/futin/test-claude-issues), created empty for this purpose, throwaway.
- **Registered** via `backlog.mjs init`, **connected** via `backlog.mjs connect github futin/test-claude-issues` — wrote `backlog/source.json` (`{"kind":"github","repo":"futin/test-claude-issues"}`) and the four issue-form templates, committed and pushed to `main`.
- **Token:** a fine-grained PAT in the server's `.env` (`BM_GITHUB_TOKEN`), scoped to **Issues: read/write** + **Metadata: read** on this repo specifically. First attempt used a token not yet scoped to the repo — surfaced correctly as `access: "not-found"` on `GET /api/trackers`, not a silent failure; re-scoping the token and re-polling flipped it to `access: "ok"` with no restart needed (access is checked live per poll; only the token *value* needs a restart).
- **Server:** the docker-compose stack (`server`/`client` containers), which bind-mounts the whole repo (`.:/app`) and runs `nest start --watch` — i.e. it was already serving `feature/tracker`'s live source before any merge. The server container was restarted once to pick up the corrected token (env vars are interpolated at `docker compose up`, not read live from `.env`).

## Test 1 — read side (poller, label bootstrap, issue mapping)

- Filed issue #1 via GitHub's UI, title only. Landed on the board within one poll tick as `test-claude-issues` / `#1` / **section: ideas** / `untyped: true` — because the actual applied label was GitHub's stock `bug`, not our `type:bug` (a UI quirk, not a bug in the mapper: our type labels are deliberately namespaced to never collide with GitHub's default nine).
- Confirmed all eight `type:*`/`kind:*`/`in-progress`/`runner-fix` labels already existed in the repo — the poller's label bootstrap (phase 2) had created them idempotently on first successful sync, before any issue existed.
- Swapped the label to `type:bug` by hand (`gh api .../labels`). Next poll tick: item moved to **section: bugs**, `untyped: false`. Confirms the mapper reads `type:*` labels live, per poll, not cached at issue-creation time.

## Test 2 — write-back (`backlog-groom`, phase 3's write routes)

- Ran `/backlog-groom` in an ordinary Claude Code session, cwd = the test repo. It correctly identified the item as tracker-backed and wrote `## Cause` / `## Fix` **into the GitHub issue body itself** — confirmed via `gh api repos/.../issues/1`, body updated, no local file ever created under `bugs/open/`.
- Board reflected it immediately: `groomed: true`, `updated` bumped to the edit timestamp.
- Caveat worth recording: this particular session succeeded despite running the **stale installed plugin** (marketplace cache, pre-task-46) — it improvised by reading the live `feature/tracker` checkout's server source directly (a sibling directory on disk) rather than following stale skill prose. Real, but not a reliable substitute for the plugin actually carrying the code (see Test 3 and "Gotcha" below).

## Test 3 — dispatch, claim protocol, execute, close-out

**First attempt failed instructively.** Clicking Start on the board dispatched a `backlog-execute` session that resolved `$CLAUDE_PLUGIN_ROOT` to the
still-stale marketplace install (`0.1.1`, pre-task-46). It had no notion of a `gh:owner/repo#n` id shape — tried `backlog.mjs show bug-1`, got
`unknown id: bug-1`, and was stopped by hand after ~3 minutes of unproductive exploration. Root cause: `feature/tracker` (task-46) was committed and
pushed but not yet merged to `main`, and `plugin:sync` only ever installs from `origin/main` — so no amount of local branch work reaches a dispatched
session until it's merged and synced.

**Fix applied:** merged `feature/tracker` → `main` (`b5f00c8`, fast-forward-able, clean), ran the full suite (`pnpm test`: **620/620 passed**, jest +
node runner both green), pushed, ran `pnpm run plugin:sync` → installed `v0.1.1 @ b5f00c8`. Verified the installed copy now contains tracker-mode code
(`grep` for `kind === 'github'` in the installed `backlog.mjs` hit).

**Second attempt — clean pass, full loop:**

1. Session `576ce284` launched, resolved the skill from the freshly-synced plugin, read `backlog/source.json`, correctly identified tracker mode.
2. `node backlog.mjs show 1 --json` → resolved `gh:futin/test-claude-issues#1`, printed the full item, no confusion.
3. Ran `superpowers:systematic-debugging` against the real repo state (`git ls-files` → 5 scaffolding paths, zero application code) and correctly
   re-confirmed the recorded Cause: this is synthetic test data with nothing to fix.
4. `node backlog.mjs stop 1 --keep-started` → billed the execute session, posted/edited the claim comment (`<!-- bm:claim -->`, session id,
   `phase: execute`, live heartbeat).
5. `node backlog.mjs move 1 done --outcome <file>` → posted the `## Outcome` comment and closed the issue.

**Final state, cross-checked on both sides:**

| | Board (`GET /api/items`) | GitHub (`gh api .../issues/1`) |
|---|---|---|
| status | `done` | `state: closed`, `state_reason: completed` |
| groomed | `true` | `## Cause`/`## Fix` present in body |
| labels | `untyped: false` | `type:bug` kept, `in-progress` cleared |
| assignee | `futin` | — |
| billing | `executeElapsed: 62`, `executeTokens: 10682` | — |
| comments | — | claim comment (posted → edited → released) + separate `## Outcome` comment |

No local commit was made or expected — a tracker item has no file to commit; the groomed/executed record lives entirely in the issue body and its
comments.

## What this proves

The full phase-3 loop works against a real GitHub repository, unmodified from what ships in `main` today: **connect → poll (read + label
bootstrap) → groom (write-back through the API) → dispatch → claim (comment protocol, heartbeat) → execute → archive/close**. Every write in the
loop went through the seven guarded `/api/items/*` routes and the claim-by-comment protocol exactly as spec'd — nothing was hand-patched to make
the test pass.

## Gotcha worth keeping

**Dispatch against a tracker project is only as good as the installed plugin.** Unlike Orchestrate (which has an explicit phase-4 gate refusing
tracker projects outright), a single-item dispatch on a tracker project will *launch* against whatever plugin version happens to be installed —
silently succeeding by model improvisation, or visibly flailing, depending on luck. The practical rule going forward: merge and `plugin:sync`
tracker-affecting skill changes before dispatch-testing them live; don't rely on manually running `/backlog-groom` or `/backlog-execute` from an
un-synced branch as a substitute for a real dispatch test.

## Next

Phase 4 — orchestrator on a tracker project (spec §7) — not yet captured. Orchestrate stays correctly gated off until then
(`projectIsFiles` client-side, `orchestrating a tracker project arrives in phase 4` server-side).
