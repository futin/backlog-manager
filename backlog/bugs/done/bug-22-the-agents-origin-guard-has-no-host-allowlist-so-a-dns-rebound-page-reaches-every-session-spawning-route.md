---
id: bug-22
title: The agents origin guard has no Host allowlist, so a DNS-rebound page reaches every session-spawning route
created: 2026-09-06
tags: security, audit-2026-09-06
updated: 2026-09-12T18:46:05Z
groom-elapsed: 417
groom-tokens: 81919
started: 2026-09-12T18:31:37Z
execute-elapsed: 868
execute-tokens: 105584
---

## Symptom

`SameOriginPostGuard` compares `new URL(origin).host` against `req.headers.host` and
nothing else. Both headers are controlled by the same attacking page, so a DNS-rebinding
page satisfies the equality check while its own `fetch` is genuinely same-origin — which
means no preflight, and `content-type: application/json` passes the guard's other check
for free. Both of the guard's checks clear, and the request lands on every POST the guard
protects, `dispatch` / `orchestrate` / `resume` included.

Raised as the sole **Critical** of the 2026-09-06 audit (`audits/2026-09-06-audit.md`),
upheld by its skeptic pass.

## Repro

Not reproduced end to end — the rebinding half needs an attacker-controlled domain and a
short-TTL DNS record. The guard-clearing half is reproducible directly:

```
curl -X POST http://127.0.0.1:4322/api/agents/dispatch \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://evil.test:4322' \
  -H 'Host: evil.test:4322' \
  -d '{"project":"...","id":"...","prompt":"..."}'
```

The guard accepts it: the two headers agree, and the content-type is the one it wants.

Full chain, as the attack would run it: a victim on this machine loads a page from a
domain the attacker controls, served on port 4322. After load, DNS for that domain
re-resolves to 127.0.0.1. The page `fetch`es `/api/agents/dispatch`. The browser treats it
as same-origin — no preflight, `application/json` sent freely — and both `Origin` and
`Host` read `evil.test:4322`, so the equality holds. The local API forwards the attacker's
`prompt` verbatim to the dashboard's `POST /api/spawn` at the dashboard's permission
ceiling: a Claude Code session with file-write permission in another repo on this machine.

## Affects

- `server/src/agents/origin.guard.ts:97` — `sameOrigin` is the bare host equality
- `server/src/main.ts:24` — `await app.listen(PORT, BIND)`, no Host validation, no helmet,
  no host middleware
- `server/src/app.module.ts`, `server/src/security.ts` — no host check either; the CSP's
  `connect-src 'self'` binds the board's own pages, not an attacker's
- `server/src/agents/agents.controller.ts:82` — forwards `body.prompt` verbatim into
  `AgentsService.dispatch` → `POST /api/spawn`, `permissionMode` clamped only to the
  dashboard ceiling
- `docs/subsystems/invariants.md:1185-1206` and the guard's own header comment — the documented
  threat model, which names hidden cross-origin form POSTs and `Origin: null` only

## Cause

Both of the guard's checks are computed from headers the attacking page controls
*together*, and nothing anywhere in the stack asks the one question rebinding cannot
answer: **which host was this request addressed to?**

`sameOrigin` (`origin.guard.ts:97`) asserts a *relation* — `new URL(origin).host ===
req.headers.host` — not an *identity*. A rebound page satisfies a relation with two
matching lies: `Origin: http://evil.test:4322` and `Host: evil.test:4322` agree perfectly.
The content-type check is not a second opinion on that, because after the rebind the
page's `fetch` is genuinely same-origin from the browser's point of view — there is no
preflight to withhold and no CORS decision to lose, so `application/json` is sent for
free. Two checks, one bypass.

An allowlist is the check the attack cannot pass, for a structural reason: the browser
derives `Host` from the URL the attacker's own page was loaded from. The attacker chooses
its value, but cannot make it read `localhost` while the page's origin stays
`evil.test` — the authority in both headers is theirs by construction. "Do these two
headers agree" is a question a rebound page always answers yes to; "is this a name this
app answers to" is one it always answers no to.

Two structural facts widen the blast radius past the title:

- **The guard is route-scoped, the exposure is not.** `SameOriginPostGuard` is attached
  by `@UseGuards` to six agents POSTs (`agents.controller.ts`), so a rebound page still
  reaches every GET in the app: `/api/items/body` reads any registered project's backlog
  file straight off disk, `/api/projects` and the orchestrator reader hand over absolute
  host paths and run state. That read surface is precisely what the loopback bind exists
  to protect (`main.ts:12-20`), so a fix scoped to the POST routes would close the
  session-spawning half and leave the original asset open to the same page.
