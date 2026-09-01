---
id: bug-2
title: A bare cd into a worktree silently re-keys orchestrate.mjs to the wrong project
created: 2026-08-31
tags: orchestrate, cli
updated: 2026-09-01T10:09:09Z
groom-elapsed: 102
---

## Symptom

After any shell command leaves the session's cwd inside a per-item worktree, every
later `orchestrate.mjs` call resolves to the *worktree* rather than the project, and
reports that no run exists:

```
$ node .../orchestrate.mjs heartbeat
no run exists for this project — run `orchestrate.mjs init --project <path>` first
$ pwd
/Users/…/backlog-manager/.worktrees/task-3
```

Exit `3`. The live run is untouched and perfectly healthy — the tool is simply looking
in a directory nothing ever writes.

The failure is quiet in the way that matters: exit `3` is also the ordinary "no run
yet" answer, so an unattended loop that treats `3` as "nothing to do" reads a healthy
run as absent. Nothing is written, nothing is corrupted, and nothing says the project
was misidentified.

## Repro

Observed live during the first real `backlog-orchestrate` run (run-20260831-211011,
item task-3), not reconstructed afterwards:

```bash
# from the project root, with a run already live
cd "$PWD/.worktrees/task-3" && pnpm exec jest --version   # any ad-hoc probe
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
# → exit 3, "no run exists for this project"
cd /path/to/project-root
node "$CLAUDE_PLUGIN_ROOT/skills/backlog-orchestrate/tools/orchestrate.mjs" heartbeat
# → exit 0, run is intact
```

The probe does not have to be an `orchestrate.mjs` command, and that is the whole
point — it was a one-off `pnpm exec jest --version` run to check binary resolution.
Any command that leaves the shell inside the worktree arms the trap for every call
after it.

## Affects

- `skills/backlog-orchestrate/tools/orchestrate.mjs` — the cwd walk to the nearest
  `.git` that resolves "which project". A linked worktree has its own `.git` (a file,
  not a directory), so the walk terminates there and produces a valid-looking,
  wrong answer.
- `skills/backlog-orchestrate/SKILL.md` — "Where commands run, and why it is not
  negotiable" already documents this hazard in full, and mandates the
  `( cd … && … )` subshell form. It scopes that rule to the two `cd` sites the skill
  itself prescribes (the resume and abort `backlog.mjs stop` calls). Nothing covers a
  `cd` the operator introduces for an unrelated reason.
- `CLAUDE.md` — the "`orchestrate.mjs` is always invoked from the project root"
  invariant, which reasons the same way and reaches the same scope.

## Cause

Known, and deliberate as far as it goes. `orchestrate.mjs` resolves the project by
walking up from its own cwd to the first `.git`, exactly as `backlog.mjs` does. Inside
a linked worktree that walk finds the worktree's own `.git` file first and keys the run
under the worktree's path — a location nothing else reads.

The repo already reasoned about this and chose to leave the tool quiet, putting the
rule in the skill instead: *"A loud failure would be safer; this one is quiet, which is
exactly why the rule belongs here rather than in the tool."*

What this bug adds is that the chosen mitigation does not cover the actual failure
surface. A prose rule can only bind the commands the prose knows about, and the trap is
armed by commands the skill never mentions — anything at all that lands the shell in
the worktree. The skill's own two `cd` sites were never the likely source; an operator
probing the worktree is.

Pinned to one function: `resolveProjectRoot` (`orchestrate.mjs:203`), whose test is
`fs.existsSync(path.join(dir, '.git'))`. `existsSync` cannot tell a directory from a
file, and that is the entire defect surface — a linked worktree's `.git` is a file, so
the very first probe succeeds and the walk stops one tree short of the project.

`backlog.mjs`'s identical walk is not part of this bug and must not be changed with it.
The two tools want opposite answers from the same code: the headless `backlog-execute`
sessions this orchestrator dispatches run `backlog.mjs` *inside* a worktree on purpose,
because the item file they read and stamp is the worktree's own copy. Resolving a
worktree to itself is correct there and wrong only here. Whatever lands, it lands in
`orchestrate.mjs` alone.

## Fix

Detect the worktree and refuse loudly, in `resolveProjectRoot` itself — no `git`
subprocess, because none is needed. The walk already touches `<dir>/.git`; the whole
discriminator is what that entry *is*:

- **A directory** — ordinary clone or the main tree. Return `dir`, exactly as today.
- **A file** whose `gitdir:` target contains a `commondir` entry — a linked worktree.
  Refuse.
