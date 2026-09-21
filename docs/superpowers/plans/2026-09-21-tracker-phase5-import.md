# Tracker-backed backlog, phase 5 — `backlog.mjs import` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `backlog.mjs import github [owner/repo] [--no-forms]` moves a files project's whole `backlog/` store onto GitHub issues through the local API, in one
shot per project, resumably, and deletes the item files only once every issue exists and every cross-link has been rewritten.

**Architecture:** One new command in `skills/backlog/tools/backlog.mjs`, dispatched beside `connect`, plus one new pure module,
`skills/backlog/tools/import-lib.mjs`, holding every text transformation (outcome split, footer, cap fit, id rewrite, ordering) with no file or network
access, so each is a table of cases. The command reuses `connect`'s marker and forms writers, the API-mode helpers (`apiPost`, `apiGet`, `apiGetText`) and the
files-mode readers (`backlogItemFiles`, `readItemFile`). The server changes NOT AT ALL: every request `import` makes is one of the seven existing write routes
or one of the existing reads, and the write routes already refuse a `files` project — which is exactly why the marker is written first.

**Tech Stack:** Node ESM (`.mjs`), synchronous `fs` and `spawnSync` for git, `fetch` through the existing `apiRequest`, node's own test runner
(`node --test`, via `pnpm run test:skills`) with the existing `fakeApi`/`withApi`/`runNode` helpers in `skills/backlog/tools/backlog.test.mjs`.

**Spec:** [docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md](../specs/2026-09-17-tracker-backed-backlog-design.md) — §8 (revised
2026-09-21), §12.4 (its test list), §14 decisions 12–14. The plan argues from that section; read it first, and where this plan and §8 disagree, §8 wins and the
plan is what gets fixed.

**How to read this plan.** This plan specifies **required behaviour and exact test cases**, never implementation prose to transcribe. Code blocks below are
shell commands to run and expected output to check — not source to copy into the repo. Where a step describes a function, it states its name, its inputs, its
outputs and the cases that prove it; the implementer writes the code and is expected to disagree with this document where the code disagrees with it. Every
size figure is a soft target. (This overrides the writing-plans template's "code blocks required" rule, on purpose: handed code gets transcribed verbatim,
and a bug in a plan then becomes a bug on the branch with nobody positioned to catch it.)

## Global Constraints

- **The marker is written first and the files are deleted last** (§8.2, §8.5, §14.12). Between the two, the board shows the tracker's items and ignores the
  files. Nothing in this plan writes the marker after any request, and nothing deletes a file before pass 2 has fully succeeded.
- **Every refusal in §8.1 leaves the project byte-identical** — no marker, no forms, no request. The one read that precedes the marker write is a probe
  `GET /api/items`, which is how "server up, else exit `5`" is decided before anything is written.
- **The server is not changed.** No new route, no new field, no adapter change. If a step seems to need one, the step is wrong — re-read §8.3 step 4 (counters
  ride a synthetic released claim) and §8.4 (`ifUpdatedAt` comes from `GET /api/items`).
- **`import` never commits, stages or touches git history.** It reads git (`status`, `ls-files`, `rev-parse`, `branch -r --contains`, `remote get-url`) and
  prints the commit instruction. `backlog-orchestrate` is the only skill that commits.
- **Exit codes:** `5` for a refused connection to the API (existing `API_DOWN_CODE`), `2` for no git repo (existing), `1` for every other refusal and for any
  non-2xx a request answered. No new code.
- **`process.exitCode = await main(...)`** stays the entry; the pacing sleep is an awaited `setTimeout` promise, fully settled before `main` returns, so it
  holds nothing open. `backlog.test.mjs`'s `CLI_SOURCES` guard is untouched — `import-lib.mjs` is a library, not an entry point, and is NOT added to it.
- **The footer `<!-- bm:imported from=<id> … -->` is the idempotency key** (§8.6). The readable `_Imported from …_` line is for humans and is never parsed.
- **Content-creating requests are paced** at one per second (`create`, `claim`, `release`, `state`, `body`) — §8.3 step 6. The interval is
  `BM_IMPORT_PACE_MS`, default `1000`, read once per command, so the suite sets `0`. Reads (`GET /api/items`, `GET /api/items/body`) are not paced.
- **Bodies are capped below GitHub's 65,536 characters** with named headroom: `IMPORT_BODY_CAP = 65000`, one constant in `import-lib.mjs`, with a comment
  saying the headroom is for pass 2 (a `_From #n._` line and id rewrites that can grow, `ref-9` → `#123`).
- **New prose wraps at 160 columns.** Comments explain *why*, at the density the file already has.
- **`import-lib.mjs` imports nothing from `backlog.mjs`** and `backlog.mjs` imports it. One direction, no cycle. It may import `node:path` and nothing else
  from node — it never touches the filesystem or the network.
- **Only the driver commits, in the worktree, on `backlog/<id>`.** Each task ends in a commit; commit messages in the repo's imperative style
  (`feat(task-NN): …`, `test(task-NN): …`, `docs(task-NN): …`), body at 72 columns.

---

## File structure