- **The one middleware that does run on every request only sets response headers.**
  `applySecurityHeaders` (`security.ts`) adds the CSP; `connect-src 'self'` constrains
  pages this app serves, never the attacker's.

Stated narrowly on purpose, as captured: the origin guard is not broken — it does what its
header comment says — and the loopback bind is not the failure. `BM_BIND` does what it
claims; a browser on this machine is simply already inside the boundary a bind draws. The
gap is that the repo has no layer that validates `Host` at all.

## Fix

### Decision 1 — one global middleware, not a third check inside the guard

Add the allowlist as **Express middleware applied to every route**, not to the agents
POSTs. Two reasons, and the first is the decisive one:

- The read routes are exposed to exactly this attack, and they are the reason "loopback is
  the access control" was written in the first place. Closing only the guarded POSTs would
  fix the title and leave `/api/items/body` handing a rebound page the contents of every
  registered project's backlog.
- It keeps one implementation of "is this host ours". With the gate in front, the guard's
  existing `Origin.host === Host` equality inherits the allowlist transitively (an
  allowlisted `Host` plus equality means an allowlisted `Origin`), so the guard needs no
  new comparison and gains no duplicate of this rule.

Register it from the **same applier that registers the CSP**, host gate first, so no app
built in this repo — the one `main.ts` boots, the ones the suites build — can carry the
CSP without also carrying the gate. Concretely: `applySecurityHeaders` becomes
`consumer.apply(allowedHostGate, securityHeaders).forRoutes('{*splat}')`, and it is worth
renaming it (`applySecurityMiddleware`) with its two call sites — `app.module.ts` and
`test/csp.test.ts`'s fixture module — since it no longer only applies headers. Registering
ahead of `ServeStaticModule` is already how the CSP reaches the served `index.html`, and
the gate needs the same position for the same reason.

Refuse with **403** and `{ error: 'unrecognised Host header' }`, matching the guard's
shape (`HttpException({ error }, 403)`), before routing.

### Decision 2 — what the allowlist accepts, and why each entry cannot be rebound

One exported predicate, `isAllowedHost(hostHeader, env = process.env)`, read from
`process.env` **per request** with no cache (the same posture `BM_AGENTS` has). Parse with
`new URL('http://' + host)`; a throw is a refusal. Compare the **hostname only, never the
port** — the port a request arrives on is the port this process chose to listen on, and
pinning it here would plant a third copy of `BM_API_PORT`/`BM_WEB_PORT`/the tailnet port
for no security gain: an attacker's page must already reach our socket to matter. Lowercase
the hostname and strip one trailing dot (`localhost.` is the same name as `localhost`, and
stripping makes the suffix rules below stricter rather than looser).

Accept, in this order:

1. **Any IP literal** — `net.isIP()` on the hostname with IPv6 brackets stripped
   (`new URL('http://[::1]:4322').hostname` is `'[::1]'`, brackets included). An IP literal
   is not a name and therefore cannot be DNS-rebound: for a browser to send
   `Host: 203.0.113.5` to this socket the packet would have to route to that address, not
   to loopback. It is also, empirically, what every existing suite sends — supertest binds
   an ephemeral port and issues `Host: 127.0.0.1:<port>` (verified while grooming: two
   probes returned `127.0.0.1:53492` and `127.0.0.1:53494`), so this rule alone is why the
   existing jest suites stay green without editing a single one of them.
2. **`localhost`.**
3. **Any `.ts.net` name** — `pnpm run tailnet` is the one documented remote path, and this
   mirrors `vite.config.ts`'s `allowedHosts: ['.ts.net']` deliberately, so the API and the
   dev server agree on the same set. A tailnet name is minted by Tailscale for a node, not
   by whoever registers a domain, so an attacker cannot point one at 127.0.0.1. Match on a
   label boundary at the **end** of the hostname (`endsWith('.ts.net')`), never a substring:
   `evilts.net` and `ts.net.evil.test` must both fail.
4. **Anything in `BM_ALLOWED_HOSTS`** — comma-separated, trimmed, lowercased, empty
   entries ignored; an entry beginning with `.` is a suffix match on a label boundary, any
   other entry is an exact hostname match. The escape hatch for a setup this repo does not
   ship: a reverse proxy, an mDNS `.local` name, another container calling the API by
   service name.

Refuse everything else, **including an absent or empty `Host`** — HTTP/1.1 requires the
header, every browser and `curl` sends it, and defaulting an absent one to "allowed" would
reopen the hole to a hand-rolled client.

### Decision 3 — what deliberately does not change

- `SameOriginPostGuard`'s logic. Its two checks stay exactly as they are (`Origin: null`
  and the preflight-free form POST are still its job). Only its header comment changes:
  name rebinding as a case it does **not** close and point at the new gate as the layer
  that does.
- `main.ts` and `BM_BIND`. The bind is not the failure and no line of it moves.
- `vite.config.ts`. Vite already validates its own `Host`; the dev server's `/api` proxy
  forwards the browser's `Host` untouched (no `changeOrigin`), so the gate sees
  `localhost:5177` on that path and allows it by rule 1/2.
- No `helmet`, no `enableCors()`. Neither answers this, and `enableCors` would weaken it.

### Files

- **new** `server/src/allowed-hosts.ts` — `isAllowedHost` plus the middleware.
- `server/src/security.ts` — register the gate ahead of `securityHeaders` in the one
  applier; rename it and update its doc comment.
- `server/src/app.module.ts`, `test/csp.test.ts` — the applier's two call sites.
- `server/src/agents/origin.guard.ts` — header comment only (threat model + pointer).
- `CLAUDE.md` — the "loopback bind is the access control" invariant gains a sibling entry:
  *every route is gated by a Host allowlist; loopback literals, `localhost`, `.ts.net` and
  `BM_ALLOWED_HOSTS` are the only names this app answers to, and the gate is registered by
  the same applier as the CSP.*
- `docs/subsystems/invariants.md` — the matching `Why:` section (rebinding defeats a bind
  and an origin-equality check; an allowlist is what it cannot pass), cross-linked from the
  bind section (~:1170) and the origin-guard section (:1185-1206), whose stated threat
  model is what this bug proved incomplete.
- `README.md` env table and `.env.example` — one `BM_ALLOWED_HOSTS` row/block, beside
  `BM_BIND`.

### Test cases

New `test/allowed-hosts.test.ts`, unit cases on `isAllowedHost` (hostname → verdict):

| Host header | Verdict | Pins |
|---|---|---|
| `127.0.0.1:4322`, `127.0.0.1:53492` | allow | rule 1, and the shape every suite sends |
| `[::1]:4322` | allow | bracket stripping before `net.isIP` |
| `localhost:4322`, `localhost:5177`, `localhost`, `LOCALHOST:4322`, `localhost.:4322` | allow | rule 2, portless, case, trailing dot |
| `mac.tail1234.ts.net:5177` | allow | rule 3, the tailnet path |
| `evil.test:4322` | refuse | the bug's own repro |
| `evilts.net:4322` | refuse | suffix match is dot-anchored, not substring |
| `ts.net.evil.test:4322` | refuse | suffix must be at the end |
| `127.0.0.1.evil.test:4322` | refuse | the IP test reads the whole hostname |
| `''`, `undefined` | refuse | absent Host is not a pass |

Plus, with an env argument: `BM_ALLOWED_HOSTS='board.example'` allows `board.example:4322`
and still refuses `other.example:4322`; `BM_ALLOWED_HOSTS='.corp.example'` allows
`x.corp.example:4322` and refuses `corp.example.evil.test:4322`; changing the variable
between two calls changes the verdict (proves the per-request read, no cache).

Integration cases (supertest against `AppModule`, the idiom `test/agents-origin-guard.test.ts`
already uses — its `recordFetches()` stub and `expect(sent).toEqual([])` assertion are what
prove nothing left the process):

1. **The bug, as a red test.** `POST /api/agents/dispatch` with
   `host: evil.test:4322`, `origin: http://evil.test:4322`, `content-type: application/json`
   and a valid body → **403**, error matching `/Host/`, and `sent` is `[]`. Today this
   returns 201 and spawns.
2. **The read half.** `GET /api/items/body?path=<a real registered item>` with
   `host: evil.test:4322` → 403, and the response body contains none of the file's bytes.
   This is the case that fails if the gate is scoped to the agents routes.
3. **`GET /api/health` with `host: evil.test:4322` → 403** — the gate is a property of the
   server, not of `/api/agents`.