- **A file** whose target has no `commondir` — a submodule working tree. Return `dir`,
  unchanged behaviour. Verified empirically, not assumed: a worktree gitdir
  (`<main>/.git/worktrees/<name>`) carries `HEAD commondir gitdir index logs refs`, a
  submodule gitdir (`<super>/.git/modules/<name>`) carries `HEAD config description
  hooks index info logs objects packed-refs refs` — `commondir` is present in exactly
  one of them. Sniffing "`.git` is a file" alone would wrongly refuse inside a
  submodule.

That removes the objection the first candidate was filed with. The cost is two small
reads on a path already being stat'ed, not a `git rev-parse` in front of every command.

The refusal has to be *actionable*, since the operator who trips it will be mid-run and
possibly unattended. It can name the project root without shelling out, from the same
two files: the `.git` file gives `gitdir: <abs or relative path>` (resolve relative
targets against the directory holding the `.git` file — a submodule's is relative, and
git can be configured to write relative worktree pointers too), and `<gitdir>/commondir`
gives the common git dir, itself possibly relative to the gitdir (`../..` in practice).
The main tree is that common dir's parent. So the message can read: this is the worktree
`<path>`, its project root is `<root>`, re-run from there. If the common dir's parent is
not a working tree at all (a bare main repo), degrade to naming the worktree and the
gitdir and stop — refusing without a suggestion still beats answering wrongly.

Exit `1`, which the contract already fits without amendment: "a problem with THIS call,
independent of run state... nothing is ever written when a command exits 1." Not `3` —
`3` is the exact conflation this bug is about, an unattended loop reading "no run yet"
where a healthy run exists.

Second entry point, closing the same hole from the other side: `init` does not call
`resolveProjectRoot` (it takes `--project`), so a worktree path handed to `init`
would still key a run under a directory nothing reads. Run the same helper over the
validated `--project` value and refuse identically, before anything touches disk.

What must NOT be checked: `stage --worktree`, `stage --branch` and `verify --cwd`.
Those name a worktree deliberately — they are the mechanism the invariant prescribes,
and the check belongs on cwd-derived and `--project`-derived roots only.

## Test cases

Against `skills/backlog-orchestrate/tools/orchestrate.test.mjs`, whose fixtures already
build real worktrees (`git worktree add`) and already spawn the CLI with an arbitrary
`cwd`, so no new harness is needed.

1. `heartbeat` with cwd set to a linked worktree of an initialised project: exit `1`;
   stderr names the worktree path and the project root; the project's own `run.json` is
   byte-identical afterwards; no directory keyed to the worktree path appears under
   `BM_ORCH_HOME`.
2. Same, from a *subdirectory* of that worktree: identical refusal — the walk reaches
   the worktree's `.git` before any parent's.
3. Regression, existing behaviour: `heartbeat` from the project root, and from a nested
   subdirectory of it, still exit `0` (the suite's existing "resolve the project from
   cwd via the nearest `.git` ancestor" test must stay green untouched).
4. `init --project <worktree path>`: exit `1`, and nothing written anywhere under
   `BM_ORCH_HOME`.
5. Regression: a directory in no git repository at all still exits `1` with the existing
   `no .git found` message — the new refusal must not swallow or reword it.
6. A submodule working tree (`.git` is a file, gitdir has no `commondir`) resolves to
   itself and does not refuse. This is the case that proves the discriminator is
   `commondir`, not "`.git` is a file".
7. Regression: `verify <id> --cwd <worktree>` invoked from the project root behaves
   exactly as today — the flag's worktree path is never subjected to the check.

## Prose that has to move with it

Three places currently document this as a rule the tool does not enforce, and each says
so explicitly. They become wrong the moment the code lands.

- `skills/backlog-orchestrate/SKILL.md`, "Where commands run, and why it is not
  negotiable": drop *"A loud failure would be safer; this one is quiet, which is exactly
  why the rule belongs here rather than in the tool"* — the failure is now loud. Widen
  the scope while there, which is the point this bug added: the section currently reads
  as "use a subshell at these two `cd` sites", when the rule is **this session's cwd must
  be the project root whenever `orchestrate.mjs` is called, whatever put it elsewhere**.
  The subshell form stays mandatory; it is now one instance of the rule rather than its
  whole extent. The exit-code table's `1` row gains the new refusal.
- `CLAUDE.md`, the "`orchestrate.mjs` is always invoked from the project root" invariant:
  it reasons that the walk "would find the worktree's own `.git` first and silently key
  the run under the worktree's path instead of erroring — the run would appear to vanish,
  not crash loudly." After the fix it does crash loudly; the invariant survives as a
  contract, but its stated reason inverts.
- `docs/invariants.md:78`, the long-form version of the same, plus the
  `resolveProjectRoot` header comment in `orchestrate.mjs` (~40 lines, currently
  asserting "this walk would NOT error"). That comment is the single most wrong artefact
  after the change and should be rewritten, not patched.
