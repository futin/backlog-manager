---
id: idea-11
title: Path-scoped .claude/rules pointers into the invariant rationale, once headless loading is proven
created: 2026-09-07
tags: docs, claude-code
---

## Problem

CLAUDE.md is now a normative index (d7463d2): each invariant is the rule plus an
anchored `Why:` link, and the reasoning lives in `docs/subsystems/invariants.md`.
A headless `backlog-execute` session, or the reviewer agent, follows that link only
if it chooses to — the reasoning is one hop away at the moment it matters most,
which is when the session is about to "simplify" something a rule forbids.

Claude Code has a tool-triggered alternative: `.claude/rules/*.md` with a `paths:`
frontmatter glob loads only when the session reads a matching file (documented in
the memory page). That is the "pulled only when required" shape this repo wants,
but the docs do not say whether `claude -p` sessions and custom agents
(`agents/*.md`) receive path-scoped rules — and those two are exactly this repo's
consumers. Built on an assumption, the pointers would silently do nothing for the
sessions they exist for.

## Rough shape

1. **Probe first, throwaway.** A rule with `paths: ["server/src/agents/**"]`
   carrying a sentinel sentence; a `claude -p` session told to read a matching
   file and repeat any instruction it was given; the same through a custom agent
   dispatched from a `-p` session; and once from inside a `git worktree add`
   checkout, since per-item worktrees are where execute runs. Record the four
   answers in the item.
2. **If they load:** thin pointer files, one per area — orchestrator, watchdog,
   board, skills — each a handful of lines: "before changing files under X, read
   `docs/subsystems/invariants.md` §A, §B, §C". Pointers only; the prose keeps its
   single copy in invariants.md, so nothing new can drift. `backlog-execute`'s
   contract sweep needs no change because a pointer states no contract.
3. **If they do not load for `-p` or agents:** close this as out-of-scope with the
   probe result as the reason — the interactive-only benefit is not worth a second
   place for a session to look.

## Open questions

- Do path-scoped rules load in `claude -p` sessions and in subagents? The docs
  cover neither; the probe is the whole point of this item.
- Does a rule fire on `Read` alone, or also on `Edit`/`Grep`/`Glob` of a matching
  path? An execute session often edits a file it read a hundred turns earlier.
- Is a pointer measurably better than the `Why:` link CLAUDE.md already carries?
  Worth one comparison on a real item before adding a mechanism.
