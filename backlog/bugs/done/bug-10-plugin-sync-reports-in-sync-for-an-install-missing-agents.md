---
id: bug-10
title: plugin:sync reports in sync for an install missing agents/
created: 2026-09-01
tags: plugin, sync, agents
updated: 2026-09-02T08:19:11Z
groom-elapsed: 115
started: 2026-09-02T08:13:27Z
execute-elapsed: 344
---

## Symptom

`pnpm run plugin:sync` prints `in sync — installed v0.1.1 is <sha>, same skills
as the working tree` and returns without doing anything, for an install whose
`agents/` directory does not exist at all. The message is true as written and
misleading as read: the skills really are identical, and the reader takes that
sentence to mean the *install* is current.

The practical consequence is that adding `agents` to a machine's `sparsePaths`
can never take effect through the normal path. The sync is the only supported
way to reinstall, and it declines to reinstall precisely because the one path
it inspects has not moved — so the newly-permitted `agents/` is never fetched,
and `backlog-manager:backlog-reviewer` stays unresolvable however many times
the sync is run.

Observed while orchestrating task-4..task-9 on 2026-09-01: the reviewer agent
`backlog-orchestrate` dispatches before every merge did not exist, all four
reviews had to be run through a general agent pointed at
`agents/backlog-reviewer.md`, and the sync could not fix it.

## Repro

1. Ensure the working tree and `origin/main` agree and `skills/` is clean, so
   the sync has no other reason to act.
2. Remove `agents` from this marketplace's `sparsePaths` in
   `~/.claude/plugins/known_marketplaces.json`, then reinstall so the install
   genuinely lacks `agents/`. (A sync run performed while `sparsePaths` lacks
   `agents` reaches this state on its own — that is how it was first hit.)
3. Add `agents` back to `sparsePaths`.
4. `pnpm run plugin:sync`.

Actual: `in sync — …, same skills as the working tree`, exit 0, nothing
installed. `ls "$INSTALL/agents"` still reports no such directory, and
repeating step 4 never changes that.

Expected: the sync notices the install is missing a published path and
reinstalls.

The forced sequence the script itself uses does work, which is what confirms
the short-circuit is the whole of the problem rather than a marketplace or
sparse-checkout fault:

```
claude plugin marketplace update backlog-manager-marketplace
claude plugin uninstall backlog-manager@backlog-manager-marketplace
claude plugin install  backlog-manager@backlog-manager-marketplace -y
```

## Affects

- `scripts/sync-plugin.mjs:139-145` — the short-circuit. `hashTree` is called
  on `join(REPO_ROOT, 'skills')` and `join(install.installPath, 'skills')`
  only; `.claude-plugin` and `agents` are never hashed on either side, so no
  difference in them can be seen.
- `scripts/sync-plugin.mjs:41` — `PUBLISHED_PATHS = ['skills',
  '.claude-plugin', 'agents']`, the list the same script uses for its dirty
  check at line 153 and quotes in its own blocker message at line 87. The two
  lines disagree about what the publish surface is, and only the digest is
  wrong.
- `CLAUDE.md:207-215` and `docs/invariants.md:135-145` — both record that an
  install carries only what `PUBLISHED_PATHS` and `sparsePaths` *both* name,
  and that the repo controls only the first. Neither records that the sync
  cannot act on a change to the second, which is what makes the invariant hard
  to satisfy in practice.

## Cause

Two independent causes, one per finding the capture left open.

**1. The short-circuit measures one third of the publish surface.** Lines
140-141 hash `<repo>/skills` against `<install>/skills` and nothing else;
line 143 pairs that with `install.gitCommitSha === head` and returns. Because
`agents/` is never hashed on either side, an install with no `agents/`
directory at all is byte-for-byte indistinguishable from a complete one.
`PUBLISHED_PATHS` (line 41) already names all three paths and is already used
correctly for the dirty check at line 153, so the digest is the single line
that disagrees with the rest of the script.

