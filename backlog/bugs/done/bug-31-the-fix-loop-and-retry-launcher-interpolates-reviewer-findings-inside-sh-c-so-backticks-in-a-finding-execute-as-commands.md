---
id: bug-31
title: The fix-loop and retry launcher interpolates reviewer findings inside sh -c, so backticks in a finding execute as commands
created: 2026-09-06
tags: skills, orchestrate, security
runner-fix: true
updated: 2026-09-12T16:34:30Z
groom-elapsed: 278
groom-tokens: 62062
started: 2026-09-12T16:18:03Z
execute-elapsed: 987
execute-tokens: 147610
---

## Symptom

A fix-loop session (`<dir>/logs/<id>-fix-<n>.jsonl`) or a retry session starts with a
prompt from which every backtick-quoted identifier has been removed, and its `.err`
file shows the shell trying to run those identifiers as commands:

```
sh: rowId: command not found
sh: command substitution: line 1: syntax error: unexpected end of file
sh: Infinity: command not found
sh: DELETE: command not found
sh: docs/subsystems/api-reference.md:57: No such file or directory
```

Seen in 3 of the 26 fix sessions on this machine: backlog-manager `bug-15-fix-1.err`,
claude-agents-dashboard `bug-4-fix-1.err`, ixray `bug-14-fix-1.err`. All three sessions
recovered because the executor read `reviews/<id>-1.md` itself, so no item was merged on
a mangled prompt — but the prompt the driver meant to send never arrived intact, and
what did run was chosen by the reviewer's prose.

## Repro

1. Have a reviewer report whose Important finding quotes an identifier in backticks,
   e.g. `` `rowId` `` (any review of code does).
2. Follow SKILL.md §7 `verdict: fix`: "resume the item's own executor session with the
   findings pasted in — step 5's retry line unchanged". Step 5's line (SKILL.md ~931) is
   `nohup sh -c 'cd … && BM_ORCH_RUN=<runId> exec claude -p --resume <sessionId> "<what to do differently>" …'`.
3. The findings land inside the double quotes inside the single-quoted `sh -c` script,
   where `sh` performs command substitution: every `` `x` `` and `$(x)` is executed and
   replaced by its output. `.err` fills with `command not found`; the session's first
   user message has the identifiers blanked.

The dashboard project's driver worked around it unprompted by writing the findings to
`<dir>/prompts/<id>-fix-<n>.txt` first (9 files exist there, none in the other three
projects, and SKILL.md never names a `prompts/` directory) — every one of those sessions
has an empty `.err`. The backlog-manager and ixray drivers pasted inline, as the skill
says to.

## Affects

- `skills/backlog-orchestrate/SKILL.md` §4 "Dispatch the headless session" retry line (~931): `"<what to do differently>"` inside `sh -c '…'`
- `skills/backlog-orchestrate/SKILL.md` §7 "Review", the `verdict: fix` branch (~1002–1016): "Paste the findings as the reviewer wrote them"
- `skills/backlog-orchestrate/references/recovery.md` wherever a resume re-uses the same line

Reviewer text is derived from repository content (file names, comments, test names), so
a repository can steer what the driver's shell executes. Low likelihood today; zero cost
to close.

## Cause

`skills/backlog-orchestrate/SKILL.md` puts driver-composed prose in a **command
position**. The retry launcher (§5, line ~952) and the fix loop that reuses it
verbatim (§7, "step 5's retry line unchanged") spell the prompt
`"<what to do differently>"` — double-quoted, inside the single-quoted
`sh -c '…'` body. A double-quoted word is *not* a literal in `sh`: it still
undergoes command substitution (`` `x` `` and `$(x)`) and parameter expansion
(`$x`). §7 then orders the one text most certain to contain those characters
pasted into that position — "Paste the findings as the reviewer wrote them —
they name `file:line`" — and a reviewer quoting identifiers in backticks is
simply what a code review looks like.

Measured, not reasoned. The same shape, with a stub in place of `claude`:

