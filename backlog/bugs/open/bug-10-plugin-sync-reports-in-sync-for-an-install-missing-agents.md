---
id: bug-10
title: plugin:sync reports in sync for an install missing agents/
created: 2026-09-01
tags: plugin, sync, agents
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

unknown

The mechanism is not in doubt — the digest covers one of three published paths
— but the fix is a judgement call this capture should not pre-empt, and there
is a second, separate finding tangled up with it that wants its own diagnosis
before either is settled:

**a sync run rewrites `sparsePaths` back to `[".claude-plugin", "skills"]`.**
Observed twice on 2026-09-01: the entry was edited to include `agents` and a
successful sync installed `agents/`; a later sync run from a different session
reverted the entry and the install lost `agents/` again. Whether that is
`claude plugin marketplace update` restoring a default, something in the
uninstall/install pair, or this script, was not established. It matters because
it decides what a fix has to defend against: if the entry cannot be relied on
to persist, then hashing `agents` correctly still leaves a machine that
silently drops the agent on the next unrelated sync, and the durable fix may
have to assert or repair `sparsePaths` rather than merely notice its effect.

## Fix

unknown

Worth weighing when this is groomed, and deliberately not decided here:

- Hash all of `PUBLISHED_PATHS` rather than `skills` alone, so the digest
  measures the actual publish surface. Smallest change, and it makes the
  message honest. It does not address the `sparsePaths` reversion above.
- Treat a published path that is missing from the install as a reinstall
  trigger outright, independent of any digest — a missing directory is not a
  content difference and arguably should not need one to be noticed.
- Have the script assert `sparsePaths` covers `PUBLISHED_PATHS` and say so
  loudly (or repair it) when it does not. This is the only option that touches
  the half `CLAUDE.md` says the repo does not control, so it deserves the most
  scrutiny: it means the repo writing machine-local state, and whether that is
  a boundary worth crossing to make an invariant self-enforcing is the real
  question.
- Whatever is chosen, the `in sync` message should name what it compared.
