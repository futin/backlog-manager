# backlog-orchestrate — deciding an unanswered question (`questionMode: decide`)

Read this file **in full** when §3's open-questions hunt finds a question that goes unanswered — `AskUserQuestion` was unavailable, errored or returned no
answer — and the run's `questionMode` (`status --json` carries it) is `decide`. A `park` run never opens it, and neither does a question that _was_ answered.
The trigger is the found question, so a fresh run and a `--resume`d one reach it the same way: both are in §3's pre-flight when they find one.

Section and step numbers below name sections of `SKILL.md`. A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace
`${CLAUDE_PLUGIN_ROOT}` with the plugin root the body was loaded with before running any command here.

**`questionMode: decide`** → research first, decide everything a follow-up commit can undo, and stop only for one of the five reasons in part 3. Then record
what you decided. The three parts run in order for every question the hunt found.

**`park` is untouched by all of it.** A `park` run never opens this file: it records every unanswered question verbatim and stages `needs-answers`, exactly as
`SKILL.md` §3 says. A person who picked `park` picked it to see every question, and narrowing that silently would break the one promise the mode makes — so
the research step, the decide-or-stop split and the five reasons below apply under `decide` only.

## 1. Research before treating anything as a question

Before deciding or parking, look for the answer where it may already be written down: the item body and its comments (tracker: the issue comments `show`
returns), the PRs and issues it links, the repo's `CLAUDE.md`, the `.claude/rules/` files scoped to the files in play, `docs/`, and the code as it actually is.

**A question the record already answers is not a question.** Write that answer into the item through the same path as part 2 below, citing where it came from
(the file and section, the comment, the PR), and record **nothing** with `assume` for it: it was found, not assumed, and listing it among the assumptions would
send a reviewer to re-check a decision nobody made.

## 2. Decide and record anything a follow-up commit can undo

The class this covers is wide on purpose — most questions a plan leaves open are in it: a name; which existing helper to reuse; the test strategy; where a
guard lives; the shape of an internal error; copy inside a UX that is already agreed; the smaller of two scopes the item allows. A wrong answer to any of
these costs one follow-up commit, which is less than a parked item and a re-run. Prefer the smallest answer that lets the plan proceed.

1. Answer every such question, using what part 1 found and the code as it is.
2. Write those answers into the item body through the **same** path an answered question takes — "Writing an answer into the item" in `SKILL.md` §3, inside the
   worktree, in step 4. That is what makes the answer ride the branch into the base and show up in the item's own diff, instead of living only in a run file
   nobody reads.
3. Record the pairs on the queue item, so the archive can answer months later whether this item's plan was written by a human or filled in by the runner.

Write `<dir>/questions/<id>-assumed.json` with the **Write tool**, as the `park` path does for its questions file — an array of `{"question":…,"answer":…}` pairs,
`[{"question":"question one","answer":"what you decided — not the alternative, because the reason"}]` — and pass it in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" assume <id> --json "<dir>/questions/<id>-assumed.json"
```

**The array is ordered: the decision the owner is most likely to overrule first, the safest last.** The run drawer renders it in that order, so the order is
the ranking — there is no rank field, and the `{ question, answer }` shape does not change. Each `question` is the question as the item words it. Each `answer`
is one line in the shape `<choice> — not <alternative>, because <reason>`: the choice, the alternative it beat, and why — so a reviewer can overrule it without
reconstructing what else was on the table.

**All of one item's decisions go into ONE `assume` call**, so the order holds. `assume` appends rather than replaces, so a question found later in this same
pre-flight goes in a second call that lands after the first. The ranking therefore holds within one call, not across calls: a second call's entries are
ranked among themselves and sit after the first call's, whatever their risk — read the array that way rather than as one ranking.

Then continue to the loop (`SKILL.md` §4) and dispatch the item like any other. `assume` **exits `1` on a `park` run**, nothing written — the tool enforces
this, not this file, because this file is re-read on every one of a run's several hundred turns and prose drifts across them where a refusal does not. It is
the same division of labour `stage <id> merged` under branch mode already keeps.

**A decided answer is an assumption, and is written as one.** The item body records what was assumed and that the runner assumed it — never phrased as though
a human had settled it. Someone reading that item in six months has to be able to tell the two apart without opening a run file.

## 3. Stop only for one of five reasons

Under `decide`, stage `needs-answers` for a question only when it hits one of these five reasons, numbered as here and in this order:

1. **Irreversible, or acts outside the repo** — data deletion, a production write, anything sent to a person.
2. **Contradicts the item, a recorded decision or the repo's rules** — a recorded decision being a spec, a decision log or an earlier answer on the item. A plan
   citing a section nobody wrote is this reason: the plan contradicts the record it points at.
3. **Wrong premise** — it does not reproduce, it is already fixed, or the evidence says the ask makes things worse.
4. **A product fork that no document settles and users would notice** — an either/or between two products is the plain case.
5. **A step only the owner can take** — a credential, an account, an approval, a purchase.

**Anything not on the list is decided** (part 2). `decide` is permission to answer, never an obligation to invent: `attention <id> --kind needs-answers` stays
legal and stays right under it, and the five reasons are exactly where it is right.

**An item mixing both kinds parks whole.** If any one of its questions hits a stop reason, the item stages `needs-answers` and nothing else happens to it:
nothing is written into the item, because answers are only ever written in the step-4 worktree and a parked item never reaches step 4; and nothing is recorded
with `assume`, because no plan ran on those answers. The answers you would have chosen for its decidable questions are not lost — they go into the parked
questions file as context, each one marked as the runner's recommendation, after the question that stopped the run — so the owner answers once and the next
run has everything.

**A question parked under `decide` is self-contained, in plain words.** Write `<dir>/questions/<id>.json` with the **Write tool**, as `SKILL.md` §3's `park`
path does, but each stopping entry is not the item's raw question: it is a rewrite a person can answer cold, from a phone — the scenario in one sentence, what
the user sees under each option, the recommendation first, and which of the five reasons stopped the run. Then park with the `--detail` that names the reason,
one of these five fixed strings and nothing else:

- reason 1 — `--detail "stop reason 1 — irreversible or outside the repo"`
- reason 2 — `--detail "stop reason 2 — contradicts the item, a recorded decision or the rules"`
- reason 3 — `--detail "stop reason 3 — wrong premise"`
- reason 4 — `--detail "stop reason 4 — a product fork no document settles"`
- reason 5 — `--detail "stop reason 5 — a step only the owner can take"`

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" attention <id> --kind needs-answers --detail "stop reason 4 — a product fork no document settles" --questions-json "<dir>/questions/<id>.json"
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-orchestrate/tools/orchestrate.mjs" stage <id> needs-answers
```

The strings are fixed so that nothing the run composed reaches published text: on a tracker project every `attention` call comments on the issue, so
`--detail` is published (`references/tracker.md` §3), and the rewritten questions travel in the questions file, never on the command line. When more than one
question stops the item, the detail names the lowest-numbered reason among them; the questions file names each one's own.

(The rule against restating an unanswered question in prose applies to every outcome, `park` included, and so stays in `SKILL.md` §3.)
