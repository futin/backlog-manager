import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * `BM_ORCH_CONTROL_HOME` — the pause-request directory (task-17,
 * `server/src/orchestrator/pause-control.util.ts`), defaulted here for the
 * same class of reason `BM_WATCHDOG=off` above is set, but for the writing
 * half rather than the reading half.
 *
 * `POST /api/agents/pause` WRITES this directory, and its untouched default
 * is `~/.backlog-manager/settings/orchestrator-control/` — the developer's
 * real one, inside the same `settings/` tree the watchdog config lives in. A
 * suite that builds `AppModule` and posts to that route without an override
 * would leave a real pause request on the machine, and the process it would
 * be read by is a real orchestrator run: `orchestrate.mjs` reads exactly
 * this path at its two dispatch gates. Running `pnpm test` must never be
 * able to pause somebody's run, and — like a spawned session — no assertion
 * can undo a request a real run has already acted on.
 *
 * One temp directory for the whole process, not one per suite: nothing here
 * needs isolation BETWEEN suites (each writes under its own project path
 * key), only isolation from the real directory. Per-suite overrides still
 * win, hence `||=`.
 */
process.env.BM_ORCH_CONTROL_HOME ||= mkdtempSync(join(tmpdir(), 'bm-control-'));

/**
 * `BM_TRACKER_SYNC_FILE` — the per-repo sync interval file (#17, `server/src/tracker/sync-config.util.ts`), defaulted for both halves at once. Its untouched
 * default is the developer's real `~/.backlog-manager/settings/tracker-sync.json`: READ by every poller tick and every tracker summary, so a real `off` on
 * a repo a suite happens to name would silently freeze that suite's poller; and WRITTEN by `POST /api/trackers/sync`, so a suite posting to it would switch
 * the developer's real repo off. A file under a fresh temp directory that does not exist yet reads as every repo `15s` — today's behaviour — which is what
 * every suite that is not about this feature assumes. `||=`, like the two above.
 */
process.env.BM_TRACKER_SYNC_FILE ||= join(mkdtempSync(join(tmpdir(), 'bm-tracker-sync-')), 'tracker-sync.json');

/**
 * `BM_JIRA_SITE`, `BM_JIRA_EMAIL`, `BM_JIRA_TOKEN` — the Jira credentials (`server/src/jira/env.util.ts`), blanked here for the same class of reason
 * `BM_WATCHDOG=off` is set, but for the outbound half: the Jira poller is armed the moment all three are present, and any suite that builds `AppModule` and
 * calls `app.init()` then makes a REAL request to a REAL site at boot (the `tenant_info` lookup and the identity probe, then a sweep every poll). A suite
 * that stubs `global.fetch` for its own reasons would see calls it never expects, and one that does not would send the developer's real API token to the
 * network from `pnpm test`.
 *
 * `=`, not `||=` — the opposite choice to every block above, and deliberately. Those default a value so a suite can still choose its own; these must
 * OVERWRITE whatever is there, because the value a developer has is exactly the one that must not reach a test. A shell that exports `BM_JIRA_TOKEN` would
 * survive `||=`, and `ConfigModule.forRoot` makes it worse: it reads `.env` at import time but never overrides a key that already EXISTS, so a key set to
 * `''` here, before any import, is what keeps `.env`'s real values out of the process. An empty string is "absent" to `jiraEnv` (whitespace-only counts as
 * unset), so `configured: false` follows without a suite doing anything. A suite that wants Jira on passes `jiraEnv` an object, or sets the three itself in
 * `beforeEach` — and every suite that builds `AppModule` with them set overrides `JiraClient` with one built on a fake `fetch`.
 */
process.env.BM_JIRA_SITE = '';
process.env.BM_JIRA_EMAIL = '';
process.env.BM_JIRA_TOKEN = '';

/**
 * `BM_JIRA_FILE` — the board list and repo mappings (`~/.backlog-manager/settings/jira.json`), defaulted so no suite reads the developer's real boards. Phase 1
 * only reads it, but a real board list on a machine would change what `GET /api/jira` answers (and what the poller sweeps, once a suite arms it). A file under
 * a fresh temp directory that does not exist yet reads as no boards and no mappings, which is what every suite that is not about Jira assumes. `||=`, like
 * the blocks above the credentials: a suite that points it at a fixture keeps its own value.
 */
process.env.BM_JIRA_FILE ||= join(mkdtempSync(join(tmpdir(), 'bm-jira-')), 'jira.json');
