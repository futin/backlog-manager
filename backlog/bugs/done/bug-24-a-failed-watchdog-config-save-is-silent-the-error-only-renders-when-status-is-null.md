---
id: bug-24
title: A failed watchdog config save is silent: the error only renders when status is null
created: 2026-09-06
tags: ui, settings, audit-2026-09-06
updated: 2026-09-12T19:13:57Z
groom-elapsed: 215
groom-tokens: 62147
started: 2026-09-12T18:56:05Z
execute-elapsed: 1072
execute-tokens: 128302
---

## Symptom

A rejected `POST /api/agents/watchdog/config` produces no visible message anywhere. The
select keeps showing the old value and the user believes the setting stuck.

`useWatchdog`'s `save()` catch sets `error` and leaves `status` untouched — correctly, the
failure was on the write, not the read. But `WatchdogGroup` gates its only render of
`error` behind `status === null`, and `status` is still populated. There is no toast, alert
or error banner anywhere in `client/src`, so nothing else catches it either.

This directly contradicts the file's own header argument, which says a setting that cannot
be seen to fail to stick is worse than one that refuses outright.

## Repro

1. Open Settings › Orchestrator watchdog with the API reachable, so `status` populates.
2. Make `POST /api/agents/watchdog/config` fail (stop the API, or return a non-2xx —
   `updateWatchdogConfig`, `client/src/lib/agents.ts:525`, throws on non-2xx or a malformed
   body).
3. Change any of the four knobs.

The select snaps back to the stored value with no message.

## Affects

- `client/src/hooks/useWatchdog.ts:113-121` — the `save()` catch: `setError` only, `status`
  left populated
- `client/src/components/settings/WatchdogGroup.tsx:129` — `status === null` gate on the
  only `error` render (message at `:136`)
- `client/src/components/settings/WatchdogGroup.tsx:175-222` — the four
  `config.*`-controlled selects that keep showing the old value
- `client/src/components/settings/WatchdogGroup.tsx:44-50` — the header comment this
  behaviour contradicts
- `client/src/lib/agents.ts:525` — `updateWatchdogConfig`, the throwing call

## Cause

One `error` state serving two failure kinds that need different placements, and only one
of them has a render site.

- `useWatchdog` keeps a single `error` field. `reload()`'s catch writes it
  (`client/src/hooks/useWatchdog.ts:101-108`) and `save()`'s catch writes the same field
  (`:118-122`), correctly leaving `status` alone — the failure was on the write, not the
  read.
- `WatchdogGroup` reads `error` in exactly one place: inside `if (status === null)`
  (`client/src/components/settings/WatchdogGroup.tsx:129-143`), where it is appended to
  the "Unavailable" notice at `:136`. Nothing below that early return ever mentions
  `error`.
- `status` is never reset to `null` once a GET has succeeded — neither catch touches it —
  so from the first successful mount fetch onward the only branch that renders `error` is
  permanently unreachable. A save failure therefore has no render site at all.
- The select "snapping back" is not a second defect: all four controls are controlled off
  `status.config` (`:174`, `:185`, `:200`, `:216`), and a failed save leaves `status` at
  the last value the server actually returned. The value on screen is correct; what is
  missing is anything saying the change was refused.
- Nothing else catches it either. `client/src` has no toast or alert host — the only
  live-region role in the whole client is `role="status"` on the board's empty state
  (`client/src/App.tsx:129`) — and `updateWatchdogConfig`
  (`client/src/lib/agents.ts:588-598`) throws on a non-2xx (via `unwrap`, `:60-68`, whose
  `ApiError` carries the server's own `error` string), on a rejected fetch, and on a
  malformed 200 body, so all three arrive in that same dead-ended catch.

A load failure (`status === null`) legitimately replaces the whole group; a save failure
must render *beside the control*, with `status` intact — and the render site only handles
the first.

## Fix

Split the two failures in the hook and give the save failure its own render site that
does not require `status === null`. Of the three shapes the audit left open — a second
state field, a discriminated `error` value, per-control placement — this takes the second
state field *carrying the field name*, which buys per-control placement without changing
`error`'s meaning for the hook's other consumer (`WatchdogMonitor` never calls `save`, so
it needs no change at all).

**1. `client/src/hooks/useWatchdog.ts` — a second state field.**

Return one more field beside `status`/`error`/`reload`/`save`:

```ts
saveError: { field: keyof WatchdogConfig | null; message: string } | null
```

Rules, all of which the cases below pin:

- `save(patch)` clears `saveError` synchronously *before* its `await`, so a retry never
  displays the previous attempt's message while the new POST is in flight.
- `save`'s catch sets `saveError` and touches neither `status` nor `error`. `field` is the
  first key of `patch` (`Object.keys(patch)[0]`, narrowed to `keyof WatchdogConfig`) —
  every control posts exactly one key — and `null` when `patch` is empty. `message` is the
  same string the current catch computes.
- `save`'s success path clears `saveError` as well as `error`, as today.
- `reload`'s success path clears `error` only and deliberately leaves `saveError`
  standing. The mount fetch and the focus refetch fire on their own schedule; a window
  switch must not erase the one line telling the user their change never stuck, and the
  refreshed `config` is what makes that line *true* rather than stale. The next save
  attempt is the only thing that clears it.
- Both writes keep the existing `mountedRef.current` guard.

**2. `client/src/components/settings/WatchdogGroup.tsx` — one render site, chosen by a
pure function.**

Export, so a test can pin it without a DOM:

```ts
export function saveErrorSlot(field: keyof WatchdogConfig | null):
  'enabled' | 'tickMs' | 'graceMs' | 'maxAttempts' | 'end'
```

It returns the field's own slot for the four known keys and `'end'` for `null` or anything
it does not recognise. That total-by-construction fallback is the point: a message with no
matching row must still land somewhere, because a `saveError` that renders nowhere is
precisely the bug being fixed, and an unrecognised field is how it would come back.

Render the message as its own row — `<div className="set-row set-error-row" role="alert">`
— immediately after the `SettingsRow` whose slot matches, and after the last row for
`'end'`. The text is one line, naming no setting (its position does that):

> Not saved — {message}. The value shown is the one still on the server.

Exactly one such row is rendered, and only when `saveError !== null`. The `status === null`
branch at `:129` is unchanged — its "Unavailable" notice stays the load failure's render
site — and so is the `{ live: false }` call, the ladders, and all four controls.

**3. `client/src/styles.css` — `.set-error-row` / `.set-error`**, beside the other `.set-*`
rules (~`:558-570`). `var(--red)`, matching `.run-controls-error`'s posture for a real
failure rather than `.sheet-error`'s amber: this is a write the server refused, not a
warning about a run that still starts. Font size tracks `.set-hint` (10.5px).

**4. Out of scope, deliberately:** a GET that fails *after* a first success is also silent
in this group (`error` set, `status` populated, nothing rendered) — but Settings only
reloads on mount and on focus, and what it leaves on screen is the last real server value,
not a lie about a change the user just made. `WatchdogMonitor` (`:81`, `:107-117`) gates
its own `error` render the same way and is a live view whose staleness has other tells.
Neither changes here. Nothing in `client/src/lib/agents.ts`, `server/` or `shared/` changes
either.

### Test cases

The reason this survived: `test/settings-watchdog.test.tsx` stubs only successful POSTs
(`:254`, `:303`) and only a rejecting GET (`:341`), and `test/watchdog-hook.test.tsx`'s
cases reject only `fetchWatchdog` (`:148`), never `updateWatchdogConfig`. Every case below
is a failing POST.

`test/watchdog-hook.test.tsx` (mount GET succeeds with `status('idle')` in all five; the
POST is overridden per case with `mockImplementationOnce`):

1. **A non-2xx POST lands in `saveError` and nowhere else.** POST resolves
   `{ ok: false, status: 500, json: () => ({ error: 'watchdog.json is read-only' }) }`;
   after `save({ tickMs: 120_000 })`: `saveError` equals
   `{ field: 'tickMs', message: 'watchdog.json is read-only' }`, `error` is `null`, and
   `status` still deep-equals the mounted status (`config.tickMs` still
   `DEFAULT_WATCHDOG_CONFIG.tickMs`).
2. **A rejected POST lands there too.** POST rejects `new Error('network down')`;
   `saveError.message` is `'network down'`, `saveError.field` is `'maxAttempts'` for
   `save({ maxAttempts: 4 })`, `status` unchanged, `error` `null`.
3. **An empty patch reports a `null` field rather than dropping the message.**
   `save({})` against a rejecting POST: `saveError.field` is `null` and
   `saveError.message` is a non-empty string.
4. **A later successful save clears it.** Fail `save({ tickMs: 120_000 })`, then succeed on
   `save({ tickMs: 300_000 })` with a 200 carrying that config: `saveError` is `null` and
   `status.config.tickMs` is `300_000`.
5. **A successful reload leaves it standing.** Fail a save, then dispatch a `window`
   `focus` event answered by a successful GET: `error` is `null`, `status` is the refetched
   value, and `saveError` is still the object from case 1.

`test/settings-watchdog.test.tsx` — `stubFetch` needs one addition: let `onConfigPost`
return either a `WatchdogStatus` (as today, so cases 7/8 are untouched) or a failure
marker — the string `'reject'` for a rejected promise, or `{ status: number; body: unknown }`
for a non-2xx response routed through the same `json()` shape `jsonOk` uses.

6. **A refused save renders a message and keeps every knob.** GET returns the default
   config; POST answers 500 with `{ error: 'watchdog.json is read-only' }`. Select `'3'`
   on "Give up after": an element with `role="alert"` appears whose text contains
   `Not saved` and `watchdog.json is read-only`; the select still reads `'2'`; all four
   controls are still in the document; `Could not reach the watchdog` is **not**.
7. **The message sits in the failing control's row.** Same setup as 6;
   `screen.getByRole('alert').previousElementSibling` must contain the element returned by
   `screen.getByLabelText('Give up after')`. This is the assertion that would fail on a
   group-level banner, which is what makes "beside the control" a tested claim rather than
   a comment.
8. **The checkbox path behaves identically.** POST answers 500; click "Enabled": the
   checkbox is still `checked`, and the alert is present.
9. **A later successful save removes the message.** After case 6's failure, re-stub the
   POST to succeed with `maxAttempts: 4` and select `'4'`: `queryByRole('alert')` is
   `null` and the select reads `'4'`.
10. **`saveErrorSlot` is total.** A plain unit case, no DOM: each of the four keys returns
    its own slot; `null` returns `'end'`; an unrecognised string (cast) returns `'end'`.

Run `pnpm test` (both runners) and `pnpm run typecheck`.

In the browser (playwright MCP tools): open `http://127.0.0.1:5177/` with the API up, go to
Settings and wait for the "Orchestrator watchdog · this server" group to render its four
knobs (so the GET has succeeded and `status` is non-null — the exact state that makes the
bug reachable). Then evaluate a snippet that wraps `window.fetch` so a POST to
`/api/agents/watchdog/config` resolves as a 500 with body
`{"error":"watchdog.json is read-only"}` while every other request passes through. Change
"Give up after" to `3`. Expected: a red line reading `Not saved — watchdog.json is read-only.
The value shown is the one still on the server.` appears directly beneath the "Give up
after" row, the select still shows `2`, and the other three knobs are untouched. Reload the
page (dropping the fetch wrapper) and change the same knob again: the save succeeds, the
select shows the new value and no message is rendered.

## Outcome

2026-09-12 — Fixed as planned: `useWatchdog` gained a second state field
`saveError: { field, message } | null`, and `WatchdogGroup` renders it as its own
`role="alert"` row directly under the control whose save was refused, chosen by the
exported total function `saveErrorSlot`. The `status === null` load-failure branch, the
`{ live: false }` call, the three ladders and all four controls are untouched, as are
`client/src/lib/agents.ts`, `server/` and `shared/`. `.set-error-row`/`.set-error`
(`var(--red)`, 10.5px) were added beside the other `.set-*` rules.

Nine test cases were added, all written before the code and all watched fail first:
five in `test/watchdog-hook.test.tsx` (non-2xx POST, rejected POST, empty patch → `field:
null`, a later success clears it, a successful reload leaves it standing) and four in
`test/settings-watchdog.test.tsx` (a refused save renders and keeps every knob, the
message sits in the failing control's own row, the checkbox path behaves identically, a
later success removes it), plus a DOM-free case pinning `saveErrorSlot`'s totality.
`stubFetch`'s `onConfigPost` now also accepts `'reject'` or `{ status, body }`; its
success shape is unchanged, so the pre-existing cases are untouched.

Verification — `pnpm run typecheck` then `pnpm test` (both runners), on the final tree:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm test
Test Suites: 83 passed, 83 total
Tests:       1607 passed, 1607 total
# tests 535
# pass 535
# fail 0
PASS  jest
PASS  node --test (skills)
pnpm test: both runners passed.
```

Browser check (playwright, API on 4399 + Vite on 5199 so the user's own stack on
4322/5177 was never touched; both killed by pid afterwards). Settings → Orchestrator
watchdog rendered its four knobs (so the GET had succeeded and `status` was non-null —
the exact state that made the bug unreachable before). With `window.fetch` wrapped to
answer the config POST 500 `{"error":"watchdog.json is read-only"}`, changing "Give up
after":

```
alertText:            "Not saved — watchdog.json is read-only. The value shown is the one still on the server."
alertColor:           rgb(224, 83, 63)      (var(--red))
prevSiblingHasSelect: true                  (the row above the alert is the "Give up after" row)
giveUpAfter:          "3"                   (unchanged — the server's own value)
checkEvery/grace/enabled: unchanged
unavailableNotice:    false                 (the group did not collapse into the load-failure notice)
```

Reloading without the wrapper and changing the same knob to 4 saved for real: no alert
rendered and the select read `4`. That real save wrote `maxAttempts: 4` into
`~/.backlog-manager/settings/watchdog.json`; it was restored to its prior `3` immediately
afterwards and the file was re-read to confirm.

Contract sweep: 3 sites updated (docs/subsystems/board.md — the Settings section now
states that the one group that writes to the server is also the one that can be refused,
and how that reads; client/src/components/settings/WatchdogGroup.tsx — the header's
"a setting that cannot be seen to fail to stick is worse than one that refuses outright"
argument now names bug-24 as the same argument arriving from the refusal side, the save
paragraph names the new row, and the `status === null` comment says where a failed SAVE
lands instead; test/settings-watchdog.test.tsx — a comment citing `useWatchdog.ts:88-97`
for `save`, already stale and made staler by this diff, now cites the function by name
with no line numbers). Left standing on purpose: `docs/superpowers/plans/` and
`docs/superpowers/specs/` still record the old four-field `useWatchdog` return shape
(`{ status; error; reload; save }`, e.g. `2026-09-04-orchestrator-watchdog.md:360`,
`2026-09-05-watchdog-monitor.md:89`). Those are the historical plan and spec documents
this repo was built from, not live reference docs — rewriting them would falsify the
record of what was designed at the time. `docs/subsystems/board.md`'s docs-sync stamp was
deliberately NOT re-baselined: its `verified:` sha must name a commit, and this session
does not commit.

Red proof: 9 tests went red with the change reverted. With `save`'s catch restored to
`setError(...)` in `useWatchdog.ts` (file copied aside, restored from the copy — never
`git stash`), all five new hook cases failed and the nine pre-existing ones stayed green.
With the hook restored and only the five `{errorRow(...)}` render sites removed from
`WatchdogGroup.tsx`, the four new DOM cases failed and the thirteen pre-existing ones
stayed green. The tenth new case (`saveErrorSlot`'s totality) stays green under that
second variant by design — it pins a pure function that variant still exports; its own
red was the `TS2305: has no exported member 'saveErrorSlot'` this suite failed with
before the function existed.
