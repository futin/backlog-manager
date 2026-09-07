# Publishing a change to the skills

Run this whenever you edit anything under `skills/`, `agents/` or
`.claude-plugin/`. Until you do, your edit has changed nothing: the Claude Code session
sitting next to you is running an **installed copy** of this plugin, and an install is a
copy, not a link. The gap is silent — the `started` marker once shipped in a commit and
the installed plugin sat on the repo's first commit for weeks afterwards.

Git is the publishing boundary. The marketplace source is the GitHub repo over SSH,
sparse-checked out, so the installer sees committed, pushed work and nothing else. That
is why the sync script refuses a tree that is anything less rather than installing stale
code and reporting success.

## Steps

```bash
# 1. commit, on main
git add skills agents
git commit
# 2. push — the installer clones from GitHub, not from your working tree
git push
# 3. reinstall from the pushed HEAD
pnpm run plugin:sync
# 4. restart Claude Code so the new skills load
```

`plugin:sync` is [`scripts/sync-plugin.mjs`](../../scripts/sync-plugin.mjs). What it
actually does, in order:

1. **Compares surfaces.** One digest per entry of `PUBLISHED_PATHS` (`skills`,
   `.claude-plugin`, `agents`) over the repo and over the install, path-and-bytes so a
   rename or a deletion moves the digest too. Equal digests *and* an install commit equal
   to `HEAD` means it prints `in sync` and stops.
2. **Refuses an unpublishable tree.** Uncommitted files under the published paths (it
   names them), a `HEAD` ahead of `origin/main` (push first), or a `HEAD` behind it
   (pull first, or the install moves backwards). It fetches `origin/main` before
   comparing, so a stale ref cannot make a pushed tree look unpushed.
3. **Warns about the machine-local half** — see Failure modes.
4. **Uninstalls and reinstalls**, rather than `claude plugin update`: the cache directory
   is keyed by the version in `.claude-plugin/plugin.json`, so an update stops at
   "already at the latest version" however far the commit behind it has moved. The
   reinstall is cheap because the source is sparse.
5. **Re-measures every published path after the install** and fails loudly if any still
   differs, naming the file to edit.
6. **Prunes older version directories**, skipping any marked `.in_use` by a running
   session.

## Verification

The script's own last lines are the verification: `installed v<version> @ <sha>` naming
the install path, and a reminder to restart. A run that ends in
`installed … still differ(s) from the repo` has failed — read the two lines under it,
they name the cause.

To confirm a specific skill or agent actually landed, look in the install path the script
printed; that directory is what a session loads, and it is the only place worth checking.
`node --test scripts/sync-plugin.test.mjs` covers the pure halves — the refusal ladder,
the digests, the sparse-path hint — and runs as part of `pnpm test`
(`test:skills`'s glob includes `scripts/*.test.mjs`, which is exactly why that half of
the glob must not be lost).

## Failure modes

**`in sync` for an install that is missing a whole directory.** This was bug-10. The
script used to hash `skills` alone, so an install whose sparse checkout never wrote
`agents/` was indistinguishable from a complete one, and the short-circuit declined to
reinstall forever — the one path it measured never moved. It now measures every entry of
`PUBLISHED_PATHS` on both sides, and a missing tree hashes as empty, so absence *is*
drift with no separate existence check to keep in sync. The install's commit sha cannot
cover for this: it records which commit the copy came from, not which paths were checked
out of it, and the same sha legitimately yields an install with or without `agents/`.

**A published path is absent from the install no matter how often you sync.** The repo
controls only half of the publish surface. The other half is this machine's marketplace
declaration, in `~/.claude/settings.json` under
`extraKnownMarketplaces.<marketplace>.source.sparsePaths` — and a path missing there is
never cloned, so no reinstall through any route can produce it. Add it there, start a
session so the marketplace clone is re-sparsed, and sync again.

Do **not** edit `~/.claude/plugins/known_marketplaces.json`: it is a cache Claude Code
re-materializes from that declaration on session start, so an edit to it is not merely
transient — it is what triggers the revert. The script warns before it touches anything
when it can see the shortfall, and fails after the reinstall when it cannot.

**A new agent or skill directory that nobody can see.** Claude Code discovers a plugin's
agents by the same root-level directory convention it uses for skills, so a directory
absent from `PUBLISHED_PATHS` *or* from the sparse declaration is invisible post-install
even though it sits right there in the repo. Anything a skill needs at runtime has to
live under a published path.

**The install carries every path but not the current bytes.** The version-keyed cache
directory did not overwrite in place. A version bump in `.claude-plugin/plugin.json` is
the lever; the script says so in those words.

**No plugin at all.** The reinstall is an uninstall followed by an install, so a failed
install leaves the machine with nothing. The script says exactly that and hands over the
one command that fixes it — `claude plugin install backlog-manager@backlog-manager-marketplace`.

**Edited, pushed, synced — and a running orchestrator run still behaves the old way.** A
run resolves its own skill files through `$CLAUDE_PLUGIN_ROOT`, the copy it started with.
Which copy a run follows after merging a fix to the runner itself is the orchestrator's
own rule, in [the invariant rationale](../subsystems/invariants.md); the short version is
that a sync makes the new behaviour available to the *next* run, not the current one.

<!-- docs-sync:
  sources:
    - scripts/sync-plugin.mjs
    - scripts/sync-plugin.test.mjs
    - .claude-plugin
  kind: workflow
  verified: c8a7bd892b82da46fea507eedf12ddadbe1d5a46
-->