```
$ sh -c 'exec ./stub.sh "Fix `rowId` and $(touch OWNED)"'
sh: rowId: command not found          # stderr — this is the .err in the Symptom
argv[1] = "Fix  and "                 # the identifiers are gone from the prompt
OWNED                                 # ...and the substitution ran
```

Two distinct failure modes ride the one hole, and only the first has been seen:

1. **Substitution.** Each `` `…` ``/`$(…)` is executed and replaced by its
   output, so the session is resumed with a prompt whose identifiers have been
   blanked — `bug-15-fix-1.err` on this machine is a reviewer quoting CSS
   (`` `.run-track-name-stalled { color: var(--ink) }` ``), and `var(--ink)` is
   what produced its `syntax error near unexpected token ('`.
2. **An apostrophe ends the dispatch entirely.** Findings that say "doesn't" or
   quote `it's` close the outer single quote mid-body; the line becomes a syntax
   error and *nothing spawns*. SKILL.md's §4 rule "One line, and no apostrophes"
   governs the fixed marker text the run composes itself — it cannot govern this
   one, because the words belong to the reviewer, not the driver.

The convention that closes it already exists one file over, and these two lines
are the only place in the skill that still disobeys it: `attention
--questions-json <file>` and `assume --json <file>` take their payloads by file
"rather than inline argv … the content is prose the run composed, and prose does
not survive shell quoting intact" (`orchestrate.mjs` ~2073). The
claude-agents-dashboard driver rediscovered that convention unprompted mid-run —
9 files under `<dir>/prompts/`, every matching `.err` empty — while the
backlog-manager and ixray drivers did as SKILL.md said and got the `.err` files
in the Symptom.

Why it survived 26 fix sessions: the damage is invisible on the happy path. The
resumed session recovers by reading `reviews/<id>-1.md` itself, `run.json`
records nothing about prompts, and stderr goes to a `.err` nobody opens unless
the item parks. So the defect shows up only as a fix loop that was handed a
worse prompt than the run intended — and as arbitrary repository-derived text
choosing what the driver's shell executes.

## Fix

Carry every run-composed prompt in a file and name the file on the command line;
never interpolate prose into a command. The prompt file travels the same path
the questions payload already does, and `<dir>/prompts/` needs no tool change —
the sidecar archiver is a denylist of two, so it is archived with the run.

