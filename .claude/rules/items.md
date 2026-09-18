---
paths: ["server/src/items/**"]
---

# Pointers only — the reasoning lives in docs/subsystems/invariants.md

- Before changing files here, read docs/subsystems/invariants.md#a-projects-source-is-a-committed-marker-resolved-per-request-and-an-unsupported-one-never-falls-back-to-files
- Before changing files here, read docs/subsystems/invariants.md#the-middle-rung-comes-from-git-not-the-item-file
- Before changing files here, read docs/subsystems/invariants.md#the-orchestrate-sheets-uncommitted-flag-is-read-from-git-per-request-and-memoised-nowhere
- Before changing files here, read docs/subsystems/invariants.md#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places
- Before changing files here, read docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value
- Before changing files here, read docs/subsystems/invariants.md#the-seven-item-write-routes-are-guarded-refused-for-files-and-serialised-per-item
- Before changing files here, read docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins
