---
id: bug-24
title: A failed watchdog config save is silent: the error only renders when status is null
created: 2026-09-06
tags: ui, settings, audit-2026-09-06
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

One `error` state serving two failure kinds that need different placements. A load failure
(`status === null`) legitimately replaces the whole group; a save failure must render
*beside the control*, with `status` intact — and the render site only handles the first.

## Fix

unknown — the shape is separating the two errors so a save failure has its own render site
that does not require `status === null`. Whether that is a second state field, a discriminated
`error` value, or per-control error placement is the open call. Whichever is chosen, add the
case that is missing: `test/settings-watchdog.test.tsx` stubs only successful PATCHes
(`:254`, `:303`) and only a rejecting GET (`:341`), and `test/watchdog-hook.test.tsx`'s nine
cases reject only `fetchWatchdog` (`:148`), never `updateWatchdogConfig` — which is why this
survived.