| Path                                                    | Responsibility                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `skills/backlog/tools/import-lib.mjs` (create)          | Pure text functions: outcome split, footer render/parse, cap fit + blob link, old-id rewrite, pass-1 ordering, counters |
| `skills/backlog/tools/import-lib.test.mjs` (create)     | Table cases for every export above, node runner                                                                       |
| `skills/backlog/tools/backlog.mjs` (modify)             | `IMPORT_USAGE`, the `import` command (preconditions, begin, pass 1, pass 2, delete, resume), `connect`'s message      |
| `skills/backlog/tools/backlog.test.mjs` (modify)        | `fakeApi` route functions gain the request as a second argument; `importFixture`; the CLI cases of §12.4               |
| `skills/backlog/SKILL.md` (modify)                      | The `import` block beside `connect`'s; `connect`'s "later phase" sentence names `import`                              |
| `docs/subsystems/skills.md` (modify)                    | CLI paragraph + a verb-table row for `import`                                                                         |
| `README.md` (modify)                                    | The tracker paragraph gains the one-sentence migration path                                                           |
| `CLAUDE.md`, `docs/subsystems/invariants.md` (modify)   | One new invariant bullet + its `Why:` section                                                                         |

---

### Task 1: `import-lib.mjs` — the pure transformations

**Files:**
- Create: `skills/backlog/tools/import-lib.mjs`
- Create: `skills/backlog/tools/import-lib.test.mjs`

**Interfaces — Produces** (every later task calls these by exactly these names):

- `IMPORT_BODY_CAP` — `65000` (see Global Constraints).
- `splitOutcome(body: string) → { rest: string, outcome: string }`. Finds the first line matching `^## Outcome\s*$`; the section runs to the next `^## ` line
  or end of text. `outcome` is that section's text without its heading, trimmed; `rest` is the body with the whole section removed and at most one blank line
  where it was. No such heading → `{ rest: body, outcome: '' }`.
- `renderImportFooter({ id, created, tags, relPath }) → string`. Two lines: `<!-- bm:imported from=<id> created=<created> tags=<a,b> -->` then
  `_Imported from backlog/<relPath>_`. The `tags=` key is present only when `tags` is non-empty; values joined by `,`. `relPath` is the path under `backlog/`
  exactly as `backlogItemFiles` returns it (`tasks/open/task-1-foo.md`, `out-of-scope/oos-2-bar.md`).
- `parseImportFooter(body: string) → string | null`. The `from=` id out of the marker comment, or `null`. Matches only `<!-- bm:imported from=<id>`, never
  the readable line.
- `blobLink(repo, sha, relPath) → string` — `https://github.com/<repo>/blob/<sha>/backlog/<relPath>`.
- `fitBody(text, cap, link) → { text: string, truncated: boolean }`. Unchanged when `text.length <= cap`. Otherwise splits at `^## ` lines (the preamble
  before the first heading is segment zero), keeps whole segments from the top while `kept.length + trailer.length <= cap`, where `trailer` is
  `\n\n_Truncated. Full text: <link>_`, and appends the trailer. A preamble that alone exceeds `cap` yields the trailer only.
- `rewriteOldIds(text, map: Map<string, number>) → string`. Replaces every match of `(?<![\w/-])(bug|task|idea|ref)-(\d+)(?![\w-])` whose whole match is a
  key of `map` with `#<n>`. Everything else — unknown ids, ids inside paths or filenames — stays.
- `importOrder(items) → items`. Stable sort: `status` rank `open` → `done` → `out-of-scope`, then `created` ascending (string compare of the frontmatter
  value), then section order `bugs, ideas, tasks, refactors`, then numeric id. Each item is `{ id, section, status, created, ... }`; `status` is
  `'out-of-scope'` for the flat section.
- `countersOf(data) → { groomElapsed, executeElapsed, groomTokens, executeTokens } | null`. Reads the four frontmatter keys `groom-elapsed`,
  `execute-elapsed`, `groom-tokens`, `execute-tokens` as non-negative integers (absent → `0`); returns `null` when all four are `0`; a non-integer value throws
  a plain `Error` naming the key (the caller wraps it with the file path).

