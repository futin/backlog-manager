---
paths: ["skills/**", "agents/**"]
---

# Pointers only — the reasoning lives in docs/subsystems/invariants.md

- Before changing files here, read docs/subsystems/invariants.md#editing-skills-changes-nothing-until-commit--push--pluginsync
- Before changing files here, read docs/subsystems/invariants.md#agents-is-part-of-the-plugins-publish-surface
- Before changing files here, read docs/subsystems/invariants.md#registryjson-has-exactly-one-writer-and-a-linked-worktree-registers-its-main-tree
- Before changing files here, read docs/subsystems/invariants.md#backlog-managerretro-has-exactly-one-writer-and-the-retro-never-writes-run-state
- Before changing files here, read docs/subsystems/invariants.md#started-and-phase-are-the-lifecycle-keys-in-frontmatter-and-neither-is-a-status
- Before changing files here, read docs/subsystems/invariants.md#pnpm-test-is-the-union-of-both-runners
- Before changing files here, read docs/subsystems/invariants.md#backlogmjs-in-a-tracker-project-needs-the-stack-up
