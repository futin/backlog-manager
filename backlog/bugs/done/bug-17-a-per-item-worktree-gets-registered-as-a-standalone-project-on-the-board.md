---
id: bug-17
title: A per-item worktree gets registered as a standalone project on the board
created: 2026-09-04
tags: registry, worktree, skills
---

## Symptom

`~/.backlog-manager/registry.json` carried a sixth project called `bug-13`,
pointing at
`/Users/andrejajevtic/Documents/custom-projects/backlog-manager/.worktrees/bug-13`
— a per-item orchestrator worktree, registered as if it were a repository of
its own. The board listed it beside the five real projects.

The entry outlived the directory it named: `.worktrees/bug-13` was removed when
that item merged, so by the time anyone noticed, the phantom project pointed at
nothing at all. Nothing in the app could remove it, because the server is
read-only over the registry by invariant and `backlog.mjs` had an upsert but no
removal.

## Repro

1. Let `backlog-orchestrate` create a per-item worktree under `.worktrees/<id>`.
2. Inside that worktree, run anything that upserts the registry — the headless
   `backlog-execute` session filing a follow-up item is the realistic path:
   `backlog.mjs new bugs "..."`, or `backlog.mjs init` on a worktree whose
   `backlog/` has not been created yet.
3. `~/.backlog-manager/registry.json` gains an entry whose `path` is the
   worktree and whose `name` is the item id.
4. Merge the item. The worktree is deleted; the registry entry is not.

## Affects

- `skills/backlog/tools/backlog.mjs:94` — `resolveRoot`, whose `existsSync`
  walk accepts a `.git` file
- `skills/backlog/tools/backlog.mjs:70` — `registerBestEffort`, which passes
  that root straight into the registry
- `skills/backlog-orchestrate/tools/orchestrate.mjs:194` — `linkedWorktreeInfo`,
  the discriminator that already exists for bug-2's version of this problem
- `CLAUDE.md` — the registry single-writer invariant

## Cause

`resolveRoot` walks up to the nearest `.git` and tests it with `existsSync`,
which its own comment says covers "a directory for a normal clone, a file for a
worktree or submodule". A linked worktree therefore resolves to itself.

That resolution is correct and must not change. An execute session running
inside a worktree has to resolve `backlog/` to *that worktree's* copy — the
copy it is editing, the copy that merges. This is the same reason CLAUDE.md
records that `backlog.mjs`'s walk deliberately resolves a worktree to itself
where `orchestrate.mjs`'s refuses one.

The bug is that one consumer of that root wants a different answer.
`registerBestEffort` hands it to the registry unchanged, and the registry
stores absolute host paths that the board, the item-body allowlist and the
orchestrator all key on — none of which a directory deleted at merge time can
satisfy. Same root, two consumers, one wrong.

This is bug-2 seen from the other side. There, a cwd inside a worktree silently
re-keyed a run to the wrong project; the discriminator built to catch it
(`commondir` in the `gitdir:` target, never "`.git` is a file") was exactly what
this seam needed and never got.

## Fix

Map the resolved root through a registry-specific function before writing it,
leaving `resolveRoot` and every other consumer alone:

- not a linked worktree → the root unchanged
- linked worktree with a determinable main tree → the **main tree's** path
- linked worktree with no determinable main tree (bare main repo) → register
  nothing, with the same non-fatal stderr note `registerBestEffort` already
  uses for a failed write

Main tree rather than a flat refusal, because the worktree's items merge back
into it: the main tree IS the project the capture belongs to, and it is almost
always already registered, so the upsert degrades to a harmless name refresh.

The discriminator must be a `commondir` entry in the `gitdir:` target, never
"`.git` is a file" — a submodule working tree is a file too, and must keep
registering as itself.

Separately, the registry needs a removal path. The upsert has no undo, this
tool is the registry's only writer, and the phantom entry proved there is no
supported way to repair one.

Cases the fix must satisfy:

- `linkedWorktreeInfo` returns null for an ordinary clone, non-null with the
  main tree named for a real linked worktree, and null for a **real** submodule
  working tree.
- The mapping returns the root unchanged for an ordinary repo, the main tree
  for a worktree, and the submodule itself for a submodule.
- End to end: `init` **and** `new`, spawned with cwd inside a real linked
  worktree, put the main tree in the registry and the worktree nowhere in it.
- `init` spawned inside a real submodule registers the submodule's own path.
- Removal drops exactly the named entry, leaves the others' `name` and
  `createdAt` untouched, and reports a miss rather than a silent success.

## Outcome

2026-09-04 — fixed as the Fix section describes.

What changed, all in `skills/backlog/tools/backlog.mjs`:

- `linkedWorktreeInfo` — a **second copy** of `orchestrate.mjs`'s function,
  duplicated rather than imported because one skill's `tools/` may never import
  another's (that file's own header states the rule). Verified line-for-line
  identical to the original with comments stripped.
- `registryRoot(root)` — the mapping above. Returns `null` only for a bare main
  repo.
- `registerBestEffort` — maps through it, and treats a `null` as the same
  non-fatal skip it already gives an unwritable registry.
- `unregisterProject(root, file)` plus a `backlog.mjs unregister <path>`
  command. Keyed on an exact string compare against `path`, matching how the
  upsert keys its own insert — so an entry pointing at a directory that no
  longer exists is still removable. Requires the path explicitly: every other
  verb in this tool acts on the repo you stand in, and a bare `unregister` that
  dropped whichever project that happened to be is an accident the registry has
  no undo for. A path that is not registered exits 1, never a silent success.

`resolveRoot` is unchanged, deliberately. `registerProject` stays a pure
registry writer taking an already-correct absolute path, so all four of its
existing tests were untouched.

`CLAUDE.md`'s registry invariant now records what gets written
(`registryRoot(root)`, not the raw root), why remap beats refusal, why the
discriminator is `commondir`, and that `unregister` is part of the same single
writer.

Tests — 14 new in `skills/backlog/tools/backlog.test.mjs`, written before the
code and watched fail. Every fixture drives real git plumbing (`git worktree
add`, `git submodule add -c protocol.file.allow=always`) rather than
hand-rolling a `.git` file, because the entire claim under test is what git
itself writes; the submodule case asserts its `.git` really is a file before
asserting the discriminator ignores that. Mutation-checked: stubbing
`registryRoot` to the identity turns three of them red, including both
end-to-end CLI cases.

Verification:

```
$ pnpm run test:skills
ℹ pass 291
ℹ fail 0

$ pnpm test
Test Suites: 55 passed, 55 total
Tests:       875 passed, 875 total

$ pnpm run typecheck
> tsc --noEmit
```

The stale entry itself was then removed with the new command, against the real
registry: the diff was exactly the four lines of the `bug-13` entry, every other
project byte-identical including `createdAt`.

Not done here, recorded instead: `.worktrees/bug-14` and `.worktrees/runs-archive`
were still on disk from earlier runs. Neither is registered, so neither is this
bug; they are leftover directories, not phantom projects.
