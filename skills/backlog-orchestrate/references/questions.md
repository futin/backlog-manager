# backlog-orchestrate — deciding an unanswered question (`questionMode: decide`)

Read this file **in full** when §3's open-questions hunt finds a question that goes unanswered — `AskUserQuestion` was unavailable, errored or returned no
answer — and the run's `questionMode` (`status --json` carries it) is `decide`. A `park` run never opens it, and neither does a question that _was_ answered.
The trigger is the found question, so a fresh run and a `--resume`d one reach it the same way: both are in §3's pre-flight when they find one.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
`${CLAUDE_PLUGIN_ROOT}` with the plugin root the body was loaded with before running any command here.

**`questionMode: decide`** → decide each question yourself, then record what you decided:

1. Answer every question, using the item, the repo's `CLAUDE.md`, the `.claude/rules/` files scoped to the files in play, and the code as it actually is.
   Prefer the smallest answer that lets the plan proceed.
2. Write those answers into the item body through the **same** path an answered question takes — "Writing an answer into the item" in `SKILL.md` §3, inside the worktree,
   in step 4. That is what makes the answer ride the branch into the base and show up in the item's own diff, instead of living only in a run file nobody reads.
3. Record the pairs on the queue item, so the archive can answer months later whether this item's plan was written by a human or filled in by the runner:

Write `<dir>/questions/<id>-assumed.json` with the **Write tool**, as the `park` path does for its questions file — an array of `{"question":…,"answer":…}` pairs,
`[{"question":"question one","answer":"what you decided"}]` — and pass it in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" assume <id> --json "<dir>/questions/<id>-assumed.json"
```

Then continue to the loop (`SKILL.md` §4) and dispatch the item like any other. `assume` appends rather than replaces, so a second question decided later in this same
pre-flight does not erase the first. It **exits `1` on a `park` run**, nothing written — the tool enforces this, not this file, because this file is re-read on
every one of a run's several hundred turns and prose drifts across them where a refusal does not. It is the same division of labour `stage <id> merged` under
branch mode already keeps.

**A decided answer is an assumption, and is written as one.** The item body records what was assumed and that the runner assumed it — never phrased as though
a human had settled it. Someone reading that item in six months has to be able to tell the two apart without opening a run file.

(The rule against restating an unanswered question in prose applies to every outcome, `park` included, and so stays in `SKILL.md` §3.)

And one thing `decide` does **not** change: `attention <id> --kind needs-answers` stays legal and stays right under it. `decide` is permission to answer, never
an obligation to invent. A question that genuinely cannot be answered — a plan citing a section nobody wrote, an either/or between two products — still parks
its item, in either mode.
