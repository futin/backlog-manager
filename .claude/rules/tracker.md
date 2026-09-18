---
paths: ["server/src/tracker/**"]
---

# Pointers only — the reasoning lives in docs/subsystems/invariants.md

- Before changing files here, read docs/subsystems/invariants.md#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected
- Before changing files here, read docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value
- Before changing files here, read docs/subsystems/invariants.md#a-tracker-project-has-no-item-files-and-that-shows-up-in-three-places
- Before changing files here, read docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins
