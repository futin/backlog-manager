# Review 2 — `docs/superpowers/specs/2026-10-24-groom-pr-and-auto-merge-design.md`

Reviewer: fresh subagent (Fable 5.1), round 2, 2026-10-24. Scope: the spec at commit `92dc0f9` (297 lines). Round 1's report is
`2026-10-24-groom-pr-and-auto-merge-design-review-1.md`; everything it raised that `git diff HEAD~1 -- docs/superpowers/specs/` fixes is not re-reported.

## Verdict: APPROVE WITH FIXES

No Critical. Three Important, all in the groom `pr` flow on a tracker project — ordering and ids that the prose leaves to the reader where the code (claim
protocol, `plan-review` label) makes the order and the id matter. Everything else checked out against the code.

### Round-1 status

- C1 (wait semantics) — fixed (:178–192 now one bounded foreground wait, 45 min, Bash 10-min cap acknowledged).
- C2 (`autoMergeAllowed` field) — fixed (gone; `gh api repos/{owner}/{repo} --jq .allow_auto_merge` at :170, verified a real field on the REST repo object).
- I1 (Refs #<n> on a promote) — fixed (:121–124 names the new task's number).
- I2 (killed groom tree blocks ticks) — fixed (:139–145 `isSkippedTree` + `groomTaken`; matches `skills/backlog-tick/tools/tick.mjs:531–538`).
- I3 (files project always gets a PR) — fixed (step 7, :125–127).
- I4 (execute on MERGED) — fixed (:187–188).
- Unfixed round-1 Minors carried below (M1–M3).

## Important

**I1 — :102, :108–110, :115–121 — where the groom's `stop` sits on a tracker project is unstated, and the two orderings given contradict each other.**
:102 keeps the groom's own order "pick, claim, brainstorm, plan, write the item, `stop`" and :109 says `stop` runs in the tree; but :115–116 and :121 move
the tracker item write (`new … --from` / `body`) AFTER commit and push. Read literally, `stop` (the claim release) runs before the issue write. The groom
skill's own rule forbids that: `skills/backlog-groom/SKILL.md:72` — "run `stop` only after `body` exits `0`" — because a refused `body` must keep the claim
for the retry, and a release means a second `start` and a second claim comment on the issue that is never deleted. Nothing on the server requires a live
claim for the write itself (`server/src/items/sources/github.source.ts:811–833` checks only `ifUpdatedAt`), so a wrong order fails silently, not loudly.
→ State the tracker order in step 6 explicitly: `git push` → `new`/`body` (with `--plan-review`) → `stop <id>` (plain) → `gh pr create` → the auto-merge
procedure; and reword :102 so "`stop`" is "release the claim, at the point each source's step says" rather than last-before-commit. On a files project the
order of :102 stands (`stop` rewrites the item file — it removes `started:` and re-stamps `groomed-at:`, SKILL.md:414 — so it must run BEFORE the commit of
step 5, which the spec should also say, or the committed item carries a `started:` line).

**I2 — :125–127 with :116 and :154 — step 7 on a tracker project never says the issue is still written.** Step 4 defers a tracker groom's issue write to
after the push (:115–116). Step 7 then covers "a tracker groom that wrote no spec" and says "end as today". With no commit there is no push, so the deferred
write has no trigger in the text — yet :154 assumes it happens ("writes no mark"). A bug's plan-the-fix with no spec is the COMMON tracker case (a spec is
written only for the "project with a written design" size, :112–113), so the most frequent path through this flow is the one with no stated write.
→ Make step 7 explicit for a tracker: write the issue as an in-place groom does (`body`/`new` with no `--plan-review`, no `blob/<sha>` — the plan cites
nothing that is not already on `<base>`), run `stop`, then remove the tree and branch. Say that the `--if-updated-at` retry rule (SKILL.md:66–72) applies in
the tree exactly as in the main checkout.

**I3 — :187, :149–150 — `backlog.mjs plan-review <id> off` on a promote names the wrong item.** The mark is written by `new … --from <id> --plan-review`
(:116, `skills/backlog/tools/backlog.mjs:2193–2194`), so it sits on the NEW task, `#<n>` of :122–123, not on the `<id>` the groom was started with (the
idea or refactor, which the promote closes). `plan-review <id> off` on the closed original is a no-op or a refusal, and the new task stays gated behind a
label nobody is told to remove — exactly the "approved-looking plan with no way through" the mark exists to prevent, inverted. :150's hand instruction
("gives the `plan-review <id> off` command") has the same ambiguity.
→ Spell the id in both places as "the issue that holds the plan — the new task's number on a promote, the bug's own on a bug", the sentence :122–123
already uses for `Refs`.

## Minor

- **M1 (round 1, unfixed) :185–186** — "the Bash tool caps a call at 10 minutes" is the dashboard's default, not a constant: `pending.ts:45–48, 69–73`
  clamps the per-call window to 5 s–30 min with 10 min default (round 1 cites). Say "the spawn's per-call cap (10 minutes by default)".
- **M2 (round 1, unfixed) :225–226** — `composePrompt` joins with a single space (`server/src/agents/prompt.util.ts:35`), so an old-tab groom body ends in
  `" " + COMMIT_RULE`. Stripping "one exact trailing `COMMIT_RULE`" leaves the space, and appending ` ${clause}` yields a double space. Say "trailing
  `COMMIT_RULE` and the whitespace before it", or the "byte-identical to today's" promise at :224 fails on an old tab.
