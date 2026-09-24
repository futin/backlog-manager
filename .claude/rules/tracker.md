---
paths: ["server/src/tracker/**"]
---

# Mechanism for the rules scoped to these paths — the headline is in CLAUDE.md, the reasoning in docs/subsystems/invariants.md

- **The claim protocol is one comment per session per issue, and the LOWEST live comment id wins.** `server/src/tracker/claim.ts` is the one implementation of
  what a claim IS (render, parse, `claimsFor`, `isLive`, `newestClaim`, `winner`, `currentClaim`);
  `GithubSource.claim` is the one implementation of taking one. The sequence
  is list · post · settle (`settleMs`, 1 s) · list · UNION, and the union is what decides — never the second list alone, because GitHub's comment listing is
  eventually consistent. A LOSER deletes its own comment; a claim that merely went STALE is released (`released: { reason: 'stale' }`), never deleted, because
  it is the permanent record of work somebody did and carries the counters to prove it. **Who may release is a quadruple: the holder always, the RUN that owns
  the claim, the HOST that holds the claim once it can show the session is gone, ANYONE once the claim is dead** (bug-42, bug-48) — the second clause is task-47
  §7.6's same-run takeover, which `claim` enforced and `release` did not, so a board force stop's spawned `--abort` could not release the dead driver's claims.
  `ItemReleaseRequest.runId` is the assertion, a 400 on anything but a non-empty string, sent by `trackerRelease` on EVERY release and never by `backlog.mjs
  stop`; the test is guarded with `typeof`/`length` so a claim with no `run` is never same-run with anything, and `isLive` reaches the dead clause first. **The
  THIRD clause is bug-48's, and it is split across the two processes**: the server checks `sameHost` and nothing else — `ItemReleaseRequest.host`, validated by
  `optional()` like `claim`'s, guarded with the same `typeof`/`length` so a claim with no `host` is never same-host with anything — while the PROOF that the
  holder is gone belongs to `backlog.mjs abort <id>`, the only sender of that field, because the server can see neither the caller's filesystem nor its process
  table. `abort` releases with `reason: 'aborted'` (bug-40's word, the same event) and NO `counters` key, and refuses unless all three hold: the claim's `host`
  is non-empty and equals `hostIdentity()` (a hostless claim is refused, never assumed local); the claim is unreleased and live (a dead one exits 0 saying the
  next `start` retires it, and makes no request); and `holdingSessionEvidence` answers `gone` — Claude Code's registry `<configDir>/sessions/*.json` was read,
  understood, and holds no entry naming the holder whose pid is running (and whose `procStart` matches `/proc/<pid>/stat` field 22 where `/proc` exists) — a
  check that is meaningful ONLY because the host refusal already ran, since on a foreign machine an absent entry is bug-46's false negative. It answers
  `unknown`, and `abort` refuses, when the directory is unreadable, any entry lacks a string `sessionId` or integer `pid`, or the aborting session cannot find
  its own running entry (bug-49; a transcript mtime was the evidence before, and every killed session's transcript post-dates its last beat). `gone` is "no
  process now": a board-dispatched `claude -p` session between turns has no entry either, so nothing automatic may release on this signal. In files mode
  `abort` is exit 1 naming `stop <id> --abandon`. The split is billing's, for billing's reason (the CLI holds the clock, the transcripts and the process table), and the boundary it draws is a MISTAKE one, not a security one: `stop` has always sent a caller-supplied `session`.
  `CLAIM_STALE_MS` is a named alias of `RUN_STALE_MS`, not a second number. **Every release removes `in-progress`; exactly one reason also clears the
  ASSIGNEE, and it is `aborted`** — the claim SETS the assignee when it wins, so after a session torn down mid-item that field records no work while still
  reading as ownership, which is the same false signal the label is removed for arriving through the other field the protocol writes. `stopped`, `merged` and
  `imported` keep it, because there it is a true record of who did the work. The `updateIssue(assignees: [])` result is ignored exactly as `removeLabel`'s is
  (the comment is already edited, so the release HAS happened) and the cache absorbs the issue when it succeeds. **A heartbeat names its author too, and the rule there is the holder or the claim's
  own run, and nobody else** (bug-45): `ItemHeartbeatRequest.session` is required (a 400 without it, like `release`'s), `runId` is the same optional same-run
  assertion with the same `typeof`/`length` guards, and the check runs BEFORE the
  released branch, `finished` included — but a DEAD claim does not open to anyone, because reviving one is the harm (a rival's beats hold a claim live forever,
  so the staleness repair never fires). Retiring a dead claim stays `claim`'s business. And **"is this claim mine?" is answerable from printed output**:
  `start`'s lost-race line and `heartbeat`'s refusal both carry `— this session is <id>` — on `start` the rule bug-47 appended follows it rather than ending
  the line — `show` prints `claim-session:` (empty, never absent, when unheld) and `this-session:`, and `show --json` carries `session`. **A claim also says WHERE its holder is** (bug-46): `ClaimRecord.host` is `<user>@<host>`, optional
  because every stored claim predates it, absent meaning "the machine was not recorded" and NEVER "local". It is sent by whichever CLI took the claim
  (`hostIdentity()` in `backlog.mjs` and again in `orchestrate.mjs` — a skill's `tools/` may never import another's) — **`BM_MACHINE_NAME` overrides it in
  BOTH tools, and a blank one reads as unset**, because a claim comment on a public repository publishes whatever this returns and the default spells out the
  OS username and the real hostname; the two copies must read the same variable, since the server's `sameHost` clause compares the strings for equality and a
  machine answering two names could not release its own driver's claim — and never derived server-side, because
  the server may be in the compose stack where `os.hostname()` is a container id (#225's abort reads `BM_MACHINE_NAME` through compose only to COMPARE a
  claim's `host`, with no `<user>@<host>` default — unset refuses); `session` is NOT widened to carry it, since three checks compare `session`
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
  rather than reporting "unclaimed". **Every issue holding an unreleased cached claim is re-read per tick, and that list is the truth for its comments**
  (bug-55) — conditional on a per-issue ETag whose remembered ids a `304` is reconciled against, a comment younger than `RECONCILE_GRACE_MS` kept even when
  absent, `commentsHwm` never moved by it, a `404` read as an empty list — because the repo-wide `since` read can never see a deletion, and `forgetComment`
  only ever hears of the loser THIS process deleted.
  Rate limits are values, never exceptions: a sleeping repo gets no request at all, and `detail` names the reset TIME. The nine labels
  live in `server/src/tracker/labels.ts`, are created idempotently on a repo's first successful sync — phase 2's one write to GitHub — and agree with
  `connect`'s issue forms by a source-reading guard (`test/tracker-labels.test.ts`), never an import. Why:
  [invariants.md](docs/subsystems/invariants.md#the-tracker-cache-is-the-one-cache-in-this-server-whose-age-is-a-rendered-value)
