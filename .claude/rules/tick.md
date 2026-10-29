---
paths: ["server/src/tick/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **`~/.backlog-manager/settings/tick.json` has exactly one writer, the server, and a file that cannot be read is never replaced.** The file is `$BM_TICK_FILE`,
  else `~/.backlog-manager/settings/tick.json`, shaped `{ haltAfter, maxPlans, maxPrs, resetAt: { <abs main-checkout path>: <ISO> } }`, and `writeTickFile` in
  `server/src/tick/tick-breaker.util.ts` is the only thing that writes it: a temp file in the SAME directory, then `rename`, merged over the current file with
  `resetAt` merged key by key, so a Reset of one project never forgets another's, and every number the write was not sent carried over from the file. `tick.mjs` (`readTickSettings`) reads it for `decide` and `status`; the server
  reads it only to answer GET and to merge its own write. Reading has three outcomes — `ok`, `missing` (ENOENT: `haltAfter` 3, `maxPlans` 3, `maxPrs` 2, no resets) and `unreadable` — and
  UNREADABLE is an I/O error that is not ENOENT, text that is not JSON, or JSON that is not a plain object (stricter than `jira.json`, which reads a non-object
  as empty: a hand-edit in flight is not "3, no resets"). An unreadable file is never replaced — both POSTs throw `TickFileUnreadable` BEFORE any write and
  answer `409`, leaving the file byte-identical; `GET /api/ticks` answers `config.source: "unreadable"` with `haltAfter` 3 and the caps 3 and 2 for display only; and `tick.mjs
  decide` answers `idle`, so no project ticks until a person fixes it. `haltAfter` is an integer 1–10 (`TICK_HALT_LIMITS`), and so are `maxPlans` and `maxPrs`
  (`TICK_CAP_LIMITS`, the tool's `CAP_MIN`/`CAP_MAX` hand copy, pinned by twin `CAP_CLAMP` tables): a non-integer in the FILE reads as that key's default, in a
  POST body it is a `400` naming the key; a number outside the range clamps; `POST /api/ticks/config` takes any non-empty subset of the three (`400 nothing to
  set` for none), and an omitted cap flag on `decide` falls back to the file before 3 / 2. `POST /api/ticks/reset` stamps `max(now, the newest parseable at in that project's
  recent)`, allowed in every state, touches no lock and writes nothing under the tick home; it is `404` for a project with no tick directory and `400` for
  anything but an absolute string. The server only READS `$BM_TICK_HOME` (per call, cached nowhere), skips a directory name that does not decode, is relative,
  or does not re-encode to itself, and `tick/` is not an outbound-calling module. Both POSTs sit behind `SameOriginPostGuard`. Why:
  [invariants.md](docs/subsystems/invariants.md#tickjson-has-exactly-one-writer-the-server-and-a-file-that-cannot-be-read-is-never-replaced)
