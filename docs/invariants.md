# Invariant rationale

The rules live in [CLAUDE.md](../CLAUDE.md); this file keeps the full
reasoning behind the ones whose "why" runs longer than the rule. Most of
these encode a failure that already happened or an attack that was closed
deliberately — read the relevant section before changing one.

## `started:` and `phase:` are the lifecycle keys in frontmatter, and neither is a status

The `status:` ban stands (both parsers still throw on it), unaffected by
either of these keys — a second answer to "which directory holds this file"
is the competing source of truth the ban exists to prevent, and neither
lifecycle key answers that question. `started` answers a different one — is
someone on this right now — and an item carrying it is still an open item in
`<section>/open/`. `phase` answers a narrower, shorter-lived question on top
of that: *which* activity currently holds the `started:` marker, `groom` or
`execute`. It has no meaning and no lifespan of its own — it is written
alongside `started:` only when `start` is called with `--as`, and `stop`
always removes it, in the same call that decides what happens to
`started:`. That one-way coupling is deliberate, not an oversight: a `phase`
that could outlive its `started:` as a live marker, or go stale
independently of it, would be a second axis an item's "where is it in its
lifecycle" depended on — exactly the ambiguity the `status:` ban already
exists to close off, reopened one key over. It was a *two*-way coupling —
`phase:` and `started:` removed together, never separately — until Task 7's
`stop --keep-started` deliberately broke the other direction: it removes
`phase:` same as any stop, but leaves `started:` behind, because at that
point `started:` has already stopped being a live marker and become the
archived item's record of when work began — a `phase:` still naming an
activity would misdescribe finished work as ongoing, so it is exactly the
value that must not survive, while `started:` surviving is the whole point.
`stop` never takes an `--as` of its own for this reason — it reads `phase:`
back off the file instead, the one place that can't disagree with itself.
Surfaced raw by the scanner; "in progress" is
`started !== '' && status === 'open'`, decided in the client, because
archiving deliberately keeps the value as history (see below).

`start`/`stop` are still the only two commands that rewrite an existing
item's content — `move` renames and never opens the file — so both must
round-trip unknown keys and the body byte-for-byte, and both stamp
`updated:` while doing it, inside `writeItemFile`, the one function they
both funnel through rather than each writing that line itself (a caller
added later can't forget a convention it never has to know about). `move` is
deliberately excluded from that stamp — opening a file just to change one
line would reintroduce the exact risk the plain `renameSync` exists to
avoid. Every skill path that moves an item calls `stop` immediately
beforehand — `backlog-groom`'s moves (an idea promoted to `done/`, anything
rejected to `out-of-scope/`), `backlog-execute`'s abandonment path, and now
`backlog-execute`'s own successful archive too (see the next paragraph) — so
`updated:` is never more than one function call older than the move that
follows it, for every path there is.

Two skills call `start`/`stop`, holding the marker for different spans, and
`backlog-execute` now calls two different shapes of `stop`. `backlog-groom`
holds the marker for one groom session — `start --as groom` once the item
and the verdict are both confirmed, `stop` again once that verdict's steps
finish, or as soon as the session ends without a verdict at all, so an
abandoned groom never leaves a stamp nothing will clear — billing whatever
elapsed into `groom-elapsed:` every time it does. `backlog-execute` picks an
item up with `start --as execute` and holds the marker until the work is
either parked or archived. Walking away without archiving calls plain
`stop`: it bills the session into `execute-elapsed:` and clears `started:`
along with `phase:`, because nobody is working the item anymore and there is
nothing left to date. Archiving instead calls `stop --keep-started`: it
bills the same way and still drops `phase:`, but leaves `started:` in place,
because a `move ... done` is about to follow and the archived item should
still record *when the work began*, not merely *that* it did — the same
historical value a bare `started:` has always carried for this skill, now
sitting alongside the elapsed total instead of standing in for it. Either
skill can stamp an idea now: the original reasoning for refusing one — "an
idea has nothing to execute" — held for execute but not for groom, since
deciding an idea's verdict is itself the active work the marker exists to
describe. None of this widens who writes the file: `backlog.mjs` is still
the single writer, `start`/`stop` are still the only two commands that touch
an existing item's content, and the round-trip guarantee above covers both
callers identically.

