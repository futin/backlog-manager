# Fresh-session fix loop — design

Groomed from #224 on 2026-09-25. Promoted to a task whose `## Plan` carries the implementation steps; this file is the design those steps implement.

## Problem

`backlog-orchestrate` §7 spends a fix loop by resuming the item's own executor session (`claude -p --resume <sessionId>`, SKILL.md §5's retry line). The fix
therefore inherits every token the execute session read. The 2026-09-24 retro sweep found 62 of 178 headless sessions peaking above 200k tokens, costing $977.80
— 69 % of measured spend — and 26 of the 49 fix sessions were among them. That long-context tier is also billed at a rate the retro's price fit does not model.

## Decisions

This groom ran with no question channel, so each open question from #224 was settled here and is recorded as a named assumption. Any of them can be overturned
by editing this file and the task's plan before the task is executed.

1. **Not wholesale: gate on the resumable session's peak context.** A fix loop resumes when the session it would resume peaked below **150,000** tokens, and
   starts a fresh session at or above that. Resuming keeps the executor's reasoning, which is worth keeping when it is cheap; the bill #224 measured is the
   >200k tier, and 150k leaves margin because a fix loop grows the context it resumes. The number is one named constant in `orchestrate.mjs`, not a flag and not
   an environment variable — SKILL.md's env-var allowlist test exists to stop a knob nothing reads, and a threshold nobody tunes yet is that knob.
   _Assumption A1: 150k is a starting value, to be revisited from the retro split in decision 5._

2. **The decision lives in the tool, not in the driver's arithmetic.** A new read-only verb, `orchestrate.mjs fix-mode <id>`, prints one JSON line naming the
   mode and, for a resume, the session id to resume. The driver copies it; it never compares numbers itself. That keeps the rule testable under `node --test`
   and makes a `--resume`d driver reach the same answer the crashed one would have.

3. **Which session is "the one to resume".** The most recently recorded usage entry of the item — the last `fix` loop if there is one, else the last `retry`,
   else `execute` — by recording order in `item.usage`. So a second fix loop after a fresh first one resumes the first fixer (whose context is small), which is
   the cheapest way to keep the reasoning that produced the current diff. Its `peakContextTokens` decides; its `sessionId` is what gets resumed.
   _Assumption A2: when that entry has no `peakContextTokens` (written before this change, or a transcript with no assistant usage), the mode is `resume` — the
   current behaviour, never a guess in the expensive direction. When it has no `sessionId`, the mode is `fresh`, because there is nothing to resume._

4. **The fresh fixer's context: the findings verbatim, plus pointers — never a pasted diff.** Its prompt file (`<dir>/prompts/<id>-fix-<n>.txt`, the same path
   the resume loop uses, written with the Write tool) carries: the run marker's constraints (unattended, never commit/push/merge, never background a command),
   the reviewer's findings verbatim, the report path, the item file path the reviewer read, the base branch, the instruction to read `git diff <base>...HEAD`
   and the files the findings name before changing anything, the verification commands the item's `## Outcome` lists, and where to append its own
   `### Fix loop <n>` record (the worktree item file's `## Outcome` in a files project; `<dir>/outcomes/<n>.md` in a tracker project). It is not a
   `/backlog-execute` trigger: in a files project execute has already moved the item to `done/`, and execute refuses a done item.
   _Assumption A3: the diff is read by the session, not pasted — a large diff pasted into the prompt is exactly the context this change exists to avoid, and
   the findings name `file:line`, which is what a narrow read needs._

5. **Nothing about `fix` kind or transcript naming changes.** The fresh session writes `<dir>/logs/<id>-fix-<n>.jsonl` / `.err`, is named `orch <id> fix <n>`,
   and `usage` records it as `kind: 'fix', loop: n` exactly as today — identity is the slot, never the session id (`RunSessionUsage` doc comment). What
   distinguishes the two modes afterwards is derivable without a new field: a resumed session keeps the id it was handed, a fresh one does not. The retro
   derives the mode that way and reports **per mode**: loops, direct cost, median peak context, and the verdict of the review pass that follows each loop
   (fix loop `k` is judged by review pass `k + 1`). That split is the measurement #224's first open question asks for.

6. **`watch` keeps overwriting `item.sessionId` with the newest session.** After a fresh loop the item's session is the fixer's. That is the right session for
   `references/recovery.md`'s `resume-session` to resume after a crash — it is the one that last worked the branch — so recovery needs no change beyond saying so.

7. **Retries are out of scope.** #224 suggested the same option for §5's retry after a spend-limit or error end. A retry resumes a session that did not finish,
   whose in-flight reasoning is the thing being retried; a fresh retry is a different design question with different evidence, and folding it in would make
   the retro split in decision 5 measure two changes at once.

## Surfaces touched

- `skills/backlog-orchestrate/tools/orchestrate.mjs` — `readSessionUsage` also returns `peakContextTokens`; new `fix-mode` verb.
- `shared/types.ts` — `RunSessionUsage.peakContextTokens?: number | null`, documented.
- `skills/backlog-orchestrate/SKILL.md` §7 — the fix loop runs `fix-mode` first, then one of two launchers; a third `exec claude -p` line (fresh fixer).
- `skills/backlog-orchestrate/references/recovery.md` — one sentence on `resume-session` after a fresh fix loop.
- `skills/backlog-retro/tools/lib/totals.mjs` and the report text — the per-mode split.
- Tests: `orchestrate.test.mjs` (new verb, peak field, the launcher-count assertions that pin "exactly 2" lines), `retro-lib.test.mjs` / `retro.test.mjs`.

This is a `runner-fix`: it changes `backlog-orchestrate`'s SKILL.md and CLI, so a run hoists it ahead of items that would otherwise be fixed by the old loop.
