# Jira skills: user-set order

Short design (small change). Approved in conversation 2026-11-17.

## Intent

The person wants the skills under Jira › Setup › Skills — and therefore in every card's `Run ▾` menu — in the order they actually use them, not the order they
were added. Today `jira.json`'s `skills` array is append-only from the UI's side: `POST /api/jira/skills` pushes a new skill to the end, `/skills/delete`
removes one, and nothing moves one. Both `JiraSkillsGroup` and `JiraRunMenu` draw the array as stored.

## Goals / non-goals

- Goal: move any skill up or down in Setup; the new order is stored and every reader (Setup card, Run menu, every browser on this machine) follows it.
- Non-goal: reordering the two built-ins (`Work it end to end`, `Open with the ticket loaded`) — they stay pinned under `Built in`, above the skills.
- Non-goal: a per-browser order. The list is the machine's (`jira.json`), so its order is too.
- Anti-goal: a client-side optimistic order that can disagree with the file — the card keeps drawing only what `GET /api/jira` returns.

## Approaches

1. **↑/↓ buttons per skill row + a whole-order write route** — picked. Matches Settings › Dashboards and the Orchestrate order step
   (`docs/superpowers/specs/2026-09-05-orchestrate-question-mode-design.md` §7.5 chose ↑/↓ over
   drag-and-drop), no new dependency, keyboard-reachable, trivially testable in jsdom.
2. Drag-and-drop rows — rejected: breaks the repo's ↑/↓ precedent and needs a DnD library or hand-rolled HTML5 drag code jsdom can't exercise well.
3. Per-browser order in Local settings — rejected: the list itself is per-machine, so two browsers would show the same skills in different orders.

## Design

- **Route:** `POST /api/jira/skills/order`, body `{ ids: string[] }`, `SameOriginPostGuard`, `requireConfigured()`, through `this.writing(...)` like the other
  skill routes. Answers `{ ok: true }`.
  - 400 `ids must be an array of non-empty strings` when `ids` is missing, not an array, or holds a non-string or empty string; 400
    `ids holds <id> twice` when one id appears twice in the body.
  - "The current ids" are the distinct ids of the entries `readSkill` ACCEPTS — exactly what `GET /api/jira` shows the card — not every raw string id. A
    hand-edited entry the reader drops (empty name, bad id, not an object) is therefore never required in `ids` and can never wedge the route.
  - 409 `the skill list changed since this page loaded — reload and try again; nothing was written` when the set of `ids` is not exactly the current ids:
    a missing id, an extra id, or an unknown one. Nothing is written. A dedicated error class, mapped to 409 like `JiraConfigUnreadableError` — `writing()`
    gains a third mapped error. 409 rather than the per-id 404 `unknown skill`: the whole list is stale, not one id. A stale tab holding the same set in an
    older order passes and overwrites another tab's reorder — last write wins, accepted for one person's machine. An unreadable file is the writers' 409.
  - Nothing to move → `{ ok: true }`, nothing written and no file created: `ids` already in the stored order (including `ids: []` against a file with no
    accepted skills, a missing file, or a non-array `skills`).
  - The writer (`config.util.ts`, beside `deleteSkill`) works on the RAW entries: for each id in `ids`, every raw entry whose `id` equals it (a hand-edit can
    duplicate an id; `readList` returns both, `deleteSkill` removes both) is placed there, keeping their relative order. Every other raw entry — no id, or
    one `readSkill` drops — keeps its relative order after the ordered ones. Other keys of each entry and of the file are untouched; written through
    `writeJsonAtomic`. The card builds `ids` from `data.skills` with duplicates dropped (first occurrence), so a duplicated id never trips the 400.
- **Card (`JiraSkillsGroup`):** each skill row gets `↑` and `↓` `Chip`s (`variant="flat"`, `size={28}`, `aria-label="Move <name> up|down"`) before
  the `Make default` / `default` slot (built-ins, drawn by the same `row()` helper, get none); `↑` disabled on the first skill, `↓` on the last, both while `busy` or while that row's remove `Confirm` is open. A click swaps the
  neighbours and sends the full order through the card's existing `write()` with the fallback `the order was not saved` — same busy guard, same
  reload-on-success, same error line under the add row (`<fallback> (HTTP <status>)` / `<fallback> — the server did not answer` when the body has no sentence).
  A refused move (409 included) leaves the drawn list until the next refetch, as a refused remove does today — accepted; the sentence says to reload.
- **Run menu:** no change; it already follows the array.
- **Docs/comments:** this is a seventh config writer and the first that reorders rather than merging ONE entry, so the rule that says "the six writers …
  and nothing else … merge ONE entry" must name it and its contract: `.claude/rules/jira.md` (the writers paragraph), the matching section of
  `docs/subsystems/invariants.md`, the writers banner at `config.util.ts` (~line 270), `jira-write.controller.ts` and `jira.module.ts` headers,
  `docs/subsystems/jira.md` (module table, writers section, Setup card line) and `docs/subsystems/api.md` (the guarded-POST count), and the card's header
  comment.

## Tests

- Server (`test/jira/`): a valid reorder rewrites the file in the new order and keeps extra keys; missing id → 409; extra/unknown id → 409; duplicate in
  the body → 400 naming it; non-array / empty-string id → 400; an entry `readSkill` drops (empty name, id `s_x`) is not required in `ids` and stays after
  the ordered ones; two raw entries sharing one id move together; an unchanged order and `ids: []` with a missing file write nothing (no file created);
  an unreadable file → 409 unchanged; unconfigured → the same answer the other skill routes give.
- Client: first row's ↑ and last row's ↓ are disabled; clicking ↓ on the first of three POSTs `{ ids: [b, a, c] }` and reloads; a refused write shows the
  server's sentence and draws no local reorder.
- Run `grep -l` over `test/` for each new symbol / route string (guard suites that count routes) and include the hits in the scoped run.

## Left to the builder

Where the writer sits in `config.util.ts`, the error class's name, and any CSS the row needs (the Dashboards arrows are bare `Chip`s with no class).