`groom-elapsed:` and `execute-elapsed:` are permanent, accumulating integer
counters — one whole-seconds total per activity, never reset, growing by one
more `stop`'s worth each time that activity picks the item back up again.
`stop` only adds to a bucket when the item has a recognized `phase:`
(nothing to bill against otherwise — a plain `start` with no `--as` leaves
both `started:` and every bucket alone) and when `started:` is the full
second-precision timestamp shape, never the legacy bare date: UTC midnight
is not the hour anyone began work, so treating a bare date as billable would
fabricate up to 24 hours nobody worked — the marker is still cleared, just
never billed. The seconds added are floored at zero, to cover clock skew
between whatever machine wrote `started:` and whatever machine is now
calling `stop`: two machines a few seconds apart must never bill negative
time just because the second one's clock reads slightly behind the first's.
And a bucket that already holds something other than a plain unsigned
integer — a hand-edit, or a value some older, buggier build left behind —
makes `stop` refuse outright rather than reset it to zero: resetting would
silently destroy whatever real total was recorded there, and a refusal at
least leaves the bad value in the file for a human to recover by hand.

The `started:` value is a second-precision UTC timestamp
(`2026-08-28T14:03:07Z`), not a date, because the useful resolution for "is
anyone on this right now" is minutes and hours: a bare date rounded
everything picked up today to `0d`, which is precisely the work the marker
exists to surface, and read as "nothing has happened yet". UTC because the
value is compared against `Date.now()` on whatever machine renders the
board.

Both timestamp shapes are on disk permanently. Every file stamped before
`phase:` and elapsed billing existed carries a bare `YYYY-MM-DD`, and no
command rewrites an existing item's frontmatter on its own initiative — so
this is not a migration window that closes, and a reader that drops the
date-only branch breaks real files. A bare date is aged in DAYS ONLY
(`today`, then `Nd`): UTC midnight is not the hour anyone started work, so
reading `14h` off `2026-08-26` would be inventing it. `elapsedSince` in
`client/src/lib/item-age.ts` is the one implementation of both branches.

## Editing `skills/` changes nothing until commit + push + `plugin:sync`

A plugin install is a copy, not a link: Claude Code loads
`~/.claude/plugins/cache/backlog-manager-marketplace/backlog-manager/<version>/`,
never the working tree. The drift is silent — `started` shipped in `fcd3d16`
and the installed plugin sat on the first commit for weeks. The marketplace
source is the private repo `futin/backlog-manager` over SSH,
sparse-checked-out to `.claude-plugin skills`, which is why an install is
~400KB instead of the ~215MB a `directory` source copied (`node_modules` and
`dist` included — the CLI honours no ignore file; checked against 2.1.246,
and it rejects a `file://` source, so a local-only git source is not on the
table). Git is therefore the publishing boundary: the installer sees pushed
commits and nothing else, so `plugin:sync` refuses a dirty `skills/`, an
unpushed HEAD, or a HEAD behind `origin/main` rather than installing stale
code and reporting success. It never commits or pushes for you. It also
uninstalls and reinstalls rather than calling `claude plugin update`: that
command compares the version in `plugin.json` and stops at "already at the
latest version" however far the commit behind it has moved, and the cache
directory is keyed by version, so the alternative would be a patch bump —
another commit, another push — on every skills edit. A reinstall from a
sparse source is cheap enough that the bump buys nothing. It no-ops when
the installed copy already matches HEAD, verifies the landed `skills/` by
hash, and prunes older version copies — skipping any marked `.in_use`,
which a running session still has open. New skills load on the next Claude
Code restart, not in the session that ran the sync.

## Loopback bind is the access control (except where noted)

Nothing in this stack has auth in front of it — the item-body route reads
every registered project's backlog files straight off disk — so loopback is
the access control. `BM_BIND` is the single knob for the bind (`main.ts` and
`vite.config.ts` read the same variable); `docker-compose.yml` sets it to
`0.0.0.0` in both services because there the loopback *publish* is the
boundary and a container-loopback bind would just hide the port. Reach it
from another device with your own `tailscale serve` in front of the loopback
port, which is also what makes `allowedHosts: ['.ts.net']` in
`vite.config.ts` meaningful — that list is never consulted for a bare IP, so
it protects nothing on a wildcard bind. With `BM_AGENTS` on, that bind is no
longer standing in front of a read surface alone: it also fronts a POST that
spawns a Claude Code session with file-write permission in another repo.
That is a boundary a browser inside the loopback does not respect at all,
which is exactly why the origin and content-type guard on those two routes
exists — the bind and the guard cover different attackers, and neither
substitutes for the other.

## The served build carries a CSP; dev does not

`server/src/security.ts` sets the header from Nest, so it rides on
`client/dist` and on `/api` alike. It is deliberately not a `<meta>` tag in
`client/index.html`: that would apply in dev too, where Vite injects an
inline React-refresh preamble a strict `script-src` would block. Dev binds
loopback only, so the build is where the policy earns its keep. `script-src`
carries the sha256 of the pre-paint theme script instead of
`'unsafe-inline'` — edit that script and `test/csp.test.ts` goes red until
`THEME_SCRIPT_SHA256` follows.

## Dispatch derives the action; it never accepts one

`shared/agent.ts` is the single derivation (`deriveAction`), imported by the
board to label a button and by the server to validate a request — one
implementation, so a button can never promise what the API refuses.
`POST /api/agents/dispatch` re-scans the item file and 409s when the
request's action disagrees, which is the groomed invariant enforced on the
only side that can read the file. The prompt is the one field whose
client-supplied content is taken outright — `action` is checked against the
file rather than trusted, `permissionMode` is clamped to the dashboard's
ceiling, and `model`/`effort` go through `pickFrom` against the mirrored
`MODELS`/`EFFORTS` lists — so editing the prompt in the launch sheet is the
actual point of the sheet. Those last two drop rather than clamp or reject:
there is no ladder to clamp along and nothing in the item file to check
against, and `undefined` is what makes `JSON.stringify` omit the key, which
is what makes the dashboard omit the flag — so a name this build has not
heard of costs that flag, never the launch, which is the failure mode a
duplicated list has to survive. Note the controller rebuilds the dispatch
body field by field, so a new field reaches the service only when it is
added there too.

## The browser never talks to the dashboard

`connect-src 'self'` forbids it and the bearer token must not be in a page,
so every call goes board → this API → dashboard. `BM_AGENTS_URL` is env-only
and never client-supplied: there is deliberately no request shape in which a
browser names the host this server will call. `BM_AGENTS` defaults to off,
so an unconfigured install makes no outbound request at all.

## A project the dashboard cannot see cannot be dispatched to

Its `POST /api/spawn` takes a `dirName` resolved against projects active
inside its `LOOKBACK_HOURS` (24 by default), so a quiet repo has no key to
send. Accepted, not worked around: the alternative is teaching that app to
take an absolute path, which widens the widest write surface it has. This is
the one block that leaves a control on screen: the button's own `title` and
its visually-hidden `aria-describedby` span carry the per-item reason (it
names the path, and nothing else in the UI does), while Settings lists the
host-level setup — including the two fixes for this one, a session in that
repo or a higher `LOOKBACK_HOURS`. Environment-level blocks render no button
at all; see the `dispatchGate` section below. Never derive a `dirName` from
a path to route around this. The membership check behind it
(`status.projectPaths.includes(item.projectPath)`, in `dispatchGate`,
`shared/agent.ts`) is a raw string compare, not a realpath one, even though
`agents.service.ts` already calls `realpathSync` elsewhere for its own item
lookup and could afford one here too: `dispatchGate` is one implementation
the board also runs in a browser, which has no filesystem to resolve a
symlink with, so the server side stays just as literal rather than let the
two sides risk giving different answers. Known consequence: a registered
project whose path reaches its git root through a symlink can show a
disabled button even with a live session inside `LOOKBACK_HOURS`, if the
dashboard's own recorded path and the registry's do not match byte-for-byte.

## Environment-level blocks hide the dispatch control; per-item disables it

`dispatchGate` (`shared/agent.ts`) answers with
`hidden` / `disabled` / `enabled`, and `dispatchBlock` is the flattened
string form of the same ladder for the two callers that only refuse (the
launch sheet's re-check and the server's). Dispatch off, dashboard
unreachable, no `CLAUDE_BIN`, remote answers off — none of those is about
any one card, all four are true of every card at once, and none is fixable
from the board, so they render no button. That is what makes the promise in
the spec and `.env.example` — with `BM_AGENTS` off the board "renders
exactly as it does today" and "shows no dispatch buttons" — literally true;
do not "improve" it into a disabled button on forty cards. The
project-visibility block is the opposite case and keeps its button.

## The two agents POSTs are guarded by content-type and origin

(`server/src/agents/origin.guard.ts`) — this is the one place in the app
where loopback is NOT the access control. Nest registers
`express.urlencoded` on every app it builds, and
`application/x-www-form-urlencoded` is a content type a cross-origin HTML
form posts with no CORS preflight — so before this guard, any page in the
developer's browser could auto-submit a hidden form at
`/api/agents/dispatch` and spawn a session with an attacker-written prompt.
The browser is already inside the loopback boundary; a bind cannot help.
Both halves are load-bearing: a non-`application/json` content type is
refused (which forces a preflight there is deliberately no `enableCors` to
answer), and a present `Origin` that is not this request's own host is
refused (which is what closes `Origin: null` from a sandboxed iframe).
Absent `Origin` stays allowed — curl and every server-side test send none.
`GET /api/agents/status` is deliberately outside it, like every other GET
here. Known consequence: a TLS-terminating proxy in front of this that
rewrites `Host` without rewriting `Origin` will 403 — the guard compares
host and port only, not the scheme, precisely so a `tailscale serve` that
preserves `Host` keeps working.

## Launch sheet model/effort pickers seed from Settings, never the last launch

`dispatchDefaultModel` / `dispatchDefaultEffort`
(`client/src/lib/settings.ts`, mirroring the dashboard's own
`spawnDefaultModel` / `spawnDefaultEffort`) are per-device like every other
key there, default to `''` — no flag, the CLI decides — and are clamped
against the same `MODELS`/`EFFORTS` the sheet renders, so a stored name can
never be one the selects cannot show. Remembering the *last pick* stays
rejected: a sticky `max` from last week quietly spending on a trivial groom
is the failure a per-launch control exists to prevent, and a default you set
once in a row you can go and read is the opposite arrangement. Permission
mode deliberately has no stored default — it comes from the server's
`plan.defaultMode` and is clamped to the host ceiling, and a remembered mode
would fight that ladder. That server-side default is `auto`, because a
dispatched session runs unattended: nobody is necessarily at the terminal the
permission prompt would appear on, so a lower rung means a session that stops
on its first unapprovable tool call and silently does nothing. `auto` is not
the top rung — `bypassPermissions` stays a per-launch choice, since asking for
the most a host allows by default is how a convenience becomes an incident —
and the ceiling clamps `auto` down on a dashboard that caps lower, so this
never widens a stricter host.

## `linkBase` is per-device and becomes an href

`clampSettings` routes it through `clampOrigin`, which parses it as a URL —
the browser's own parser, not a regex — and rejects any scheme but
`http(s)`. It is the one settings key a hand-edited localStorage value could
turn into script execution.
