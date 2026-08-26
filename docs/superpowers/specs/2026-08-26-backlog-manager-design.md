# backlog-manager — design

**Status: approved 2026-08-26.**

A home for the four backlog skills (`backlog`, `backlog-capture`, `backlog-groom`,
`backlog-execute`), published as a Claude Code plugin, plus a local NestJS + React
app that shows the backlog of every registered project on one board — the same
shape as `../guide-manager`, with backlog items in place of guides.

## Goals

- One board, all projects: every open bug, idea, task, and out-of-scope item
  across every repo that uses the backlog store.
- JIRA-style overview: all item types visible at once, grouped by type.
- Skills move out of `~/.claude/skills/` into this repo and install as a plugin.
- Later (out of scope for v1, but the layout must not fight them): filtering by
  project, search by name — the toolbar ships in v1 since the pattern is already
  built in guide-manager.

## Non-goals (v1)

- No editing items from the UI. Writes stay with the skills; the app is read-only.
- No database. The files are the store.
- No auth. Same trust model as guide-manager: local machine + tailnet.

## Data model (existing, unchanged)

A backlog store is a `backlog/` directory at a repo root:

| Section       | Prefix | Lifecycle    |
|---------------|--------|--------------|
| bugs          | bug    | open → done  |
| ideas         | idea   | open → done  |
| tasks         | task   | open → done  |
| out-of-scope  | oos    | flat         |

One Markdown file per item. Frontmatter: `id`, `title`, `created`, optional
`tags`. Status is the directory (`open/` vs `done/`), never a field. Body
headings are fixed per section:

- bug: `## Symptom`, `## Repro`, `## Affects`, `## Cause`, `## Fix`
- idea: `## Problem`, `## Rough shape`, `## Open questions`
- task: `## Goal`, `## Plan`, `## Test cases`, `## Done when`
- out-of-scope: `## What was proposed`, `## Why rejected`, `## What would change the answer`

**Groomed** is derived, not stored: a bug is groomed when `## Cause` and `## Fix`
are filled (not `unknown`); a task is always groomed (capture refuses a task
without a real plan); ideas and out-of-scope have no groomed state.

## Registration

`~/.backlog-manager/registry.json` lists the projects on the board:
`{ name, path, createdAt }` per entry — `name` = git-root basename, `path` = git
root, absolute.

**Exactly one writer: `backlog.mjs`.** Its `init` and `new` subcommands upsert
the entry for the current repo as a side-effect. Any repo touched by
`backlog-capture` appears on the board automatically; no manual registration.
The server re-reads the registry per request and never writes it — a project
registered mid-session shows up without a restart (guide-manager invariant,
kept).

## Repo layout

pnpm workspace, mirroring guide-manager:

- `skills/` — the four skills, moved in from `~/.claude/skills/`.
  `skills/backlog/tools/backlog.mjs` comes with them. Skills reference the tool
  via `${CLAUDE_PLUGIN_ROOT}` instead of `~/.claude/skills/backlog/`.
  `.claude-plugin/plugin.json` + marketplace manifest publish the repo as the
  `backlog-manager` plugin. `skills/` is the plugin skill root — never duplicate
  under `.claude/skills/`.
- `server/src/` — NestJS, no Mongo:
  - `registry/` — read-only view of the registry file, re-read per request.
  - `items/` — walks each registered project's `backlog/`, parses frontmatter +
    sections, serves the index and item bodies.
  - `static.ts` — serves `client/dist` when built.
- `client/src/` — React SPA: `SideRail` (Projects | Settings), `BoardView`,
  `ItemDrawer`, `SettingsView`, hooks (`usePersistedState`, `useSettings`,
  `useItems`).
- `shared/` — `types.ts` (registry + API shapes), `theme.css` (the five themes,
  copied).
- `backlog/` — this repo eats its own dog food.
- `docs/superpowers/` — this spec + implementation plans.

## API

Three routes:

- `GET /api/projects` — registry entries + per-project open counts. A registered
  path that no longer exists (or has no `backlog/`) is returned flagged as
  missing, not silently dropped — a disappeared backlog is information.
- `GET /api/items` — the flat index:
  `{ project, projectPath, section, status, id, title, created, tags, groomed, path }`
  per item, plus `errors[]` naming any malformed files that were skipped. The
  board renders the partial index and shows a warning — same semantics as
  `backlog.mjs board` exit 1.
