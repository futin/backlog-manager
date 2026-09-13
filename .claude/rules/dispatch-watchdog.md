---
paths: ["server/src/agents/**"]
---

# Pointers only — the reasoning lives in docs/subsystems/invariants.md

- Before changing files here, read docs/subsystems/invariants.md#dispatch-derives-the-action-it-never-accepts-one
- Before changing files here, read docs/subsystems/invariants.md#the-orchestrate-spawn-prompt-is-composed-server-side
- Before changing files here, read docs/subsystems/invariants.md#the-browser-never-talks-to-the-dashboard
- Before changing files here, read docs/subsystems/invariants.md#every-agents-post-is-guarded-by-content-type-and-origin
- Before changing files here, read docs/subsystems/invariants.md#one-run-per-project-checked-twice
- Before changing files here, read docs/subsystems/invariants.md#a-resume-is-serialized-at-three-layers
- Before changing files here, read docs/subsystems/invariants.md#the-watchdog-spawns-it-never-writes-the-run-file
- Before changing files here, read docs/subsystems/invariants.md#armed-idle-off
- Before changing files here, read docs/subsystems/invariants.md#grace-any-attempt-starts-the-clock-only-a-success-counts
- Before changing files here, read docs/subsystems/invariants.md#a-board-started-run-is-visible-before-its-run-file-exists
