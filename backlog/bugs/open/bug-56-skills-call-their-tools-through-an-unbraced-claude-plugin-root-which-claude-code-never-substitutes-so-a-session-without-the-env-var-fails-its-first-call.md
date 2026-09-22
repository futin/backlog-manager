---
id: bug-56
title: Skills call their tools through an unbraced $CLAUDE_PLUGIN_ROOT, which Claude Code never substitutes, so a session without the env var fails its first call
created: 2026-09-22
tags: skills, plugin
---

## Symptom

A skill's first tool call sometimes fails with `Cannot find module '/skills/backlog/tools/backlog.mjs'` (or `.../backlog-orchestrate/tools/orchestrate.mjs`): the
`$CLAUDE_PLUGIN_ROOT` in the command expanded to empty. The session then spends turns rediscovering the install — `echo "[$CLAUDE_PLUGIN_ROOT]"`, a `find` over
`~/.claude/plugins/cache` — and hard-codes `PR=<cache path>` for the rest of the run. ~10 s on the Mac; ~2 min on the Linux machine during the 2026-09-22 bug-55
race, long enough that the Linux board's run looked like it never started.

Measured over this machine's transcripts, first plugin-rooted call per session: 22 empty-root failures against 486 working calls since 2026-09-15, on every
Claude Code version from 2.1.268 to 2.1.280, both `sdk-cli` (dashboard-spawned) and `claude-desktop`, whether the skill loaded through the `Skill` tool or was
injected by a prompt. Same project, same day, both outcomes (guide-manager 2026-09-22: 8 fail, 3 ok). Every failure resolved to an EMPTY root — never another
plugin's. It happens on the Linux machine too.

## Repro

Not deterministic. Start several sessions that invoke `/backlog` or the orchestrate trigger; some sessions' first `node "$CLAUDE_PLUGIN_ROOT/skills/..."` call
fails. In one of them, `echo "[$CLAUDE_PLUGIN_ROOT]"` prints `[]` while the skill header reads `Base directory for this skill: <cache>/backlog-manager/0.1.1/skills/<name>`.
Example: `~/.claude/projects/-Users-andrejajevtic-Documents-custom-projects-guide-manager/dd85c89f-f4c1-4090-850a-5996186b6715.jsonl`, 21:32:39 → 21:32:50.

## Affects

- `skills/backlog-orchestrate/SKILL.md` (59 uses), `skills/backlog-groom/SKILL.md` (15), `skills/backlog-execute/SKILL.md` (7), `skills/backlog/SKILL.md` (6),
  `skills/backlog-capture/SKILL.md` (4), `skills/backlog-retro/SKILL.md` (2)
- `skills/backlog-orchestrate/references/recovery.md` (13), `skills/backlog-orchestrate/references/rationale.md` (1)
- usage headers: `skills/backlog/tools/backlog.mjs:7`, `skills/backlog-orchestrate/tools/orchestrate.mjs:17`, `skills/backlog-retro/tools/retro.mjs:17`
- prose that says a run resolves through `$CLAUDE_PLUGIN_ROOT`: `docs/subsystems/skills.md:136`, `docs/workflows/publishing.md:70`,
  `docs/subsystems/invariants.md:712`

## Cause

Every use is the UNBRACED `$CLAUDE_PLUGIN_ROOT`. Claude Code substitutes the BRACED `${CLAUDE_PLUGIN_ROOT}` in a plugin skill's text at load time, so the model
sees an absolute path and the shell never has to know the variable. The unbraced spelling is left alone, and the command then depends on the variable being
exported into the Bash tool's environment, which it only sometimes is. Evidence: guide-manager's `tutor`/`study` skills write `node "${CLAUDE_PLUGIN_ROOT}/bin/register.js"`,
and in every one of 7 transcripts that loaded them the injected skill text holds 0 literal `${CLAUDE_PLUGIN_ROOT}` and the resolved
`guide-manager/0.1.x/...` path instead.

## Fix

Switch every `$CLAUDE_PLUGIN_ROOT` under `skills/` to `${CLAUDE_PLUGIN_ROOT}` so it is rewritten in the text, and add a guard test that fails on an unbraced use
anywhere under `skills/`. Two things to check while doing it: (1) bug-9 — slash-command argument substitution rewrites `$N` in skill bodies; the braced form is
a named variable, not `$N`, but the `nohup env BM_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" …` verify launcher in `skills/backlog-orchestrate/SKILL.md` must still read
correctly once the value is a literal path; (2) the substituted path carries the plugin version (`…/0.1.1`), which matches today's behaviour (a running session
keeps the install it started on, `docs/workflows/publishing.md:70`) but the three docs lines should say "the path the skill text was loaded with", not the env
var. Takes effect only after commit, push and `pnpm run plugin:sync`.