- [ ] **Step 1: Write the failing tests** in `import-lib.test.mjs` (node runner, `import { … } from './import-lib.mjs'`). Cases, one `test()` each or grouped
  by function — every case below must appear with its exact expected value:

  `splitOutcome`
  1. `'# T\n\n## Plan\nx\n\n## Outcome\nShipped.\n\n## Notes\ny\n'` → `rest` is `'# T\n\n## Plan\nx\n\n## Notes\ny\n'`, `outcome` is `'Shipped.'`.
  2. Outcome is the last section: `'## Plan\nx\n\n## Outcome\nDone\nand more\n'` → `outcome` `'Done\nand more'`, `rest` `'## Plan\nx\n'`.
  3. No heading → `rest` identical to input, `outcome` `''`.
  4. `'## Outcome\n\n'` (empty section) → `outcome` `''`, `rest` `''`.
  5. `### Outcome` (level 3) is NOT the heading → untouched, `outcome` `''`.

  `renderImportFooter` / `parseImportFooter`
  6. `{ id: 'task-1', created: '2026-08-30', tags: ['a', 'b'], relPath: 'tasks/open/task-1-foo.md' }` → exactly
     `'<!-- bm:imported from=task-1 created=2026-08-30 tags=a,b -->\n_Imported from backlog/tasks/open/task-1-foo.md_'`.
  7. Empty `tags` → no `tags=` substring anywhere in the output.
  8. `parseImportFooter` of case 6's output → `'task-1'`; of `'_Imported from backlog/tasks/open/task-1-foo.md_'` alone → `null`; of `''` → `null`.
  9. Footer at the END of a body that also mentions `bug-3` above it → `'task-1'` (the marker, not the first id in the text).

  `fitBody` / `blobLink`
  10. `blobLink('futin/x', 'abc123', 'tasks/open/task-1-foo.md')` → `'https://github.com/futin/x/blob/abc123/backlog/tasks/open/task-1-foo.md'`.
  11. Text of length exactly `cap` → returned unchanged, `truncated: false`.
  12. Three sections of 400 chars each (`## A`, `## B`, `## C`), `cap` 900 → output keeps `## A` and `## B` whole, no `## C` text, ends with
      `_Truncated. Full text: <link>_`, `truncated: true`, and `output.length <= 900`.
  13. Preamble alone of 1000 chars, `cap` 500 → output is the trailer alone, WITHOUT its leading blank lines because nothing precedes it: assert the
      output starts with `_Truncated. Full text:` and `truncated: true`.
  14. A 70,000-char text against `IMPORT_BODY_CAP` → `truncated: true` and `output.length <= IMPORT_BODY_CAP`.

  `rewriteOldIds` with `map = new Map([['task-1', 4], ['idea-12', 7]])`
  15. `'see task-1 and (task-1).'` → `'see #4 and (#4).'`
  16. `'task-1:'`, `'task-1,'`, `` '`task-1`' `` each rewrite the id and keep the punctuation.
  17. `'sub-task-1'` → unchanged. `'idea-12-tracker-backed'` → unchanged. `'backlog/tasks/open/task-1-foo.md'` → unchanged.
  18. `'task-99'` (not in map) → unchanged. `'Task-1'` → unchanged (case-sensitive).
  19. Inside a code fence: `'```\ntask-1\n```'` → `'```\n#4\n```'`.
  20. `'idea-12 → task-1'` → `'#7 → #4'`.

  `importOrder`
  21. Input `[done bug created 2026-01-01, open task created 2026-03-01, open bug created 2026-02-01, oos created 2025-01-01]` → ids in order:
      open bug, open task, done bug, oos — status rank beats `created`.
  22. Two open items with equal `created`: bugs before tasks; two open bugs with equal `created`: `bug-2` before `bug-10` (numeric, not lexical).

  `countersOf`
  23. `{}` → `null`. `{ 'groom-elapsed': '0', 'execute-tokens': '0' }` → `null`.
  24. `{ 'execute-elapsed': '120', 'execute-tokens': '3400' }` → `{ groomElapsed: 0, executeElapsed: 120, groomTokens: 0, executeTokens: 3400 }` — every
      key present, absent ones `0`.
  25. `{ 'groom-elapsed': 'abc' }` → throws, message contains `groom-elapsed`.

- [ ] **Step 2: Run to verify they fail**

```bash
node --test skills/backlog/tools/import-lib.test.mjs
```
Expected: FAIL — `Cannot find module` for `import-lib.mjs`.

- [ ] **Step 3: Implement `import-lib.mjs`** to the interface above. Header comment: what the module is (phase 5's text half), why it is pure (a table of cases
  is the only way to prove a truncation rule), and why the regex excludes `/` and `-` neighbours (the footer's readable line and the truncation link would
  otherwise be rewritten — case 17 is that bug).

- [ ] **Step 4: Run to verify they pass**, then run the whole node suite to make sure the new file is picked up by the glob and nothing else moved:

```bash
node --test skills/backlog/tools/import-lib.test.mjs && pnpm run test:skills
```
Expected: PASS, and `test:skills` reports the new file's cases in its total.

- [ ] **Step 5: Commit** — `feat(task-NN): add import-lib, the pure half of backlog.mjs import`.

---

### Task 2: the `import` command — usage and every §8.1 refusal

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` — `USAGE` (~L1884: add `import      move this project's item files onto a tracker (github)` under `connect`), a
  new `IMPORT_USAGE` beside `CONNECT_USAGE` (~L1934), and `if (cmd === 'import') { … }` placed directly after the `connect` block (~L2750), before
  `unregister`.
- Modify: `skills/backlog/tools/backlog.test.mjs` — `importFixture`, and the refusal cases.

**Interfaces — Consumes:** `resolveRootOrFail`, `linkedWorktreeInfo`, `originRemoteUrl`, `parseOriginRepo`, `isValidRepo`, `sourceMode`,
`backlogItemFiles`, `readItemFile`, `apiGet`, `API_DOWN_CODE`, `BacklogError` — all already in `backlog.mjs`. **Produces:** the command's argument shape and
its refusal sentences, which Tasks 3–5 extend but never reorder.

**Behaviour.** `backlog.mjs import github [owner/repo] [--no-forms]`. Checks run in THIS order, each a refusal with nothing written and (except the probe)
no request made:

1. Sub-command missing or not `github`, or more than one positional → `IMPORT_USAGE` on stderr, exit `1`. `IMPORT_USAGE` names the command, both flags, and
   says in one line that the stack must be running and that item files are deleted only at the end.
2. No git repo → exit `2` (from `resolveRootOrFail`).
3. Linked worktree → the same sentence `connect` prints, with `import` in place of `connect`; exit `1`.
4. Marker (`sourceMode(backlog)`): `bad` → its own message, exit `1`. An explicit `{"kind":"files"}` marker → `already has a source marker: <path> — delete
   it by hand first`, exit `1`. A `github` marker with NO item files → `<root> is already tracker-backed (<marker> names github <repo>) — nothing to
   import`, exit `1`. A `github` marker WITH item files → resume mode (Task 5); the repo is the marker's, and a positional repo that differs is refused:
   `<marker> names <a>, not <b>`. No marker → fresh mode.
