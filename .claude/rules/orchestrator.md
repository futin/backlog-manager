---
paths: ["skills/backlog-orchestrate/**", "server/src/orchestrator/**", "shared/agent.ts"]
---

# Pointers only — the reasoning lives in docs/subsystems/invariants.md

- Before changing files here, read docs/subsystems/invariants.md#the-orchestrators-run-file-has-exactly-one-writer-one-reader--the-same-relationship-the-registry-has
- Before changing files here, read docs/subsystems/invariants.md#a-runs-sidecars-are-archived-beside-its-run-file-task-31
- Before changing files here, read docs/subsystems/invariants.md#orchestratemjs-is-always-invoked-from-the-project-root-never-from-inside-a-per-item-worktree
- Before changing files here, read docs/subsystems/invariants.md#backlog-orchestrate-is-the-only-skill-that-commits-or-merges
- Before changing files here, read docs/subsystems/invariants.md#merge-mode-is-run-scoped-and-a-malformed-one-is-a-400
- Before changing files here, read docs/subsystems/invariants.md#question-mode-is-run-scoped-and-it-only-ever-takes-effect-in-a-headless-run
- Before changing files here, read docs/subsystems/invariants.md#a-classifier-denial-degrades-the-run-every-other-merge-failure-parks
- Before changing files here, read docs/subsystems/invariants.md#merged-is-not-the-only-success-exit--branched-is-its-branch-mode-sibling
- Before changing files here, read docs/subsystems/invariants.md#a-runner-fix-item-is-hoisted-to-the-front-of-the-queue-and-the-marker-is-read-at-base
- Before changing files here, read docs/subsystems/invariants.md#a-pause-request-is-a-file-the-server-writes-and-the-tool-reads
- Before changing files here, read docs/subsystems/invariants.md#a-stop-is-the-control-files-second-kind-and-nothing-resumes-a-stopped-run
- Before changing files here, read docs/subsystems/invariants.md#the-merge-happens-in-whichever-tree-holds-the-base-and-the-run-removes-only-the-tree-it-made
- Before changing files here, read docs/subsystems/invariants.md#the-driver-owns-a-tracker-items-claim-for-the-whole-item
- Before changing files here, read docs/subsystems/invariants.md#remote-runs-ride-beside-runs-never-in-it
