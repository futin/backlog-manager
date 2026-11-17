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

1. **↑/↓ buttons per skill row + a whole-order write route** — picked. Matches Settings › Dashboards and the Orchestrate order step (§7.5 chose ↑/↓ over
   drag-and-drop), no new dependency, keyboard-reachable, trivially testable in jsdom.
2. Drag-and-drop rows — rejected: breaks the repo's ↑/↓ precedent and needs a DnD library or hand-rolled HTML5 drag code jsdom can't exercise well.
3. Per-browser order in Local settings — rejected: the list itself is per-machine, so two browsers would show the same skills in different orders.

## Design

- **Route:** `POST /api/jira/skills/order`, body `{ ids: string[] }`, `SameOriginPostGuard`, `requireConfigured()`, through `this.writing(...)` like the other
  skill routes. Answers `{ ok: true }`.
  - 400 when `ids` is not an array of non-empty strings, or holds a duplicate.
  - 409 (the server's sentence says the list changed — reload) when `ids` is not exactly the set of string ids the file's raw `skills` entries hold:
    a missing id, an extra id, or an unknown one. Nothing is written.
  - The writer (`config.util.ts`, beside `deleteSkill`) works on the RAW entries, as `deleteSkill` does: entries are rewritten in `ids` order; a raw entry
    without a string `id` (half-broken) keeps its relative order after the ordered ones. Other keys of each entry and of the file are untouched.
- **Card (`JiraSkillsGroup`):** each skill row gets `↑` and `↓` `Chip`s (`variant="flat"`, `size={28}`, `aria-label="Move <name> up|down"`) before
  `Make default`; `↑` disabled on the first skill, `↓` on the last, both while `busy` or while that row's remove `Confirm` is open. A click swaps the
  neighbours and sends the full order through the card's existing `write()` — same busy guard, same reload-on-success, same error line under the add row.
- **Run menu:** no change; it already follows the array.
- **Docs/comments:** update the counts and lists that name the config write routes (`jira-write.controller.ts`, `jira.module.ts`, `config.util.ts` header,
  the card's header comment, and any doc under `docs/` that enumerates the skill routes).

## Tests

- Server (`test/jira/`): a valid reorder rewrites the file in the new order and keeps extra keys; missing id → 409; extra/unknown id → 409; duplicate → 400;
  non-array / empty-string id → 400; a half-broken entry stays after the ordered ones; unconfigured → the same answer the other skill routes give.
- Client: first row's ↑ and last row's ↓ are disabled; clicking ↓ on the first of three POSTs `{ ids: [b, a, c] }` and reloads; a refused write shows the
  server's sentence and draws no local reorder.
- Run `grep -l` over `test/` for each new symbol / route string (guard suites that count routes) and include the hits in the scoped run.

## Left to the builder

Exact error wording, where the writer sits in `config.util.ts`, and the CSS (reuse the Dashboards ↑/↓ styling if it fits the row).
