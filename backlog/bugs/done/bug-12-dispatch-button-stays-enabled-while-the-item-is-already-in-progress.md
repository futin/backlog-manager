---
id: bug-12
title: Dispatch button stays enabled while the item is already in progress
created: 2026-09-01
tags: board, dispatch
updated: 2026-09-03T11:44:21Z
groom-elapsed: 41
started: 2026-09-03T11:27:52Z
execute-elapsed: 989
---

## Symptom

A card whose item is live work in progress — `started:` stamped on the file by a
running `backlog-groom` or `backlog-execute` session, i.e. `isInProgress(item)`
true — still renders an enabled dispatch button, on the card and in the drawer.
Clicking it spawns a *second* session against the same item, so two skill
sessions hold the same file at once: both may `start`/`stop` it, both may move
it, and the second `stop` bills a `started:` the first one already cleared.

This is the same double-dispatch an orchestrator run is already protected from.
`runClaimBlock` (`shared/agent.ts`) exists precisely because a run's claim
cannot be read off the item file — the work happens in a worktree and `main`'s
copy looks untouched. The locally-started case is the opposite: the claim IS on
the item file, `started:` is right there, and nothing reads it as a block.

## Repro

1. Board on any project with an open, groomed bug or task.
2. Dispatch it once (or run `backlog.mjs start <id>` by hand) so the file
   carries `started:` and `phase:`.
3. Reload the board. The card shows the amber in-progress bar
   (`progressLabel`) — and the dispatch button next to it is still enabled,
   with its normal `dispatch <action> to a Claude session` title.
4. Click. A second session launches for the same item.

## Affects

- `client/src/components/board/DispatchButton.tsx:90` — `blocked` reads exactly
  two per-item blocks (`dispatchGate` reason, then `runBlock`); nothing there
  consults `isInProgress`.
- `client/src/lib/item-progress.ts:13` — `isInProgress`, the predicate the card
  already renders its bar from, unused by the dispatch path.
- `shared/agent.ts` — `runClaimBlock` / `dispatchBlock`: the block vocabulary
  this one is missing from, and where the server's own refusal is derived.
- `client/src/components/board/ItemCard.tsx:389`,
  `client/src/components/board/ItemDrawer.tsx:267`,
  `client/src/components/archive/ArchiveView.tsx:268` — the three call sites.

## Cause

The block vocabulary was built one blocker at a time, and each new one was
added where its *data* came from. `dispatchGate` reads `AgentsStatus`, so its
four environment lines and one project line live in `shared/agent.ts`.
`runClaimBlock` reads the run payload, so it went there too and is handed to
`DispatchButton` as a prop, because the leaf has no run data. Both are things
the item file cannot answer.

"A local session already holds this item" is the one blocker the item file
*can* answer — `started:` is written by `backlog.mjs start` and cleared by
`stop`, and `isInProgress` (`client/src/lib/item-progress.ts`) already derives
it for the card's amber bar. Nothing ever wired that predicate into the
dispatch path: `DispatchButton`'s `blocked` line (`DispatchButton.tsx:90`)
coalesces exactly two reasons and stops. So the board renders the in-progress
bar and an enabled dispatch button on the same card, one telling the reader a
session holds this item and the other offering to start a second one.

The skills themselves are already protected — `start <id>` refuses any file
that carries a `started:` stamp, which is why the second session does not
double-`start`. What it does instead is worse-shaped: `backlog-groom` hits
"already in progress" and has to run the whole "find out whose marker it is"
conversation about a marker set ninety seconds ago by a session the user
launched from the same board, and `backlog-execute` refuses outright. The cost
is a wasted spawn and a confusing refusal, not a corrupted file — but the board
is the thing that invited it.

## Fix

One derived, client-side block, mirroring `runClaimBlock`'s role for the
locally-started case. Groomed decisions: shared helper + client only (the board
is the only surface that can double-dispatch — the server's dispatch re-scan
stays as it is), and the block does **not** care how old the stamp is, matching
`backlog.mjs start`'s own rule that any stamp refuses, fresh or stale.

1. **`client/src/lib/item-progress.ts` — new `progressBlock(item)`**, returning
   `string | null`. Null unless `isInProgress(item)`; otherwise a reason built
   from `progressLabel(item)` and `item.started`, reading
   `a session is already working this item (executing since <stamp>)` — the
   parenthetical is what varies, so the sentence stays grammatical for all
   three `progressLabel` answers including the bare `in progress` fallback.
   It goes in this module and not in `shared/agent.ts` on purpose:
   `isInProgress` and `progressLabel` are already here, `shared/` must not
   import from `client/`, and hoisting the pair into `shared/` would be a move
   the server has no use for while the block stays client-only.

2. **`DispatchButton.tsx` — derive it, do not add a prop.** Unlike `runBlock`,
   the fact is on the item this component already holds, so all three call
   sites (`ItemCard`, `ItemDrawer`, `ArchiveView`) get it with no signature
   change.

3. **Order: environment → project visibility → in progress → run claim.** The
   new reason reads BEFORE `runBlock`, extending the existing
   most-fundamental-first rule by the same logic that put the run claim last:
   the stamp is on the file this board is rendering, the run claim is a
   volatile fact about another worktree. The two coexist only pathologically
   (a run works in its own worktree, so `main`'s copy of a claimed item
   normally carries no stamp at all), and when they do, the file wins.
   Update the ordering comment above `blocked` and the file header's "There
   are TWO per-item blocks" line — there are three.

