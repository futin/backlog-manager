---
paths: ["test/**", ".claude/rules/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **Every `.claude/rules/` file carries `paths:` and is a pointer, never a second copy of the reasoning.** A rule with no `paths:` loads at `session_start` in
  every session — a context-floor increase on all of them, which is the one failure mode the mechanism can introduce; a rule that restated a rule would be a
  third statement of it, free to drift from both CLAUDE.md and the rationale. Measured, not assumed (Claude Code 2.1.268): a glob fires for a headless
  `claude -p`, inside a linked worktree, and for a custom subagent's read; it does NOT fire for `Write`, `Grep`/`Glob`, or a source read through
  `codegraph_explore`. Pinned by `test/claude-rules.test.ts`, which passes vacuously on an empty directory. Why:
  [invariants.md](docs/subsystems/invariants.md#path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35)
- **A suite that hands an app to supertest listens once, on `127.0.0.1`, via `listenLoopback` (`test/helpers/app.ts`)** — never on the wildcard, never per
  request. supertest dials `http://127.0.0.1:<port>` unconditionally while a bare `listen(0)` binds `::`, so any process holding that port on `127.0.0.1`
  answers instead: ~1 request in 1,500 on a loaded machine, which is one false red per `pnpm test` and so a merge-gate defect (bug-33). Not `jest.retryTimes`.
  `watchdog-sweep.test.ts` is the one exception — `createApp({ listen: true })`, opt-in, because its other cases install fake timers first. Pinned by a source
  guard in `test/supertest-bind.test.ts`: behaviour cannot catch a suite that forgets, since forgetting is green 1,499 runs in 1,500. Why:
  [invariants.md](docs/subsystems/invariants.md#a-supertest-suite-listens-once-on-127001-through-listenloopback)
- **A jsdom suite's fixture dates are relative to the clock the assertion runs under** — `daysAgoDate`/`daysAgoStamp` (`test/helpers/dates.ts`), read at call
  time so a faked clock is honoured, never an absolute literal. `created` is compared against the REAL clock by `leavesBoard` → `isStale` → `lastTouched`, so a
  literal is not a constant but an expiry date: the card renders for `staleDays` and then stops, red on a tree nobody touched (bug-44, three cases, two suites,
  every orchestrator run parked at `verify`). `test/fixture-clock.test.ts` is the source guard — every `test/*.test.tsx`, the four keys `created`, `updated`,
  `lastCommit`, `started`, a closed allowlist whose every entry carries its reason — and it reads source because behaviour cannot: a fresh literal is green for
  thirty days. `.ts` suites are out of scope (they pass `now` explicitly), and a literal behind a NAME passes the guard, which `board.test.tsx`'s `CREATED` uses
  deliberately and says so. Why:
  [invariants.md](docs/subsystems/invariants.md#a-fixture-date-is-relative-to-the-clock-the-assertion-runs-under)