- **M3 (round 1, unfixed) :120** — `docs(groom): <item title>`: the PR title check is the first commit line, and a long item title is fine for the
  `pr-title` regex but the builder should cap it (72 chars is the git convention this repo keeps for commit subjects).
- **M4 :174–175** — "If GitHub reports nothing is pending … `gh` merges directly" understates it: `gh pr merge --auto` merges at once when
  `mergeStateStatus` is CLEAN, HAS_HOOKS or UNSTABLE — UNSTABLE includes checks still running that are not REQUIRED. On a repo with no required checks the
  PR merges before CI finishes and `--fix` can never run. The spec already leaves the confirmation to the builder (:296); note the "no required checks"
  consequence there so the reference file states it.
- **M5 :243, :251** — "Execute default finish" is not the row's name: `client/src/components/settings/SettingsView.tsx` names it `Execute finish`. Quote
  the row as it reads, and name the new one `Groom finish` to match.
- **M6 :129, :271 (pr-mode §9 "the worktree stays")** — the groom tree is left in place after the merge, and `groomTaken` (:143) excludes the item while
  `.worktrees/groom-<id>` exists. After a merged groom the item is groomed (bug) or closed (promote), so no tick wants it — but after a PR closed WITHOUT
  merging the item is still ungroomed and now invisible to every tick until a person removes the tree. Worth one sentence in the final message (:129)
  or in :297's collision rule.
- **M7 :125–127** — on a files project a rejection or an out-of-scope move is a diff (a file moved), so by step 5's rule it gets a PR. Fine, but say so;
  today "Groomed on disk only" is deliberately not printed for a rejection and a reader may assume the same of the PR.
- **M8 :253** — a remote execute launch carries `--auto-merge`/`--fix` only inside the prompt's clause (`spawnInProject`, `agents.service.ts:532–541`), so
  the REMOTE machine's installed plugin decides what the tokens mean; an older plugin ignores them silently (pr-mode §1: "`--finish pr` is the one signal").
  One line: the flags need the plugin synced on the machine that runs them.
- **M9 :130, :264** — `skills/backlog/tools/backlog.test.mjs` pins `backlog-groom`'s closing "Groomed on disk only" line and its stamp order (rule
  `.claude/rules/tests.md`, "Cases that pin a skill's prose"); the SKILL.md edits for the `pr` exception must keep those sentences or extend the pins.
  `orchestrate.test.mjs`'s `RULES` needles may pin "only skill that merges" in the orchestrate body too (:261). Add both suites to "Tests the builder owes".
- **M10 :283** — `trackerGroomCandidate` (`tick.mjs:597–605`) takes no `root`; `groomTaken` needs one. Builder detail, but the spec's twin claim implies the
  signature changes for the tracker half.

## Checklist notes

1. **Facts** — verified: rule 2 and 5 scope and order (`agents.service.ts:430–457`), remote execute-only rule (:419–421), `finishClause` text
   (`shared/agent.ts:936–939`), `composePrompt` (`prompt.util.ts:26–36`), `COMMIT_RULE` (:924–927), `FINISH_FLAG` (:878), `backlog.mjs` `--plan-review` on
   `new`/`body` (2193–2194, 2244) and the `plan-review <id> on|off` verb (2191, 3718), `isSkippedTree`/`executeTaken`/`startedMarker`
   (`tick.mjs:505–538`), `planReviewBlock` after `inReviewBlock` in dispatch, orchestrator's `plan-review` parse (`orchestrate.mjs:1330–1368`), pr-mode §1,
   §2, §8, §9 contents and numbering, execute's `stop --keep-started` after push (§8), `Switch` and `clampSettings`/`pickOne` in the client, `gh api`
   placeholders and `gh repo view --json` merge-method fields. The `gh` direct-merge behaviour (M4) is the one external fact the spec itself defers.
2. **Contradictions** — I1 (two orderings of `stop`), I3 (`<id>` vs `<n>`). Example values otherwise agree with the rules.
3. **Edge cases** — empty: step 7 (I2); duplicate: a stale claim on retry (I1); old stored data: old-tab `COMMIT_RULE` strip (M2), `prFixDefault` without
   `prAutoMergeDefault` handled (:246); concurrency: tick vs board groom-pr handled by `groomTaken`, execute at `<base>` unaffected; external failure:
   `gh` refusal, not-allowed, closed-without-merge, wall clock all stated; PR closed without merge leaves the tree (M6).
4. **Copy** — M5; the `finish mode:` line and the `auto-merge: not allowed …` line are stated verbatim; the sheet note is left to the builder (:294).
5. **Scope** — non-goals at :53–64; nothing in scope depends on a non-goal; remote groom finish is refused, not deferred.
6. **Hard rules** — the two invariants the spec changes are named with their rule-file homes and the `claude-rules` guard (:257–264); "the server never writes
   git", "dispatch derives the action", the tick's one-writer and never-merges rules, and the claim protocol are untouched — I1 is the one place the text
   as written would breach a skill rule (SKILL.md:72) by omission.
