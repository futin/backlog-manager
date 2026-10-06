# backlog-orchestrate — when a check fails: a second review says `fix`, or `verify` exits non-zero

Read this file **in full** when either happens: a second review says `verdict: fix` (the item's `fixLoops` is now `2`), or `verify` exits non-zero (`1`, red
rows; `5`, nothing to verify with). Both are observable results inside the loop, so a fresh run and a `--resume`d one reach it the same way. The ceiling itself
— at most two fix loops per item, **shared** between review and verify and counted in the run file — stays in `SKILL.md` §7, with `fix-mode` and both launchers.
A red command is not an opinion: nothing green-lights a merge except the commands passing.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
`${CLAUDE_PLUGIN_ROOT}` with the plugin root the body was loaded with before running any command here.

## A second review says `fix` (§7)

After the second `fix` verdict (`fixLoops` is now `2`), stop looping and hand it to a human:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind fix-exhausted --detail "2 fix loops, still: <verdict summary, your words> — report at <dir>/reviews/<id>-2.md"
```

`<verdict summary, your words>` is one line of your own on what the reviewer still objects to — never a quote from the report. The report path sitting beside it
in the same string is the verbatim copy, which is precisely why the entry points at the report rather than carrying it (§4's rule, second half).

Then, **with a channel**, ask: merge anyway, keep fixing, skip, or stop the run — their call, on their repo. **With no channel**, `stage <id> parked` and
continue to the next item, keeping the branch and worktree for them to look at. Never merge unreviewed-through changes silently just because the loop ran out:
"merge anyway" is a decision a person makes, not a default.

**That menu belongs to an unresolved review verdict and to nothing else.** A reviewer's findings are a judgement, and a person is entitled to read the report
and decide they do not block a merge. A failing verification is not a judgement — it is a command that came back red — so when the shared ceiling runs out with
`verify` still failing, this paragraph is _not_ the paragraph that applies: the section below says what happens there, and what happens there is always a park.
Arriving here from `verify` and reading "merge anyway" as still on offer is the one way to talk this system into breaking its own Hard limit, so the offer is
scoped here rather than left to be inferred.

## `verify` exits non-zero (§8)

Exit `0` (merge) and the two "has not finished" cases stay in `SKILL.md` §8; these are the two exits that say something failed.

- **exit `1`** — something is red. Treat the failing rows exactly like review findings: feed them into a fix loop, spent the same way
  (`stage <id> fixing --fix-loop`, then §7's `fix-mode` and whichever launcher it names, commit, re-review). In either mode's prompt file the failing rows —
  each command and its tail — stand where the reviewer's findings would, and a fresh prompt names no report path, because no review asked for this loop. The
  ceiling is the same two loops and it is _shared_ with review — an item does not get two review loops _and_ two verify loops, which is exactly what one counter
  per item, incremented by whoever spends the loop, enforces.

  **When that shared ceiling runs out with verification still red, the item parks — with a channel or without one.** Do not fall through to the section above's
  exhaustion paragraph: its "merge anyway" is an offer about an unresolved review _verdict_, and there is no equivalent judgement to make here. A red command is
  not an opinion.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind fix-exhausted --detail "2 fix loops, verification still red: <the failing command names> — rows in status --json"
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  `<the failing command names>` is the names alone — `pnpm test`, `pnpm run typecheck` — and never their output. The rows in `status --json` carry the output
  and the exit codes, and the detail says so rather than repeating it: captured output is exactly the text §4's rule keeps off a command line.

  With a channel you may still say so and ask whether to keep fixing, skip, or stop the run — three of the four options above. Never the fourth. Never merge red:
  nothing green-lights a merge except the commands passing.

- **exit `5`** — nothing resolvable to verify with: no `verify.json`, no `test`/`typecheck`/`build` script, no fenced `## Done when` command. Nothing was
  written, and this item cannot prove itself. **Park it**:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind parked --detail "nothing to verify with — add backlog/verify.json or a ## Done when block"
  node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> parked
  ```

  Annoying on an unconfigured repo, and correct anyway: "merged, verified by nothing" is the false-done this entire system exists to prevent.

On an exit `1`, read the rows themselves (`status --json`) before spending a loop, because one of them is not what it looks like. A row whose `tail` begins
**`could not run this command (…)`** never executed at all — a missing binary, a command string the OS refused, output too large to capture. It is red like any
other red row and it gates the merge identically, but sending a fix loop after the _code_ over it wastes a session on an item nothing was ever tested against.
Fix the command or the environment, or park the item with `attention <id> --kind parked --detail "a check could not run: <the failing command names> — fix the
command or the environment"`, then `stage <id> parked`. The row's `tail` is the tool's text, not this run's: it stays in `status --json` and never goes in
the detail.