5. Fresh mode with zero item files → `no item files under <backlog> — use \`backlog.mjs connect github\` for an empty store`, exit `1`.
6. Repo: positional, else derived from `origin` exactly as `connect` does (same two sentences for no origin / not GitHub), then `isValidRepo` (same sentence).
7. Git state, three `spawnSync` calls in the project root:
   - `git status --porcelain -- backlog` must print nothing → else `backlog/ has uncommitted changes — commit or stash them first:` followed by the porcelain
     lines, exit `1`.
   - `git ls-files --error-unmatch -- <every item file>` must exit `0` → else `these item files are not tracked by git: <list>`, exit `1`.
   - `git rev-parse HEAD` (fails → `no commits yet`, exit `1`), then `git branch -r --contains HEAD` must list at least one line whose trimmed value starts with
     `origin/` → else `HEAD <sha7> is not on any origin/* branch — push first; the truncation link pins files at HEAD`, exit `1`. Keep the full sha for Task 3.
8. Every item file parses (`readItemFile`; the first malformed one is the refusal, path-prefixed as it already is). Any file under a `*/open/` directory with
   a non-empty `started:` → `<n> open item(s) are in progress — stop them first: <ids>`, exit `1`. A `started:` on a `done/` or `out-of-scope/` file is ignored.
9. Probe: `apiGet('/api/items')`. Transport failure → exit `5` with the existing message. Keep the payload — Task 5 reads it.

Only after all nine does anything get written (Task 3).

- [ ] **Step 1: Test scaffolding.** In `backlog.test.mjs`, beside `connectFixture`, add `importFixture({ originUrl = 'git@github.com:futin/x.git', items,
  push = true } = {})`: `backlogFixture()`; write `backlog/README.md` and each `items[i]` = `{ relPath, text }` under `backlog/`; `git add -A`; one commit with
  `-c user.name=t -c user.email=t@t`; `git remote add origin <originUrl>`; when `push`, `git update-ref refs/remotes/origin/main HEAD` (a real remote-tracking
  ref without a network — that is what `branch -r --contains` reads). Return `{ dir, backlog, sha }` with `sha` from `git rev-parse HEAD`. Also a small
  `itemText(front, body)` helper rendering `---\nkey: value\n---\n<body>` — the fixture files are hand-shaped strings, never produced by the tool under test.