- `GET /api/items/body?path=…` — raw Markdown of one item, lazy-fetched by the
  drawer. The path must resolve inside a registered project's `backlog/`
  (allowlist built from the registry per request, guide-manager
  `resolveAllowed` pattern); anything else 404s.

No server-side filtering: the whole index is a few hundred rows of
title-and-date, and the toolbar narrows it client-side over the array already in
memory (guide-manager rationale, kept verbatim).

## Board UI (chosen design: kanban by type)

Four columns, fixed order: **Bugs · Ideas · Tasks · Out of scope**. Each column
header carries its count. Column contents scroll independently.

Toolbar above the board (guide-manager's `guides-tools` pattern):

- search — titles only, plain `useState`, deliberately not persisted;
- project select — `all` sentinel default, persisted;
- status select — `open` (default) / `done` / `all`, persisted. Out-of-scope is
  flat and unaffected by it;
- sort — newest first (default) / by name / by project, persisted.

Unmatched persisted project falls back to All, visibly (select and board agree).
Two distinct empty states: nothing registered vs. no matches.

**Card** — guide-manager `.guides-card`, ported verbatim: bordered flex-column,
13px/600 title on top, `margin-top:auto` footer with an outline type pill
(`pill-bug` red, `pill-idea` mustard, `pill-task` blue-ish, `pill-oos` gray —
outline + ink only, no tinted fills, composes with every theme) and a mono meta
line `id · project · created`. Groomed bugs get a small marker; ungroomed reads
as the default state, not a warning. Whole card is the tap target
(`role="button"`).

## Item drawer

Click a card → right-side drawer, ~480px, over the board; board stays mounted
behind it. ESC and backdrop click close it. At ≤700px it becomes a full-width
overlay (guide-manager viewer pattern).

Content: header with id pill, title, project name, created date, file path;
body is the item's Markdown rendered to HTML (sections exactly as authored).
Read-only. Body is fetched on open, not carried in the index.

## Settings

Same machinery as guide-manager (`settings.ts`, flat object in
`localStorage['backlog-manager.settings']`, `clampSettings` coercion,
per-device on purpose), minus the three bionic fields:

- theme — the five themes (Midnight Radar default);
- density — comfortable / compact;
- text size — fontScale 90–120 stops;
- opens on — last / projects / settings.

## Infra

- docker-compose: `api` + `client` only (no Mongo service). Read-only host
  mounts for the project roots, because the registry stores absolute host paths.
- Tailnet hostnames allowlisted in `vite.config.ts` (`allowedHosts: ['.ts.net']`).
- Every path the server answers appears in the Vite proxy list, asserted by a
  test (guide-manager invariant, kept).
- Ports: own trio, movable via `.env` (`BM_API_PORT` / `BM_WEB_PORT`).
- pnpm only, pinned via `packageManager` + corepack.

## Error handling

- Malformed item file → skipped, named in `errors[]`, partial board + warning.
- Registered project with missing path or missing `backlog/` → flagged entry in
  `/api/projects`, shown on the board as a degraded project row.
- Registry file missing/unreadable → empty board with the "nothing registered
  yet" state, not a 500.

## Testing

jest, flat in `test/`, `*.test.ts(x)`, component suites opt into jsdom via
docblock:

- parser: frontmatter, section headings, groomed derivation, malformed files;
- registry: per-request re-read, missing file, missing project paths;
- items e2e (supertest): index shape, errors[], body route + allowlist 404s;
- board: filtering/sort/status interactions, empty states (jsdom);
- drawer: open/close, lazy body fetch (jsdom);
- vite-proxy assertion test.

## Migration / rollout

1. This repo starts as a fresh git repo (`git init` is step one of the plan).
2. Skills copied in, paths rewritten to `${CLAUDE_PLUGIN_ROOT}`, registration
   side-effect added to `backlog.mjs`.
3. Plugin installed from the marketplace manifest; the copies under
   `~/.claude/skills/` are then removed by hand (user step — flagged at the end
   of implementation).
4. Existing projects appear on the board the first time any backlog skill runs
   in them; a one-off `backlog.mjs register` walk is deliberately not built —
   YAGNI, `init` upsert covers it.