The commit check cannot cover for it, which is why this is a real gap rather
than redundancy: `gitCommitSha` records which commit the install was cloned
from, not which paths the sparse checkout actually wrote out of it. The same
sha legitimately produces an install with `agents/` or without it, depending
entirely on machine-local `sparsePaths`. Nothing in the install record
distinguishes the two.

Measured 2026-09-02: `diff -r` is clean between the repo and the install for
all three of `skills`, `.claude-plugin` and `agents`, so hashing all three
introduces no standing drift — the fix cannot turn the short-circuit into a
reinstall-on-every-run loop.

**2. The `sparsePaths` reversion is Claude Code's own config reconcile — not
this script, and not `claude plugin marketplace update`.**
`~/.claude/plugins/known_marketplaces.json` is a *materialized cache*. The
declaration it is built from is `~/.claude/settings.json` →
`extraKnownMarketplaces["backlog-manager-marketplace"].source.sparsePaths`,
which still reads `[".claude-plugin", "skills"]` and has never had `agents`
added to it.

Claude Code 2.1.250 reconciles cache from declaration on session start (the
startup path that logs `Installing N marketplace(s) in background`, and the
headless plugin-install path alongside it). For every declared marketplace it
deep-compares the declared `source` object against the materialized one; any
difference at all classifies the entry `sourceChanged` and re-materializes it
**from the declaration**, which re-runs
`git sparse-checkout set --cone -- <declared paths>` in the marketplace clone.

So hand-editing `known_marketplaces.json` does not merely fail to persist —
it is precisely what *triggers* the revert, on the next session start, started
from any project. The edit makes cache and declaration disagree, and the
reconciler resolves every disagreement in the declaration's favour.

Evidence on this machine, all consistent with that mechanism and with nothing
else:

- install record `installedAt 2026-09-01T18:41:23Z`, and the install copy does
  carry `agents/backlog-reviewer.md` (mtime 20:41 local) — the edit worked
  while it lasted.