- [ ] **Step 2: Write the failing refusal cases** (each asserts exit code, a stderr substring, that NO `source.json` exists afterwards, that every fixture file
  is byte-identical, and — where a fake API is stood up — `requests.length === 0` unless the case is the probe):
  1. `import` alone → exit `1`, stderr matches `usage: backlog\.mjs import github`.
  2. `import gitlab a/b` → exit `1`, same usage.
  3. Linked worktree (`git worktree add`, as `connect`'s existing case does) → exit `1`, stderr contains `linked git worktree` and `import`.
  4. `{"kind":"files"}` marker beside one item → exit `1`, stderr contains `delete it by hand`.
  5. `github` marker, no item files → exit `1`, stderr contains `already tracker-backed`.
  6. No marker, no item files → exit `1`, stderr contains `connect github`.
  7. No origin, no positional → exit `1`, stderr matches `import github <owner>\/<repo>` — the sentence names THIS command, not `connect`.
  8. Dirty `backlog/` (append a byte to an item after the commit) → exit `1`, stderr contains `uncommitted changes` and the porcelain line ` M backlog/…`.
  9. Untracked item (write a new file after the commit; note `status --porcelain` catches it first, so ALSO a case where the file is gitignored via
     `.git/info/exclude` — clean status, not tracked) → exit `1`, stderr contains `not tracked by git`.
  10. `push: false` → exit `1`, stderr contains `not on any origin/* branch` and the first seven characters of `sha`.
  11. Open item with `started: 2026-09-20T10:00:00Z` → exit `1`, stderr contains `in progress` and the id; a DONE item with `started:` and nothing else wrong
      proceeds past this check (assert by reaching the exit-5 probe against port 1).
  12. Everything valid, port 1 → exit `5`, existing message, no marker written.
  13. A malformed item file (no leading `---`) → exit `1`, stderr contains the file's absolute path.

- [ ] **Step 3: Run to verify they fail**

```bash
node --test skills/backlog/tools/backlog.test.mjs
```
Expected: the new cases FAIL (today `import` falls through to `USAGE`, exit `1`, and the usage text does not name `import github`).

- [ ] **Step 4: Implement** the usage, the dispatch block and the nine checks. Put the git reads in one helper (`gitImportState(root, files)`) returning
  `{ dirty: string, untracked: string[], sha: string | null, pushed: boolean }` so the messages are composed in one place and the same three commands are
  reused by Task 5's resume path. Comment the ORDER of the checks: cheap and local first, the probe last, because the probe is the one check with a side
  effect on somebody else (a request).

- [ ] **Step 5: Run to verify they pass**, plus the whole node suite (the `USAGE` change can break an existing exact-match case):

```bash
pnpm run test:skills
```
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(task-NN): add backlog.mjs import — usage and the §8.1 refusals`.

---

### Task 3: fresh import, pass 1 — marker, forms, one issue per item

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` — the `import` block continues after the probe.
- Modify: `skills/backlog/tools/backlog.test.mjs` — `fakeApi` passes the request to route functions; pass-1 cases.

**Interfaces — Consumes:** Task 1's exports; `writeSourceMarker`, `writeIssueForms`, `registerBestEffort`, `registryRoot`, `apiPost`. **Produces:** an
in-memory `plan` array of `{ id, relPath, section, status, data, body, outcome, number | null }` in `importOrder`, and `map: Map<oldId, number>`, which Task 4
consumes.

**Behaviour** (§8.2–8.3), after Task 2's checks pass, fresh mode:

1. `writeSourceMarker(backlog, repo)`; unless `--no-forms`, `writeIssueForms(root)` (skips existing files, as it already does). `registerBestEffort(root)` so
   the write routes find the project in the registry. `project = registryRoot(root)` is the `project` field of every request.
2. Build `plan` from every item file: `id` from the filename (`^([a-z]+-\d+)-`), `section`/`status` from the first one or two path segments (`out-of-scope`
   → status `'out-of-scope'`), `data`/`body` from `readItemFile`. For a `done/` item, `splitOutcome(body)`; for every other status the body is whole and
   `outcome` is `''`. Sort with `importOrder`.
3. Per item, in order, `stamp = new Date().toISOString()` taken ONCE at command start:
   - Compose: `footer = renderImportFooter({ id, created: data.created, tags: data.tags, relPath })`;
     `fitted = fitBody(rest, IMPORT_BODY_CAP - footer.length - 2, blobLink(repo, sha, relPath))`; `issueBody = fitted.text + '\n\n' + footer` (when
     `fitted.text` is empty, just the footer).
   - `POST create` `{ project, section, title: data.title, body: issueBody }` plus `kind: data.kind` only when the frontmatter has a non-empty `kind`, plus
     `runnerFix: true` only when the frontmatter has a `runner-fix` key whose value is not `false` (the same presence rule `orchestrate.mjs`'s
     `parseItemForGate` uses). NEVER a `from` key. Record `number` from the response; `map.set(id, number)`.
   - `counters = countersOf(data)`; when non-null: `POST claim` `{ project, id: '#<n>', phase: 'execute', session: 'import-<stamp>' }` → `commentId`, then
     `POST release` `{ project, id: '#<n>', commentId, session: 'import-<stamp>', reason: 'imported', counters }`.
   - `status === 'done'` → `POST state` `{ project, id: '#<n>', status: 'done', outcome }` (`outcome` omitted when `''`). `out-of-scope` → nothing more;
     `create` closed it.
   - Print one stdout line per item as it lands: `<id> → #<n>` (and ` (truncated)` when `fitted.truncated`).
   - Sleep `BM_IMPORT_PACE_MS` after each content-creating request.
4. Any `BacklogError` mid-pass: stderr `import stopped at <id>: <server's sentence>` (a `429`'s sentence already names the reset time — copy it, do not
   compose one), exit with the error's code (`5` for a lost connection, else `1`). Files and marker stay. Nothing is deleted in this task at all — Task 4
   adds the deletion, so at the end of Task 3 a successful run still exits `0` with the files in place and a stdout line `pass 1 complete — <k> issues`.

- [ ] **Step 1: Extend `fakeApi`** so a route function is called as `answer(body, { method, query })` — the existing routes ignore the second argument, so
  nothing else changes. Add a `githubRoutes()` builder for these cases: `/api/items/create` answers `{ id: '#<n>', urn: 'gh:futin/x#<n>', url: …, number: n }`
  with `n` starting at 4 and incrementing per call; `/api/items/claim` → `{ commentId: 900 + calls }`; `/api/items/release`, `/api/items/state`,
  `/api/items/body` (POST) → `{ ok: true, updatedAt: '2026-09-21T10:00:00Z' }`; `/api/items` (GET) → `{ items: [], errors: [] }` unless overridden.
  Every case passes `BM_IMPORT_PACE_MS: '0'` through `apiEnv`.

- [ ] **Step 2: Write the failing cases.** Fixture: four items — `bugs/open/bug-2-two.md` (created `2026-02-01`), `tasks/open/task-1-one.md` (created
  `2026-01-01`, tags `x, y`, `runner-fix: true`), `tasks/done/task-3-three.md` (created `2026-01-15`, body with `## Plan` and `## Outcome\nShipped it.`,
  `execute-elapsed: 120`, `execute-tokens: 3400`), `out-of-scope/oos-5-five.md` (created `2025-12-01`). Assertions:
  1. **Marker and forms first.** After the run: `backlog/source.json` is `{"kind":"github","repo":"futin/x"}` pretty-printed; the four form files exist; with
     `--no-forms` they do not. The FIRST request in `requests` is the `GET /api/items` probe and the SECOND is a `POST /api/items/create`.
  2. **Order.** The `create` requests' `title`s are, in order: `one` (task-1, open, oldest), `two` (bug-2, open), `three` (task-3, done), `five` (oos).
  3. **Request shapes.** task-1's `create` body has `section: 'tasks'`, `runnerFix: true`, no `from` key, no `kind` key, and its `body` ends with the exact
     footer `<!-- bm:imported from=task-1 created=2026-01-01 tags=x,y -->\n_Imported from backlog/tasks/open/task-1-one.md_`. bug-2's has no `runnerFix` key.
     oos-5's has `section: 'out-of-scope'`.
  4. **Outcome split.** task-3's `create` body does not contain `Shipped it.`; the `state` request for `#6` has `status: 'done'` and `outcome: 'Shipped it.'`.
  5. **Counters, and their position.** The request sequence for task-3 is exactly `create`, `claim`, `release`, `state` (filter `requests` by `id === '#6'`
     plus the create); `claim` has `phase: 'execute'` and a `session` matching `/^import-\d{4}-/`; `release` has the same `session`, `reason: 'imported'`,
     `counters: { groomElapsed: 0, executeElapsed: 120, groomTokens: 0, executeTokens: 3400 }`. No `claim`/`release` request names any other id.
  6. **Cap.** A fifth item whose body is a 500-char preamble plus `## A` (30,000 chars), `## B` (30,000), `## C` (10,000) → its `create` body has length
     `<= IMPORT_BODY_CAP`, contains `## B` and not the `## C` text, contains
     `_Truncated. Full text: https://github.com/futin/x/blob/<sha>/backlog/tasks/open/<file>_` with the fixture's real `sha`, and STILL ends with the footer
     (footer after the trailer). stdout for that item ends ` (truncated)`.
  7. **stdout map.** stdout contains `task-1 → #4`, `bug-2 → #5`, `task-3 → #6`, `oos-5 → #7` in that order.
  8. **Failure keeps everything.** `/api/items/create` answers `{ status: 502, body: { error: 'GitHub answered 502' } }` on the SECOND call → exit `1`,
     stderr contains `import stopped at bug-2` and `GitHub answered 502`, the marker EXISTS (written first, per spec), all four item files are byte-identical,
     and no request of any kind follows the failing `create` (the run stopped).
  9. **Pacing is read from the environment.** With `BM_IMPORT_PACE_MS` unset the suite would take ~10 s; assert instead that the constant's default is `1000`
     by reading `backlog.mjs`'s source for the literal `BM_IMPORT_PACE_MS` and `1000` on the same line (a source guard, the same shape the repo already uses
     for `5177`).