1. **§7, `verdict: fix`** — before the launcher, write the findings verbatim to
   `<dir>/prompts/<id>-fix-<n>.txt` (`<n>` the `fixLoops` value `stage --fix-loop`
   just echoed back, so a second loop keeps the first one's prompt) using the
   **Write tool**, not a heredoc and not `printf`. State that choice and its
   reason in the text: a heredoc delimiter that happens to appear in the
   findings ends the document early, and `printf '%s' '…'` re-introduces the
   apostrophe problem this fix exists to remove.
2. **§5's retry line** — same, to `<dir>/prompts/<id>-retry-1.txt`, since the
   "what to do differently" text quotes execute's failure `## Outcome`, which
   carries command output.
3. **Both launchers read the file back** in place of the inline prompt:
   `"$(cat "<dir>/prompts/<id>-fix-<n>.txt")"`. Command-substitution *output* is
   not re-scanned for expansions, so argv arrives byte-identical to the file —
   verified against the same stub used above: backticks, `$(touch OWNED)`,
   `var(--ink)` and an apostrophe all survived intact, nothing executed, `.err`
   empty. The inner double quotes around the path are what keep a path with a
   space intact; both sit inside the single-quoted body, which does not change.
4. **Guard the empty prompt.** Prefix the command with `test -s "<file>" &&` so
   a missing or empty prompt file spawns nothing at all: `sh` exits, `watch`
   sees a dead pid within a second and the driver treats it as the dispatch
   failure it is. Without it `$(cat …)` degrades to `""` and the run spends its
   one fix loop on a session resumed with no instruction.
5. **State the rule once, so it covers the family and not just these two
   lines.** In §4's dispatch rules: *prose this run did not compose — reviewer
   findings, execute's `## Outcome`, a captured error — never rides a shell
   command line; it goes in a file and the command names the file.* Then apply
   it to the two remaining inline payload writes: §3's
   `printf '%s' '[…]' > "<dir>/questions/<id>.json"` and its `-assumed.json`
   twin become Write-tool writes (an apostrophe inside a question is today a
   syntax error), and `attention --detail` / `stage --note` values stay the
   driver's own short words rather than a verbatim quote of reviewer prose.
6. **`references/recovery.md`** — `resume-session` says "step 5's retry line
   unchanged", which now silently means a prompt file too. Say it: write
   `<dir>/prompts/<id>-retry-1.txt` first, then the line.
7. **`docs/subsystems/invariants.md` ~line 107** calls `<dir>/prompts/` "the one
   driver invented"; after this it is prescribed, so that clause changes with
   the code it describes.

Four existing tests pin the shape and must stay green — they are also why the
path is substituted literally rather than exported: `SKILL.md names no
environment variable but the three it owns` would fail on a new `BM_` name, and
`no dispatch line contains an apostrophe`, `the run id assignment sits inside
the sh -c body`, and `both dispatch lines name the session they spawn` all
re-read the two `exec claude -p` lines and require there still be exactly two.

### Test cases

All in `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (node runner;
`pnpm run test:skills`, and `pnpm test` runs both runners):

- **The launcher takes its prompt from a file.** Of the two `exec claude -p`
  lines, the `--resume` one contains `$(cat "<dir>/prompts/` and no longer
  contains the string `<what to do differently>`.
- **The prompt file is written before the launcher, and by the Write tool.**
  SKILL.md names `<dir>/prompts/<id>-fix-<n>.txt` and
  `<dir>/prompts/<id>-retry-1.txt`, the write instruction precedes the launcher
  line in file order, and the section forbids a heredoc for it.
- **Red proof, executed rather than asserted about.** Take the retry line *from
  SKILL.md*, substitute `<dir>`→a temp dir, `<id>`→`bug-1`, `<sessionId>`→`s1`,
  `<runId>`→`run-1`, and replace the `claude` token with a stub script that
  dumps its argv to a file; write a prompt file containing ``Fix `rowId` here``,
  `$(touch OWNED)`, `var(--ink)` and `it's`; run the line. Assert the captured
  prompt argv equals the file's bytes (trailing newline aside), no `OWNED`
  exists under the temp cwd, and the `.err` file is empty. In the same test run
  the pre-fix shape (the prompt interpolated inline) through the same harness
  and assert it *does* create `OWNED` — a harness that cannot go red proves
  nothing about the shape that is green.
- **An absent prompt file spawns nothing.** Same harness with the prompt file
  removed: the stub's argv dump never appears, pinning the `test -s` guard.
- **The rule is written down where a run will read it.** §4's dispatch rules
  contain the sentence from step 5, and no `printf` line under §3 writes a
  questions payload any more.

### Done when

`pnpm test` is green, the five cases above exist and the four named existing
tests still pass. Not browser-visible — no Playwright check applies. Inert for
the *next* run until this is committed, pushed and `pnpm run plugin:sync` has
copied it into the install, which is why the item carries `runner-fix: true`:
the run that executes it must not be the run still dispatching through the
broken line.

## Outcome

2026-09-12 — fixed as the `## Fix` describes, all seven steps.

`skills/backlog-orchestrate/SKILL.md` §5's retry launcher now reads its prompt
from `<dir>/prompts/<id>-retry-1.txt` (`"$(cat "…")"`), guarded by `test -s
"…" &&` so a missing or empty prompt file spawns nothing; §7's `verdict: fix`
writes the reviewer's findings verbatim to `<dir>/prompts/<id>-fix-<n>.txt`
with the Write tool and reuses that same line with this loop's `<n>` in both
the guard and the `$(cat …)`; §4's dispatch rules now carry the general rule
("prose this run did not compose … never rides a shell command line; it goes
in a file and the command names the file"), and §3's two `printf '%s' '…' >
questions/…` payload writes became Write-tool writes under it.
`references/recovery.md`'s `resume-session` says to write the prompt file
before the line it calls "unchanged". Still exactly two `exec claude -p` lines
in the file, and neither contains an apostrophe.

Five cases added to `skills/backlog-orchestrate/tools/orchestrate.test.mjs`.
The last two execute SKILL.md's own retry line with `claude` swapped for an
argv-dumping stub, rather than asserting about its text: a hostile prompt
(`` `rowId` ``, `$(touch OWNED)`, `var(--ink)`, `it's`) arrives in argv
byte-identical, creates no `OWNED`, and leaves an empty `.err`; the same
harness run over the pre-fix inline shape does create `OWNED` and delivers a
mangled prompt, and with the apostrophe present spawns nothing at all — both
failure modes the `## Cause` names, reproduced.

Verification — `pnpm test`, both runners:

```
$ pnpm test
Test Suites: 82 passed, 82 total
Tests:       1567 passed, 1567 total
PASS  node --test (skills)
pnpm test: both runners passed.
```

The skills runner re-run alone afterwards, on the final file state:

```
$ pnpm run test:skills
# tests 526
# pass 526
# fail 0
```

The four existing tests the `## Fix` named as constraints, run by name
together with the five new ones:

```
ok 1 - no dispatch line contains an apostrophe
ok 2 - the run id assignment sits inside the sh -c body, not in front of nohup
ok 3 - SKILL.md names no environment variable but the three it owns
ok 4 - the retry launcher takes its prompt from a file, not from argv
ok 5 - the prompt file is written before the launcher, and by the Write tool
ok 6 - the no-prose-in-argv rule is stated once, and §3 obeys it too
ok 7 - bug-31 red proof: a file-carried prompt reaches argv intact and executes nothing
ok 8 - an absent or empty prompt file spawns nothing
ok 9 - both dispatch lines name the session they spawn
# pass 9
# fail 0
```

One deviation from the plan, stated rather than left to be found: the plan's
step 1 spoke only of `<dir>/prompts/`, and §5's block originally gained a
`mkdir -p "<dir>/prompts"` alongside §4's `mkdir -p "<dir>/logs"`. That was
removed again — the Write tool creates the directory on its way to the file,
so the `mkdir` would have sat *after* the write it was meant to enable. §4
now says so once, and contrasts it with `<dir>/logs/` and `<dir>/verify/`,
which a shell redirect will not create for itself. The same reasoning removed
`mkdir -p "<dir>/questions"` from §3.

Contract sweep: 3 sites updated (docs/subsystems/invariants.md — both the
"`<dir>/prompts/` one driver invented" clause at ~108 the plan named and the
denylist rationale at ~131 that said "bug-31 will add…";
skills/backlog-orchestrate/tools/orchestrate.mjs:288, the same sentence in
`archiveSidecars`'s comment; skills/backlog-orchestrate/tools/orchestrate.test.mjs:419,
the sidecar case's "bug-31 will document…"). Four further hits were left
standing on purpose, all of them records of what was true when written rather
than statements of the current contract: the done items
`backlog/tasks/done/task-31-…`, `backlog/ideas/done/idea-8-…`, the plan
`docs/superpowers/plans/2026-09-01-orchestrate-skill-floor-trim.md:127`, and
the two comments that say "whatever else a driver invented" as a description
of an open set (`server/src/orchestrator/orchestrator.service.ts:125`,
`orchestrate.test.mjs:359`) — that set is still open, so those two are simply
still true.
Red proof: 5 tests went red with the change reverted — all five new cases were
written and run against the unmodified SKILL.md first (`# pass 0 / # fail 5`),
and the red-proof case additionally executes the pre-fix shape in-process on
every run, so it cannot quietly stop pinning anything.

### Fix loop 1 — 2026-09-12

The reviewer's Important finding was right, and the `## Outcome` above was
wrong to say "all seven steps": step 5 has two clauses and only the first was
implemented. The rule went into §4 and §3's `printf` payloads became Write-tool
writes, but "`attention --detail` / `stage --note` values stay the driver's own
short words rather than a verbatim quote" did not — so §2:331 and §9:1431 were
still telling a driver to paste `--note "<the classifier's own message,
verbatim>"`, model-written `Reason:` free text in a double-quoted argument, in
the same file that had just forbidden exactly that.

What changed in this loop:

- **§4's rule gained its second half.** `attention --detail`, `stage --note`
  and `merge-mode --note` stay inline arguments on purpose — one short line
  each, and what the run drawer renders — and what makes that safe is stated:
  the value is the driver's own summary plus a pointer, and the copy of record
  already lives where the same string points (the report, the `status --json`
  rows, the transcript).
- **Both classifier-denial notes are fixed text now**: `--note "auto mode
  classifier denied the merge probe"` (§2) and `--note "auto mode classifier
  denied the merge of <id>"` (§9). The trade is stated where it is made: the
  `Reason:` free text is lost from `mergeModeNote`, which answers "why is this
  run in branch mode" — and which of the two sites asked is the whole of that
  answer. The verbatim message is still in the driver's own transcript beside
  the command that provoked it.
- **Three placeholders now say whose words they are**: `<verdict summary, your
  words>` (§7), `<the failing command names>` (§8, names and never their
  output) and `<what happened, your words>` (§5), each with a sentence under
  it saying what the string points at instead of carrying.
- **Two Minor findings, both made worse by this diff, fixed too.** §8's
  "every other `<dir>` in this file is pasted once" was false once the retry
  line pasted it four times; it now names the retry line and says why that one
  cannot take the same `env` treatment — and why a mismatched paste there
  spawns nothing rather than reading the wrong prompt. §7's "the two names
  that carry this loop's `<n>`" read as a closed list that omitted the `.err`
  and the session name, which is how a fix loop overwrites the retry's stderr —
  the very file this item's `## Symptom` was found in. It is now every name,
  stated as one substitution of `retry 1` → `fix <n>`.

Coverage for the class the finding named, in
`skills/backlog-orchestrate/tools/orchestrate.test.mjs`:

- `every --detail and --note value is the driver's own words` — flattens
  SKILL.md, `recovery.md` and `rationale.md` (values wrap across lines; a
  line-by-line scan is how this class survived round one), then holds every
  `--note`/`--detail` value against two rules: no value may ask for a verbatim
  quote, and every `<…>` placeholder inside one must be on a closed list, each
  entry carrying the reason it is safe. The list is asserted in both
  directions, so a spelling that leaves the prose has to leave the list, and a
  floor on the number of values found keeps the scan from passing vacuously.
- `the classifier denial records the run fact, not the classifier prose` —
  exactly two `merge-mode branch --note` sites, with their exact strings.
- The existing rule test gained the second-half sentence.

Verification — `pnpm test`, both runners, on the final tree:

```
$ pnpm test
Test Suites: 82 passed, 82 total
Tests:       1567 passed, 1567 total
PASS  node --test (skills)
pnpm test: both runners passed.
```

Contract sweep: none found. `<the classifier's own message…>` survives only in
`docs/superpowers/plans/2026-09-04-orchestrator-merge-mode.md:541`, the plan
this feature was built from — a record of what was decided then, not a
statement of the contract now. `mergeModeNote`'s own contract
(`shared/types.ts:845`, `orchestrate.mjs:1941`, `invariants.md:515-608`) says
"why `mergeModeEffective` differs" and never "the classifier's message", so it
is unchanged by this; `RunDetail.tsx:399` and `run-stage.ts:176` say the note's
post-mortem value is naming *which call* was denied, which both new notes do.
§10's "quoting `mergeModeNote` verbatim" is now quoting the run's own sentence,
so it stays as written.
Red proof: 3 tests went red with the change reverted — with §5's SKILL.md at
`HEAD` (this item's round-one commit) and the test file as it now stands,
`every --detail and --note value is the driver's own words`, `the classifier
denial records the run fact, not the classifier prose` and the extended `the
no-prose-in-argv rule is stated once, and §3 obeys it too` all failed
(`# pass 0 / # fail 3`); SKILL.md was restored from a file copy, never a stash.