4. **Regressions that must stay green**, in the existing suite: same-origin dispatch with
   `host: localhost:4322` / `origin: http://localhost:4322` → 201; the Vite-proxy case with
   `host: localhost:5177` / `origin: http://localhost:5177` → 201; the no-Origin `curl` case
   → 201 (its Host is supertest's `127.0.0.1:<port>`).
5. **The tailnet shape** (new): `host: mac.tail1234.ts.net:5177`,
   `origin: http://mac.tail1234.ts.net:5177` → 201, and the same Host with
   `origin: https://mac.tail1234.ts.net:5177` → 201 as well, since the guard deliberately
   does not compare schemes and a terminating serve is the documented reason.
6. **Ordering, behaviourally rather than by reading source**: against `test/csp.test.ts`'s
   static fixture app, `GET /` with `host: evil.test:5177` → 403 and the response does not
   contain `<div id="root"></div>` — i.e. the gate runs ahead of `ServeStaticModule`, which
   streams the file itself and would otherwise answer first.

Verify with `pnpm test` (both runners) and `pnpm run typecheck`.

### Notes for whoever executes this

- **No `runner-fix: true`, deliberately.** This does edit a file under
  `server/src/agents/`, but only that guard's comment, and nothing a live orchestrator run
  depends on: the run's driver (`orchestrate.mjs`), the reviewer agent and the skills are
  untouched, and the driver never calls this API. Hoisting would buy no protection — the
  API runs under `nest --watch`, so a merge reloads it mid-run wherever this sits in the
  queue.
- **No browser check.** The defect is in a header a page cannot set by hand from the
  devtools console (`Host` is a forbidden header name), so Playwright cannot express the
  repro; the supertest cases above are the executable form of it.

## Outcome

2026-09-12 — Fixed as planned: a `Host` allowlist gating every route, not a third check
inside the origin guard.

`server/src/allowed-hosts.ts` is new and holds both halves — `isAllowedHost(hostHeader,
env = process.env)`, read per request with no cache, and `allowedHostGate`, plain Express
middleware. It accepts any IP literal (`net.isIP`, IPv6 brackets stripped), `localhost`,
any `.ts.net` name matched at a label boundary at the end of the hostname, and anything in
`BM_ALLOWED_HOSTS` (comma-separated, trimmed, lowercased, a leading `.` being a suffix
match). Hostname only, never the port; a trailing dot stripped; an unparseable, empty or
absent `Host` refused. Everything else gets 403 `{ error: 'unrecognised Host header' }`.

The gate answers the response itself rather than throwing an `HttpException` — a
divergence from the plan's wording worth naming. Nest's exception layer wraps controllers,
guards and pipes, not middleware configured through `MiddlewareConsumer`; a throw there
lands in Express's own error handler as a 500 with a stack page. The observable shape is
the one the plan asked for (403, `{ error }`), which is what a caller can see.

`applySecurityHeaders` became `applySecurityMiddleware` and now applies
`consumer.apply(allowedHostGate, securityHeaders)`, gate first, with its two call sites
(`server/src/app.module.ts`, `test/csp.test.ts`) following. `SameOriginPostGuard`'s logic
is untouched — only its header comment, which now names rebinding as the case it does not
close and points at the new file.

### Verification

`pnpm run typecheck`:

```
$ tsc --noEmit
=== EXIT typecheck: 0 ===
```

`pnpm test` (both runners):

```
# pass 535
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 67408.702292

────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.
```

jest's own summary, for the count:

```
Test Suites: 83 passed, 83 total
Tests:       1597 passed, 1597 total
Snapshots:   0 total
Time:        58.831 s, estimated 67 s
```

New suite `test/allowed-hosts.test.ts`, 30 cases: the unit table from the plan verbatim,
plus the integration half against `AppModule` — the rebound dispatch, the rebound
`/api/items/body` read, a rebound `/api/health`, the tailnet Host over both `http` and
`https` origins, `BM_ALLOWED_HOSTS`, and the ordering-against-`ServeStaticModule` case
against a static fixture app. Every pre-existing suite stayed green with no header added
to any of them, which is rule 1 doing exactly what grooming predicted: supertest sends
`Host: 127.0.0.1:<ephemeral port>`.

Contract sweep: 7 sites updated (server/src/agents/origin.guard.ts, CLAUDE.md,
docs/subsystems/invariants.md, docs/subsystems/api.md, docs/overview.md, README.md,
.env.example)

One site left standing on purpose: the `docs-sync: verified:` stamps in
`docs/subsystems/api.md`, `docs/subsystems/invariants.md` and `docs/overview.md` still
name commit `d3dbf88`. This session never commits, so the commit these edits belong to
does not exist yet and there is no sha to stamp. A stale stamp over-reports drift and
never under-reports it, so the next `/docs-sync` finds these three sections already
correct and re-baselines them.

Red proof: 9 tests went red with the change reverted

Three reverts, each by file copy (never `git stash` — the stack is shared with every other
worktree of this repo):

- Gate unregistered from the applier (`consumer.apply(securityHeaders)`) → 4 red, and the
  first of them is the bug itself: `expected 403 "Forbidden", got 201 "Created"` on the
  rebound dispatch, i.e. the attacker's prompt reaching `/api/spawn`.
- Label-boundary suffix match reverted to a substring one → 3 red (`evilts.net`,
  `ts.net.evil.test`, and the `BM_ALLOWED_HOSTS` suffix case).
- Absent/empty `Host` defaulted to allowed → 2 red.
