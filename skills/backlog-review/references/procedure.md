# The review procedure

The one description of how a change is reviewed: scope → dispatch every group → merge → one coverage retry → result. `/backlog-review`,
`backlog-orchestrate` §7 and `backlog-execute`'s `pr`-mode §7 all follow this file with their own parameters, and none of them describes dispatch itself —
three copies of these steps would drift into three different reviews. Read it in full before the first review of a session.

A reference file is read with the Read tool and never has `${CLAUDE_PLUGIN_ROOT}` filled in: replace it in any command copied from here with the absolute
path the calling SKILL.md's own commands show (the plugin root is the directory that holds `skills/`). Every command below calls the tool as

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs" <subcommand> …
```

## Parameters

The caller fills these in; every `<name>` below is one of them.

| parameter | what it is |
| --- | --- |
| `tree` | absolute path of the tree under review — every git read and every reviewer is scoped to it |
| `base` | the branch the change is measured against (a local branch; the caller has already checked it resolves) |
| `item` | absolute path of the item file, or of a snapshot of it; absent for a review with no item |
| `mode` | `full`, or absent — absent lets `scope` review incrementally from this branch's last complete review when it can |
| `report` | absolute path of the merged report, ending `.md`, outside the repo |
| `group report pattern` | where group `<n>` writes its report: `report` with `.md` replaced by `.g<n>.md` (`merge` reads the group number from that suffix) |
| `manifest path` | where `scope` writes the manifest, beside `report` |
| `config` | the reviewer config: the review flags as given (`--review-mode …`), or `--review-config <json>`, or nothing (then `scope` reads `review.json`) |
| `outcome` | `present` when the item has a `## Outcome` section to read, `none` when it has none (or there is no item) |

## 1. Scope — `review.mjs scope`

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs" scope --tree <tree> --base <base> --out <manifest path> \
  [--item <item>] [--mode full] <config>
```

It prints one JSON line, `{"mode":…,"files":n,"review":r,"skip":s,"groups":g}`, and on stderr the reason a review fell back to full
(`full review: <reason>`). Exit `1` is a bad flag or a git failure, named on stderr: stop and hand that line to the caller — nothing was dispatched.

- **`"noChange":true`** (an incremental scope whose branch has not moved since its last review): stderr carries
  `no changes since the last review (<report path>) — its verdict stands: <verdict>`. Return that sentence to the caller and stop. Nothing is dispatched
  and nothing is merged.
- **`"files":0`** otherwise: the diff is empty. Return that to the caller and stop — what an empty diff means is the caller's call (standalone: nothing to
  review; orchestrate and execute: a failure, since they commit before they review).
- **`"groups":0`** with files: every file was skipped and there is no item and no earlier finding to re-check. Dispatch nothing and go straight to
  §3, with no `--reports`.

Read the groups out of the manifest — only what dispatch needs, never the whole file list:

```bash
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({from:m.from,to:m.to,mergeBase:m.mergeBase,mode:m.mode,config:m.config}));for(const g of m.groups)console.log(JSON.stringify(g))' <manifest path>
```

The first line is the pair every reviewer diffs, the mode and the resolved reviewer config; each group line after it carries `n`, `label`, `files`,
`model`, `effort`, `rerun` and `earlier` (the earlier findings handed to it).

## 2. Dispatch every group in one message

Dispatch one `backlog-manager:backlog-reviewer` per group whose `rerun` is not `false`, **all of them in one message** — one assistant turn holding every
Agent call, so they run in parallel and the review takes as long as its slowest group, not the sum. Never one per turn, and never in the background: wait
for every one inside this turn. Each dispatch carries:

- the five fields the agent requires: `worktree` — `<tree>`; `base` — `<base>`; `from` and `to` — the manifest's; `report path` — the group report
  pattern with this group's `<n>`;
- `group` — `<n> of <N>`, then this group's `files`, one per line;
- `manifest path` — `<manifest path>`;
- `item file path` — `<item>`, when the caller has an item;
- `item checks: yes` — group 1 only, and only when there is an item;
- `earlier findings` — this group's `earlier` entries, each as `<id> — <path>:<line> — <severity>: <text>` (no location for an item-level
  one) with its `anchor:` line, or `none`;
- `outcome: none` — when `outcome` is `none` and there is an item.

Pass the group's `model` and `effort` as the Agent tool's own `model` and `effort` parameters — never as prompt text, where nothing would act on them. A
`null` value is the agent's own default: omit that parameter. A dispatch refused for its `model` or its `effort` (the tool rejects the value) is re-sent
once without the refused field, and step 3 adds `--fallback <n>:model` or `--fallback <n>:effort` for it, so the merged report says which group ran on
what.

Read only each reviewer's returned verdict line, never a report file: `merge` reads the reports.

## 3. Merge — `review.mjs merge`

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs" merge --manifest <manifest path> --out <report> \
  --reports <every dispatched group's report> [--carried <report> …] [--fallback <n>:<model|effort> …]
```

Its stdout is the only part of the review that enters this session's context: one JSON line,
`{"verdict":…,"mode":…,"uncovered":[…],"unanchored":n,"stillOpen":n,"minor":n}`, then one line per Critical/Important finding as
`<path>:<line> — <Severity>: <text>` (earlier findings still open end `(earlier)`). The verdict is `approve`, `fix` or `incomplete`; `merge` computed it,
so never re-derive it from a report. Exit `1` (a bad argument, an unreadable manifest, a report not named `.g<n>.md`) is named on stderr: stop and hand
it to the caller. Do not read the merged report or a group report into context — the one exception is the caller reading the merged
report's `## Minor` section after a person chose to fix Minor findings.

## 4. One coverage retry

When `uncovered` is non-empty, dispatch ONE `backlog-manager:backlog-reviewer` for all the uncovered files together: the same five fields with
`report path` set to `<report>` with `.md` replaced by `.retry.md`, `group` — `retry`, then those files, `manifest path`, and the big pair's model and effort
(the manifest's `config.big`, or `config.same` when its `mode` is `same`) as the Agent tool's parameters. No item checks and no earlier findings: those
stayed with their groups.
Then run `merge` again with exactly the arguments of step 3 plus `--retry <report with .retry.md>`. Its stdout replaces the first one. Still `incomplete`
after that is the result — there is no second retry; the caller says so with the uncovered files.

## 5. Re-review after a fix

Both callers' fix loops, and a standalone re-review after a fix, re-review with the previous round's manifest instead of a fresh partition:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-review/tools/review.mjs" scope --tree <tree> --base <base> --out <new manifest path> \
  [--item <item>] --previous <the latest manifest> <config>
```

`<the latest manifest>` is the manifest of the round just merged (each round gets its own `report`, so its own manifest beside it). `scope` keeps that
round's groups and each group's model and effort, puts any newly changed file in group 1, hands every finding the round left open to a group to re-check,
and marks each group `rerun: true` (group 1, and every group a fix touched) or `false`. Then §2 for the `rerun` groups only, and §3 with the other groups'
latest reports passed as `--carried <report>` — they count for coverage, while their findings come back through the re-run groups as earlier findings —
and §4 if anything is uncovered.

## Result

Hand the caller the last `merge` stdout and `<report>`. What happens next — show it, offer a fix, park an item, refuse a push — is the caller's.