4. `aria-disabled` + the `onClick` guard + the `aria-describedby` reason span
   all already key off `blocked !== null`, so nothing else in the component
   changes and the disabled *look* comes from the existing styling.

5. **CLAUDE.md** — the dispatch-block invariant says "There are two per-item
   blocks and both keep their button". It becomes three, and the third is the
   only one derived from the item file itself.

### Test cases

Unit, `test/item-progress.test.ts`:

- open item, `started: ''` → null.
- open item, `started` set, `phase: 'execute'` → reason contains `executing`
  and the stamp verbatim.
- same with `phase: 'groom'` → contains `grooming`.
- same with `phase: ''` → contains `in progress`, still grammatical.
- `status: 'done'` with `started` set → null (the archived stamp is history —
  the same reason `isInProgress` checks status at all).

Component, `test/dispatch-button.test.tsx`, all with a reachable status whose
`projectPaths` includes the item's project:

- open groomed task with `started` set → button IS rendered, `aria-disabled`
  is `"true"`, `title` is the reason, the `sr-only` span holds it, and a click
  does not call `onDispatch`.
- same item with `runBlock` also supplied → the rendered reason is the
  in-progress one, not the run one (ordering, step 3).
- in-progress item whose project the dashboard cannot see → the reason names
  the dashboard, not the session (project visibility still outranks it).
- in-progress item with `BM_AGENTS` off in the status → still renders nothing
  at all, unchanged.
- open item with no `started` → enabled exactly as today, click dispatches.

Browser check:

In the browser (playwright MCP tools): open the board at
`http://127.0.0.1:5177`, find a card showing the amber in-progress bar (mark
one with `backlog.mjs start <id> --as execute` first, and clear it with
`stop --abandon` afterwards), and confirm its dispatch tab renders with
`aria-disabled="true"` and a title naming the running session, and that
clicking it opens no launch sheet.

### Done when

`pnpm test` and `pnpm run typecheck` pass, and the board cannot offer a second
dispatch for an item a session already holds.

## Outcome

2026-09-03 — Fixed as groomed, all five steps. `progressBlock(item)` is new in
`client/src/lib/item-progress.ts`: null unless `isInProgress(item)`, otherwise
`a session is already working this item (<progressLabel> since <started>)`, so
one sentence stays grammatical across `grooming` / `executing` / the bare
`in progress` fallback, and the stamp is printed verbatim because that is what
is literally on disk. It blocks on any stamp, fresh or stale, matching
`backlog.mjs start`'s own rule; `isInProgress`'s `status === 'open'` half is
what stops an archived item's historical stamp from blocking forever.

`DispatchButton` derives it rather than taking a prop — the fact is on the item
the component already holds — so `ItemCard`, `ItemDrawer` and `ArchiveView` all
get it with no signature change. Order is now environment → project visibility
→ in progress → run claim: the file-derived block outranks the run claim
because the stamp is on the copy this board is rendering while the claim is a
volatile fact about another worktree. The component's file header, its
`blocked` ordering comment, the `aria-disabled` comment and the `sr-only`
comment all said "two blocks" and now say three, and the CLAUDE.md
dispatch-block invariant was updated to match.

Nine tests added, watched failing first. The five `progressBlock` unit cases
failed on the missing export; three of the six component cases failed on the
live behaviour (`aria-disabled` still `false`, `onDispatch` still called, the
run reason winning over the session one). The other three component cases —
project visibility still outranking the new block, the environment still
hiding the control outright, and an unstarted item still dispatching normally
— passed before the change as well as after, which is exactly their job as
ordering guards.

Verification, `pnpm run typecheck` then `pnpm test`:

```
$ pnpm run typecheck
$ tsc --noEmit
EXIT_TYPECHECK=0

$ pnpm test
Test Suites: 53 passed, 53 total
Tests:       828 passed, 828 total
Snapshots:   0 total
Time:        39.7 s
```

Browser check, done against this worktree's own stack rather than the running
docker one (which serves the main checkout, where this item carries no
`started:` stamp at all): API on 4399 with `BM_REGISTRY_FILE` pointed at a
temporary registry naming only this worktree, Vite on 5199. The real dashboard
on 4321 reports `remoteAnswer:false, spawnAvailable:false, projectPaths:[]`,
which is an ENVIRONMENT-level block that hides every dispatch button, so the
upstream `/api/health` and `/api/management` were stubbed on 4390 to report a
reachable dashboard that can see this worktree; the API and the client under
test were the real ones. This item's own card — amber, reading `executing 11m`
— rendered:

```
{ "label": "execute▸",
  "ariaDisabled": "true",
  "title": "a session is already working this item (executing since 2026-09-03T11:27:52Z)",
  "card": "executing11mDispatch button stays enabled while the item is " }
```

and clicking it opened no launch sheet (`sheetOpen: false`). Every other card
on the board was untouched: `aria-disabled: "false"`, title
`dispatch <action> to a Claude session`. The temporary registry, the stub and
both processes were removed afterwards; `git status` shows only the six
intended files.
