# CLAUDE.md as a three-tier index

Status: design approved in session 2026-09-22; spec under review. Source item: none — raised in-session while reading the context-window breakdown; capture as
a task if the work is routed through the orchestrator rather than done by hand.

## Why this exists

Every session in this repo — a chat about nothing in particular, a headless `backlog-execute`, the reviewer subagent — loads `CLAUDE.md` unconditionally. On
2026-09-22 that file is 540 lines / 71,333 bytes, and the desktop app's context panel prices the two CLAUDE.md files at 29.6k tokens, of which the global one is
~1.5k. So the project CLAUDE.md costs **~28k tokens per session**, 11% of a 250k window, before a word is typed.

430 of the 540 lines are the `## Invariants` section: 78 bold-led bullets (76 there, 2 under `## Conventions`), 66 of them ending in a `Why:` link into
`docs/subsystems/invariants.md`. Those 66 carry 8,187 of the section's 8,456 words — 97%. Thirty-two of them are orchestrator, run-file, worktree, claim or
tracker mechanism. A session that never touches those files pays for all of it.

The compression route has already been taken. `docs/superpowers/plans/2026-09-07-claude-md-normative-index.md` (commit `fb00e7e`, "shorten 40 invariants to
statement + link") moved reasoning out to `invariants.md` and left each bullet as "the rule, the single implementation's name, the contract numbers, a link".
That is the shape the file has now, and it still costs 28k. Compression has hit the limit of its shape: what remains is mechanism, and mechanism is what a
session editing those files needs — it is only a session NOT editing them that should not pay.

The lazy-loading mechanism also already exists, wired the wrong way round. `.claude/rules/` holds six path-scoped files whose `paths:` globs already partition
the repo by subsystem (`orchestrator`, `dispatch-watchdog`, `items`, `tracker`, `board`, `skills`); Claude Code injects one the moment a session `Read`s a file
under its glob, and task-35 measured that this fires for headless `claude -p`, inside a linked worktree, and for a subagent's read. But each file is 0.8–2 KB of
one-line pointers into `invariants.md` — deliberately, because the design of the day said "CLAUDE.md remains the surface that every session loads
unconditionally, which is why no rule is moved out of it". The lazy layer is tiny and the eager layer is fat. This spec inverts that.

## The shape: three tiers, one home each

Every rule that today has a `Why:` link is stated at three depths, each with exactly one home:

| tier | says                                                | lives in                                     | loaded when                                   |
| ---- | --------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 1    | the **headline** — the rule in one bolded sentence  | `CLAUDE.md`, `## Invariants` / `## Conventions` | every session, unconditionally                |
| 2    | the **mechanism** — how the rule is implemented     | ONE `.claude/rules/<file>.md`                | a file under that rule file's `paths:` is read |
| 3    | the **reasoning** — the failure it encodes          | `docs/subsystems/invariants.md#<anchor>`     | a reader follows the link                     |

Tier 1 keeps the index property `docs/overview.md` already claims for CLAUDE.md ("one normative line per rule"): every session knows every rule EXISTS and
where to read more. Tier 2 is what an editor of those files needs and nobody else does. Tier 3 is unchanged.

The 12 bullets with no `Why:` link stay whole in CLAUDE.md. Each is ≤ 59 words; they are the short cross-cutting rules (`/api`, loopback, `pnpm only`, the
allowlist, `open/ → done/`) and there is no mechanism to move.

### Tier 1 — the CLAUDE.md line

One line per rule, nothing after the link:

```
- **<headline>** Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)
```

The headline is the bullet's FIRST bold span, byte for byte. The link is the bullet's existing `Why:` link, reused verbatim. A line longer than 160 columns
breaks before `Why:` onto a two-space-indented continuation line, which is the style the file already uses. One sentence at the top of `## Invariants` states the
tiers so a reader knows where the mechanism went; there are no per-line pointers to rule files, because 66 of them would cost what the split saves.

### Tier 2 — the rule-file bullet

The original CLAUDE.md bullet, moved as **verbatim lines** — headline, mechanism and `Why:` link, wrapping and indentation preserved, in CLAUDE.md's order.
Nothing is reworded in the move. Each rule file is:

```
---
paths: [<globs>]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **<headline>** <mechanism …> Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)
- …
```

The existing pointer lines (`- Before changing files here, read docs/subsystems/invariants.md#…`) are all removed: every anchor they pointed at is now either a
full bullet in that file or homed in another file. There are **no secondary pointer lines** — a rule file may not carry a one-liner pointing at a bullet homed
elsewhere. Today's cross-references (e.g. `items.md` pointing at the claim protocol) go; the CLAUDE.md headline list is the cross-reference every session holds,
and one line shape keeps the guard simple. If a seam turns out to need one, that is a later change with its own test rule, not a quiet exception.

### Homes — the one table the migration reads

Placement rule: a bullet lives where its writer or authority lives. Five anchors are cited by two or three rule files today and get one home each; eleven have
no home today and get one. Three new rule files cover the areas no glob reaches.

**`orchestrator.md`** — `paths: ["skills/backlog-orchestrate/**", "server/src/orchestrator/**", "shared/agent.ts"]` (unchanged). 17 bullets:
`the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has` ·
`remote-runs-ride-beside-runs-never-in-it` (was also in board) · `a-runs-sidecars-are-archived-beside-its-run-file-task-31` ·
`backlog-orchestrate-is-the-only-skill-that-commits-or-merges` · `the-driver-owns-a-tracker-items-claim-for-the-whole-item` (was also in items, tracker) ·
`the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made` · `merge-mode-is-run-scoped-and-a-malformed-one-is-a-400`
(two bullets) · `merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling` ·
`question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run` · `a-classifier-denial-degrades-the-run-every-other-merge-failure-parks` ·
`undoing-an-already-completed-orchestrator-merge-is-git-revert--m-1-never-git-reset---hard` (orphan) ·
`orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree` ·
`a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base` · `a-pause-request-is-a-file-the-server-writes-and-the-tool-reads` ·
`a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run` ·
`a-sessions-cost-is-recorded-per-transcript-and-a-transcripts-identity-is-its-file-name` (orphan).

**`dispatch-watchdog.md`** — `paths: ["server/src/agents/**", "shared/agent.ts"]` (gains `shared/agent.ts`, where `dispatchGate` and `deriveAction` live).
13 bullets: `a-board-started-run-is-visible-before-its-run-file-exists` · `dispatch-derives-the-action-it-never-accepts-one` · `isitemid-accepts-three-shapes` ·
`the-orchestrate-spawn-prompt-is-composed-server-side` · `the-browser-never-talks-to-the-dashboard` ·
`a-project-the-dashboard-cannot-see-cannot-be-dispatched-to` (orphan) · `one-run-per-project-checked-twice` · `a-resume-is-serialized-at-three-layers` (two
bullets) · `the-watchdog-spawns-it-never-writes-the-run-file` · `armed-idle-off` · `grace-any-attempt-starts-the-clock-only-a-success-counts` ·
`every-agents-post-is-guarded-by-content-type-and-origin`.

**`board.md`** — `paths: ["client/src/**"]` (unchanged). 11 bullets: `a-starting-entry-blocks-what-a-run-file-blocks-bug-21` ·
`escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes` · `board-versus-archive-is-derived-and-last-touched-has-three-rungs` ·
`settings-is-two-pages-the-page-is-the-scope` · `contentwidth-is-stamped-before-first-paint-and-the-csp-hash-travels-with-it` ·
`environment-level-blocks-hide-the-dispatch-control-per-item-ones-disable-it` · `a-crashed-run-renders-as-crashed-never-as-nothing` (two bullets) ·
`the-resume-coupling-the-board-offers-a-hand-resume-exactly-when-the-sweeper-will-not` ·
`launch-sheet-modeleffort-pickers-seed-from-settings-never-the-last-launch` · `queue-wait-is-not-work`. Loses its pointers to `remote-runs` and
`a-tracker-project-has-no-item-files` (homed in orchestrator and items).

**`items.md`** — `paths: ["server/src/items/**"]` (unchanged). 5 bullets: `the-seven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item` ·
`a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files` ·
`a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places` (was also in board, tracker) · `the-middle-rung-comes-from-git-not-the-item-file` ·
`the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere`. Loses its pointers to the claim protocol, the tracker cache and
the driver's claim (homed in tracker, tracker, orchestrator).

**`tracker.md`** — `paths: ["server/src/tracker/**"]` (unchanged). 3 bullets: `the-claim-protocol-lowest-live-comment-id-wins` (was also in items) ·
`the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected` ·
`the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value` (was also in items).

**`skills.md`** — `paths: ["skills/**", "agents/**"]` (unchanged). 9 bullets:
`registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree` ·
`backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state` · `backlogmjs-in-a-tracker-project-needs-the-stack-up` (ONE bullet — see
dedupe) · `import-writes-the-marker-first-and-deletes-the-files-last` (orphan) · `refactors-is-a-peer-section-not-a-facet-on-ideas` (orphan) ·
`started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status` · `every-skill-cli-exits-through-processexitcode-never-processexit` ·
`editing-skills-changes-nothing-until-commit--push--pluginsync` · `agents-is-part-of-the-plugins-publish-surface`. Loses `pnpm-test-is-the-union-of-both-runners`
to `scripts.md`.

**`security.md`** — NEW, `paths: ["server/src/*.ts", "vite.config.ts", "docker-compose.yml"]`. The single-level glob names `main.ts`, `security.ts`,
`allowed-hosts.ts`, `static.ts` and `app.module.ts` — the server's edge, which no existing glob reaches. 2 bullets:
`loopback-bind-is-the-access-control-except-where-noted` (orphan) · `every-route-is-gated-by-a-host-allowlist` (orphan).

**`scripts.md`** — NEW, `paths: ["scripts/**", "package.json", "pnpm-workspace.yaml"]`. 2 bullets:
`the-tailnet-serve-is-a-script-and-its-port-is-read-where-compose-reads-it` (orphan) · `pnpm-test-is-the-union-of-both-runners` (from skills — the rule is
about `scripts/test-all.mjs` and `package.json`'s `test` script, which is where an edit would break it).

**`tests.md`** — NEW, `paths: ["test/**", ".claude/rules/**"]`. 3 bullets: `a-supertest-suite-listens-once-on-127001-through-listenloopback` (orphan; from
`## Conventions`) · `a-fixture-date-is-relative-to-the-clock-the-assertion-runs-under` (orphan; from `## Conventions`) ·
`path-scoped-clauderules-reach-a-headless-run-in-a-linked-worktree-task-35` (orphan — the mechanism's rule about itself, which is why the file also scopes
`.claude/rules/**`: a session editing a rule file is told the rule for rule files).

Totals after the move: 62 anchors, 66 bullets before dedupe, 65 after (four anchors — merge mode, resume serialisation, crashed-run rendering, the stack-up
refusal — carry two bullets each; the last of those is the duplicate), every one in exactly one file. Word budget lands roughly: orchestrator 2.3k,
dispatch-watchdog 1.2k, skills 1.0k, board 0.9k, tracker 0.9k, items 0.8k, tests 0.7k, scripts 0.2k, security 0.2k.

### Dedupe

`backlogmjs-in-a-tracker-project-needs-the-stack-up` is stated twice in CLAUDE.md with an identical headline — once at 110 words (the marker's three states, the
`exit 1` for a malformed marker, the three id shapes and the two refused ones) and once at 71 words restating a subset. The migration keeps the first and drops
the second, and refuses to drop it unless every backtick span and number in the dropped bullet appears in the kept one.

## Guards

The guards are what let the split hold after the people who did it have moved on. All read the files as SOURCE, the way the suite already does.

### `test/claude-rules.test.ts`

Keep, unchanged in intent: every rule file declares a non-empty `paths:` list; every `invariants.md` anchor a rule file cites resolves to a heading; every glob
matches at least one tracked-or-untracked-unignored file today; the suite passes vacuously on an absent directory. The glob-to-regex helper must accept the two
shapes the new files add — `server/src/*.ts` (single level) and a bare literal such as `package.json` — which the existing grammar already covers.

Drop: "rule files are pointers only" and "no rule file exceeds 25 lines". Both encoded the pointer design; a rule file now legitimately runs to 100+ lines.

Add, as behaviour with the exact cases the implementer writes:

1. **A rule file is bullets and nothing else.** After the frontmatter, every non-blank line is a `# ` heading, the start of a bullet (`- `), or a two-space
   continuation of the bullet above. A line of free prose fails, naming file and line. Every bullet carries exactly one
   `docs/subsystems/invariants.md#<anchor>` link. Cases: the real tree passes; a fixture body with a stray paragraph fails on that line; a fixture bullet with no
   link fails naming its headline; a fixture bullet with two links fails.
2. **One home per anchor, and the two tiers name the same set.** Collect `(anchor, headline)` from every `- **` bullet under CLAUDE.md's `## Invariants` to end
   of file that carries a `Why:` link; collect the same from every rule-file bullet. Both sides join continuation lines and collapse whitespace before
   extracting the first bold span, so a headline that happens to wrap compares equal to one that does not (one does today: the resume-coupling headline at
   `CLAUDE.md:464` closes its bold span on the continuation line). The two multisets are equal — same anchors, same headlines byte for byte,
   same counts — and every anchor's rule-file bullets all sit in ONE file. Cases: the real tree passes; an anchor present in CLAUDE.md and no rule file fails
   naming it (this is the case that goes red against today's tree, on eleven orphans); an anchor in two rule files fails naming both; a headline edited on one
   side only fails naming the anchor.
3. **CLAUDE.md carries headlines, not mechanism.** Join each `- **` bullet's continuation lines and collapse whitespace. A bullet with a `Why:` link must match
   exactly `- **<headline>** Why: [invariants.md](docs/subsystems/invariants.md#<anchor>)` and nothing more. A bullet without a `Why:` link is at most 80 words
   (whitespace-separated tokens).
   Cases: the real tree passes (this is the second case red against today's tree, on all 66); a fixture with one sentence after the link fails; an 81-word
   unlinked fixture fails; a wrapped two-line headline joins and passes; a bullet whose first bold span is followed by a second bold span takes the first.

The 80-word bound is the guard that stops mechanism creeping back into CLAUDE.md by the side door of dropping the link. The two plain `- ` bullets under
`## Conventions` (the comment-density note and the "tests are flat in `test/`" paragraph) are not bold-led and are outside case 3 — see "Left in place".

### `test/dialog-count-docs.test.ts`

`claudeBullet()` reads the Escape bullet from `.claude/rules/board.md` — the mechanism is where the three dialog names now live. The CLAUDE.md half narrows to
"the headline `Escape has one owner, and the topmost dialog is the only one that closes.` is present". The file's own doc comment updates from "two prose
files" to the three tiers. Nothing about `invariants.md`'s half or the hook's own comment changes.

### `skills/backlog/tools/backlog.test.mjs` — `CLAUDE.md carries the import invariant bullet`

Unchanged. The headline (`` `import` writes the marker first and deletes the files last, and the `bm:imported` footer is its idempotency key. ``) already carries
both needles, so the case keeps passing against tier 1 alone, and guard 2 above covers that the mechanism landed in `skills.md`.

### The migration's own checks (throwaway, not committed)

A script in the session scratchpad performs the split from the homes table above, deterministically, so it can be re-run until the checks pass. It refuses a
Why-linked bullet whose anchor the table does not map, and a bullet with two `invariants.md#` links. After writing it asserts **token survival**: every backtick
span, every number and every `bug-`/`task-`/`idea-`/`ref-` id in the old CLAUDE.md from `## Invariants` onward appears in the new CLAUDE.md ∪ the nine rule
files. Because bullets move as verbatim lines, the only way this can fail is the dedupe, and the dedupe carries its own check.

## Consumers that change

Each site below states or depends on "CLAUDE.md holds the rule text" or "rule files are pointers". One phrase each; none changes behaviour beyond what the
tiers require.

- **`CLAUDE.md` itself** — `## Layout`'s `.claude/rules/` line (currently "six path-scoped pointer files … one line per anchor … and nothing else") describes
  the nine files and the tier they hold; the `.claude/DESIGN.md` line's aside ("those pin to `invariants.md` anchors only") follows. The one-sentence intro under
  `## Invariants` states the three tiers. The rules-about-rules bullet keeps its anchor and gets the headline
  `Every .claude/rules/ file carries paths: and is the one home of its rules' mechanism — never the reasoning.`; its mechanism text is rewritten (the only bullet
  whose mechanism changes, because its old mechanism WAS the pointer rule) to state: `paths:` mandatory and why; one home per anchor, headlines byte-equal across
  tiers, pinned by `test/claude-rules.test.ts`; the P4/P5 gaps and that the headline in CLAUDE.md is the mitigation; the contract sweep visits `.claude/rules/`.
- **`docs/subsystems/invariants.md`**, section `## Path-scoped .claude/rules reach a headless run in a linked worktree (task-35)` — heading unchanged (it is an
  anchor). The opening paragraph's "is a **pointer** — one line per anchor" becomes the one-home statement. "**Why pointers only.**" becomes "**Why one home for
  the mechanism.**": three STATEMENTS of one rule was the drift the pointers avoided; three TIERS is not that — each tier says something the others do not, and
  the guards pin the seams; the contract sweep now visits `.claude/rules/` because tier 2 states contract. P5's closing sentence ("which is why no rule is moved
  out of it") becomes "which is why every rule's HEADLINE stays in it", and a dated subsection `### The 2026-09-22 split` records the numbers: 540 lines /
  71,333 bytes / ~28k tokens before, 430 of them Invariants, 8,187 of 8,456 words under a Why link; the after figures once measured.
- **`docs/overview.md`** — line 15's "one line per rule" becomes "one headline per rule"; lines 24–26's "six path-scoped pointer files" becomes the tier-2
  description; the `### Where the rules live` paragraph states the three tiers. The docs-sync stamp is handled as the workflow says (below).
- **`agents/backlog-reviewer.md`**, check 2 — "Read `<worktree>/CLAUDE.md` and work through its **Invariants** section against the diff" gains: "and, for each
  file the diff touches, read the `.claude/rules/*.md` whose `paths:` covers it — that is where each headline's mechanism is; a rule file loads on a `Read`, and a
  reviewer reads a diff, so open them yourself". The reviewer cannot rely on the glob firing.
- **`skills/backlog-execute/SKILL.md`**, the contract sweep's site list (`CLAUDE.md`, `docs/`, `README*`, …) — `` `.claude/rules/*.md` `` joins it, right after
  `CLAUDE.md`. Tier 2 states identifiers, numbers and paths, so it is a site that can lie.
- **`skills/backlog-orchestrate/SKILL.md`**, decide-mode step 1 ("using the item, the repo's `CLAUDE.md` and the code") — gains "the `.claude/rules/` files
  scoped to the files in play".

Untouched, on purpose: `docs/superpowers/plans/2026-09-07-claude-md-normative-index.md` and every other spec or plan that describes the pointer design
(history); `skills/backlog-orchestrate/references/rationale.md`'s `CLAUDE.md:227` citation (a record of a past sweep); the global `~/.claude/CLAUDE.md`; the
plugin's publish surface — `.claude/rules/` is repo-local and was never published, and the headless sessions this repo spawns run in ITS linked worktrees, where
task-35 measured the globs firing.

## Left in place

- The two plain `- ` bullets under `## Conventions` — the comment-density sentence (15 words) and "Tests are flat in `test/` …" (~330 words, ~900 tokens). The
  second is mechanism about test layout and would sit naturally in `tests.md`, but it has no `Why:` anchor, so moving it means inventing one (or citing
  `pnpm-test-is-the-union-of-both-runners`, which it is largely about) and writing a headline — a content edit, not a move. Out of scope here; a candidate for a
  follow-up refactor once the mechanical split has landed.
- `## Commands`, `## Layout` and the Invariants intro — already the index register (the 2026-09-07 plan's finding, still true).

## Non-goals

- Rewording any mechanism. Bullets move as verbatim lines; the one exception is the rules-about-rules bullet, whose old mechanism described the design this spec
  replaces.
- Secondary pointer lines in rule files. One line shape, one guard.
- New or renamed `invariants.md` headings. Every anchor CLAUDE.md cites today resolves and keeps resolving.
- `@import` — eager, no saving (the 2026-09-07 plan's finding).
- Re-running the `InstructionsLoaded` matrix. P1–P5 stand; nothing here changes when a rule file loads, only what it holds.
- Changing `skills/**` prose beyond the two one-phrase sweep/decide additions. The publish boundary is untouched.

## Risks and what answers them

- **P4/P5 stand: a session that only `Write`s under a glob, or reads source only through `codegraph_explore`, never loads tier 2.** Answered three ways: the
  headline is in CLAUDE.md, so the session knows the rule exists and can open the rule file; the reviewer is told to read the matching rule files against every
  diff; the contract sweep visits them. This is the same gap the pointer design accepted — the pointers were "a floor, not a guarantee" — with a smaller
  always-loaded floor and the same reviewer backstop.
- **A rule file loads whole on touch.** `orchestrator.md` at ~2.3k words is ~6k tokens per session that reads an orchestrator file. That is the intended
  trade: the cost moves from every session to the sessions that need it.
- **`tests.md` fires often.** Nearly every execute session reads a test file, so ~700 words ride along. Still strictly less than today, where the same 700 words
  ride in every session including the ones that read nothing.
- **Headline-only lines lose the implementation's name for a chat session** (e.g. tier 1 says "has exactly one writer" without naming `backlog.mjs`). Accepted
  under the approved shape; the name is one `Read` away and the reviewer sees it.

## Order of work and verification

1. Write the three new `test/claude-rules.test.ts` cases and the `dialog-count-docs` change first; run them against today's tree and record the red — guard 2
   fails on the eleven orphans, guard 3 on all 66 fat bullets. That red IS the proof the guards can see the thing they exist to catch.
2. Run the migration script; run the token-survival check; fix the homes table until both are clean.
3. Hand-edit the prose sites under "Consumers that change".
4. `pnpm test` (both runners) and `pnpm run typecheck` green.
5. docs-sync: record the checker's status before step 3 and after step 4; the set of docs it reports as drifted must be identical. If it flags `overview.md`,
   `invariants.md` or `CLAUDE.md` (all three are in `docs/.docs-sync.yml`, as `overview`, `subsystem` and `index`) as edited without a source change,
   re-baseline those only, through the docs-sync workflow, never by hand-editing a stamp. `.docs-sync.yml` lists no `.claude/rules/*` file today, so the three
   new rule files need no entry — their mechanical checks (anchors resolve, globs match) are `test/claude-rules.test.ts`'s.
6. Measure: `wc -c CLAUDE.md` before and after (71,333 → expected 24–27 KB). The token figure has no tokenizer in the repo; the person who lands this opens a
   fresh session and reads the context panel's "Memory files" line, expecting roughly 28k → 9k for the project file, and records both numbers in the
   `invariants.md` subsection.

## Approaches considered

- **Compress in place again.** Already done once (`fb00e7e`). With 97% of the section's words under Why links, the remaining text is mechanism; shortening it
  further loses the mechanism without changing who loads it.
- **Full move — topic bullets leave CLAUDE.md entirely, ~4k tokens left.** Saves ~2k more than the chosen shape but a chat session would not know the
  orchestrator rules exist, `overview.md`'s "index" claim would be false, and every consumer that reads CLAUDE.md's Invariants section as a checklist would need
  re-pointing rather than extending. Rejected for the weaker index.
- **Three tiers, headline stays** — chosen. Keeps the index, moves 97% of the words, one mechanical move with mechanical guards.
