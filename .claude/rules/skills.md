---
paths: ["skills/**", "agents/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **`~/.backlog-manager/registry.json` has exactly one writer**: `skills/backlog/tools/backlog.mjs` (`init`/`new` upsert, plus `unregister`, the one removal
  path). The server re-reads it per request, never writes, never caches. What gets written is `registryRoot(root)`, not the root `resolveRoot` returned
  (bug-17): a linked worktree registers its **main tree**, a bare main repo registers nothing (non-fatal stderr note), and `resolveRoot` itself is deliberately
  unchanged. The discriminator is a `commondir` entry in the `gitdir:` target, never "`.git` is a file". Why:
  [invariants.md](docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree)
- **`~/.backlog-manager/retro/` has exactly one writer, `retro.mjs record`, and `backlog-retro` never writes under the run-state directory** — the same
  relationship `registry.json` and `run.json` each have with their writer, stated for the third directory under `~/.backlog-manager` a tool owns. A record is
  evidence, so `record` refuses to overwrite one (exit `2`): the fix for a wrong record is the next sweep, never an edit. `sweep` reads four homes and writes
  none of them — the run-state home, the retro home (for deltas), `registry.json` (for project names) and, by recorded lease id alone, one driver transcript per
  run. Why: [invariants.md](docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state)
- **`backlog.mjs` in a tracker project needs the stack up, and says so with exit `5`.** The marker decides the mode — absent or `{"kind":"files"}` runs today's
  synchronous code byte for byte and makes no HTTP request on any verb; `{"kind":"github"}` with a valid repo routes every command through
  `http://127.0.0.1:${BM_API_PORT ?? 4322}`; anything else is exit `1` naming the marker, NEVER a fallback to files. There is no offline queue on purpose: a
  parked write would be a second source of truth on one laptop. Ids are `31` / `#31` / this project's own URN; a file-shaped id and another repo's URN are each
  refused with their own sentence. Why: [invariants.md](docs/subsystems/invariants.md#backlogmjs-in-a-tracker-project-needs-the-stack-up)
- **`import` writes the marker first and deletes the files last, and the `bm:imported` footer is its idempotency key.** The eight write routes refuse a `files`
  project, so no request `backlog.mjs import github [owner/repo] [--no-forms]` makes could precede the marker; the deletion is the transaction's commit and runs
  only after pass 2 has rewritten every cross-link. A re-run rebuilds `old id → #n` from the `<!-- bm:imported from=<id> … -->` footer on each indexed issue and
  skips those items — the footer is on the tracker, where a crash cannot lose it, and the readable `_Imported from …_` line beside it is never parsed. Counters
  ride ONE synthetic `claim` + `release` (`reason: 'imported'`) BEFORE the close, because `claim` refuses a closed issue, and a resumed repair deliberately does
  not re-bill them. An over-cap body is cut at a `## ` boundary and links the file at HEAD, which is why HEAD must be on an `origin/*` ref and `backlog/` must be
  clean — except that a resume ignores its own uncommitted marker (`?? backlog/source.json` or `A  backlog/source.json`, via `withoutResumeMarker`), which a
  stopped run always leaves and the link never points at; ` M backlog/source.json` still refuses. Every refusal leaves the project byte-identical, a mid-run
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
  which round-trip unknown keys and the body byte-for-byte; "in progress" is decided in the client. Why:
  [invariants.md](docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status)
- **Every skill CLI ends with `process.exitCode = main(...)`, never `process.exit(main(...))`.** Writing to a pipe is asynchronous, so `process.exit()`
  drops everything past 65,536 bytes of a `--json` payload while a `> file.json` redirect stays fine — which is why the shipped instance passed every hand
  check. Safe only because none of them holds the event loop open (synchronous `fs`, `spawnSync` children, and `watch`'s `Atomics.wait` sleep); whoever
  adds a timer, server or async child closes the handle rather than restoring `process.exit()`. **`backlog.mjs` and `api-call.mjs` may also end
  `process.exitCode = await main(...)`** (task-46, task-47): the rule is about `process.exit()` truncating a pipe, which asynchrony has nothing to do with, and
  each one's every `fetch` is awaited to completion with `connection: close`, so no pooled socket outlives the call. `orchestrate.mjs` and `retro.mjs` hold no
  asynchronous work and stay on the synchronous form, which the guard enforces per file — and `orchestrate.mjs` can, precisely because `api-call.mjs` is a
  CHILD it `spawnSync`s rather than a `fetch` it awaits. Each tool carries its own note on why _its_ file is safe;
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
