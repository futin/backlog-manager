---
id: ref-4
title: styles.css comment claims --magenta has no job on this screen, but the capture dispatch control reads it
created: 2026-09-15
kind: chore
tags: css, theme, docs-accuracy
updated: 2026-09-17T12:14:56Z
promoted-to: task-42
groom-elapsed: 344
groom-tokens: 64465
---

## What exists today

`client/src/styles.css:678-683` carries this comment above the column-tick rules:

> `--magenta`: the only named hue in the palette with no job on this screen (its
> documented owner, the Task-subagent marker, belongs to another app sharing
> `theme.css`) and one of the few defined in all five themes.

The claim is false. `var(--magenta)` has five uses in that file, and only one is the
column tick the comment sits above:

| line | rule |
|---|---|
| `:685` | `.board-col-refactors .board-col-tick` — the tick, the one use the comment accounts for |
| `:1490` | `.dispatch-tab.capture` |
| `:1493` | `.dispatch-tab.capture:hover` |
| `:1497` | `.dispatch-chip.capture` |
| `:1503` | `.dispatch-chip.capture:hover` |

Four of the five are the **capture** dispatch control — the tone that marks the one
action an out-of-scope item can derive (`deriveAction` returns `capture` for an
out-of-scope item by SECTION, per the dispatch invariant in `CLAUDE.md`). So `--magenta`
is not unused on this screen; it is the identity colour of a control the board relies on.

Nothing misbehaves at runtime, which is why this is a chore and not a bug: the rules are
correct, the rendering is correct, and only the comment is wrong.

## Why it should change

This is not a cosmetic inaccuracy — it has already propagated twice.

The front-end redesign spec (`docs/superpowers/specs/2026-09-15-fe-redesign-design.md`)
repeated the claim, and it was written into `.claude/DESIGN.md` §8.2 as "`--magenta`
keeps no job on this screen". The whole-branch review of that document caught it by
counting the token's uses in source rather than trusting the prose, and §8.2 now records
the capture control's tone correctly (`bc955c2`). The comment that started the chain is
still in the stylesheet, so the next reader who trusts it reaches the same wrong
conclusion — and the redesign's own §8.2 now contradicts it directly.

There is a second, sharper reason. The redesign moves the refactors column tick from
`--magenta` to `--amber` (the new category ramp: refactors `--amber`, ideas `--mustard`,
bugs `--red`, tasks `--green`). Once that lands, `:685` is gone and the capture control
becomes `--magenta`'s *only* remaining use. A comment saying the token has no job, sitting
in a file where its only job is about to be the sole one left, is exactly the setup for
someone deleting the token from `theme.css` and silently unstyling the capture chip across
all five themes.

This repo's `CLAUDE.md` states that comments explain *why* and that the existing density is
deliberate. A comment asserting a falsehood about the codebase costs more than no comment,
because it is trusted at the density the rest of them have earned.

## Rough shape

Rewrite the comment at `client/src/styles.css:678-683` to say what is true: `--magenta` is
the capture dispatch control's tone (`.dispatch-tab.capture` / `.dispatch-chip.capture`),
and it is additionally used for the refactors tick until the category ramp moves that tick
to `--amber`. Keep whatever remains accurate — the note that the hue is defined in all five
themes, and the `--proj-8` adjacency argument, both still hold.

Two things worth doing in the same pass:

- Check whether the "documented owner, the Task-subagent marker, belongs to another app
  sharing `theme.css`" clause is still true of the sibling app, or is itself stale. It is
  the part of the comment that made the false claim sound researched.
- Grep for the same assertion elsewhere. It reached a spec and a design document from here;
  it may have reached other prose too.

Do not change any rule — this is a comment fix. If the category-ramp work (the redesign's
§8.2) lands first, fold this into it rather than doing it twice.
