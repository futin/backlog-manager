---
id: idea-14
title: Pick an exact versioned model, not a family alias
created: 2026-09-22
tags: launch-sheet, settings, spawn
---

## Problem

`MODELS` in `shared/agent.ts:173` is four family aliases — `opus`, `sonnet`, `haiku`, `fable` — and every picker that reads it (the Launch sheet, the
Orchestrate sheet, both Settings pages, `DEFAULT_MODEL`) can therefore only say "some Opus". Which Opus a run actually got is decided by the host CLI at spawn
time, not by the board, so two runs launched a week apart from the same picked value can be different models and the run file records nothing that would tell
them apart. That makes a retro's cost-per-item comparison across a model bump silently wrong, and it makes "re-run this item on the model it succeeded on"
impossible to express.

The ask is the picker offering an exact, versioned model the way the harness's own recommendation reads — Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5 — with only
the most recent version of each family listed for now, rather than the full historical matrix.

## Rough shape

- Turn `MODELS` from `readonly string[]` into a small record per entry: the `--model` value the dashboard's spawn accepts, a display label, and the family it
  belongs to. `pickFrom` stays a membership test over the accepted values, so its "drop, never reject" contract (`shared/agent.ts`, the comment above it) is
  unchanged — a name this build has never heard of still falls through to the CLI's own default.
- One list, most-recent-per-family, so it stays four rows. The comment on `MODELS` already justifies duplicating the dashboard's list rather than fetching it;
  a versioned list bumps roughly as often as a model ships, which is the same trade with a shorter half-life — worth restating in that comment, and worth
  deciding whether the bump is a manual edit or something `plugin:sync` should notice.
- `DEFAULT_MODEL` becomes a versioned value too, and `test/default-model.test.ts` already pins the three places that carry it literally (the skill dispatch
  lines, the reviewer agent) — those literals have to move together or that test goes red, which is the point of it.
- The eleven `MODELS` callers listed by the blast radius (`LaunchSheet`, `OrchestrateSheet`, `SettingsView`, `lib/settings.ts`, plus tests) render the label
  and submit the value; `clampSettings` keeps validating against the accepted values.
- Worth deciding at groom time: whether an older stored settings value (`opus`) still resolves — either by keeping the aliases as accepted-but-unlisted spawn
  values, or by mapping a stale family alias forward to that family's current entry on read.

## Open questions

- Does the dashboard's `server/lib/spawn.ts` actually accept versioned ids today, or only the four aliases? This whole idea is blocked on that answer — the
  board can only offer what the spawn will take, and `MODELS` exists to mirror that list verbatim.
- Most-recent-only now: do we want the list to grow to older versions later, or is "one row per family, always current" the permanent shape? The two lead to
  different data structures.
- Should a run file record the resolved model id at spawn time regardless of this change? That is the part a retro actually needs, and it may be worth doing
  on its own even if the picker stays alias-only.
