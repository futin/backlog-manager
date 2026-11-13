# Jira Execute Run: review before finishing — design

Status: draft, 2026-11-13. Short design (small change).

## Intent

A Jira **Execute** Run (`composeJiraPrompt` → `executeText`, `server/src/jira/prompt.util.ts`) works a ticket "end to end": read the ticket, implement,
verify, maybe move the ticket to done, commit, and — with **Open MR when done** — push and open one merge request. Nothing reviews the change before it
leaves the session. An item's `--finish pr` execute already does (`skills/backlog-execute/references/pr-mode.md` §7): commit, a grouped `backlog-reviewer`
review through `skills/backlog-review/references/procedure.md`, up to two fix rounds, and a push only on `approve`. The Jira Run should end the same way, so a
ticket's MR (or its local branch) has been reviewed against the ticket before anyone else sees it.

## Goals

- An Execute Run with a branch can end in a local review gate: commit → review → fix rounds → only then the Jira transition and the push/MR.
- A **Review before finishing** switch on the launch sheet's Branch section, beside **Open MR when done**, on by default.
- The review judges the change against the ticket as well as the code (the ticket's text is the review's item).
- Reviewer model and effort come from Settings' `review.json`, as `/backlog-review` and item runs already read it.

## Non-goals

- CodeRabbit / remote MR review — that is `docs/superpowers/specs/2026-11-13-coderabbit-review-design.md`, and on GitLab the MR step already names
  `mr-review-loop`. The two compose: the local gate runs before the push, CodeRabbit after the MR exists.
- A reviewer picker on the Jira launch sheet (item runs have one). Settings is the one control for now.
- Any change to item runs, `/backlog-review` standalone, or execute's `pr-mode.md`.
- Review on the `context` built-in or on skill actions (a skill's prompt is the person's own template).

## Anti-goals

- **The switch off must leave the prompt byte for byte what it is today**, so a person who turns it off, and every old preview, Copy prompt and Run, sees no
  change.
- A Run must never push, open an MR, or move the ticket to done after a review that did not say `approve`.
- No unattended session may stop on a question: the gate never asks before fixing (the standalone `/backlog-review` does, which is why it is not the route).

## Constraints

- `JIRA_PROMPT_MAX` is 4 000 characters and counts the workspace block and the person's edits; the review must cost one short sentence, not the rules.
- Editing `skills/` takes effect only after commit, push and `pnpm run plugin:sync` (CLAUDE.md invariant).
- `review` is a branch-choice field exactly like `openMr`: execute only, never under mode `none` (an Execute Run without a branch is already refused upstream).

## Approaches

| | Approach | Trade-off |
| - | -------- | --------- |
| **A — picked** | The `jira` skill owns a review reference; the prompt adds one sentence pointing at it; `JiraWorkspace` gains `review` and the sheet a switch. | Short prompt, rules live in one skill file, item runs untouched. Needs push + `plugin:sync` to take effect. |
| B | The prompt calls standalone `/backlog-review --base <base>` and spells the fix rounds inline. | No skill change, but standalone asks before fixing (blocks an unattended session) and the rules eat the 4 000 cap and drift from §7. |
| C | Extract execute's §7 into a shared `backlog-review/references/gate.md` used by both. | One copy of the fix-round rules, but it rewrites the item PR path too — a bigger blast radius than this asks for. |

The person picked **A** (2026-11-13), along with "local review" over CodeRabbit and "switch, default on" over always / default off.

## Design

**Shape of the choice.** `JiraBranchChoice` and `JiraWorkspace` (`shared/types.ts`) gain `review: boolean`, carried exactly like `openMr`: the preview query
(`?review=true`), the dispatch body (`review?: boolean`), `parseBranchChoice` (`server/src/jira/branch-choice.util.ts`: `true`/`'true'`/`false`/`'false'`,
anything else a 400 `review must be true or false`; `review` with an action other than `execute` or under mode `none` a 400 `review is only for execute with a
branch`), and the resolved workspace. **Absent is `false` on the server**, so an old client or a hand-built request keeps today's prompt; the client's draft
defaults it to `true`, so the sheet starts on.

**The sheet.** `JiraBranchSection` shows a `Switch` labelled **Review before finishing** beside **Open MR when done**, under the same condition (execute, a
branch mode). The client's `branchChoice` / `branchDispatchFields` / preview query carry it like `openMr` (`client/src/lib/jira.ts`).

**The prompt.** `executeText` with `ws.review === false` (or `ws === null`) is unchanged byte for byte. With `ws.review === true` the order becomes: implement
and verify; commit (`COMMIT_RULE`'s staging rule, without its `Do not push.`); **review with the backlog-manager:jira skill's review reference, against
`<base>`**; and only on its `approve`, the done-transition rule and then the closing rule (push + MR when `openMr`, else `Do not push.`). The base named is
`ws.target ?? ws.base`, and when both are null (a `continue` with no target) the sentence says "against the repository's default branch" and the reference
resolves it. The transition moves after the review because a ticket must not read Done for a change that failed its review.

**The reference** — `skills/jira/references/review.md`, linked from `skills/jira/SKILL.md`. Modelled on `pr-mode.md` §7, mapped onto a Jira Run:

- `tree` — the worktree the workspace block entered; `base` — the base the prompt named, else `origin/HEAD`'s branch, else `main` (standalone
  `/backlog-review`'s §1 resolution); refuse, with nothing reviewed and nothing pushed, when the base is not a local branch.
- `item` — `<tmp>/<KEY>.item.md`: the `jira.mjs show <KEY>` output, written by the session, outside the repo. `outcome` — `none`.
- `mode` — `full`; reports, group reports and manifests under the same `<tmpdir>/backlog-review/<repo key>/` home `/backlog-review` uses, never in the repo.
- `config` — none, so `scope` reads Settings' `review.json`.
- `approve` → back to the prompt's transition and closing rule. `fix` → at most two fix rounds: fix what the findings name, re-run the verification, commit
  the round, re-review through the procedure's re-review branch. Still `fix` after round two, `incomplete`, `"files":0`, red verification, or a `scope` /
  `merge` exit 1 → **stop**: no transition, no push, no MR; the final report gives the findings, the report paths, the tree, the branch, and the exact
  push/MR commands for a person who decides the findings are wrong.
- Every reviewer is waited for inside the same turn, never left running in the background.

**Prompt budget.** The added sentence is fixed text plus the base name; a test measures its fixed part, as the workspace block's is measured today, and the
longest composed execute prompt stays under `JIRA_PROMPT_MAX`.

## Left to the builder

- The exact wording of the prompt sentence and the reference, within the rules above.
- Whether `review` and `openMr` share one guard sentence in `parseBranchChoice` or keep two.
- Test placement follows `.claude/rules/tests.md`; the source guards that pin `JiraBranchChoice` callers are found by `grep -l` before pushing.
- Docs: `docs/subsystems/jira.md` (or wherever the Execute prompt is described) and `.claude/rules/jira.md` gain the `review` field next to `openMr`.
