---
paths: ["test/**", ".claude/rules/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **Every `.claude/rules/` file carries `paths:` and is the one home of its rules' mechanism — never the reasoning.** `paths:` is mandatory because a rule
  file without one loads at `session_start` in every session — a context-floor increase on all of them, the one failure mode this mechanism can introduce.
  Every Why-linked CLAUDE.md rule has exactly one rule-file home and its headline is byte-equal across the two tiers, pinned by `test/claude-rules.test.ts`:
  a rule file is bullets and nothing else, each anchored exactly once; CLAUDE.md's linked headlines and the rule files' bullets are one multiset with one home
  per anchor; a linked CLAUDE.md bullet is a headline and a link, any other bullet at most 80 words — so mechanism cannot creep back by any door. Measured,
  not assumed (Claude Code 2.1.268): a glob fires for a headless `claude -p`, inside a linked worktree, and for a custom subagent's read; it does NOT fire for
  `Write`, `Grep`/`Glob`, or a source read through `codegraph_explore` — the headline in CLAUDE.md is what covers that gap, and the reviewer is told to open the
  matching rule files against every diff. `backlog-execute`'s contract sweep visits `.claude/rules/*.md`, because this tier states contract. Why:
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
- **Tests are flat in `test/` under jest and beside the tool they cover under node; the node globs do not descend, so a suite one level deeper never runs**
  — `*.test.ts` / `*.test.tsx` at the top of `test/`, component suites opting into jsdom with a `@jest-environment jsdom` docblock; skill tests next to the
  tool they cover (`skills/*/tools/*.test.mjs`) under node's own test runner, not jest — but `pnpm test` runs both runners, via `scripts/test-all.mjs`. The
  split is which runner executes a file, not which ones one word covers; that half is the `pnpm test` rule in `.claude/rules/scripts.md`. Cases that pin a
  **skill's prose** rather than a tool live in `skills/backlog/tools/backlog.test.mjs` too (`backlog-groom`'s stamp order and its closing `Groomed on disk only`
  line, `backlog-execute`'s pre-review checks and the `agents/backlog-reviewer.md` half that reads them): that glob is the node runner's only reach into
  `skills/` — the other half of the pair, `scripts/*.test.mjs`, covers `scripts/` alone — and none of those files sits beside a `tools/` directory.
  The one exception is deliberate — the `Groomed on disk only` cases assert `skills/backlog-orchestrate/SKILL.md`'s half of that seam too, in this suite
  rather than in `orchestrate.test.mjs`, because the rule is two skills agreeing on one sentence and a suite that reads only one half cannot catch them drifting
  apart; the reviewer/execute pair is the same shape. They read that file, never import it — the "one skill's `tools/` may never import another's" rule is
  untouched. `backlog-retro` splits its suite in two — `retro.test.mjs` (the CLI, spawned as a child process) and `retro-lib.test.mjs` (the modules under
  `tools/lib/`) — and BOTH sit at the `tools/` level on purpose: `test:skills`'s globs are `skills/*/tools/*.test.mjs` and `scripts/*.test.mjs`, so a file
  under `tools/lib/` matches neither and would never be run, which is the same as not existing. Why:
  [invariants.md](docs/subsystems/invariants.md#where-a-test-file-sits-decides-which-runner-executes-it)
