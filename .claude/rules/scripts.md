---
paths: ["scripts/**", "package.json", "pnpm-workspace.yaml"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **The tailnet serve is a script, and its port is read where compose reads it.** `scripts/tailnet.mjs` (`pnpm run tailnet`, `up`/`status`/`down`) is the one
  sanctioned way past the loopback bind below; it resolves `BM_WEB_PORT` the way compose does — exported variable over `.env` over the compose default — because
  a hand-typed `tailscale serve` stores a second copy of the port inside tailscaled, which drifts and surfaces as a bare 502 on the phone. The tailnet port and
  the loopback port are always the same number (which is why HTTPS serve is out: `--https` takes only 443/8443/10000); plain HTTP is deliberate and rides inside
  WireGuard; `funnel` and `--set-path` are never used. `5177` appears once in the script, asserted against its source text by `scripts/tailnet.test.mjs`. Why:
  [invariants.md](docs/subsystems/invariants.md#the-tailnet-serve-is-a-script-and-its-port-is-read-where-compose-reads-it)
- **`pnpm test` is the union of BOTH runners** — `scripts/test-all.mjs` runs `test:jest` and then `test:skills`, always both, and exits `1` if either failed. Do
  not "simplify" `test` back to bare jest: jest's `testMatch` can never reach `skills/*/tools/*.test.mjs`, the whole of this repo's single-writer tooling. The
  two named scripts stay the single copy of what each runner runs; neither runner short-circuits the other; the script has no test of its own on purpose. Why:
  [invariants.md](docs/subsystems/invariants.md#pnpm-test-is-the-union-of-both-runners)