- [ ] **Step 3: Run to verify they fail**

```bash
node --test skills/backlog/tools/backlog.test.mjs
```
Expected: FAIL — the run exits `0` after the probe with no `create` request.

- [ ] **Step 4: Implement** pass 1. Keep the composition of one item's requests in a helper (`importOne(ctx, item)`) so Task 5's resume calls the same code
  for the done-but-still-open repair. Comment WHY `from` is not sent (§8.3 step 3) and why `claim` must precede `state` (§8.3 step 4: `claim` refuses a
  closed issue).

- [ ] **Step 5: Run to verify they pass** — `pnpm run test:skills`. Expected: PASS.

- [ ] **Step 6: Commit** — `feat(task-NN): import pass 1 — marker first, one issue per item, counters as a released claim`.

---

### Task 4: pass 2 cross-links, then delete the files

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` — the `import` block continues after pass 1.
- Modify: `skills/backlog/tools/backlog.test.mjs`.

**Interfaces — Consumes:** Task 3's `plan` and `map`; `apiGet('/api/items')`, `apiGetText('/api/items/body?path=…')` (as `show` uses them, ~L2226–2230),
`rewriteOldIds`, `apiPost('body', …)`.

**Behaviour** (§8.4–8.5):

1. `index = GET /api/items`; `rows = index.items.filter(it => it.projectPath === project)` — the same predicate `show`/`board` use. For every `(oldId, n)` in
   `map`: `row = rows.find(it => it.id === '#<n>')` (missing → `BacklogError` `#<n> is not in the index yet — re-run import to resume`, exit `1`);
   `current = GET /api/items/body?path=<row.path>`.
2. `next = rewriteOldIds(current, map)`. If the item's frontmatter had a non-empty `from`, prepend `_From #<m>._\n\n` when `map.has(from)`, else
   `_From <from>._\n\n` (the fact survives; only the link is missing). If `next === current`, no request. Else `POST body` `{ project, id: '#<n>', body: next,
   ifUpdatedAt: row.updated }` — exactly the field `show --json` reports as `updatedAt` — and NO `runnerFix` key. Paced.
3. Only when every patch has succeeded: `fs.unlinkSync` each item file (never `README.md`, never `source.json`, never a directory). Then stdout:
   `imported <k> item(s) into github <repo>`, a blank line, `commit these files — the marker does nothing until the machine running the board has pulled it:`,
   then one bare path per line: `backlog/source.json`, each form written, each deleted item path (as `backlog/<relPath>`). Exit `0`.
4. A failure anywhere in pass 2: the same `import stopped at <id>: …` line, exit `1`, NO file deleted.

