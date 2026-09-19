---
id: task-49
title: Instance marker — tell two installs apart from the environment
created: 2026-09-19
tags: ui, server, env
---

## Goal

Two machines each run their own instance of this board and the two are pixel-identical, so a tab or a screenshot does not say which one you are looking at.
Give the server two environment variables that mark an install, and draw them where the confusion actually happens: the browser tab, and the app's own chrome.

`BM_INSTANCE=mac` is a free-form, machine-local label. `BM_INSTANCE_MARK=cyan-circle` is one of six hue+shape pairs. Absent `BM_INSTANCE` renders today's app
byte for byte — that is the property the whole change is measured against.

The mark names a **pair** rather than a hue, deliberately: the treatment was chosen over a coloured pill because the marks stay tellable apart at 16 px and
without colour vision, which a hue alone cannot do. A hue-only variable with a shape derived elsewhere would let two installs collide on shape and lose that
silently.

No palette override, no per-instance theme, no Settings control. The marker is host identity; `theme` is a per-device `localStorage` preference, and the two
must not fight.

## Plan

The full plan — nine tasks, the six marks and their tokens/hexes, every test case, the verification steps — is
[docs/superpowers/plans/2026-09-19-instance-marker.md](../../../docs/superpowers/plans/2026-09-19-instance-marker.md). Read it before starting; what follows
is the shape, not a substitute.

1. **Shared vocabulary** — `shared/types.ts` gains `INSTANCE_MARKS` (six ids), `InstanceMark`, `isInstanceMark`, `InstanceInfo`
   (`{ label, mark, note }`) and `INSTANCE_LABEL_MAX` (24).
2. **The route** — new `server/src/instance/`, `GET /api/instance`, always 200, environment read per request and cached nowhere (the `token.util.ts` pattern).
   An unknown mark is reported in `note`, never defaulted to a hue — the posture `resolveSource` takes toward an `unsupported` marker.
3. **One home for what a mark looks like** — `client/src/lib/instance-mark.ts` holds the token, the literal hex and the SVG geometry per mark, and builds both
   the rail glyph and the favicon data URI from it. The favicon cannot read CSS variables (browser chrome paints it), so the colour necessarily exists twice;
   a test reads `shared/theme.css` and asserts the hex matches the token's midnight value, which is the only thing that can catch them drifting.
4. **The hook** — `useInstance`, one fetch at mount, no polling and no refocus re-read: the environment cannot change under a running server.
5. **The rail badge** — an outline plate under `.rail-brand`, inside the existing brand element so it travels to the narrow bar. Outline and not a fill,
   because a fill reads as status and DESIGN.md §8.0 reserves the rail's ornament for decoration that means nothing. Gets its own §8 subsection.
6. **The tab** — title becomes `<label> · Backlog Manager` (prefix, not suffix: a narrow tab truncates the tail, and the tab strip is the surface this was
   asked for), and the `<link rel="icon">` href is swapped. Stamped from React; `client/index.html` is not edited, so `THEME_SCRIPT_SHA256` stays valid.
7. **Settings › Shared** — a read-only `Instance` card first in the right column, above Claude Agents. Two rows, `Label` and `Mark`, both `not set` when
   nothing is configured; the route's `note` is the `Mark` row's hint. Read-only for `TrackersGroup`'s reason: the value lives in the server's environment and
   a control here would be a second writer of it.
8. **Environment** — `docker-compose.yml` passes both through as interpolations with an empty default, never literals (bug-25's rule), pinned in
   `test/compose-env.test.ts`; `.env.example` documents both; `CLAUDE.md` and `docs/subsystems/invariants.md` gain the entry and its anchor.

## Test cases

Seven new suites plus one extended; the plan file carries each one's table in full.

- **`isInstanceMark`** — all six pass; `'cyan'`, `'cyan-square'`, `'CYAN-CIRCLE'`, `''`, `null`, `undefined`, `0`, `{}` all fail. `INSTANCE_MARKS` has six
  members, no duplicates, and **every shape half and every hue half is distinct** — the property the treatment rests on.
- **`GET /api/instance`** (via `listenLoopback`) — unset → all null; mark set with no label → all null; whitespace label → all null; label only →
  `{ label, mark: null, note: null }`; label + valid mark → both, `note: null`; label + garbage mark → `mark: null` and `note` naming the bad value; a 40-char
  label comes back at 24. Plus one case mutating `process.env` between two requests to the same app, which is the assertion that nothing is cached.
- **`instance-mark.ts`** — an entry per `INSTANCE_MARKS` member and no extras; hexes, paths and tokens each distinct; every token declared in all five theme
  blocks of `shared/theme.css`; every hex equal to its token's midnight value, read from that file; `faviconHref` returns a distinct, parseable
  `data:image/svg+xml,` URI per mark.
- **`useInstance`** — one fetch at mount and not a second on re-render; a rejected fetch and a 500 both leave `data: null`.
- **Rail badge** — no label renders no element at all (not an empty one); label with no mark renders the plate and no `<svg>`; label + mark renders the glyph
  `aria-hidden`; the badge is a descendant of `.rail-brand`, so the narrow bar cannot lose it.
- **Tab** — no label leaves title and icon href untouched; label only prefixes the title and leaves the icon; label + mark does both.
- **Settings** — nothing set still renders the card with two `not set` rows; an unknown mark shows the route's `note`; the card is on Shared and not on Local.
- **`test/compose-env.test.ts`** — `BM_INSTANCE` is `['${BM_INSTANCE:-}']` and `BM_INSTANCE_MARK` is `['${BM_INSTANCE_MARK:-}']`. First key pair in that file
  where one name is a prefix of another, so assert the whole-key matching too.

## Done when

- `pnpm test` (both runners), `pnpm run typecheck` and `pnpm run build` are green.
- **With nothing set, the app is unchanged** — no badge, `Backlog Manager` in the tab, stock amber favicon, and the rail is identical to `main`'s. This is the
  check that matters most; every machine that does not opt in must be unaffected.
- With `BM_INSTANCE=mac` and `BM_INSTANCE_MARK=cyan-circle`: the badge, the `mac · Backlog Manager` title, the cyan-circle favicon legible at 16 px, and the
  Instance card on Settings › Shared.
- With `BM_INSTANCE_MARK=nonsense`: the label still renders, the glyph does not, and the Settings card names the bad value.
