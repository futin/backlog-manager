# backlog-manager

Claude Code plugin repo that homes four backlog skills — `backlog`,
`backlog-capture`, `backlog-groom`, `backlog-execute` — plus a local NestJS +
React app that shows every registered project's backlog on one
kanban-by-type board. No database: the registry file and each project's
`backlog/` directory are the data.

## Commands

| Task | Command |
|---|---|
| Whole stack (api + client, no db) | `pnpm run docker:up` |
| Rebuild the stack from scratch | `pnpm run docker:sync` |
| API only, on the host | `pnpm run dev` |
| Client only, on the host | `pnpm run dev:web` |
| Tests | `pnpm test` (jest, `--runInBand`) |
| Skill tests | `pnpm run test:skills` (`node --test skills/*/tools/*.test.mjs`) |
| Types | `pnpm run typecheck` |
| Production build | `pnpm run build` |

Ports: API `4322`, Vite `5177`. Only the host side moves, via `BM_API_PORT` /
`BM_WEB_PORT` in `.env` — inside the compose stack they are fixed.

## Layout

- `server/src/` — Nest. `health/` (`GET /api/health`), `items/`
  (`GET /api/items`, `GET /api/projects`, `GET /api/items/body`), `registry/`
  (read-only view of the registry file), `static.ts` (serves `client/dist`
  when built — conditionally, so a missing bundle means "API only", never a
  catch-all with nothing behind it).
- `client/src/` — React SPA: side rail (Projects / Settings — a plain section
  switch), the board (toolbar with search plus project/status/sort selects,
  four fixed columns — bugs/ideas/tasks/out-of-scope — each card opening a
  read-only drawer that renders the item's Markdown body), Settings (five
  themes, density, text scale, landing section).
- `shared/` — `types.ts` (`Section` / `ItemStatus` / `BacklogItem` /
  `ItemsIndex` / `ProjectSummary` / `Registry`, defined once and imported by
  both sides), `theme.css` (the five theme palettes as CSS custom
  properties).
- `skills/backlog/`, `skills/backlog-capture/`, `skills/backlog-groom/`,
  `skills/backlog-execute/` — the skills this repo publishes.
- `skills/backlog/tools/backlog.mjs` — the CLI every skill calls, and the
  registry's only writer.
- `backlog/` — this repo's own file-based backlog, one Markdown file per
  item, self-registered like any other project.
- `docs/superpowers/` — design spec and implementation plan.

## Invariants

- **`skills/` is the plugin skill root**; never duplicate it under
  `.claude/skills/` — a copy there loads the same skills twice and drifts.
- **`~/.backlog-manager/registry.json` has exactly one writer**:
  `skills/backlog/tools/backlog.mjs` (its `init`/`new` upsert). The server
  re-reads it per request, never writes, never caches.
- **Item files are read-only to the server and client**; every write goes
  through the skills.
- **Every server route lives under `/api`**; the Vite proxy has exactly one
  entry, asserted by `test/vite-proxy.test.ts`.
- **Item bodies are served through an allowlist** built from the registry
  (`allow.util.ts`); a file outside every registered `backlog/` 404s.
- **Groomed is derived** (bug: Cause+Fix filled and not "unknown"; task: Plan
  non-empty), never stored; status is the directory, never frontmatter.
- **Ports 4322/5177** — guide-manager holds 4321/5175/5176 on this machine.
- **Both processes bind `127.0.0.1` by default and both compose ports publish
  on `127.0.0.1`.** Nothing in this stack has auth in front of it — the
  item-body route reads every registered project's backlog files straight off
  disk — so loopback is the access control. `BM_BIND` is the single knob for
  the bind (`main.ts` and `vite.config.ts` read the same variable);
  `docker-compose.yml` sets it to `0.0.0.0` in both services because there the
  loopback *publish* is the boundary and a container-loopback bind would just
  hide the port. Reach it from another device with your own `tailscale serve`
  in front of the loopback port, which is also what makes
  `allowedHosts: ['.ts.net']` in `vite.config.ts` meaningful — that list is
  never consulted for a bare IP, so it protects nothing on a wildcard bind.
- **Container mounts land on host paths, read-only**, because the registry
  stores absolute host paths.
- **pnpm only**, pinned by `packageManager`, enforced via corepack in the
  image.
- **`allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`**; a skipped build
  surfaces as Vite failing to start.
- **Editing `vite.config.ts` needs `docker compose restart client`.**
- **Backlog items move `open/` → `done/`; `out-of-scope/` is flat.**

## Conventions

- Comments explain *why*, at length, and the existing density is deliberate —
  match it rather than stripping it.
- Tests are flat in `test/`, `*.test.ts` / `*.test.tsx`; component suites opt
  into jsdom with a `@jest-environment jsdom` docblock. Skill tests live next
  to the tool they cover (`skills/*/tools/*.test.mjs`) and run under
  node's own test runner, not jest.