- [ ] **Step 1: Write the failing cases.** Fixture from Task 3 plus: task-1's body contains `Blocked on bug-2 and task-99.` and a fenced block with
  `task-3`; task-3's frontmatter has `from: idea-9` (no such item — unknown) and bug-2's has `from: task-1`. `GET /api/items` is a route FUNCTION that, once
  any `create` has been called, answers rows for every created number with `id: '#<n>'`, `projectPath` = the fixture's root, `path: 'gh:futin/x#<n>'`,
  `updated: '2026-09-21T10:00:0<n>Z'`; `GET /api/items/body` (by `method === 'GET'`) answers the body the fake recorded from that number's `create`. Cases:
  1. **Rewrite.** The `POST body` for `#4` has `body` containing `Blocked on #5 and task-99.` and the fence containing `#6`, `ifUpdatedAt:
     '2026-09-21T10:00:04Z'`, and `'runnerFix' in body === false`.
  2. **`from:` becomes a line.** `#5`'s patched body starts with `_From #4._\n\n`; `#6`'s starts with `_From idea-9._\n\n`.
  3. **No patch when nothing changes.** `#7` (oos, no ids, no from) gets no `POST body`.
  4. **The footer survives pass 2** — `#4`'s patched body still ends with its exact footer (the readable line's `task-1-one.md` is NOT rewritten).
  5. **Delete last.** After a successful run, no `*.md` remains under any `LEAF_DIRS` directory, `backlog/README.md` still exists, `source.json` exists, and
     `commitList(stdout)` (the existing helper) equals `['backlog/source.json', <the four form paths>, 'backlog/tasks/open/task-1-one.md',
     'backlog/bugs/open/bug-2-two.md', 'backlog/tasks/done/task-3-three.md', 'backlog/out-of-scope/oos-5-five.md']` — forms in `FORM_FILES` order, items in
     import order.
  6. **A pass-2 failure deletes nothing.** `POST body` answers `{ status: 409, body: { error: 'changed since read', updatedAt: '…' } }` → exit `1`, stderr
     contains `import stopped at task-1` (the OLD id, which is what the operator can find on disk) and `changed since read`, all four files byte-identical,
     marker present.
  7. **Every pass-2 request is a `body` POST or a GET** — no `create`/`state`/`claim`/`release` after the last pass-1 request.

- [ ] **Step 2: Run to verify they fail** — `node --test skills/backlog/tools/backlog.test.mjs`. Expected: FAIL — no `POST body`, files still present.

- [ ] **Step 3: Implement** pass 2 and the deletion. The deletion loop runs ONLY after the pass-2 loop returns; comment that this ordering IS §8.5 and that a
  `try/finally` around it would be wrong (a failure must leave the files).

- [ ] **Step 4: Run to verify they pass** — `pnpm run test:skills`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(task-NN): import pass 2 — rewrite cross-links, then delete the item files`.

---

### Task 5: resume — the footer is the idempotency key

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` — the resume branch of the `import` block.
- Modify: `skills/backlog/tools/backlog.test.mjs`.

**Behaviour** (§8.6). Marker says `github` AND item files exist:

1. Task 2's checks 6–9 run as in fresh mode, with `repo` from the marker (a positional that differs is the Task 2 refusal). Forms: `writeIssueForms` unless
   `--no-forms` (it skips files already present). `registerBestEffort` as before. The marker is NOT rewritten.
2. Rebuild the map: `rows` from the probe's payload filtered to this project; for each row, `GET /api/items/body?path=<row.path>` → `parseImportFooter` →
   when non-null, `map.set(oldId, Number(row.id.slice(1)))`. Print `resuming: <k> of <total> item(s) already imported`.
3. Pass 1 skips every item in `map`. One repair: an item whose file is under `done/` but whose row `status` is `'open'` (its `state` failed last time) gets
   `POST state done` with its Outcome again — and nothing else (no second `claim`; comment why: the duplicate would be worse than the missing one, and the
   stderr line at the original failure named the item).
4. Pass 2 runs over EVERY entry of `map`, old and new, then the deletion and the commit instruction exactly as Task 4.

- [ ] **Step 1: Write the failing cases.** Fixture from Task 3 with the marker ALREADY present and `GET /api/items` pre-seeded with rows `#4` (task-1, status
  `open`) and `#6` (task-3, status `open` — its close failed) whose bodies (served by the GET body route) carry their footers; `#5` and `#7` absent.
  1. **Skips footer-matched issues.** The `create` requests are exactly two, titles `two` then `five`, numbered `#8` and `#9` by the fake (its counter
     starts at 8 in this case). stdout contains `resuming: 2 of 4`.
  2. **Repairs the open done-item.** Exactly one `state` request names `#6`, with `outcome: 'Shipped it.'`; no `claim`/`release` names `#6`.
  3. **Pass 2 covers old and new.** A `POST body` for `#4` rewrites `bug-2` → `#8`.
  4. **Marker untouched, forms honoured.** `source.json` mtime unchanged (or byte-identical to the seeded content); with `--no-forms` no form file is written.
  5. **A positional repo that disagrees is refused** — `import github futin/other` → exit `1`, stderr contains `names futin/x, not futin/other`, no request.
  6. **Deletion still last** — after success, no item files remain and `commitList(stdout)` lists all four deletions.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL (Task 2 currently has no resume branch past the mode check).

- [ ] **Step 3: Implement.** The resume branch and the fresh branch converge on the same `importOne`/pass-2/delete code; the only differences are (a) whether
  the marker is written and (b) the pre-filled `map` and the one repair.

- [ ] **Step 4: Run to verify they pass** — `pnpm run test:skills`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(task-NN): import resumes from bm:imported footers`.

---

### Task 6: prose — SKILL.md, the docs, the invariant, and `connect`'s sentence

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs` — `connect`'s populated-store refusal (~L2696–2703): `… moving a populated one onto a tracker is \`import\`'s
  job, which is not built yet` → `… run \`backlog.mjs import github\` instead`. Update the comment above it (it says phase 5 is not built).
- Modify: `skills/backlog/SKILL.md` (~L100–114): after the `connect` block, an `import` block of the same shape — the command line in a `bash` fence, what it
  writes in which order (marker and forms, then issues, then deletes the files and prints the commit list), the eight refusals in one sentence each, the
  resume rule (footer), and what is lost (§8.6's last paragraph, one line). Change `connect`'s `(importing those is a later phase's job)` to
  `(that is \`import\`'s job)`.
- Modify: `docs/subsystems/skills.md` — the CLI paragraph (~L29) gains `and, since task-NN, \`import github [owner/repo] [--no-forms]\`, which moves a files
  project's items onto issues through the local API and deletes the files last`; the verb table gains a row `import` whose API-mode cell says `files mode
  ONLY — the command that moves a project INTO API mode; refused (already tracker-backed) once there`.
- Modify: `README.md` (~L244–247): one sentence after `Connect one with …`: `Move an existing files project with \`backlog.mjs import github\`; it writes the
  marker first, one issue per item, and deletes the files only once every cross-link has been rewritten.`
- Modify: `CLAUDE.md` — one invariant bullet after the `backlog.mjs in a tracker project needs the stack up` bullet:
  **`import` writes the marker first and deletes the files last, and the `bm:imported` footer is its idempotency key.** The write routes refuse a `files`
  project, so no request could precede the marker; the deletion is the transaction's commit and runs only after pass 2; a re-run rebuilds `old id → #n` from
  `<!-- bm:imported from=<id> … -->` and skips those items; counters ride one synthetic `claim`+`release` (`reason: 'imported'`) BEFORE the close because
  `claim` refuses a closed issue; an over-cap body is cut at a `##` boundary and links the file at HEAD, which is why HEAD must be on an `origin/*` ref;
  `import` never commits. `Why:` link to the new `invariants.md` anchor.
- Modify: `docs/subsystems/invariants.md` — a new `## \`import\` writes the marker first and deletes the files last` section: the rule, then the failure it
  encodes (the 2026-09-17 draft wrote the marker last, which `writerFor`'s `files` refusal made impossible — not a bug that shipped, a design that could not
  have), the resume rule and why the readable line and the marker comment are two different things, the counters decision (§14.13) and the cap decision
  (§14.14) with their costs, and the three things that are lost. Wrap at 160.

- [ ] **Step 1: Prose pins** (in `backlog.test.mjs`, where the other SKILL.md pins live): SKILL.md contains `import github [owner/repo] [--no-forms]` in a
  fenced block; SKILL.md no longer contains `later phase's job`; `backlog.mjs`'s source no longer contains `not built yet`; `CLAUDE.md` contains a bullet
  whose text includes both `marker first` and `bm:imported`. Run — expected: FAIL on all four.

- [ ] **Step 2: Make the edits above.** Then `pnpm run test:skills` — expected: PASS.

- [ ] **Step 3: Run the union.** `pnpm test` — both runners green (the jest half has a `claude-rules` test and doc guards that read `CLAUDE.md`).

- [ ] **Step 4: Commit** — `docs(task-NN): document backlog.mjs import — SKILL.md, skills.md, README, invariant`.

---

## After the run — the first real migration (guide-manager), by hand, NOT part of the orchestrator run

Recorded here so the sequence has one home; every step is the operator's, from a terminal in `~/Documents/custom-projects/guide-manager`.

1. `git push origin main` — guide-manager is one commit ahead of `origin/main` (survey, 2026-09-21); §8.1 refuses until HEAD is on an `origin/*` ref.
2. `pnpm run plugin:sync` in backlog-manager once the run has merged and pushed — the installed skill is a copy of the pushed HEAD.
3. Stack up (`pnpm run docker:up` or `pnpm run dev`) with `BM_GITHUB_TOKEN` set — the poller must be able to see `futin/guide-manager`.
4. `node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" import github` — 18 items; expect `task-1 → #4 (truncated)`, one `claim`+`release` pair for
   the single item with counters, and two `done/` items whose stray `started:` is ignored. Roughly 25 content-creating requests at 1/s.
5. Read the printed commit list, `git add` exactly those paths, commit, push. Open the board and confirm 18 issues under the project with the tracker's
   poll-age line.
6. If it stops: read the stderr line, fix the named cause, re-run the same command — it resumes.

## Self-review (done while writing; kept so a reader can check it)

- **Spec coverage.** §8.1 → Task 2 (checks 1–9). §8.2 → Task 3 step 1. §8.3 steps 1–6 → Task 3 (split: step 2; footer/cap: step 3 composition; create:
  step 3; counters: step 3; close: step 3; pacing + map: step 3/4). §8.4 → Task 4 steps 1–2. §8.5 → Task 4 step 3. §8.6 → Task 3 step 4 (failure), Task 5
  (resume). §12.4's list: every named case appears in Tasks 2–5. §14.12–14 → Task 6's invariant text. §13 (own task, one run) → the capture that follows.
- **Placeholders.** None: every step names the file, the behaviour and the cases. `task-NN` in commit messages is the id the capture mints — the one value
  this document cannot know.
- **Name consistency.** `splitOutcome`, `renderImportFooter`, `parseImportFooter`, `blobLink`, `fitBody`, `rewriteOldIds`, `importOrder`, `countersOf`,
  `IMPORT_BODY_CAP` (Task 1) are the names Tasks 3–5 use; `importFixture`, `githubRoutes`, `itemText`, `commitList` are the test helpers; `importOne`,
  `gitImportState` are the two implementation helpers named so Task 5 can find them. `BM_IMPORT_PACE_MS` appears in Global Constraints, Task 3 and Task 6's
  source guard.