- the marketplace clone was re-sparsed at 18:44:00Z (clone dir mtime 20:44
  local, three minutes after the install, matching the entry's `lastUpdated`)
  and now has no `agents/` at all; its `.git/info/sparse-checkout` lists only
  `/.claude-plugin/` and `/skills/`.
- the live `known_marketplaces.json` and all three
  `known_marketplaces.json.bak-*` snapshots show the two-path list.
- corroboration: `guide-manager-marketplace` declares four paths
  (`.claude-plugin`, `skills`, `bin`, `assets`) in that same settings block,
  and its cache entry has carried all four unchanged since 2026-08-28. A
  declared path persists; an undeclared one cannot.

The install is currently ahead of the clone — it has `agents/`, the clone does
not — so the next reinstall through any route drops the agent again until the
declaration is fixed.

What this means for the invariant: `CLAUDE.md` and `docs/invariants.md` both
point at `known_marketplaces.json` as "the marketplace's own `sparsePaths`
(machine-local)". That file is the cache, not the control. The lever is
`extraKnownMarketplaces` in `settings.json`, and once `agents` is declared
there the reconciler drives both the cache and the sparse checkout to match it
without anyone editing either.

## Fix

The judgement call the capture deliberately left open, decided here: **the
script reads the declaration and reports on it; it never writes machine-local
state.**

Two reasons, and the second is the one that settles it. Writing
`known_marketplaces.json` is guaranteed transient — that file is the cache the
reconciler overwrites, so writing it *is* cause 2, performed deliberately.
Writing `settings.json` would mean a repo script editing the user's own
config, and the declaration legitimately lives at any of several tiers (user,
project, local or managed settings, or `--sparse` on
`claude plugin marketplace add`), so the repo cannot know that the tier it can
see is the tier that governs. Detection plus a post-install hard failure that
names the exact key makes the invariant self-diagnosing without crossing that
boundary at all.

Four changes to `scripts/sync-plugin.mjs`:

1. **Digest the whole publish surface.** Replace the two single-path
   `hashTree` calls with a pair of exported pure helpers — one that maps
   `PUBLISHED_PATHS` to per-path digests for a given root, and one that takes
   two such maps and returns the paths whose digests differ, in
   `PUBLISHED_PATHS` order. `hashTree` already returns `''` for a missing
   root, so an absent `agents/` surfaces as drift with no separate existence
   check: one mechanism covers both of the first two options the capture
   listed. Short-circuit only when that drift list is empty *and*
   `install.gitCommitSha === head`.
2. **Both messages name what was compared.** In sync: name the paths that
   matched, not "same skills as the working tree". Proceeding: name the paths
   that drifted, so the reason for a reinstall is legible before it starts.
3. **The post-install verification checks the same list** (it currently
   re-hashes `skills` alone, line 189), and its failure message becomes the
   diagnosis. A reinstall that completes and *still* lacks a published path is
   the sparse-checkout shortfall by elimination, so the message must name
   `~/.claude/settings.json` →
   `extraKnownMarketplaces.<marketplace>.source.sparsePaths`, state that
   `known_marketplaces.json` is a reconciled cache whose edits are reverted on
   the next session start, and exit non-zero. This is the load-bearing half of
   the fix: it converts "the reviewer agent silently is not there" into a red
   sync that says which file to edit.
4. **A read-only pre-flight warning before the uninstall.** If
   `~/.claude/settings.json` parses and declares this marketplace with a
   `sparsePaths` array that does not cover `PUBLISHED_PATHS`, print a warning
   naming the missing paths and the full key, then continue. Warn, never
   refuse: the file the script can read is one tier of several, and a machine
   declaring at another tier — or declaring no `sparsePaths` at all, which
   clones the full repo and is perfectly correct — must not be blocked by a
   check that cannot see it. Step 3 remains the authoritative one. Its
   placement before the uninstall is only so the actionable line is not buried
   under install output; it must never be able to abort between the uninstall
   and the install, which is the window that leaves the machine with no plugin.

**Tests** — `scripts/sync-plugin.test.mjs`, `node --test` via
`pnpm run test:skills`, alongside the existing `publishBlocker` and `hashTree`
cases, which stay as they are:

- identical digest maps produce an empty drift list.
- an install missing `agents` entirely (digest `''` against a non-empty repo
  digest) is reported as drifted — the bug's exact case, and the one that
  fails against today's code.
- a differing `.claude-plugin` is reported too, and when more than one path
  differs they come back in `PUBLISHED_PATHS` order.
- the per-root digest helper keys every entry of `PUBLISHED_PATHS` over a
  fixture root, including one that does not exist on disk (value `''`).
- the `sparsePaths` pre-flight helper — pure, taking a parsed settings object
  and a marketplace name — returns the missing paths for
  `[".claude-plugin", "skills"]`, empty for a declaration listing all three,
  empty for a declaration carrying no `sparsePaths` key at all (full clone),
  and empty for absent settings or an absent marketplace entry.

**Docs.** `CLAUDE.md`'s "`agents/` is part of the plugin's publish surface"
invariant and `docs/invariants.md:135-145` both name
`known_marketplaces.json` as the machine-local half. Correct both: the
declaration is `extraKnownMarketplaces` in `~/.claude/settings.json`, the
cache is `known_marketplaces.json` and is reconciled from it on session start,
and the sync now measures every entry of `PUBLISHED_PATHS` and fails loudly
when an install comes up short.

**One manual machine step, outside the repo and not something any code change
here can do:** add `"agents"` to
`extraKnownMarketplaces["backlog-manager-marketplace"].source.sparsePaths` in
`~/.claude/settings.json`, start a Claude Code session so the reconcile
re-sparses the clone, then run `pnpm run plugin:sync`.

**Verification.** `pnpm run test:skills` green. Then, against the real
install: remove `agents/` from the install copy by hand and confirm
`pnpm run plugin:sync` no longer reports "in sync" but names `agents` and
reinstalls; confirm `ls "$INSTALL/agents"` shows `backlog-reviewer.md`
afterwards; restart Claude Code and confirm
`backlog-manager:backlog-reviewer` resolves as a dispatchable agent. No
browser check applies — none of this is visible in the board.

## Outcome

2026-09-02 — fixed as planned, in `scripts/sync-plugin.mjs`, plus the doc
correction both halves of the cause called for. Nothing in the repo writes
machine-local state, as the Fix decided.

- `publishedDigests(root)` and `driftedPaths(repoDigests, installDigests)` are
  new exported pure helpers. The short-circuit now compares every entry of
  `PUBLISHED_PATHS` on both sides and fires only when the drift list is empty
  *and* `install.gitCommitSha === head`. `hashTree`'s existing `''` for a
  missing root is what makes an absent `agents/` read as drift, so there is no
  second existence check to keep in sync.
- Both messages name what was compared: `same skills, .claude-plugin, agents as
  the working tree` when in sync, and `reinstalling — <paths> differ(s)` (or the
  two commits, when only the sha moved) when not.
- The post-install verification checks the same list, and its failure message is
  the diagnosis: it names the paths, and when any of them is absent from the
  install *entirely* — the sparse-checkout shortfall by elimination — it names
  `~/.claude/settings.json` →
  `extraKnownMarketplaces.<marketplace>.source.sparsePaths`, states that
  `known_marketplaces.json` is a cache reconciled from it on the next session
  start (so an edit there is reverted, and is itself what triggers the revert),
  and exits non-zero.
- A read-only pre-flight `missingSparsePaths(settings, marketplace)` warning
  runs before the uninstall, warn-never-refuse, and cannot abort in the window
  between the uninstall and the install.
- `CLAUDE.md`'s publish-surface invariant, `docs/invariants.md`'s `agents/`
  section and the stale `PUBLISHED_PATHS` comment in the script itself all named
  `known_marketplaces.json` as the machine-local lever. All three now name
  `extraKnownMarketplaces` in `settings.json` and record the cache relationship,
  the digest gap and what the sync does about it.

### Verification

The bug's exact shape, measured against both logics — a fake install carrying
`skills/` and `.claude-plugin/` copied from the repo and no `agents/` at all:

```
OLD logic (skills only) sees drift? false
NEW logic drifted paths: ["agents"]
live settings missing: ["agents"]
```

The first line is the bug: indistinguishable from a complete install. The third
is the live declaration on this machine, which still lacks `agents`.

The real sync, run from this branch — it names its reason, then refuses at the
publish blocker without touching the install:

```
$ node scripts/sync-plugin.mjs
reinstalling — installed commit 2834976, repo HEAD 6546713
HEAD is 1 commit(s) ahead of origin/main. The marketplace clones from GitHub, so push first:
  git push
EXIT:1
```

`pnpm run test:skills` — the 9 new `scripts/sync-plugin.test.mjs` cases (digest
map keying incl. a path absent on disk, empty drift for agreement, the missing
`agents` case, a differing `.claude-plugin`, multi-path order, and the four
`missingSparsePaths` cases) alongside the existing suite:

```
1..277
# tests 277
# suites 0
# pass 277
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 33960.611625
```

`pnpm run typecheck` exit 0, and `pnpm test`:

```
Test Suites: 47 passed, 47 total
Tests:       721 passed, 721 total
Snapshots:   0 total
Time:        61.586 s
```

### Not done here, and not doable here

The live end-to-end check the Fix listed — reinstall, `ls "$INSTALL/agents"`,
restart and confirm `backlog-manager:backlog-reviewer` resolves — still needs the
one manual machine step the Fix already called out: add `"agents"` to
`extraKnownMarketplaces["backlog-manager-marketplace"].source.sparsePaths` in
`~/.claude/settings.json`, then start a session so the reconcile re-sparses the
clone. Until that is done the marketplace clone has no `agents/`, so any
reinstall — including one this sync performs — *drops* the agent from the
install, which currently still has it from the transient cache edit of
2026-09-01. That step was deliberately left to the user: it is the user's own
config, at a tier this repo cannot know is the governing one, and the whole point
of the Fix's judgement call was that no repo script writes it.
