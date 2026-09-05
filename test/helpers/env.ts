/**
 * env.ts — the one process-wide environment guard every jest suite in this
 * repo inherits, wired in through `jest.config.ts`'s `setupFiles` (which
 * runs once per test file, before the test framework and before any module
 * under test is imported).
 *
 * It exists for exactly one reason, and it is not tidiness.
 *
 * The orchestrator watchdog (`server/src/agents/watchdog.service.ts`) is a
 * Nest provider with an `onApplicationBootstrap` hook: the moment ANY suite
 * builds a Nest application from `AppModule` and calls `app.init()`, the
 * sweeper arms itself and takes a `runs()` read. That read goes through
 * `orchHome()` (`server/src/orchestrator/orchestrator.service.ts`), which
 * resolves to `~/.backlog-manager/orchestrator/` — the DEVELOPER'S REAL
 * orchestrator state directory — for any suite that has not overridden
 * `BM_ORCH_HOME`. Most suites have no reason to override it, because until
 * this feature landed nothing in the server ever acted on what it found
 * there.
 *
 * Two things go wrong without this file, and the second is much worse than
 * the first:
 *
 *   1. A crashed run sitting in the developer's real directory would make a
 *      suite that stubs `global.fetch` for its own reasons observe a
 *      `POST /api/spawn` that none of its assertions expect — a failure
 *      that reproduces only on the machine whose real directory happens to
 *      hold a stale run, i.e. the worst kind of flake there is.
 *   2. With `BM_AGENTS` genuinely on in a developer's shell, that spawn is
 *      not a stub at all: it is a real `claude -p` session started against
 *      the developer's real repository, by `pnpm test`. Running the test
 *      suite must never start an agent session, and no assertion anywhere
 *      can undo one that already started.
 *
 * `BM_WATCHDOG=off` is the operator kill switch (design §5.1,
 * `watchdogEnvOff` in `server/src/orchestrator/watchdog-config.util.ts`):
 * phase `off`, no timer, no reads, no spawn — the sweeper does nothing at
 * all. Setting it here, globally, is what makes "a suite forgot to override
 * `BM_ORCH_HOME`" a harmless oversight rather than a live incident.
 *
 * `||=`, not `=`: a suite (or a developer running one deliberately) that has
 * already set `BM_WATCHDOG` to something else keeps its own value. The
 * watchdog's own suite is the one that turns the sweeper ON, and it does so
 * by DELETING this variable in its `beforeEach` — but only after pointing
 * `BM_ORCH_HOME` at a `mkdtempSync` directory of its own, which is the
 * precondition this default exists to cover for everyone else.
 *
 * And `||=`, not `??=` — this is the one place in the file that is NOT
 * tidiness either. `??=` only assigns when the variable is `null` or
 * `undefined`, so a shell that exports `BM_WATCHDOG=` (empty string, not
 * absent) already satisfies `??=`'s "already set" test and the line above
 * is skipped. `watchdogEnvOff()` requires the literal, trimmed string
 * `'off'` (`watchdog-config.util.ts`), so that empty string reads as "not
 * off": every suite that builds `AppModule` would then arm a live sweeper
 * against the developer's REAL `~/.backlog-manager/orchestrator/` — the
 * exact incident this file exists to rule out, reached through the one
 * shell state `??=` cannot see. `||=` treats an empty string the same as
 * absent, since both are falsy, while still leaving any non-empty value —
 * a deliberate `BM_WATCHDOG=on`, say — alone, so nothing above about
 * suites keeping their own value changes.
 */
process.env.BM_WATCHDOG ||= 'off';
