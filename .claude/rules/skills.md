---
paths: ["skills/**", "agents/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **`~/.backlog-manager/registry.json` has exactly one writer**: `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`, the one removal
  path). The server re-reads it per request, never writes, never caches. What gets written is `registryRoot(root)`, not the root `resolveRoot` returned
  (bug-17): a linked worktree registers its **main tree**, a bare main repo registers nothing (non-fatal stderr note), and `resolveRoot` itself is deliberately
  unchanged. The discriminator is a `commondir` entry in the `gitdir:` target, never "`.git` is a file". Every write is temp file + `rename` in the registry's
  own directory, and only `ENOENT` starts fresh — an unparseable registry is left untouched, copied to `registry.json.corrupt-<ts>`, and the registration
  skipped with a stderr line (#255). Why:
  [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs record`, and `backlog-retro` never writes under the run-state directory** — the same
  relationship `registry.json` and `run.json` each have with their writer, stated for the third directory under `~/.backlog-manager` a tool owns. A record is
  evidence, so `record` refuses to overwrite one (exit `2`): the fix for a wrong record is the next sweep, never an edit. `sweep` reads four homes and writes
  none of them — the run-state home, the retro home (for deltas), `registry.json` (for project names) and, by recorded lease id alone, one driver transcript per
  run. Why: [invariants.md](docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state)
- **`~/.backlog-manager/tick/` has exactly one writer, `tick.mjs`, and `backlog-tick` never writes the orchestrator's run-state directory.** The directory is
  `<home>/<project-key>/` with a `lock` and a `state.json`, the key being `encodeURIComponent(<absolute main-checkout path>)` — the key `orchestrate.mjs`'s
  `projectDir` computes — and `$BM_TICK_HOME` overrides the home for the reason `$BM_ORCH_HOME` and `$BM_RETRO_HOME` exist. Only `tick-state.mjs` writes there,
  every write a temp file in the same directory plus a `rename`/`link`, never in place. `decide` opens the run-state home read-only, to see a `running` or
  `paused` run, and nothing else: no `run.json`, no control file, no sidecar. The tool is self-contained by the same rule every skill's is: it imports nothing
  from another skill's `tools/`, from `server/` or from `shared/`, and shells out to neither `orchestrate.mjs` nor `backlog.mjs`, so every rule it shares with
  one of them is a TWIN whose comment names the original, and a prune of one skill never breaks another. It writes no git either — every git call is a read.
  Why: [invariants.md](docs/subsystems/invariants.md#backlog-managertick-has-exactly-one-writer-and-the-tick-never-writes-run-state)
- **A tick does at most one unit of work, only when the project is idle, and never executes a plan that still carries `plan-review`.** `tick.mjs decide` prints
  ONE verdict — `execute`, `groom`, `recover`, `busy` or `idle` — and writes the lock only for the first two; the skill carries that verdict out in its own
  session and ends with `record`, which releases it. Busy is any of: a `running` or `paused` orchestrator run, a board-started run with no run file yet (read
  through the API, so skipped with the stack down), a `started:` marker on any open item in the main checkout or a linked worktree (the orchestrator's
  `.worktrees/<id>` and execute's `.worktrees/execute-<id>` trees skipped), a live claim, or a fresh remote run. Execute is capped by the open PRs whose head
  starts `execute/` (`gh pr list --state open --limit 500`; no `gh`, a failure, unparseable output or 500 results is `cannot count open PRs`) and groom by the
  items carrying `plan-review`; a groom only plans an ungroomed bug or promotes a refactor. The mark is the label on a tracker project and a `plan-review: true`
  frontmatter line on a files project, written in the SAME write as the plan — `backlog.mjs body|new --plan-review`, or the frontmatter groom prints — so no
  moment exists where an approved-looking plan has no mark, and every gate refuses it with one sentence, `this plan awaits review` (`PLAN_REVIEW_REASON`,
  `shared/agent.ts`, with hand-kept copies in `orchestrate.mjs` and the execute skill): the board's Run, the server's `plan`/`dispatch` ladder
  (`planReviewBlock`, always after `inReviewBlock`), the orchestrator's queue and `backlog-execute`'s own refusal. A tick never merges, never commits a groom,
  never promotes an idea, never rejects, never asks and never leaves anything running. Why:
  [invariants.md](docs/subsystems/invariants.md#a-tick-does-one-unit-only-when-idle-and-never-executes-a-plan-that-awaits-review)
- **The only `started:` marker a tick clears is the one a killed tick left, identified by the verdict in its own stale lock.** A lock older than `--lock-ttl`
  (default 180 minutes) is a tick the dashboard killed; `decide` claims it (`claimStaleLock` renames it aside and owns it only if the bytes are the ones judged
  stale, so two ticks cannot both recover), records the item `failed` — `killed at timeout` — and answers `recover`. It sets `stop: true` only where the marker
  is provably its own: a FILES project, the lock's verdict a `groom`, and that id's file in the main checkout carrying `started:` with `phase: groom`. The skill
  then runs `backlog.mjs stop <id> --abandon` on that one id. A tracker claim is never cleared by a tick (it goes stale after 15 minutes and the next `start`
  retires it), an execute's marker lives in `.worktrees/execute-<id>` and is never touched, and every other marker is a person's or another session's and keeps
  blocking the project. Why: [invariants.md](docs/subsystems/invariants.md#the-only-started-marker-a-tick-clears-is-the-one-a-killed-tick-left)
- **`backlog.mjs` in a tracker project and `jira.mjs` always need the stack up, and say so with exit `5` — save `jira.mjs worktree`.**
  The marker decides the mode — absent or `{"kind":"files"}` runs today's synchronous code byte for byte and makes no HTTP request on any verb;
  `{"kind":"github"}` with a valid repo routes every command through `http://127.0.0.1:${BM_API_PORT || 4322}`; anything else is exit `1` naming
  the marker, NEVER a fallback to files. There is no offline queue on purpose: a parked write would be a second source of truth on one laptop. Ids are `31` /
  `#31` / this project's own URN; a file-shaped id and another repo's URN are each refused with their own sentence. `review <id> on|off` is the opposite —
  tracker-only, through `POST /api/items/review`, exit `1` in a files project. `jira.mjs` has no files mode at all: every command but
  `worktree` is an
  API call, a refused connection is exit `5` with a sentence naming the backlog-manager checkout (it runs in a mapped repository, where `pnpm run dev` means
  something else), and its other codes are `2` (a 4xx) and `3` (a 5xx). `worktree` makes no request — git only, so it works with the stack down — and exits `0`,
  `1` or `4` (git refused, or a re-check stopped the Run; nothing changed), never `2`, `3` or `5`. Why:
  [invariants.md](docs/subsystems/invariants.md#backlogmjs-in-a-tracker-project-needs-the-stack-up)
- **`import` writes the marker first and deletes the files last, and the `bm:imported` footer is its idempotency key.** The eleven write routes refuse a `files`
  project, so no request `backlog.mjs import github [owner/repo] [--no-forms]` makes could precede the marker; the deletion is the transaction's commit and runs
  only after pass 2 has rewritten every cross-link. A re-run rebuilds `old id → #n` from the `<!-- bm:imported from=<id> … -->` footer on each indexed issue and
  skips those items — the footer is on the tracker, where a crash cannot lose it, and the readable `_Imported from …_` line beside it is never parsed. Counters
  ride ONE synthetic `claim` + `release` (`reason: 'imported'`) BEFORE the close, because `claim` refuses a closed issue — so both `done/` and a rejected
  `bug`/`task`/`idea`/`ref` item are created open and closed by a later `state` request, only a born-rejected `oos-N` is created closed, and an `oos-N` carrying
  counters is refused before the marker — and a resumed repair deliberately does not re-bill them. An over-cap body is cut at a `## ` boundary and links the
  file at HEAD, which is why HEAD must be on an `origin/*` ref and `backlog/` must be clean — except that a resume ignores its own uncommitted marker
  (`?? backlog/source.json` or `A  backlog/source.json`, via `withoutResumeMarker`), which a stopped run always leaves and the link never points at;
  ` M backlog/source.json` still refuses. Every refusal leaves the project byte-identical, a mid-run
  failure deletes nothing, and `import` never commits. Why:
  [invariants.md](docs/subsystems/invariants.md#import-writes-the-marker-first-and-deletes-the-files-last)
- **`refactors/` is a peer section, not a facet on ideas**: ideas are new, refactors are existing things that should be improved. Prefix `ref`, lifecycle
  identical to ideas (`open/` → `done/`, promotable to a task with `from:`, rejectable). `kind: chore | debt` is written by `backlog-capture`, round-tripped by
  the CLI as an unknown key, passed through verbatim by the API, and badged only for the values `REFACTOR_KINDS` lists. `backlog-execute` refuses the section
  outright. Why: [invariants.md](docs/subsystems/invariants.md#refactors-is-a-peer-section-not-a-facet-on-ideas)
- **`started:` and `phase:` are the lifecycle keys allowed in frontmatter, and neither is a status** — the `status:` ban stands.
  `start <id> [--as groom|execute]` writes `started:` (second-precision UTC) and, with `--as`, `phase: groom` / `phase: execute`; `stop <id>` bills
  `groom-elapsed:`/`execute-elapsed:` and `groom-tokens:`/`execute-tokens:` — four permanent, accumulating integer counters behind ONE billable gate — then
  removes `phase:` and, unless `--keep-started`, `started:` too. Cache reads are excluded from the token count; attribution is whole-session-within-the-window;
  an unattributable count writes no key, never `0`. `updated:` is stamped by every `start` and every `stop`, never by `move`. Written only by `start`/`stop`,
  which round-trip unknown keys and the body byte-for-byte; "in progress" is decided in the client. `groomed-at:` (#322) is an anchor, not a lifecycle key:
  `new` stamps `HEAD` for a bug or task (a tracker body's one `bm:groomed-at` footer, kept to one by `body`), a groom `stop` re-stamps it, and nothing else
  writes it — `drift <id>` derives from it and stores nothing. `plan-review: true` (backlog-tick) is the other non-lifecycle key a tool-written item can carry,
  `runner-fix:`'s family — a GATE, not a lifecycle key, and not a status: a tick's groom writes it in the same write as the plan, every execute gate refuses an
  item that carries it, and a person approves by deleting the line and committing. It is read by PRESENCE, any value but `false` (trimmed, case-insensitive)
  counting, so a hand-typed `plan-review: yes` still gates. Why:
  [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **Every skill CLI ends with `process.exitCode = main(...)`, never `process.exit(main(...))`.** Writing to a pipe is asynchronous, so `process.exit()`
  drops everything past 65,536 bytes of a `--json` payload while a `> file.json` redirect stays fine — which is why the shipped instance passed every hand
  check. Safe only because none of them holds the event loop open (synchronous `fs`, `spawnSync` children, and `watch`'s `Atomics.wait` sleep); whoever
  adds a timer, server or async child closes the handle rather than restoring `process.exit()`. **`backlog.mjs`, `api-call.mjs` and `jira.mjs` may also end
  `process.exitCode = await main(...)`** (task-46, task-47, Jira phase 4): the rule is about `process.exit()` truncating a pipe, which asynchrony has nothing to
  do with, and each one's every `fetch` is awaited to completion with `connection: close`, so no pooled socket outlives the call. `orchestrate.mjs` and
  `retro.mjs` hold no asynchronous work and stay on the synchronous form, which the guard enforces per file — and `orchestrate.mjs` can, precisely because
  `api-call.mjs` is a CHILD it `spawnSync`s rather than a `fetch` it awaits. Each tool carries its own note on why _its_ file is safe;
  `retro.mjs`'s is the long-form copy. `backlog.test.mjs`'s `CLI_SOURCES` is where the list of files lives — never a count in prose — and it is the only one of
  the cases that covers an entry point nobody has written yet. Why:
  [invariants.md](docs/subsystems/invariants.md#every-skill-cli-exits-through-processexitcode-never-processexit)
- **Editing `skills/` changes nothing until it is committed, pushed, and `pnpm run plugin:sync` runs.** An install is a copy of the pushed HEAD, never the
  working tree; the sync refuses dirty/unpushed/behind states. New skills load on the next Claude Code restart. Why:
  [invariants.md](docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync)
- **`agents/` is part of the plugin's publish surface.** An install carries only what `PUBLISHED_PATHS` (`scripts/sync-plugin.mjs`) and the marketplace's
  `sparsePaths` both list. The machine-local half is declared in `~/.claude/settings.json` → `extraKnownMarketplaces.<marketplace>.source.sparsePaths`, never in
  `known_marketplaces.json` — a cache, and hand-editing it triggers the revert. The sync measures every published path on both sides (bug-10). Why:
  [invariants.md](docs/subsystems/invariants.md#agents-is-part-of-the-plugins-publish-surface)
- **A new orchestrate rule enters SKILL.md as one statement; its story and its rare branches go to references/.** The body of
  `skills/backlog-orchestrate/SKILL.md` is resident for every turn of a run, so a new rule enters it as ONE imperative statement and nothing else. The
  incident that earned the rule — the bug or task id, the date, the measurement, what the failed version did — goes to `references/rationale.md`; the body
  carries no `bug-N` / `task-N` / `#N` (any width) / run-id (`run-YYYYMMDD-HHMMSS`) history outside a ``` or ~~~ fenced block, and the guard in
  `orchestrate.test.mjs` names the line that has one. A branch a clean
  run never takes (a failure path, a rare mode, one source kind) goes to its own `references/*.md` file, and the body names that file on a trigger the run
  can OBSERVE — a verdict, an exit code, a field of `backlog/source.json` — never on the driver's judgement that the case "might apply". The trigger has to
  be reachable on BOTH entry paths: a fresh run and a `--resume`, which skips the sections a fresh run finds the pointer in. Prose that only tells the driver
  to run a fixed sequence of commands and read the answer becomes an `orchestrate.mjs` subcommand, and the body keeps "run X, act on its verdict". Each
  statement the body keeps gets a `[needle, rule]` pair in the `RULES` list of the "the body keeps the rules whose stories moved to references/" case in
  `orchestrate.test.mjs` — the needle a phrase of the statement, the rule a sentence naming what was lost — so a later trim fails by rule name. The size
  report beside it (the body's size against its baselines, via `t.diagnostic`) is informational and must never become an assertion: a hard budget is how a
  load-bearing rule gets compressed away. Why:
  [invariants.md](docs/subsystems/invariants.md#a-new-orchestrate-rule-enters-skillmd-as-one-statement-its-story-and-its-rare-branches-go-to-references)
