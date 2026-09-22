---
paths: ["server/src/tracker/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.** `server/src/tracker/claim.ts` is the one implementation of
  what a claim IS (render, parse, `claimsFor`, `isLive`, `newestClaim`, `winner`); `GithubSource.claim` is the one implementation of taking one. The sequence
  is list · post · settle (`settleMs`, 1 s) · list · UNION, and the union is what decides — never the second list alone, because GitHub's comment listing is
  eventually consistent. A LOSER deletes its own comment; a claim that merely went STALE is released (`released: { reason: 'stale' }`), never deleted, because
  it is the permanent record of work somebody did and carries the counters to prove it. **Who may release is a triple: the holder always, the RUN that owns the
  claim, ANYONE once the claim is dead** (bug-42) — the middle clause is task-47 §7.6's same-run takeover, which `claim` enforced and `release` did not, so a
  board force stop's spawned `--abort` could not release the dead driver's claims. `ItemReleaseRequest.runId` is the assertion, a 400 on anything but a
  non-empty string, sent by `trackerRelease` on EVERY release and never by `backlog.mjs stop`; the test is guarded with `typeof`/`length` so a claim with no
  `run` is never same-run with anything, and `isLive` reaches the dead clause first. `CLAIM_STALE_MS` is a named alias of `RUN_STALE_MS`, not a second
  number. **A heartbeat names its author too, and the rule there is that triple MINUS its last clause** (bug-45): `ItemHeartbeatRequest.session` is required (a
  400 without it, like `release`'s), `runId` is the same optional same-run assertion with the same `typeof`/`length` guards, and the check runs BEFORE the
  released branch, `finished` included — but a DEAD claim does not open to anyone, because reviving one is the harm (a rival's beats hold a claim live forever,
  so the staleness repair never fires). Retiring a dead claim stays `claim`'s business. And **"is this claim mine?" is answerable from printed output**:
  `start`'s lost-race line and `heartbeat`'s refusal both end `— this session is <id>`, `show` prints `claim-session:` (empty, never absent, when unheld) and
  `this-session:`, and `show --json` carries `session`. **A claim also says WHERE its holder is** (bug-46): `ClaimRecord.host` is `<user>@<host>`, optional
  because every stored claim predates it, absent meaning "the machine was not recorded" and NEVER "local". It is sent by whichever CLI took the claim
  (`hostIdentity()` in `backlog.mjs` and again in `orchestrate.mjs` — a skill's `tools/` may never import another's) and never derived server-side, because
  the server may be in the compose stack where `os.hostname()` is a container id; `session` is NOT widened to carry it, since three checks compare `session`
  raw. `renderClaim` says `session <s> on <host> holds this issue …` when one is present and today's sentence byte-for-byte when it is not, the `holder` of
  all three 409s carries `host`, and `show` prints `claim-host:`/`this-host:`. A refusal that has no holder host degrades WHOLE — it names neither machine —
  because naming ours beside their blank invites the reading that a claim nothing local accounts for is litter. The four counters live in the claim (§6.4: never in the body), are SEEDED by the server from the
  newest prior claim and are BILLED by the CLI on
  release — `--abandon` sends no `counters` key at all, which is not the same as zeros. The mapper reads `started`/`phase` from an UNRELEASED claim without
  consulting its heartbeat ("any stamp, fresh or stale") and the counters from the newest claim regardless of release. Why:
  [invariants.md](docs/subsystems/invariants.md#the-claim-protocol-lowest-live-comment-id-wins)
- **The GitHub token never leaves the server, and the poller is armed only while something is connected.** `BM_GITHUB_TOKEN` is read by `githubToken()`
  (`server/src/tracker/token.util.ts`) per call and cached nowhere; no route returns it and the browser never talks to `api.github.com` — the credential's
  sibling of "the browser never talks to the dashboard", stated separately because one is about an origin and the other about a secret. `docker-compose.yml`
  passes it through as an interpolation with a default, never a literal (bug-25's rule, higher stakes), pinned by `test/compose-env.test.ts`. Outbound calls go
  to one constant host and `repo` is validated before it is interpolated. `TrackerPollerService` is a `setTimeout` chain in the watchdog's shape, armed only
  while a registered project resolves to `github` AND a token is present, disarmed on the tick that finds either missing; `arm()` is called from the bootstrap
  hook and from `GithubSource.list`. Why:
  [invariants.md](docs/subsystems/invariants.md#the-github-token-never-leaves-the-server-and-the-poller-is-armed-only-while-something-is-connected)
- **The tracker cache is the one cache in this server whose age is a rendered value.** In memory, per repo, lost on restart, rebuilt by the first sync; it
  exists because the hourly rate limit makes a per-request fetch impossible, and `polledAt` on the board, in the item modal, on the Trackers card and — since
  bug-41 — beside every tracker queue `orchestrate.mjs plan`/`init` builds is what keeps it honest. **A named `--ids` entry the cache has not polled yet buys
  ONE re-read, timed off `polledAt`, and only a second miss is refused** — never a fresh per-id `GET` to GitHub, which was weighed and rejected. Every other read stays per request — the registry's and `resolveSource`'s rules are untouched. A `304` leaves the cache unchanged and MOVES
  `polledAt`: the rendered age means "since we last successfully checked", and a conditional request that came back `304` is a successful check (settled
  2026-09-18 in spec §12.2's favour, against task-45's own authoritative case, which is recorded as having been overturned). The comments request is made every
  tick and is read by `TrackerPollerService.comments()`, which is what the claim protocol maps an item's `started`/`phase` and counters
  from — and, since task-48, what `RemoteRunsService` derives other machines' runs from, with no cache of its own. **Issues and comments have SEPARATE high-water marks and each paginates to the end** — sharing one mark asked for comments `since` the newest
  ISSUE's stamp, which hid every claim older than that from a fresh process, and `readClaim` therefore falls back to one fresh read on a cache miss
  rather than reporting "unclaimed".
  Rate limits are values, never exceptions: a sleeping repo gets no request at all, and `detail` names the reset TIME. The eight labels
  live in `server/src/tracker/labels.ts`, are created idempotently on a repo's first successful sync — phase 2's one write to GitHub — and agree with
  `connect`'s issue forms by a source-reading guard (`test/tracker-labels.test.ts`), never an import. Why:
  [invariants.md](docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value)
