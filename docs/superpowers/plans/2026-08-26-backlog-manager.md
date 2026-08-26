# Backlog Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home the four backlog skills in this repo as a Claude Code plugin, and build a NestJS + Vite/React app that shows every registered project's backlog on one kanban-by-type board with a right-hand item drawer.

**Architecture:** pnpm single-package workspace mirroring `../guide-manager`: `skills/` is the plugin skill root, `server/src/` is a NestJS API with no database (the registry JSON plus each project's `backlog/*.md` files are the store, re-read per request), `client/src/` is a React SPA served by Vite in dev and by Nest's ServeStatic in prod. `skills/backlog/tools/backlog.mjs` is the registry's only writer; the server only reads.

**Tech Stack:** Node ≥22.13, pnpm 11 (corepack), NestJS 11, Vite 5 + React 18, TypeScript strict, jest + ts-jest (+ jsdom for component suites), node:test for the skills tool, marked for drawer markdown, docker compose (2 services, no Mongo).

**Spec:** `docs/superpowers/specs/2026-08-26-backlog-manager-design.md`

## Global Constraints

- Reference implementation for every ported file is `../guide-manager` (absolute: `/Users/andrejajevtic/Documents/custom-projects/guide-manager`). Copy means: read the source file, write it here, then apply ONLY the listed changes.
- pnpm is the only package manager; `packageManager: "pnpm@11.13.0"`, `engines.node >= 22.13`, enforced via corepack in Docker.
- Ports: API `4322`, web `5177` (guide-manager already holds 4321/5175/5176 on this machine). Host-side overrides: `BM_API_PORT`, `BM_WEB_PORT`.
- Registry: `~/.backlog-manager/registry.json`, shape `{ "projects": [{ "name", "path", "createdAt" }] }`. Env override: `BM_REGISTRY_FILE`. Written ONLY by `skills/backlog/tools/backlog.mjs`.
- localStorage keys are prefixed `backlog-manager.` (settings, section, project, status, sort).
- All server routes live under `/api` — that keeps the Vite proxy list to one entry, asserted by test.
- `skills/` is the plugin skill root. Never create `.claude/skills/` copies.
- Item files are never written, moved, or edited by the server or client. Read-only everywhere except backlog.mjs.
- Comments explain *why*, at guide-manager's density. Tests live flat in `test/`, `*.test.ts(x)`; component suites opt into jsdom via `@jest-environment jsdom` docblock. Skill-tool tests are node:test `.test.mjs` files next to the tool.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (end state)

```
.claude-plugin/plugin.json          plugin manifest
.claude-plugin/marketplace.json     marketplace manifest
skills/backlog/SKILL.md             + tools/backlog.mjs (+ backlog.test.mjs)
skills/backlog-capture/SKILL.md
skills/backlog-groom/SKILL.md
skills/backlog-execute/SKILL.md
shared/types.ts                     registry + API shapes
shared/theme.css                    5 palettes, copied verbatim
server/src/main.ts                  bootstrap, port 4322
server/src/app.module.ts            Config + Items + conditional static
server/src/static.ts                serves client/dist when built
server/src/health/health.controller.ts
server/src/registry/registry.service.ts   read-only registry view
server/src/registry/registry.module.ts
server/src/items/parse.util.ts      frontmatter + sections + groomed
server/src/items/scan.util.ts       walk one project's backlog/
server/src/items/allow.util.ts      body-route allowlist
server/src/items/items.service.ts
server/src/items/items.controller.ts      GET /api/projects, /api/items, /api/items/body
server/src/items/items.module.ts
client/index.html                   pre-paint theme stamp
client/src/main.tsx                 fonts + styles + mount
client/src/App.tsx                  SideRail + section switch
client/src/styles.css               ported + board/drawer styles
client/src/components/SideRail.tsx
client/src/components/board/BoardView.tsx
client/src/components/board/ItemCard.tsx
client/src/components/board/ItemDrawer.tsx
client/src/components/settings/SettingsView.tsx
client/src/components/settings/SettingsRow.tsx
client/src/hooks/usePersistedState.ts
client/src/hooks/useSettings.tsx
client/src/hooks/useBoard.ts
client/src/lib/settings.ts
test/*.test.ts(x)                   flat, per suite below
vite.config.ts / tsconfig*.json / nest-cli.json / jest.config.ts
package.json / pnpm-workspace.yaml / .gitignore / .env.example
Dockerfile / docker-compose.yml / README.md / CLAUDE.md
```

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.ts`, `.gitignore`, `.env.example`

**Interfaces:**
- Produces: the install + script surface every later task runs against (`pnpm test`, `pnpm run test:skills`, `pnpm run typecheck`, `pnpm run build`, `pnpm run dev`, `pnpm run dev:web`).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "backlog-manager",
  "private": true,
  "version": "0.1.0",
  "packageManager": "pnpm@11.13.0",
  "engines": {
    "node": ">=22.13"
  },
  "scripts": {
    "build": "pnpm run build:server && pnpm run build:client",
    "build:server": "nest build",
    "build:client": "vite build",
    "start": "node dist/server/src/main.js",
    "dev": "nest start --watch --no-shell",
    "dev:web": "vite",
    "test": "jest --runInBand",
    "test:skills": "node --test skills/backlog/tools/",
    "typecheck": "tsc --noEmit",
    "docker:up": "docker compose up --build -d",
    "docker:down": "docker compose down",
    "docker:sync": "pnpm run docker:down && docker volume rm -f backlog-manager_backlog-manager-node-modules && pnpm run docker:up"
  },
  "dependencies": {
    "@fontsource/barlow": "^5.3.0",
    "@fontsource/barlow-condensed": "^5.3.0",
    "@fontsource/ibm-plex-mono": "^5.3.0",
    "@nestjs/common": "^11.2.1",
    "@nestjs/config": "^4.0.4",
    "@nestjs/core": "^11.2.1",
    "@nestjs/platform-express": "^11.2.1",
    "@nestjs/serve-static": "^5.0.5",
    "marked": "^16.4.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.24",
    "@nestjs/schematics": "^11.1.0",
    "@nestjs/testing": "^11.2.1",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@types/express": "^5.0.6",
    "@types/jest": "^29.5.14",
    "@types/node": "^20.19.43",
    "@types/react": "^18.3.31",
    "@types/react-dom": "^18.3.7",
    "@types/supertest": "^6.0.3",
    "@vitejs/plugin-react": "^4.7.0",
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "supertest": "^7.2.2",
    "ts-jest": "^29.4.12",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.3",
    "vite": "^5.4.21"
  }
}
```

This is guide-manager's `package.json` with: name/ports renamed; `@nestjs/mongoose`, `mongoose`, `mongodb-memory-server` removed (no database); `marked` added (drawer markdown); `test:skills` script added (node:test cannot ride jest — `backlog.mjs` is ESM and ts-jest compiles to CJS).

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
# pnpm's settings file. Single package — no `packages:` list — but pnpm 11
# reads workspace-level settings from here, and allowBuilds is not optional:
# pnpm runs no dependency install script unless the dependency is named here.
#
#   esbuild   downloads and links the platform binary Vite compiles with;
#             without it `vite` dies at startup.
#
# guide-manager also allows mongodb-memory-server here; this repo has no
# database, so esbuild is the only entry.
allowBuilds:
  esbuild: true
```

- [ ] **Step 3: Write `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.ts`**

Copy all four from `../guide-manager` (same filenames, repo root) verbatim — they carry no project name. `jest.config.ts` keeps `setupFiles: ['reflect-metadata']` and `testMatch: ['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx']` — node:test `.mjs` files under `skills/` never match, so the two runners stay disjoint.

- [ ] **Step 4: Write `.gitignore`**

```
registry.json
node_modules/
*.log
.DS_Store
.idea/

# build output
dist/
*.tsbuildinfo

# local env
.env

# client build output
client/dist/

# claude code local state — scoped, not a blanket .claude/: this repo publishes
# itself as a plugin, so anything shared there stays trackable.
.claude/worktrees/
.claude/settings.local.json
```

- [ ] **Step 5: Write `.env.example`**

```
# Copy to .env and adjust. The server reads these through @nestjs/config.

# HTTP port for the API and the built client bundle. 4322 because guide-manager
# already holds 4321 on this machine.
PORT=4322

# Absolute path to the registry backlog.mjs writes. Defaults to
# ~/.backlog-manager/registry.json when unset.
# BM_REGISTRY_FILE=/Users/you/.backlog-manager/registry.json

# Host-side ports for `docker compose up`. Only needed when something else on
# this machine already holds one — inside the stack the ports are fixed.
# BM_WEB_PORT=5177
# BM_API_PORT=4322

# The tree `docker compose up` mounts read-only into the server container so
# registered projects resolve. Defaults to ~/Documents/custom-projects. Widen it
# only if you keep backlogs elsewhere — a project the container cannot see is
# reported as missing on /api/projects, not silently dropped.
# BM_PROJECT_ROOT=/Users/you/Documents/custom-projects
```

- [ ] **Step 6: Install and verify**

Run: `pnpm install`
Expected: lockfile written, no build-script warnings other than none (esbuild is allowed).

Run: `pnpm run typecheck`
Expected: PASS (nothing to check yet compiles trivially — `tsconfig.json` includes globs that match no files; if tsc errors on "no inputs", create `shared/types.ts` in Task 2 first and re-run, then fold both into one commit).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json nest-cli.json jest.config.ts .gitignore .env.example
git commit -m "chore: pnpm workspace scaffold (nest + vite, no db)"
```

---

### Task 2: Shared types and theme

**Files:**
- Create: `shared/types.ts`
- Create: `shared/theme.css`

**Interfaces:**
- Produces: `Section` (`'bugs' | 'ideas' | 'tasks' | 'out-of-scope'`), `ItemStatus` (`'open' | 'done' | 'terminal'`), `RegistryProject { name; path; createdAt }`, `Registry { projects }`, `BacklogItem`, `ItemsIndex { items; errors }`, `SectionCounts`, `ProjectSummary` — consumed by every server and client task.

- [ ] **Step 1: Write `shared/types.ts`**

```ts
/** The registry file's shape — written only by skills/backlog/tools/backlog.mjs,
 *  read by the server. */
export interface RegistryProject {
  /** basename of the project's git root — display name on the board */
  name: string;
  /** absolute path of the project's git root */
  path: string;
  /** first registration, ISO string; never rewritten on later upserts */
  createdAt: string;
}

export interface Registry {
  projects: RegistryProject[];
}

/** The four store sections. Directory names, verbatim — these strings are the
 *  contract with backlog.mjs's SECTIONS map, not display labels. */
export type Section = 'bugs' | 'ideas' | 'tasks' | 'out-of-scope';

/** An item's status IS the directory it lives in (open/ vs done/), never a
 *  frontmatter field — backlog.mjs rejects a status: key outright. out-of-scope
 *  is flat and terminal. */
export type ItemStatus = 'open' | 'done' | 'terminal';

export interface BacklogItem {
  id: string;
  title: string;
  /** YYYY-MM-DD from frontmatter; '' when the file lacks one (still renderable) */
  created: string;
  tags: string[];
  section: Section;
  status: ItemStatus;
  /** display name of the owning project (registry `name`) */
  project: string;
  /** registry `path` of the owning project — the stable key for filtering:
   *  two checkouts of one repo share a name but never a path */
  projectPath: string;
  /**
   * Derived, never stored. bugs: `## Cause` and `## Fix` both filled (not
   * "unknown"). tasks: `## Plan` non-empty (capture refuses a task without
   * one, so this is effectively always true). ideas / out-of-scope: null —
   * groomed is not a state they have.
   */
  groomed: boolean | null;
  /** absolute path of the item's file — the key /api/items/body takes */
  path: string;
}

export interface ItemsIndex {
  items: BacklogItem[];
  /** malformed files skipped during the scan, one message per file, each
   *  prefixed with the file's absolute path — same semantics as
   *  `backlog.mjs board` exiting 1 with a partial board */
  errors: string[];
}

export type SectionCounts = Record<Section, number>;

export interface ProjectSummary {
  name: string;
  path: string;
  createdAt: string;
  /** registered path no longer has a backlog/ directory (or is gone entirely).
   *  Reported rather than hidden: a disappeared backlog is information. */
  missing: boolean;
  /** open items per section (out-of-scope counts its terminal items) */
  counts: SectionCounts;
}
```

- [ ] **Step 2: Copy `shared/theme.css`**

Copy `../guide-manager/shared/theme.css` verbatim (all 5 `[data-theme]` palettes plus the alias blocks). No changes — the tokens carry no app name.

- [ ] **Step 3: Verify and commit**

Run: `pnpm run typecheck`
Expected: PASS

```bash
git add shared/
git commit -m "feat: shared registry/API types and theme palettes"
```

---

### Task 3: Skills move-in + plugin manifests

**Files:**
- Create: `skills/backlog/SKILL.md`, `skills/backlog/tools/backlog.mjs`, `skills/backlog-capture/SKILL.md`, `skills/backlog-groom/SKILL.md`, `skills/backlog-execute/SKILL.md` (copies from `~/.claude/skills/`)
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces: `skills/backlog/tools/backlog.mjs` at its new path — Task 4 edits it; the four SKILL.md files reference it via `$CLAUDE_PLUGIN_ROOT`.

- [ ] **Step 1: Copy the four skills in**

```bash
mkdir -p skills
cp -R ~/.claude/skills/backlog skills/backlog
cp -R ~/.claude/skills/backlog-capture skills/backlog-capture
cp -R ~/.claude/skills/backlog-groom skills/backlog-groom
cp -R ~/.claude/skills/backlog-execute skills/backlog-execute
```

Do not delete the `~/.claude/skills/` originals yet — that is a user step at the very end (Task 14), after the plugin is installed, so the skills never disappear mid-migration.

- [ ] **Step 2: Rewrite the tool path in every SKILL.md**

Every `node ~/.claude/skills/backlog/tools/backlog.mjs …` invocation becomes `node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs" …` — `CLAUDE_PLUGIN_ROOT` is set by Claude Code when a plugin skill runs, and the quotes survive a space in the plugin cache path.

```bash
sed -i '' 's|node ~/.claude/skills/backlog/tools/backlog.mjs|node "$CLAUDE_PLUGIN_ROOT/skills/backlog/tools/backlog.mjs"|g' skills/backlog/SKILL.md skills/backlog-capture/SKILL.md skills/backlog-groom/SKILL.md skills/backlog-execute/SKILL.md
```

Then verify nothing was missed (some invocations may lack the `node ` prefix or use a different form):

```bash
grep -rn '.claude/skills' skills/ && echo 'LEFTOVERS — fix by hand' || echo clean
```

Expected: `clean`. If there are leftovers, rewrite each by hand to the `$CLAUDE_PLUGIN_ROOT` form and re-run the grep. Also update the header comment in `backlog.mjs` (lines 2–8) which names the old path: change `Lives under ~/.claude/skills/backlog/tools/` to `Lives under skills/backlog/tools/ of the backlog-manager plugin repo` and the two example invocations to the `$CLAUDE_PLUGIN_ROOT` form.

- [ ] **Step 3: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "backlog-manager",
  "description": "Home of the backlog skills (capture, groom, execute, board), plus a local Tailscale-reachable board showing every project's backlog",
  "version": "0.1.0"
}
```

- [ ] **Step 4: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "backlog-manager-marketplace",
  "owner": { "name": "andrejajevtic" },
  "plugins": [
    {
      "name": "backlog-manager",
      "source": "./",
      "description": "backlog skills and local backlog board"
    }
  ]
}
```

- [ ] **Step 5: Smoke-test the tool from its new home**

Run: `node skills/backlog/tools/backlog.mjs board`
Expected: exit 3 with `no backlog/ store in … — run \`backlog.mjs init\` first` (this repo has no store yet — that's the correct answer, and it proves the tool runs from the new path).

- [ ] **Step 6: Commit**

```bash
git add skills/ .claude-plugin/
git commit -m "feat: home the four backlog skills as a plugin"
```

---

### Task 4: Registry upsert in backlog.mjs (TDD, node:test)

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs`
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Produces: `registryFile(): string` (env `BM_REGISTRY_FILE` override, default `~/.backlog-manager/registry.json`) and `registerProject(root: string, file?: string): void` — exported from `backlog.mjs`. `main()`'s `init` and `new` paths call `registerProject` best-effort. The server (Task 5) reads the file this writes.

- [ ] **Step 1: Write the failing test**

Create `skills/backlog/tools/backlog.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerProject, registryFile } from './backlog.mjs'

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-registry-'))
  return path.join(dir, 'nested', 'registry.json') // nested: mkdir -p is part of the contract
}

test('registryFile honours BM_REGISTRY_FILE and falls back to the home default', () => {
  const prev = process.env.BM_REGISTRY_FILE
  try {
    process.env.BM_REGISTRY_FILE = '/tmp/somewhere/registry.json'
    assert.equal(registryFile(), '/tmp/somewhere/registry.json')
    delete process.env.BM_REGISTRY_FILE
    assert.equal(registryFile(), path.join(os.homedir(), '.backlog-manager', 'registry.json'))
  } finally {
    if (prev === undefined) delete process.env.BM_REGISTRY_FILE
    else process.env.BM_REGISTRY_FILE = prev
  }
})

test('registerProject inserts a new project with name = basename and an ISO createdAt', () => {
  const file = tmpRegistry()
  registerProject('/abs/path/my-project', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.projects.length, 1)
  assert.equal(written.projects[0].name, 'my-project')
  assert.equal(written.projects[0].path, '/abs/path/my-project')
  assert.ok(!Number.isNaN(Date.parse(written.projects[0].createdAt)))
})

test('registerProject upserts by path and never rewrites createdAt', () => {
  const file = tmpRegistry()
  registerProject('/abs/path/my-project', file)
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).projects[0]
  registerProject('/abs/path/my-project', file)
  const again = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(again.projects.length, 1)
  assert.equal(again.projects[0].createdAt, first.createdAt)
})

test('registerProject keeps other projects and appends new ones', () => {
  const file = tmpRegistry()
  registerProject('/abs/one', file)
  registerProject('/abs/two', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.projects.map((p) => p.path), ['/abs/one', '/abs/two'])
})

test('registerProject starts fresh over a corrupt registry rather than failing', () => {
  const file = tmpRegistry()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'not json')
  registerProject('/abs/one', file)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.projects.length, 1)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm run test:skills`
Expected: FAIL — `registerProject` / `registryFile` are not exported.

- [ ] **Step 3: Implement**

In `skills/backlog/tools/backlog.mjs`:

Add `import os from 'node:os'` beside the existing `node:fs` / `node:path` imports. Then, directly below the `SECTIONS` map, add:

```js
// --- board registry ----------------------------------------------------------
// The board app in this repo reads ~/.backlog-manager/registry.json to know
// which projects have a backlog at all. This tool is that file's ONLY writer —
// the same one-writer invariant guide-manager keeps for its registry. `init`
// and `new` both upsert the current repo, so any project a capture ever
// touches appears on the board without a separate registration step.
//
// Upsert is keyed on the project's absolute root path (two checkouts of one
// repo are two projects); the name is the root's basename, refreshed on every
// upsert so a renamed directory heals itself; createdAt is set once, on first
// insert, and never rewritten.
export function registryFile() {
  return process.env.BM_REGISTRY_FILE || path.join(os.homedir(), '.backlog-manager', 'registry.json')
}

export function registerProject(root, file = registryFile()) {
  let registry = { projects: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed.projects)) registry = parsed
  } catch {
    // first write, or a corrupt file — start fresh rather than fail the capture
  }
  const existing = registry.projects.find((p) => p.path === root)
  if (existing) {
    existing.name = path.basename(root)
  } else {
    registry.projects.push({ name: path.basename(root), path: root, createdAt: new Date().toISOString() })
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n')
}

// Registration must never fail the command that triggered it: a capture that
// exits non-zero because a dashboard's bookkeeping file was unwritable would
// teach people not to capture. stderr and move on.
function registerBestEffort(root) {
  try {
    registerProject(root)
  } catch (e) {
    console.error(`registry update failed (board will not list this project): ${e.message}`)
  }
}
```

Then wire the two call sites in `main()`:

In the `init` command, after the `created.length === 0` if/else block and before `return 0`, add:

```js
    registerBestEffort(r.resolved.root)
```

In the `new` command, after `console.log(block)` and before its `return 0`, add:

```js
    registerBestEffort(r.resolved.root)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test:skills`
Expected: PASS (5 tests).

- [ ] **Step 5: End-to-end check against a throwaway registry**

```bash
BM_REGISTRY_FILE=/tmp/bm-smoke/registry.json node skills/backlog/tools/backlog.mjs init && cat /tmp/bm-smoke/registry.json && rm -rf /tmp/bm-smoke
```

Expected: `initialized …/backlog` output (this repo gains its own `backlog/` store — keep it, the repo eats its own dog food), and the JSON lists this repo with `name: "backlog-manager"`.

- [ ] **Step 6: Commit**

```bash
git add skills/backlog/tools/ backlog/
git commit -m "feat: backlog.mjs registers projects into ~/.backlog-manager/registry.json"
```

---

### Task 5: Registry service (server)

**Files:**
- Create: `server/src/registry/registry.service.ts`, `server/src/registry/registry.module.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `Registry`, `RegistryProject` from `shared/types.ts`.
- Produces: `RegistryService.load(): Registry`; DI token `REGISTRY_FILE` (string) and `defaultRegistryFile(): string`. Tests and later e2e suites override `REGISTRY_FILE` to point at fixtures.

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RegistryService, defaultRegistryFile } from '../server/src/registry/registry.service';

describe('RegistryService', () => {
  function tmpFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bm-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, content);
    return file;
  }

  it('loads a well-formed registry', () => {
    const file = tmpFile(JSON.stringify({
      projects: [{ name: 'p1', path: '/abs/p1', createdAt: '2026-08-26T00:00:00.000Z' }]
    }));
    expect(new RegistryService(file).load().projects).toHaveLength(1);
  });

  it('returns an empty registry for a missing file', () => {
    expect(new RegistryService('/nope/registry.json').load()).toEqual({ projects: [] });
  });

  it('returns an empty registry for corrupt or mis-shaped JSON', () => {
    expect(new RegistryService(tmpFile('not json')).load()).toEqual({ projects: [] });
    expect(new RegistryService(tmpFile('{"projects": 7}')).load()).toEqual({ projects: [] });
  });

  it('re-reads the file per call — a project registered mid-session appears', () => {
    const file = tmpFile(JSON.stringify({ projects: [] }));
    const service = new RegistryService(file);
    expect(service.load().projects).toHaveLength(0);
    writeFileSync(file, JSON.stringify({
      projects: [{ name: 'late', path: '/abs/late', createdAt: '2026-08-26T00:00:00.000Z' }]
    }));
    expect(service.load().projects).toHaveLength(1);
  });

  it('defaults to ~/.backlog-manager/registry.json, overridable by BM_REGISTRY_FILE', () => {
    const prev = process.env.BM_REGISTRY_FILE;
    try {
      delete process.env.BM_REGISTRY_FILE;
      expect(defaultRegistryFile()).toMatch(/\.backlog-manager\/registry\.json$/);
      process.env.BM_REGISTRY_FILE = '/x/registry.json';
      expect(defaultRegistryFile()).toBe('/x/registry.json');
    } finally {
      if (prev === undefined) delete process.env.BM_REGISTRY_FILE;
      else process.env.BM_REGISTRY_FILE = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/registry/registry.service.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { Registry } from '../../../shared/types';

export const REGISTRY_FILE = 'REGISTRY_FILE';

export function defaultRegistryFile(): string {
  return process.env.BM_REGISTRY_FILE || join(homedir(), '.backlog-manager', 'registry.json');
}

/**
 * Read-only view of ~/.backlog-manager/registry.json — the single source of
 * truth for which projects have a backlog. Written only by
 * skills/backlog/tools/backlog.mjs (its init and new commands); this service
 * never writes it.
 *
 * Read per call rather than cached: a skill can register a project at any
 * moment, and the file is a few KB. A cache here would show a stale board
 * until restart.
 *
 * The constructor takes the file path so tests can point at a fixture. Nest
 * supplies it through the REGISTRY_FILE token.
 */
@Injectable()
export class RegistryService {
  private readonly file: string;

  constructor(@Optional() @Inject(REGISTRY_FILE) file?: string) {
    this.file = file ?? defaultRegistryFile();
  }

  load(): Registry {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Registry;
      if (!Array.isArray(data.projects)) throw new Error('bad shape');
      return data;
    } catch {
      // Missing, unreadable, or mis-shaped: an empty board with the "nothing
      // registered yet" state, never a 500.
      return { projects: [] };
    }
  }
}
```

`server/src/registry/registry.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { REGISTRY_FILE, RegistryService, defaultRegistryFile } from './registry.service';

/**
 * REGISTRY_FILE is provided explicitly (not left to the @Optional fallback)
 * so e2e suites can .overrideProvider(REGISTRY_FILE) onto a fixture — an
 * un-provided token cannot be overridden.
 */
@Module({
  providers: [RegistryService, { provide: REGISTRY_FILE, useFactory: defaultRegistryFile }],
  exports: [RegistryService]
})
export class RegistryModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- test/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/registry/ test/registry.test.ts
git commit -m "feat: read-only registry service, re-read per request"
```

---

### Task 6: Item parsing — frontmatter, sections, groomed (TDD)

**Files:**
- Create: `server/src/items/parse.util.ts`
- Test: `test/parse.test.ts`

**Interfaces:**
- Consumes: `Section` from `shared/types.ts`.
- Produces: `ItemParseError`, `parseFrontmatter(text): { fm: { fields: Record<string,string>; tags: string[] }; body: string }`, `sectionText(body, heading): string`, `deriveGroomed(section: Section, body: string): boolean | null`. Task 7's scanner consumes all three; Task 8's body route consumes `parseFrontmatter`.

- [ ] **Step 1: Write the failing test**

Create `test/parse.test.ts`:

```ts
import { ItemParseError, deriveGroomed, parseFrontmatter, sectionText } from '../server/src/items/parse.util';

const BUG_GROOMED = `## Symptom

It breaks.

## Repro

Run it.

## Affects

src/a.ts:1

## Cause

The check uses < instead of <=.

## Fix

Use <=.
`;

const BUG_UNGROOMED = `## Symptom

It breaks.

## Cause

unknown

## Fix

unknown
`;

describe('parseFrontmatter', () => {
  it('parses fields, splits tags on commas, returns the body', () => {
    const { fm, body } = parseFrontmatter(
      '---\nid: bug-1\ntitle: it breaks\ncreated: 2026-08-26\ntags: ui, board\n---\n\n## Symptom\n'
    );
    expect(fm.fields.id).toBe('bug-1');
    expect(fm.fields.title).toBe('it breaks');
    expect(fm.tags).toEqual(['ui', 'board']);
    expect(body).toContain('## Symptom');
  });

  it('defaults tags to [] when absent', () => {
    expect(parseFrontmatter('---\nid: x-1\ntitle: t\n---\n').fm.tags).toEqual([]);
  });

  it('rejects a status: key — the directory is the status', () => {
    expect(() => parseFrontmatter('---\nid: x-1\nstatus: open\n---\n')).toThrow(ItemParseError);
  });

  it('rejects a missing opening or closing fence', () => {
    expect(() => parseFrontmatter('id: x-1\n---\n')).toThrow(ItemParseError);
    expect(() => parseFrontmatter('---\nid: x-1\n')).toThrow(ItemParseError);
  });
});

describe('sectionText', () => {
  it('returns the text between a heading and the next ## heading, trimmed', () => {
    expect(sectionText(BUG_GROOMED, 'Cause')).toBe('The check uses < instead of <=.');
  });

  it('returns the trailing section to end of body', () => {
    expect(sectionText(BUG_GROOMED, 'Fix')).toBe('Use <=.');
  });

  it('returns empty string for a heading the body lacks', () => {
    expect(sectionText(BUG_GROOMED, 'Plan')).toBe('');
  });

  it('matches headings case-insensitively', () => {
    expect(sectionText('## cause\n\nx\n', 'Cause')).toBe('x');
  });
});

describe('deriveGroomed', () => {
  it('bug with filled Cause and Fix is groomed', () => {
    expect(deriveGroomed('bugs', BUG_GROOMED)).toBe(true);
  });

  it('bug with unknown Cause/Fix (with or without a trailing period) is not', () => {
    expect(deriveGroomed('bugs', BUG_UNGROOMED)).toBe(false);
    expect(deriveGroomed('bugs', '## Cause\n\nUnknown.\n\n## Fix\n\nx\n')).toBe(false);
  });

  it('bug missing the sections entirely is not groomed', () => {
    expect(deriveGroomed('bugs', '## Symptom\n\nx\n')).toBe(false);
  });

  it('task with a Plan is groomed; without one is not', () => {
    expect(deriveGroomed('tasks', '## Goal\n\ng\n\n## Plan\n\n1. do it\n')).toBe(true);
    expect(deriveGroomed('tasks', '## Goal\n\ng\n\n## Plan\n\n## Test cases\n')).toBe(false);
  });

  it('ideas and out-of-scope have no groomed state', () => {
    expect(deriveGroomed('ideas', 'anything')).toBeNull();
    expect(deriveGroomed('out-of-scope', 'anything')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/items/parse.util.ts`:

```ts
import type { Section } from '../../../shared/types';

/** Signals a malformed item file. The scanner catches exactly this type and
 *  reports the file instead of failing the whole index. */
export class ItemParseError extends Error {}

export interface Frontmatter {
  fields: Record<string, string>;
  tags: string[];
}

/**
 * TypeScript port of parseFrontmatter in skills/backlog/tools/backlog.mjs —
 * the same `key: value` line splitter, deliberately NOT a YAML parser. Kept
 * behaviour-identical so a file the tool wrote is always a file this can read:
 * tags is the one key that becomes a list (split on commas); a status: key is
 * rejected outright because the directory a file lives in is its status;
 * unknown keys (from:, promoted-to:, rejected:) are preserved as strings.
 */
export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    throw new ItemParseError('frontmatter must start with a --- line');
  }

  const fields: Record<string, string> = {};
  let tags: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const sep = lines[i].indexOf(':');
    if (sep === -1) continue;
    const key = lines[i].slice(0, sep).trim();
    const value = lines[i].slice(sep + 1).trim();
    if (key === 'status') {
      throw new ItemParseError('frontmatter must not carry a status: key — the directory a file lives in is its status');
    }
    if (key === 'tags') {
      tags = value === '' ? [] : value.split(',').map((t) => t.trim()).filter((t) => t !== '');
    } else {
      fields[key] = value;
    }
  }
  if (i === lines.length) {
    throw new ItemParseError('frontmatter has no closing --- line');
  }

  return { fm: { fields, tags }, body: lines.slice(i + 1).join('\n') };
}

/**
 * The text under one `## Heading`, up to the next `## ` line or end of body,
 * trimmed. Case-insensitive on the heading because these files are written by
 * skills following prose instructions, and "## cause" must not read as
 * ungroomed. Returns '' both for a missing heading and an empty section —
 * callers cannot tell the two apart, and for grooming they mean the same.
 */
export function sectionText(body: string, heading: string): string {
  const lines = body.split('\n');
  const wanted = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === wanted);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return rest.slice(0, end === -1 ? undefined : end).join('\n').trim();
}

/** "unknown" with optional trailing period, any case — the exact sentinel
 *  backlog-capture writes into a fresh bug's Cause and Fix. */
const UNKNOWN = /^unknown\.?$/i;

/**
 * Groomed is derived, never stored — see the spec. bugs: Cause and Fix both
 * filled and not the "unknown" sentinel (that emptiness is precisely what
 * backlog-execute refuses to work on). tasks: a non-empty Plan (capture
 * refuses a task without one, so false only ever means a hand-made file).
 * ideas and out-of-scope: null — grooming is not a state they have.
 */
export function deriveGroomed(section: Section, body: string): boolean | null {
  if (section === 'bugs') {
    const filled = (t: string): boolean => t !== '' && !UNKNOWN.test(t);
    return filled(sectionText(body, 'Cause')) && filled(sectionText(body, 'Fix'));
  }
  if (section === 'tasks') {
    return sectionText(body, 'Plan') !== '';
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- test/parse.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/items/parse.util.ts test/parse.test.ts
git commit -m "feat: item frontmatter/section parsing and groomed derivation"
```

---

### Task 7: Scanner, items service, index + projects routes (TDD, e2e)

**Files:**
- Create: `server/src/items/scan.util.ts`, `server/src/items/items.service.ts`, `server/src/items/items.controller.ts`, `server/src/items/items.module.ts`
- Create: `test/helpers/store.ts`
- Test: `test/items.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` / `deriveGroomed` / `ItemParseError` (Task 6), `RegistryService` + `REGISTRY_FILE` (Task 5), shared types (Task 2).
- Produces: `scanProject(project: RegistryProject): { items: BacklogItem[]; errors: string[] }`; `ItemsService.index(): ItemsIndex`, `.projects(): ProjectSummary[]`, `.body(path: string): string | null` (body wired to a route in Task 8); HTTP `GET /api/items`, `GET /api/projects`; `ItemsModule` (imports RegistryModule) — Task 9's AppModule imports it; `makeStore(...)` fixture helper reused by Task 8's tests.

- [ ] **Step 1: Write the fixture helper**

Create `test/helpers/store.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds a real on-disk backlog store — the same seven leaf directories
 * backlog.mjs init creates — plus a registry file pointing at it. The e2e
 * suites run against real files because the server's whole job is reading
 * this exact layout; mocking fs here would test the mock.
 */
export interface FixtureItem {
  /** e.g. 'bugs/open' — the leaf directory, verbatim */
  leaf: string;
  filename: string;
  content: string;
}

export function makeProject(name: string, items: FixtureItem[]): string {
  const root = mkdtempSync(join(tmpdir(), `bm-${name}-`));
  for (const leaf of ['bugs/open', 'bugs/done', 'ideas/open', 'ideas/done', 'tasks/open', 'tasks/done', 'out-of-scope']) {
    mkdirSync(join(root, 'backlog', leaf), { recursive: true });
  }
  for (const item of items) {
    writeFileSync(join(root, 'backlog', item.leaf, item.filename), item.content);
  }
  return root;
}

export function makeRegistry(projects: { name: string; path: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-registry-'));
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify({
    projects: projects.map((p) => ({ ...p, createdAt: '2026-08-26T00:00:00.000Z' }))
  }));
  return file;
}

export function item(id: string, title: string, body: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-20\n${extra}---\n\n${body}`;
}
```

- [ ] **Step 2: Write the failing e2e test**

Create `test/items.test.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ItemsModule } from '../server/src/items/items.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';
import type { BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

describe('GET /api/items and /api/projects', () => {
  let app: INestApplication;

  const alpha = makeProject('alpha', [
    { leaf: 'bugs/open', filename: 'bug-1-it-breaks.md',
      content: item('bug-1', 'it breaks', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n') },
    { leaf: 'bugs/open', filename: 'bug-2-groomed.md',
      content: item('bug-2', 'groomed bug', '## Symptom\n\nx\n\n## Cause\n\noff by one\n\n## Fix\n\nuse <=\n') },
    { leaf: 'tasks/open', filename: 'task-1-build-it.md',
      content: item('task-1', 'build it', '## Goal\n\ng\n\n## Plan\n\n1. step\n', 'tags: ui, board\n') },
    { leaf: 'tasks/done', filename: 'task-2-shipped.md',
      content: item('task-2', 'shipped', '## Goal\n\ng\n\n## Plan\n\ndone\n') },
    { leaf: 'out-of-scope', filename: 'oos-1-nope.md',
      content: item('oos-1', 'nope', '## What was proposed\n\nx\n\n## Why rejected\n\ny\n') },
    { leaf: 'ideas/open', filename: 'idea-1-broken.md', content: 'no frontmatter at all\n' }
  ]);
  const beta = makeProject('beta', [
    { leaf: 'ideas/open', filename: 'idea-1-someday.md',
      content: item('idea-1', 'someday', '## Problem\n\np\n') }
  ]);

  beforeAll(async () => {
    const registry = makeRegistry([
      { name: 'alpha', path: alpha },
      { name: 'beta', path: beta },
      { name: 'ghost', path: '/nowhere/ghost' }
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [ItemsModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(registry)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('indexes every readable item across projects with derived fields', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    const byId = new Map(index.items.map((i) => [`${i.project}/${i.id}`, i]));

    expect(byId.size).toBe(6);
    const bug1 = byId.get('alpha/bug-1') as BacklogItem;
    expect(bug1.section).toBe('bugs');
    expect(bug1.status).toBe('open');
    expect(bug1.groomed).toBe(false);
    expect((byId.get('alpha/bug-2') as BacklogItem).groomed).toBe(true);
    const task1 = byId.get('alpha/task-1') as BacklogItem;
    expect(task1.tags).toEqual(['ui', 'board']);
    expect(task1.groomed).toBe(true);
    expect((byId.get('alpha/task-2') as BacklogItem).status).toBe('done');
    const oos = byId.get('alpha/oos-1') as BacklogItem;
    expect(oos.status).toBe('terminal');
    expect(oos.groomed).toBeNull();
    expect((byId.get('beta/idea-1') as BacklogItem).projectPath).toBe(beta);
  });

  it('reports the malformed file in errors[] and still returns the rest', async () => {
    const res = await request(app.getHttpServer()).get('/api/items').expect(200);
    const index = res.body as ItemsIndex;
    expect(index.errors).toHaveLength(1);
    expect(index.errors[0]).toContain('idea-1-broken.md');
  });

  it('summarises projects with open counts and flags missing ones', async () => {
    const res = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const projects = res.body as ProjectSummary[];
    const byName = new Map(projects.map((p) => [p.name, p]));

    expect(byName.size).toBe(3);
    const a = byName.get('alpha') as ProjectSummary;
    expect(a.missing).toBe(false);
    // done task-2 is not counted; the malformed idea is not an item
    expect(a.counts).toEqual({ bugs: 2, ideas: 0, tasks: 1, 'out-of-scope': 1 });
    const ghost = byName.get('ghost') as ProjectSummary;
    expect(ghost.missing).toBe(true);
    expect(ghost.counts).toEqual({ bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- test/items.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the scanner**

`server/src/items/scan.util.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ItemParseError, deriveGroomed, parseFrontmatter } from './parse.util';
import type { BacklogItem, ItemStatus, RegistryProject, Section } from '../../../shared/types';

/**
 * The seven leaf directories a store is defined to have — the same list
 * backlog.mjs's LEAF_DIRS creates. The directory IS the item's section and
 * status; nothing in the file repeats it.
 */
const LEAVES: { section: Section; status: ItemStatus; rel: string }[] = [
  { section: 'bugs', status: 'open', rel: 'bugs/open' },
  { section: 'bugs', status: 'done', rel: 'bugs/done' },
  { section: 'ideas', status: 'open', rel: 'ideas/open' },
  { section: 'ideas', status: 'done', rel: 'ideas/done' },
  { section: 'tasks', status: 'open', rel: 'tasks/open' },
  { section: 'tasks', status: 'done', rel: 'tasks/done' },
  { section: 'out-of-scope', status: 'terminal', rel: 'out-of-scope' }
];

/**
 * Reads one project's whole store. Tolerant the way `backlog.mjs board` is:
 * a malformed file is reported in `errors` (path-prefixed) rather than
 * aborting the scan — one bad fence must not blind the board to the other
 * nine items. A missing leaf directory is a partially-scaffolded store, not
 * an error. readdirSync is sorted so the index is deterministic across
 * filesystems.
 */
export function scanProject(project: RegistryProject): { items: BacklogItem[]; errors: string[] } {
  const items: BacklogItem[] = [];
  const errors: string[] = [];
  const backlog = join(project.path, 'backlog');

  for (const leaf of LEAVES) {
    const dir = join(backlog, leaf.rel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const abs = join(dir, name);
      try {
        const { fm, body } = parseFrontmatter(readFileSync(abs, 'utf8'));
        if (!fm.fields.id || !fm.fields.title) {
          throw new ItemParseError('frontmatter is missing id or title');
        }
        items.push({
          id: fm.fields.id,
          title: fm.fields.title,
          created: fm.fields.created ?? '',
          tags: fm.tags,
          section: leaf.section,
          status: leaf.status,
          project: project.name,
          projectPath: project.path,
          groomed: deriveGroomed(leaf.section, body),
          path: abs
        });
      } catch (e) {
        errors.push(`${abs}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { items, errors };
}
```

- [ ] **Step 5: Implement the service**

`server/src/items/items.service.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { buildAllowlist, resolveAllowed } from './allow.util';
import { parseFrontmatter } from './parse.util';
import { scanProject } from './scan.util';
import type { ItemsIndex, ProjectSummary, SectionCounts } from '../../../shared/types';

/**
 * All reads walk the registry and the stores per request, like guide-manager's
 * RegistryService: a capture made mid-session shows up on the next fetch
 * without a restart, and the whole corpus is a few hundred small files —
 * nothing worth a cache that could go stale.
 */
@Injectable()
export class ItemsService {
  constructor(private readonly registry: RegistryService) {}

  index(): ItemsIndex {
    const items: ItemsIndex['items'] = [];
    const errors: string[] = [];
    for (const project of this.registry.load().projects) {
      // A missing store is /api/projects' news (flagged there), not a scan
      // error to repeat on every item fetch.
      if (!existsSync(join(project.path, 'backlog'))) continue;
      const scanned = scanProject(project);
      items.push(...scanned.items);
      errors.push(...scanned.errors);
    }
    return { items, errors };
  }

  projects(): ProjectSummary[] {
    return this.registry.load().projects.map((project) => {
      const missing = !existsSync(join(project.path, 'backlog'));
      const counts: SectionCounts = { bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 };
      if (!missing) {
        for (const it of scanProject(project).items) {
          // "open" counts: done items are history. out-of-scope is terminal
          // and counts as itself — its number is how many were declined.
          if (it.status === 'done') continue;
          counts[it.section]++;
        }
      }
      return { name: project.name, path: project.path, createdAt: project.createdAt, missing, counts };
    });
  }

  /**
   * The Markdown body of one item, frontmatter stripped (the client already
   * holds every frontmatter field from the index). Falls back to the raw file
   * when the frontmatter is malformed — the drawer is exactly where you look
   * at a broken file. Returns null for anything outside a registered
   * project's backlog/ — the caller answers 404 without learning why.
   */
  body(requestPath: string): string | null {
    const real = resolveAllowed(requestPath, buildAllowlist(this.registry.load()));
    if (real === null || !real.endsWith('.md')) return null;
    const text = readFileSync(real, 'utf8');
    try {
      return parseFrontmatter(text).body;
    } catch {
      return text;
    }
  }
}
```

Note: this imports `./allow.util`, which Task 8 creates. To keep this task self-contained and green, create `server/src/items/allow.util.ts` NOW with the two functions (the code is in Task 8 Step 3 — write it verbatim here, then Task 8 only adds its tests and the route). Alternatively swap task order; the plan keeps the service whole because splitting `body()` out would leave a dangling import.

- [ ] **Step 6: Implement controller and module**

`server/src/items/items.controller.ts`:

```ts
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ItemsService } from './items.service';
import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

/**
 * Everything lives under /api on purpose: dev-mode Vite proxies exactly one
 * prefix, and test/vite-proxy.test.ts asserts no controller ever leaves it —
 * a route outside /api would not 404 in dev, it would be answered by Vite's
 * SPA fallback with index.html.
 */
@Controller('api')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('projects')
  projects(): ProjectSummary[] {
    return this.items.projects();
  }

  @Get('items')
  index(): ItemsIndex {
    return this.items.index();
  }

  /**
   * text/plain, not JSON: the payload IS the Markdown, and wrapping it would
   * make the client unwrap it. 404 covers missing param, unregistered path,
   * and non-.md alike — the caller has no business learning which.
   */
  @Get('items/body')
  body(@Query('path') path: string | undefined, @Res() res: Response): void {
    const body = path ? this.items.body(path) : null;
    if (body === null) {
      res.status(404).send('not found');
      return;
    }
    res.type('text/plain; charset=utf-8').send(body);
  }
}
```

`server/src/items/items.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { RegistryModule } from '../registry/registry.module';

@Module({
  imports: [RegistryModule],
  controllers: [ItemsController],
  providers: [ItemsService]
})
export class ItemsModule {}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test -- test/items.test.ts test/parse.test.ts test/registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/items/ test/helpers/store.ts test/items.test.ts
git commit -m "feat: items index and project summaries over registered stores"
```

---

### Task 8: Body route allowlist (TDD)

**Files:**
- Create (if not already created in Task 7 Step 5): `server/src/items/allow.util.ts`
- Test: `test/allow.test.ts` (unit) + extend `test/items.test.ts` (e2e)

**Interfaces:**
- Consumes: `Registry` from shared types.
- Produces: `buildAllowlist(registry): Set<string>` (realpaths of every registered project's `backlog/`), `resolveAllowed(requestPath, allowedDirs): string | null`. `ItemsService.body` (Task 7) consumes both.

- [ ] **Step 1: Write the failing unit test**

Create `test/allow.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAllowlist, resolveAllowed } from '../server/src/items/allow.util';

describe('body-route allowlist', () => {
  const root = mkdtempSync(join(tmpdir(), 'bm-allow-'));
  const backlog = join(root, 'backlog');
  const inside = join(backlog, 'bugs', 'open', 'bug-1-x.md');
  // The trap: a SIBLING of backlog/ whose name shares the prefix. A bare
  // startsWith(dir) lets it through; startsWith(dir + sep) does not.
  const sibling = join(root, 'backlog-evil', 'bug-1-x.md');

  beforeAll(() => {
    mkdirSync(join(backlog, 'bugs', 'open'), { recursive: true });
    mkdirSync(join(root, 'backlog-evil'), { recursive: true });
    writeFileSync(inside, 'x');
    writeFileSync(sibling, 'x');
  });

  const registry = {
    projects: [
      { name: 'p', path: root, createdAt: '2026-08-26T00:00:00.000Z' },
      { name: 'gone', path: '/nowhere/gone', createdAt: '2026-08-26T00:00:00.000Z' }
    ]
  };

  it('allowlists each registered backlog/ dir and skips vanished projects', () => {
    const dirs = buildAllowlist(registry);
    expect(dirs).toEqual(new Set([realpathSync(backlog)]));
  });

  it('resolves a file inside a registered store', () => {
    expect(resolveAllowed(inside, buildAllowlist(registry))).toBe(realpathSync(inside));
  });

  it('refuses a prefix-sharing sibling, a file outside, and a missing file', () => {
    const dirs = buildAllowlist(registry);
    expect(resolveAllowed(sibling, dirs)).toBeNull();
    expect(resolveAllowed('/etc/hosts', dirs)).toBeNull();
    expect(resolveAllowed(join(backlog, 'bugs', 'open', 'nope.md'), dirs)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if Task 7 already created the util)**

Run: `pnpm test -- test/allow.test.ts`
Expected: FAIL with module not found if Task 7 skipped Step 5's note; PASS if it was created there. Either way continue — the e2e additions below are new.

- [ ] **Step 3: Implement `server/src/items/allow.util.ts`** (skip if it exists — but diff it against this, which is canonical)

```ts
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { Registry } from '../../../shared/types';

/**
 * Port of guide-manager's render/paths.util.ts, narrowed: only a registered
 * project's backlog/ directory is servable — the item bodies live nowhere
 * else, so nothing else is on the list.
 */
export function buildAllowlist(registry: Registry): Set<string> {
  const dirs = new Set<string>();
  for (const project of registry.projects) {
    try {
      dirs.add(realpathSync(join(project.path, 'backlog')));
    } catch {
      // project gone or store never created — /api/projects reports it
    }
  }
  return dirs;
}

export function resolveAllowed(requestPath: string, allowedDirs: Set<string>): string | null {
  let real: string;
  try {
    real = realpathSync(requestPath);
  } catch {
    return null;
  }
  for (const dir of allowedDirs) {
    // `dir + sep`, not `dir`: a bare prefix check would let /x/backlog-evil
    // through on an allowlist entry of /x/backlog.
    if (real.startsWith(dir + sep)) return real;
  }
  return null;
}
```

- [ ] **Step 4: Extend the e2e suite**

Append to the `describe` in `test/items.test.ts`:

```ts
  it('serves an item body as text/plain with the frontmatter stripped', async () => {
    const items = (await request(app.getHttpServer()).get('/api/items').expect(200)).body as ItemsIndex;
    const bug = items.items.find((i) => i.id === 'bug-2' && i.project === 'alpha') as BacklogItem;
    const res = await request(app.getHttpServer())
      .get('/api/items/body')
      .query({ path: bug.path })
      .expect(200)
      .expect('content-type', /text\/plain/);
    expect(res.text).toContain('## Cause');
    expect(res.text).not.toContain('id: bug-2');
  });

  it('404s a path outside every registered store, and a missing param', async () => {
    await request(app.getHttpServer()).get('/api/items/body').query({ path: '/etc/hosts' }).expect(404);
    await request(app.getHttpServer()).get('/api/items/body').expect(404);
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- test/allow.test.ts test/items.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/items/allow.util.ts test/allow.test.ts test/items.test.ts
git commit -m "feat: allowlisted item body route"
```

---

### Task 9: App bootstrap — main, app module, static, health

**Files:**
- Create: `server/src/main.ts`, `server/src/app.module.ts`, `server/src/static.ts`, `server/src/health/health.controller.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: `ItemsModule` (Task 7).
- Produces: a bootable server on `PORT` (default 4322); `clientDistModules(distDir?)` exported from `static.ts`; `GET /api/health` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `test/app.test.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { clientDistModules } from '../server/src/static';
import { makeRegistry } from './helpers/store';

describe('app bootstrap', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers /api/health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { ok: true });
  });

  it('answers /api/items with an empty index on an empty registry — never a 500', async () => {
    await request(app.getHttpServer()).get('/api/items').expect(200, { items: [], errors: [] });
  });

  it('registers no static module when there is no client bundle', () => {
    expect(clientDistModules('/definitely/not/built')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/app.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/src/health/health.controller.ts` — copy guide-manager's verbatim (already `@Controller('api/health')`).

`server/src/static.ts`:

```ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { DynamicModule } from '@nestjs/common';

/**
 * cwd, not __dirname: the compiled file's depth differs between `nest start`
 * (dist/server/src) and ts-jest (server/src), while every way this server is
 * actually launched — pnpm scripts on the host, compose's WORKDIR /app —
 * runs from the repo root.
 */
export const CLIENT_DIST = resolve(process.cwd(), 'client', 'dist');

/**
 * The client bundle is built by a separate task and a separate toolchain.
 * Until it exists, registering ServeStaticModule would install a catch-all
 * handler with nothing behind it — every unknown route would answer with an
 * error from inside express.static instead of a plain 404. So the module is
 * registered conditionally, and the server stays useful (the API) on its own.
 */
export function clientDistModules(distDir: string = CLIENT_DIST): DynamicModule[] {
  if (!existsSync(join(distDir, 'index.html'))) {
    console.warn(`no client bundle at ${distDir} — serving the API only`);
    return [];
  }
  return [
    ServeStaticModule.forRoot({
      rootPath: distDir,
      // Express 5 path syntax (Nest 11). Without this the SPA fallback would
      // answer /api/* with index.html.
      exclude: ['/api/{*path}']
    })
  ];
}
```

`server/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthController } from './health/health.controller';
import { ItemsModule } from './items/items.module';
import { clientDistModules } from './static';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ItemsModule, ...clientDistModules()],
  controllers: [HealthController]
})
export class AppModule {}
```

`server/src/main.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

// 4322, not guide-manager's 4321: both apps run on this machine.
const PORT = Number(process.env.PORT) || 4322;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT);
  console.log(`backlog-manager listening on http://localhost:${PORT}`);
}

// A failed boot must exit non-zero rather than leave a half-started process
// with nothing listening.
bootstrap().catch((err: unknown) => {
  console.error('backlog-manager failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests, typecheck, and boot it once**

Run: `pnpm test -- test/app.test.ts && pnpm run typecheck`
Expected: PASS.

Run: `pnpm run build:server && (node dist/server/src/main.js &) && sleep 2 && curl -s localhost:4322/api/health && curl -s localhost:4322/api/items && kill %1`
Expected: `{"ok":true}` and a JSON index listing this repo's own backlog (registered in Task 4's smoke test — if that used the throwaway `BM_REGISTRY_FILE`, run `node skills/backlog/tools/backlog.mjs init` once first so the real registry has this repo).

- [ ] **Step 5: Commit**

```bash
git add server/src/main.ts server/src/app.module.ts server/src/static.ts server/src/health/ test/app.test.ts
git commit -m "feat: nest bootstrap on 4322 with conditional static serving"
```

---

### Task 10: Client scaffold — shell, settings, styles, vite

**Files:**
- Create: `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/components/SideRail.tsx`, `client/src/components/settings/SettingsRow.tsx`, `client/src/lib/settings.ts`, `client/src/hooks/usePersistedState.ts`, `client/src/hooks/useSettings.tsx`, `client/src/styles.css`, `vite.config.ts`
- Test: `test/settings.test.ts`, `test/vite-proxy.test.ts`

**Interfaces:**
- Consumes: `shared/theme.css` (Task 2).
- Produces: `Section` (`'projects' | 'settings'`) from SideRail; `Settings`/`clampSettings`/`DEFAULT_SETTINGS`/`THEMES`/`FONT_SCALES`/`SETTINGS_STORAGE_KEY` from `lib/settings`; `usePersistedState`, `useSettings`/`SettingsProvider`; the `board-*`/`pill*`/`set-*`/`drawer*` CSS classes Tasks 11–13 style against. App renders a placeholder for the board until Task 11 replaces it.

- [ ] **Step 1: Copy the verbatim files**

From `../guide-manager/client/src/`:
- `hooks/usePersistedState.ts` → copy verbatim.
- `components/settings/SettingsRow.tsx` → copy verbatim.
- `main.tsx` → copy verbatim (fontsource imports, styles import, mount).

- [ ] **Step 2: Write `client/index.html`**

Copy `../guide-manager/client/index.html`, then change exactly two things: `<title>Backlog Manager</title>`, and the storage key in the inline pre-paint script from `'guide-manager.settings'` to `'backlog-manager.settings'`. Keep the script's comment and the rest byte-identical — it stamps theme/density/font-scale before first paint so no load flashes the default palette.

- [ ] **Step 3: Write `client/src/lib/settings.ts`**

Copy `../guide-manager/client/src/lib/settings.ts`, then apply:

1. Delete the three bionic fields from `Settings` and `DEFAULT_SETTINGS` (`bionicOn`, `bionicStrength`, `bionicFreq`), the two bionic entries in `LIMITS`, the `STRENGTHS`-feeding exports `BIONIC_STORAGE_KEY` and `bionicKeyValue`, and the `pickBool`/`clampFloat` helpers if nothing else uses them (`pickBool` and `clampFloat` become dead — delete both; keep `pickOne`, `clampInt`).
2. In `clampSettings`, delete the three bionic lines.
3. `SETTINGS_STORAGE_KEY = 'backlog-manager.settings'`.
4. `const LANDINGS = ['last', 'projects', 'settings'] as const;` (the section id is `projects` here, not `guides`) — and the doc comment above `Landing` keeps its warning that a section added to the rail must be added here.
5. Keep `THEMES` (all five), `Density`, `fontScale` + `FONT_SCALES` + its `LIMITS` entry, `Landing`, and the header comment (reworded from guide-manager to backlog-manager and with the bionic-flatness sentence dropped).

- [ ] **Step 4: Write `client/src/hooks/useSettings.tsx`**

Copy `../guide-manager/client/src/hooks/useSettings.tsx`, then: delete the second `useEffect` entirely (the `BIONIC_STORAGE_KEY` bridge — there is no reading aid here) and its imports (`BIONIC_STORAGE_KEY`, `bionicKeyValue`); keep the first effect (theme/density/font-scale stamped on the root) and the trailing comment about the fallback outside a provider.

- [ ] **Step 5: Write `client/src/components/SideRail.tsx`**

Copy guide-manager's, with: `export type Section = 'projects' | 'settings';`, `TABS` = `[{ id: 'projects', label: 'Projects' }, { id: 'settings', label: 'Settings' }]`, and the brand block:

```tsx
      <h1 className="rail-brand">
        <span className="rail-kicker">Backlog</span>
        <br />
        Manager
      </h1>
```

- [ ] **Step 6: Write `client/src/App.tsx`**

Copy guide-manager's `App.tsx`, with: lazy imports `BoardView` from `./components/board/BoardView` and `SettingsView` from `./components/settings/SettingsView`; persisted key `'backlog-manager.section'` with fallback `'projects'`; the stale-value guard becomes `const current: Section = section === 'settings' ? 'settings' : 'projects';`; the wide-wrap line becomes `<div className={current === 'projects' ? 'wrap wide' : 'wrap'}>`; render `{current === 'projects' ? <BoardView /> : <SettingsView />}`. Until Tasks 11/13 exist, create the two files as minimal placeholders so this compiles:

```tsx
// client/src/components/board/BoardView.tsx — replaced wholesale in Task 11
export default function BoardView() {
  return <div className="board-empty">loading…</div>;
}
```

```tsx
// client/src/components/settings/SettingsView.tsx — replaced wholesale in Task 13
export default function SettingsView() {
  return <div className="board-empty">settings</div>;
}
```

- [ ] **Step 7: Write `client/src/styles.css`**

Start from `../guide-manager/client/src/styles.css` and apply, in order:

1. Global rename of the reusable block names: `sed -i '' -e 's/guides-/board-/g' -e 's/\.guides\b/.board/g' client/src/styles.css` (the `.guides` flex-column block becomes `.board`; every `.guides-*` control/card/empty class becomes `.board-*`).
2. Delete whole blocks that have no counterpart here: everything from the `.bay {` comment block through `.bay-h[aria-expanded="false"] .bay-caret { … }`; everything from `.guide-viewer {` (now `.board-viewer` after the sed — delete regardless of name) through the `.guide-locked` media block at the bottom of the viewer section, including the two viewer media queries (`@media (max-width: 700px)` viewer overlay block and the 701–1200px `min-height` block); the `@media (min-width: 1201px)` block that references the viewer.
3. Update the header comment (top of file) to name this repo and drop the guide-viewer sentences; keep the `--font-scale`/zoom explanation — it still applies.
4. Delete the `--bay-gap` custom property from both density blocks (nothing uses it after step 2).
5. Replace the two pill color rules (`.pill-study`, `.pill-tutor`) with the four section pills:

```css
/* Section pills. Outline and ink only, no tint — same rationale as
   guide-manager: a tinted fill would need a mix per palette. Four hues that
   collide with nothing else on the card: --green stays the groomed marker. */
.pill-bug { color: var(--red); border-color: var(--red) }
.pill-idea { color: var(--mustard); border-color: var(--mustard) }
.pill-task { color: var(--cyan); border-color: var(--cyan) }
.pill-oos { color: var(--ink3); border-color: var(--ink3) }
```

6. Replace the `.board-card-read` / `.board-card-part` rules (post-sed names of the progress markers) with:

```css
/* Meta-line markers. Groomed is quiet confirmation, not an alarm; done is
   history and dims. */
.board-card-groomed { color: var(--green) }
.board-card-done { color: var(--ink2) }
```

7. Append the board-columns and drawer styles:

```css
/* ---------------------------------------------- board columns
   Four fixed columns — bugs, ideas, tasks, out-of-scope — in the store's own
   order. auto-fit would reflow by width alone and put out-of-scope under bugs
   on some widths; the type axis is the board's whole point, so the column
   count is stepped explicitly instead. align-items:start keeps a short column
   from stretching to its tallest neighbour. */
.board-columns { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--card-gap); align-items: start }
@media (max-width: 1100px) { .board-columns { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
@media (max-width: 700px) { .board-columns { grid-template-columns: 1fr } }

.board-col { display: flex; flex-direction: column; gap: var(--card-gap); min-width: 0 }
/* Column header: the bay header's anatomy (tick, name, count) without the
   fold — a fixed four-column board has nothing to fold. The tick carries the
   section's hue, the same one its pills wear, so a card's pill points back to
   its column at a glance. */
.board-col-h { display: flex; align-items: baseline; gap: 8px; padding-bottom: 5px; border-bottom: 1px solid var(--hairline) }
.board-col-tick { flex: none; align-self: center; width: 14px; height: 3px; background: var(--ink3) }
.board-col-bugs .board-col-tick { background: var(--red) }
.board-col-ideas .board-col-tick { background: var(--mustard) }
.board-col-tasks .board-col-tick { background: var(--cyan) }
.board-col-name {
  font-family: var(--display); font-size: 14px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .07em; color: var(--ink);
}
.board-col-count { font-family: var(--mono); font-size: 9.5px; color: var(--ink3) }

/* Degraded-state line above the board: malformed files skipped by the scan,
   or registered projects whose store is gone. Amber, not red — the board
   below it is still real, just partial. */
.board-warn { font-family: var(--mono); font-size: 10px; color: var(--amber); line-height: 1.5 }

/* ---------------------------------------------- item drawer
   A right-hand panel over the board; the board stays mounted behind it.
   Fixed elements are inside the zoomed .shell, so both dimensions get the
   same /--font-scale division the guide-manager viewer overlay needs —
   without it the drawer hangs off two edges at any text size but 100%. */
.drawer-backdrop { position: fixed; inset: 0; z-index: 60; background: var(--scrim) }
.drawer {
  position: fixed; top: 0; right: 0; z-index: 61;
  height: calc(100dvh / var(--font-scale, 1));
  width: min(480px, calc(100vw / var(--font-scale, 1)));
  background: var(--strip); border-left: 1px solid var(--hairline);
  box-shadow: -12px 0 32px var(--shadow2);
  display: flex; flex-direction: column;
}
.drawer-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding: 14px 16px; border-bottom: 1px solid var(--hairline);
  background: var(--strip-hi); box-shadow: inset 0 1px 0 var(--edge);
}
.drawer-head .pill { flex: none }
.drawer-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--ink) }
.drawer-close {
  font-family: var(--font); font-size: 11.5px; color: var(--ink2);
  background: var(--steel); border: 1px solid var(--hairline); border-radius: 2px;
  padding: 5px 10px; cursor: pointer; transition: color .15s, border-color .15s;
}
.drawer-close:hover { color: var(--ink); border-color: var(--hairline2) }
.drawer-meta {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 16px; border-bottom: 1px solid var(--hairline);
  font-family: var(--mono); font-size: 10.5px; color: var(--ink2);
}
.drawer-meta .drawer-path { color: var(--ink3); word-break: break-all }
.drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px }
.drawer-empty { font-size: 11px; color: var(--ink3); padding: 20px 2px; text-align: center }

/* Rendered item Markdown. The section headings are the store's fixed ## set
   (Symptom, Plan, …) — styled as printed labels, not document headings. */
.drawer-body h2 {
  font-family: var(--display); font-size: 12.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .08em; color: var(--ink2);
  margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--hairline);
}
.drawer-body h2:first-child { margin-top: 0 }
.drawer-body p, .drawer-body li { font-size: 12.5px; color: var(--ink); line-height: 1.55; margin: 6px 0 }
.drawer-body ul, .drawer-body ol { padding-left: 18px; margin: 6px 0 }
.drawer-body code { font-family: var(--mono); font-size: 11px; color: var(--cyan) }
.drawer-body pre { background: var(--steel); border: 1px solid var(--hairline); border-radius: 2px; padding: 10px; overflow-x: auto; margin: 8px 0 }
.drawer-body pre code { color: var(--ink) }
.drawer-body table { border-collapse: collapse; font-size: 11.5px; margin: 8px 0 }
.drawer-body th, .drawer-body td { border: 1px solid var(--hairline); padding: 4px 8px; text-align: left; vertical-align: top }
.drawer-body a { color: var(--cyan) }
.drawer-body blockquote { border-left: 2px solid var(--hairline2); padding-left: 10px; color: var(--ink2); margin: 6px 0 }
```

- [ ] **Step 8: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.PORT) || 4322;
// localhost on the host, but the service name when this runs in the compose
// stack — there localhost is the Vite container, not the API's.
const API_TARGET = `http://${process.env.API_HOST || 'localhost'}:${API_PORT}`;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT) || 5177,
    host: true,
    // Vite 5.4.12+ 403s any Host header it does not recognise; the suffix
    // form covers every node on the tailnet and survives a machine rename.
    allowedHosts: ['.ts.net'],
    // One prefix, on purpose: every server route lives under /api, and
    // test/vite-proxy.test.ts asserts controllers never leave it. A route
    // outside /api would not 404 in dev — Vite's SPA fallback would answer it
    // with index.html.
    proxy: {
      '/api': { target: API_TARGET }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
```

- [ ] **Step 9: Write the failing tests**

`test/settings.test.ts`:

```ts
import { DEFAULT_SETTINGS, FONT_SCALES, THEMES, clampSettings } from '../client/src/lib/settings';

describe('clampSettings', () => {
  it('passes a valid object through', () => {
    const s = clampSettings({ theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects' });
    expect(s).toEqual({ theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects' });
  });

  it('falls back per field, independently', () => {
    const s = clampSettings({ theme: 'neon', density: 7, fontScale: 'big', landing: 'guides' });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps fontScale into its limits', () => {
    expect(clampSettings({ fontScale: 300 }).fontScale).toBe(130);
    expect(clampSettings({ fontScale: 10 }).fontScale).toBe(80);
  });

  it('handles null and non-objects', () => {
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings('x')).toEqual(DEFAULT_SETTINGS);
  });

  it('offers five themes and four font stops (UI contract)', () => {
    expect(THEMES).toHaveLength(5);
    expect(FONT_SCALES).toEqual([90, 100, 110, 120]);
  });
});
```

`test/vite-proxy.test.ts`:

```ts
import 'reflect-metadata';

import viteConfig from '../vite.config';
import { HealthController } from '../server/src/health/health.controller';
import { ItemsController } from '../server/src/items/items.controller';

/**
 * The dev proxy has exactly one entry, /api — which is only safe while every
 * server controller actually lives under /api. A controller registered
 * outside it would not 404 in dev: Vite's SPA fallback answers with
 * index.html, and the failure is a silently-wrong response instead of an
 * error. So the invariant is asserted from Nest's own route metadata, not a
 * hand-kept list. Any new controller must be added to CONTROLLERS here —
 * the length assertion is the reminder.
 */
const CONTROLLERS = [HealthController, ItemsController];

describe('vite dev proxy', () => {
  const proxy = (viteConfig as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};

  it('proxies /api', () => {
    expect(Object.keys(proxy)).toContain('/api');
  });

  it('every controller lives under /api', () => {
    expect(CONTROLLERS).toHaveLength(2);
    for (const ctor of CONTROLLERS) {
      const prefix = Reflect.getMetadata('path', ctor) as string;
      expect(prefix === 'api' || prefix.startsWith('api/')).toBe(true);
    }
  });
});
```

- [ ] **Step 10: Run everything**

Run: `pnpm test && pnpm run typecheck && pnpm run build:client`
Expected: all suites PASS; the client builds (placeholders render).

- [ ] **Step 11: Commit**

```bash
git add client/ vite.config.ts test/settings.test.ts test/vite-proxy.test.ts
git commit -m "feat: client shell — rail, settings machinery, ported styles, vite on 5177"
```

---

### Task 11: Board — useBoard hook, BoardView, ItemCard (TDD, jsdom)

**Files:**
- Create: `client/src/hooks/useBoard.ts`, `client/src/components/board/ItemCard.tsx`
- Modify: `client/src/components/board/BoardView.tsx` (replace the placeholder wholesale)
- Test: `test/board.test.tsx`

**Interfaces:**
- Consumes: `ItemsIndex`, `ProjectSummary`, `BacklogItem`, `Section` from `shared/types.ts`; `usePersistedState`.
- Produces: `useBoard(): { items: ItemsIndex | null; projects: ProjectSummary[] | null; loading: boolean; error: boolean; refetch: () => void }`; `ItemCard({ item, onOpen })`; `BoardView` renders `<ItemDrawer item onClose>` when a card is opened — Task 12 supplies the real drawer; until then BoardView imports it, so Task 12's placeholder is created here:

```tsx
// client/src/components/board/ItemDrawer.tsx — replaced wholesale in Task 12
import type { BacklogItem } from '../../../../shared/types';

export function ItemDrawer({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  return (
    <aside className="drawer" role="dialog" aria-label={item.title}>
      <button className="drawer-close" onClick={onClose}>close</button>
    </aside>
  );
}
```

- [ ] **Step 1: Write the failing test**

Create `test/board.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import type { BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
    ...over
  };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({}),
    fakeItem({ id: 'bug-2', title: 'groomed bug', groomed: true }),
    fakeItem({ id: 'task-1', title: 'a task', section: 'tasks', project: 'beta', projectPath: '/abs/beta', groomed: true }),
    fakeItem({ id: 'task-9', title: 'finished task', section: 'tasks', status: 'done', groomed: true }),
    fakeItem({ id: 'idea-1', title: 'an idea', section: 'ideas', groomed: null }),
    fakeItem({ id: 'oos-1', title: 'declined thing', section: 'out-of-scope', status: 'terminal', groomed: null })
  ],
  errors: ['/abs/alpha/backlog/ideas/open/idea-9-broken.md: frontmatter has no closing --- line']
};

const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 2, ideas: 1, tasks: 0, 'out-of-scope': 1 } },
  { name: 'beta', path: '/abs/beta', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 1, 'out-of-scope': 0 } },
  { name: 'ghost', path: '/abs/ghost', createdAt: '2026-08-26T00:00:00.000Z', missing: true,
    counts: { bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 } }
];

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload = url.includes('/api/projects') ? PROJECTS : ITEMS;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
});

async function renderBoard() {
  render(<BoardView />);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

describe('BoardView', () => {
  it('renders the four columns with counts of what they hold (open by default)', async () => {
    await renderBoard();
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => within(c).getByTestId('col-name').textContent))
      .toEqual(['Bugs', 'Ideas', 'Tasks', 'Out of scope']);
    // done task-9 hidden by the default open filter; oos unaffected
    expect(cols.map((c) => within(c).getByTestId('col-count').textContent))
      .toEqual(['2', '1', '1', '1']);
    expect(screen.queryByText('finished task')).not.toBeInTheDocument();
  });

  it('marks groomed bugs and shows id · project · date on the card', async () => {
    await renderBoard();
    const card = screen.getByText('groomed bug').closest('.board-card') as HTMLElement;
    expect(within(card).getByText('· groomed')).toBeInTheDocument();
    expect(card.textContent).toContain('bug-2 · alpha · 2026-08-20');
  });

  it('status filter: done shows only done items in the three queue columns', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');
    expect(screen.getByText('finished task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
    // out-of-scope is flat and stays put
    expect(screen.getByText('declined thing')).toBeInTheDocument();
  });

  it('project filter narrows every column by projectPath', async () => {
    await renderBoard();
    await userEvent.selectOptions(screen.getByLabelText('Project'), '/abs/beta');
    expect(screen.getByText('a task')).toBeInTheDocument();
    expect(screen.queryByText('a bug')).not.toBeInTheDocument();
  });

  it('search narrows by title, and no matches shows the empty state', async () => {
    await renderBoard();
    await userEvent.type(screen.getByLabelText('Search items'), 'zzz');
    expect(screen.getByText('no matches')).toBeInTheDocument();
  });

  it('surfaces scan errors and missing projects as a warning line', async () => {
    await renderBoard();
    const warn = screen.getByTestId('board-warn');
    expect(warn.textContent).toContain('idea-9-broken.md');
    expect(warn.textContent).toContain('ghost');
  });

  it('opens the drawer when a card is clicked', async () => {
    await renderBoard();
    await userEvent.click(screen.getByText('a bug'));
    expect(screen.getByRole('dialog', { name: 'a bug' })).toBeInTheDocument();
  });

  it('shows the nothing-registered empty state on an empty index', async () => {
    (global.fetch as jest.Mock).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/projects') ? [] : { items: [], errors: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    });
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('nothing registered yet')).toBeInTheDocument());
  });
});
```

Note: `@testing-library/user-event` rides in as a dependency of nothing yet — add it: `pnpm add -D @testing-library/user-event@^14`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/board.test.tsx`
Expected: FAIL — `useBoard` / real BoardView missing.

- [ ] **Step 3: Implement the hook**

`client/src/hooks/useBoard.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

export interface BoardState {
  items: ItemsIndex | null;
  projects: ProjectSummary[] | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

/**
 * One fetch pair per mount, plus a refetch on window focus: items change when
 * a skill runs in some terminal, which is exactly when you alt-tab back to
 * the board — polling would answer the same question worse. Errors keep the
 * previous data so a blip degrades to "stale" rather than "blank".
 */
export function useBoard(): BoardState {
  const [state, setState] = useState<Omit<BoardState, 'refetch'>>({
    items: null,
    projects: null,
    loading: true,
    error: false
  });

  const refetch = useCallback(() => {
    Promise.all([
      fetch('/api/items').then((res) => res.json() as Promise<ItemsIndex>),
      fetch('/api/projects').then((res) => res.json() as Promise<ProjectSummary[]>)
    ])
      .then(([items, projects]) => setState({ items, projects, loading: false, error: false }))
      .catch(() =>
        setState((prev) => ({ items: prev.items, projects: prev.projects, loading: false, error: true }))
      );
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const onFocus = (): void => refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  return { ...state, refetch };
}
```

- [ ] **Step 4: Implement the card**

`client/src/components/board/ItemCard.tsx`:

```tsx
import type { BacklogItem, Section } from '../../../../shared/types';

/** Pill class + label per section — the label is the id prefix, which is what
 *  the store's own filenames call the type. */
const PILL: Record<Section, { cls: string; label: string }> = {
  bugs: { cls: 'pill-bug', label: 'bug' },
  ideas: { cls: 'pill-idea', label: 'idea' },
  tasks: { cls: 'pill-task', label: 'task' },
  'out-of-scope': { cls: 'pill-oos', label: 'oos' }
};

/**
 * guide-manager's .guides-card, ported: title on top, footer pinned to the
 * bottom with a type pill and a mono meta line. Keyboard added (the original
 * was pointer-only): the whole card is the target, so it needs to be reachable.
 */
export function ItemCard({ item, onOpen }: { item: BacklogItem; onOpen: () => void }) {
  return (
    <div
      className="board-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="board-card-title">{item.title}</div>
      <div className="board-card-foot">
        <span className={`pill ${PILL[item.section].cls}`}>{PILL[item.section].label}</span>
        <div className="board-card-meta">
          {item.id} · {item.project} · {item.created}
          {/* Groomed only on bugs: tasks are groomed by construction, and a
              marker that is always on says nothing. Ungroomed is the default
              state of a fresh bug, not a warning — so silence, not red. */}
          {item.section === 'bugs' && item.groomed ? (
            <span className="board-card-groomed"> · groomed</span>
          ) : null}
          {item.status === 'done' ? <span className="board-card-done"> · done</span> : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement the board**

Replace `client/src/components/board/BoardView.tsx` wholesale:

```tsx
import { useState } from 'react';

import { useBoard } from '../../hooks/useBoard';
import { usePersistedState } from '../../hooks/usePersistedState';
import { ItemCard } from './ItemCard';
import { ItemDrawer } from './ItemDrawer';
import type { BacklogItem, Section } from '../../../../shared/types';

const PROJECT_KEY = 'backlog-manager.project';
const STATUS_KEY = 'backlog-manager.status';
const SORT_KEY = 'backlog-manager.sort';

/** The "not narrowed" sentinel — a sentinel rather than '', so a stored value
 *  always reads as itself and never as "the field was cleared". */
const ALL = 'all';

type StatusFilter = 'open' | 'done' | 'all';
type SortKey = 'created' | 'name' | 'project';

/** Fixed column order — the store's own section order, not alphabetical. */
const COLUMNS: { section: Section; label: string; slug: string }[] = [
  { section: 'bugs', label: 'Bugs', slug: 'bugs' },
  { section: 'ideas', label: 'Ideas', slug: 'ideas' },
  { section: 'tasks', label: 'Tasks', slug: 'tasks' },
  { section: 'out-of-scope', label: 'Out of scope', slug: 'oos' }
];

/**
 * Onto a copy, never in place — the array belongs to the fetched index.
 * `created` compares as a string: backlog.mjs writes fixed-width UTC
 * YYYY-MM-DD, where lexicographic order is chronological order, and an
 * unparseable value sorts predictably instead of NaN-scrambling the list.
 */
function sortItems(items: BacklogItem[], sort: SortKey): BacklogItem[] {
  const out = [...items];
  if (sort === 'name') {
    out.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === 'project') {
    out.sort((a, b) => a.project.localeCompare(b.project) || b.created.localeCompare(a.created));
  } else {
    out.sort((a, b) => b.created.localeCompare(a.created));
  }
  return out;
}

/**
 * The board: every registered project's items in four fixed type columns.
 * All narrowing happens here, client-side, over the fetched index — the whole
 * corpus is a few hundred rows of title-and-date, and a server-side filter
 * would cost a round trip per keystroke (guide-manager's rationale, kept).
 */
export default function BoardView() {
  const { items: index, projects, loading, error } = useBoard();
  const [open, setOpen] = useState<BacklogItem | null>(null);

  /* The query is plain useState — deliberately not remembered. A remembered
     query is a board that opens showing three cards out of forty for no
     visible reason. The selects survive that objection because each one
     permanently states its own value in the bar. */
  const [query, setQuery] = useState('');
  const [project, setProject] = usePersistedState<string>(PROJECT_KEY, ALL);
  const [status, setStatus] = usePersistedState<StatusFilter>(STATUS_KEY, 'open');
  const [sort, setSort] = usePersistedState<SortKey>(SORT_KEY, 'created');

  const all = index?.items ?? [];
  const registered = projects ?? [];

  /* Fail-open on a stale stored project (unregistered since): an unmatched
     filter that emptied the board would look like the server broke. The
     fallback feeds back into the select, so control and board agree. */
  const knownPaths = new Set(registered.map((p) => p.path));
  const projectValue = knownPaths.has(project) ? project : ALL;

  const needle = query.trim().toLowerCase();
  const matches = (i: BacklogItem): boolean =>
    (projectValue === ALL || i.projectPath === projectValue) &&
    (needle === '' || i.title.toLowerCase().includes(needle)) &&
    // out-of-scope is flat and terminal — the open/done select has no say there
    (i.section === 'out-of-scope' || status === 'all' || i.status === status);

  const visible = all.filter(matches);
  const missing = registered.filter((p) => p.missing);
  const warnings = [
    ...missing.map((p) => `unreachable: ${p.name} — no backlog/ at ${p.path}`),
    ...(index?.errors ?? [])
  ];

  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Projects</div>
        <div className="board-tools">
          <input
            type="search"
            className="board-search"
            aria-label="Search items"
            placeholder="search titles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="board-select"
            aria-label="Project"
            value={projectValue}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value={ALL}>All projects</option>
            {/* Valued by path, labelled by name — two checkouts of one repo
                stay two selectable options. */}
            {registered.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
          </select>
          <select
            className="board-select"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          <select
            className="board-select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="created">Newest first</option>
            <option value="name">By name</option>
            <option value="project">By project</option>
          </select>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="board-warn" data-testid="board-warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="board-empty">loading…</div>
      ) : error && all.length === 0 ? (
        <div className="board-empty">board unavailable</div>
      ) : all.length === 0 ? (
        /* Two distinct empty states: an empty registry is fixed by running a
           backlog skill in some project; an empty RESULT is fixed by the
           controls two inches above the message. */
        <div className="board-empty">nothing registered yet</div>
      ) : visible.length === 0 ? (
        <div className="board-empty">no matches</div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map((col) => {
            const colItems = sortItems(visible.filter((i) => i.section === col.section), sort);
            return (
              <div className={`board-col board-col-${col.slug}`} key={col.section} data-testid="board-col">
                <div className="board-col-h">
                  <span className="board-col-tick" />
                  <span className="board-col-name" data-testid="col-name">{col.label}</span>
                  <span className="board-col-count" data-testid="col-count">{colItems.length}</span>
                </div>
                <div className="board-col-cards">
                  {colItems.map((item) => (
                    <ItemCard key={item.path} item={item} onOpen={() => setOpen(item)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open !== null && <ItemDrawer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
```

Also create the `ItemDrawer` placeholder shown in this task's Interfaces block (Task 12 replaces it).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- test/board.test.tsx && pnpm run typecheck`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/useBoard.ts client/src/components/board/ package.json pnpm-lock.yaml test/board.test.tsx
git commit -m "feat: kanban-by-type board with toolbar filtering"
```

---

### Task 12: Item drawer (TDD, jsdom)

**Files:**
- Modify: `client/src/components/board/ItemDrawer.tsx` (replace the placeholder wholesale)
- Test: `test/drawer.test.tsx`

**Interfaces:**
- Consumes: `BacklogItem`; `GET /api/items/body?path=…` (Task 8); `marked`.
- Produces: `ItemDrawer({ item, onClose })` — backdrop click, close button, and Escape all call `onClose`.

- [ ] **Step 1: Write the failing test**

Create `test/drawer.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemDrawer } from '../client/src/components/board/ItemDrawer';
import type { BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'bug-2', title: 'groomed bug', created: '2026-08-20', tags: ['ui'],
  section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, path: '/abs/alpha/backlog/bugs/open/bug-2-groomed-bug.md'
};

describe('ItemDrawer', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('## Cause\n\noff by one\n') } as Response)
    ) as jest.Mock;
  });

  it('fetches the body by path and renders the markdown', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/items/body?path=${encodeURIComponent(ITEM.path)}`
    );
    await waitFor(() => expect(screen.getByText('Cause')).toBeInTheDocument());
    expect(screen.getByText('off by one')).toBeInTheDocument();
  });

  it('shows the item meta: pill, project, created, path', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'groomed bug' })).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText(/alpha · 2026-08-20/)).toBeInTheDocument();
    expect(screen.getByText(ITEM.path)).toBeInTheDocument();
  });

  it('closes on Escape, on the close button, and on the backdrop', async () => {
    const onClose = jest.fn();
    render(<ItemDrawer item={ITEM} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows an unavailable state when the body fetch fails', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 404 } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('item file unavailable')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/drawer.test.tsx`
Expected: FAIL — placeholder renders none of this.

- [ ] **Step 3: Implement**

Replace `client/src/components/board/ItemDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { marked } from 'marked';

import type { BacklogItem, Section } from '../../../../shared/types';

const PILL: Record<Section, { cls: string; label: string }> = {
  bugs: { cls: 'pill-bug', label: 'bug' },
  ideas: { cls: 'pill-idea', label: 'idea' },
  tasks: { cls: 'pill-task', label: 'task' },
  'out-of-scope': { cls: 'pill-oos', label: 'oos' }
};

/**
 * The right-hand detail drawer. Read-only on purpose — every write to an item
 * belongs to the skills, so the drawer renders and never edits.
 *
 * The body is fetched on open rather than carried in the index: the index is
 * refetched on every window focus, and shipping every body every time would
 * make that refresh pay for content nobody is looking at.
 */
export function ItemDrawer({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setFailed(false);
    fetch(`/api/items/body?path=${encodeURIComponent(item.path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((text) => {
        if (alive) setBody(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* marked is synchronous unless handed async extensions — none here. The
     HTML goes in via dangerouslySetInnerHTML, which is fine for exactly one
     reason: these are the user's own local Markdown files, served through the
     registry allowlist. Nothing here renders content from another origin. */
  const html = body === null ? '' : (marked.parse(body, { async: false }) as string);

  return (
    <>
      <div className="drawer-backdrop" data-testid="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={item.title}>
        <div className="drawer-head">
          <span className={`pill ${PILL[item.section].cls}`}>{PILL[item.section].label}</span>
          <span className="drawer-title">{item.title}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>
        <div className="drawer-meta">
          <span>
            {item.id} · {item.project} · {item.created}
            {item.status === 'done' ? ' · done' : ''}
            {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
          </span>
          <span className="drawer-path">{item.path}</span>
        </div>
        <div className="drawer-body">
          {failed ? (
            <div className="drawer-empty">item file unavailable</div>
          ) : body === null ? (
            <div className="drawer-empty">loading…</div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- test/drawer.test.tsx test/board.test.tsx && pnpm run typecheck`
Expected: PASS (the board suite's drawer-open assertion now runs against the real drawer).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/board/ItemDrawer.tsx test/drawer.test.tsx
git commit -m "feat: read-only item drawer with rendered markdown body"
```

---

### Task 13: Settings view (TDD, jsdom)

**Files:**
- Modify: `client/src/components/settings/SettingsView.tsx` (replace the placeholder wholesale)
- Test: `test/settings-view.test.tsx`

**Interfaces:**
- Consumes: `useSettings`, `SettingsRow`/`SettingsGroup`/`Segmented`, `THEMES`/`FONT_SCALES`/`Landing`.
- Produces: the Settings section — theme swatches, density, text size, opens-on. No Reading group (that was the bionic aid).

- [ ] **Step 1: Write the failing test**

Create `test/settings-view.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

describe('SettingsView', () => {
  beforeEach(() => localStorage.clear());

  function renderView() {
    render(
      <SettingsProvider>
        <SettingsView />
      </SettingsProvider>
    );
  }

  it('offers the five themes and persists a pick under the backlog-manager key', async () => {
    renderView();
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Daylight Strip/ }));
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });

  it('has no bionic reading rows', () => {
    renderView();
    expect(screen.queryByText(/Bionic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixation/)).not.toBeInTheDocument();
  });

  it('changes density and text size', async () => {
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    await userEvent.click(screen.getByRole('button', { name: '120%' }));
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  it('offers Projects as a landing choice', async () => {
    renderView();
    await userEvent.selectOptions(screen.getByLabelText('Opens on'), 'projects');
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.landing).toBe('projects');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/settings-view.test.tsx`
Expected: FAIL — placeholder.

- [ ] **Step 3: Implement**

Replace `client/src/components/settings/SettingsView.tsx` with guide-manager's `SettingsView.tsx` minus the bionic material:

1. Delete the whole `<SettingsGroup title="Reading">…</SettingsGroup>` block, and the now-unused `ON_OFF`, `STRENGTHS`, `FREQUENCIES` constants.
2. `LANDINGS` becomes `[{ value: 'last', label: 'Last used' }, { value: 'projects', label: 'Projects' }, { value: 'settings', label: 'Settings' }]`.
3. In the "Text size" row's hint, drop the trailing sentence about the guide inside the viewer (there is no viewer): keep `"Scales the whole board, not just type — the rail, the cards and the spacing move with it."`
4. In the "Density" row's hint, `"more guides per screen"` → `"more items per screen"`.
5. Keep `SWATCHES`, the theme grid, Density, Text size, and Opens on exactly as they are otherwise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm run typecheck`
Expected: full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/SettingsView.tsx test/settings-view.test.tsx
git commit -m "feat: settings — theme, density, text size, landing (no bionic)"
```

---

### Task 14: Docker, docs, self-registration, final verification

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `README.md`, `CLAUDE.md`, `.dockerignore`

**Interfaces:**
- Consumes: everything.
- Produces: `pnpm run docker:up` bringing up api (4322) + client (5177); the repo registered in the real registry; docs.

- [ ] **Step 1: Write `Dockerfile` and `.dockerignore`**

Copy `../guide-manager/Dockerfile` verbatim — it is app-name-free (node:24-slim, procps, corepack, the two dependency-layer COPY lines) and every comment still applies. Copy `.dockerignore` verbatim too (`node_modules`, `dist`, `client/dist`, `.git` — check the source's exact list).

- [ ] **Step 2: Write `docker-compose.yml`**

Guide-manager's compose minus the entire `mongo` service and every reference to it, renamed:

```yaml
# The whole stack in one command:
#
#   docker compose up
#
# The Nest API on :4322 and the Vite dev server on :5177. Open
# http://localhost:5177 — that is the one with hot reload; its proxy sends
# /api through to the API container. No database service: the registry file
# and the project stores ARE the data, mounted read-only from the host.
#
# Only the host side of each published port is configurable. Set
# BM_WEB_PORT / BM_API_PORT in .env to move them.
services:
  server:
    build: .
    command: pnpm run dev
    restart: unless-stopped
    environment:
      # pnpm 11 wants a TTY to fix a node_modules/lockfile disagreement and
      # crash-loops in compose without one. CI=true is pnpm's documented
      # non-interactive answer.
      CI: 'true'
      PORT: '4322'
      # The registry stores absolute host paths, and defaultRegistryFile()
      # reads ~/.backlog-manager/registry.json off homedir() — which on Linux
      # is $HOME. Pointing it at the same path the mount below uses keeps
      # both honest.
      HOME: ${HOME}
    ports:
      - '${BM_API_PORT:-4322}:4322'
    volumes:
      - .:/app
      - backlog-manager-node-modules:/app/node_modules
      # The registry names projects by absolute host path, so those paths
      # have to mean the same thing inside the container. Read-only
      # throughout: the server never writes; backlog.mjs does, on the host.
      - ${HOME}/.backlog-manager:${HOME}/.backlog-manager:ro
      - ${BM_PROJECT_ROOT:-${HOME}/Documents/custom-projects}:${BM_PROJECT_ROOT:-${HOME}/Documents/custom-projects}:ro

  client:
    build: .
    command: pnpm run dev:web
    restart: unless-stopped
    depends_on:
      - server
    environment:
      CI: 'true'
      # vite.config.ts builds its proxy target from these. localhost inside
      # this container is this container, so the API is named by service.
      API_HOST: server
      PORT: '4322'
      WEB_PORT: '5177'
      # Bind-mount file events are unreliable on Docker Desktop; polling
      # always notices.
      CHOKIDAR_USEPOLLING: 'true'
    ports:
      - '${BM_WEB_PORT:-5177}:5177'
    volumes:
      - .:/app
      - backlog-manager-node-modules:/app/node_modules

volumes:
  backlog-manager-node-modules:
```

- [ ] **Step 3: Write `README.md` and `CLAUDE.md`**

`README.md`: what this is (the four backlog skills as a plugin + the board app), the store format table (from `backlog/README.md`), install-as-plugin instructions (`/plugin marketplace add <path-or-repo>` then `/plugin install backlog-manager@backlog-manager-marketplace`), the commands table, ports, and a screenshot placeholder.

`CLAUDE.md`, modeled on guide-manager's — commands table (`docker:up`, `dev`, `dev:web`, `test`, `test:skills`, `typecheck`, `build`), layout section, and these invariants (each one line, in guide-manager's voice):

- `skills/` is the plugin skill root; never duplicate under `.claude/skills/`.
- `~/.backlog-manager/registry.json` has exactly one writer: `skills/backlog/tools/backlog.mjs` (its `init`/`new` upsert). The server re-reads it per request, never writes, never caches.
- Item files are read-only to the server and client; every write goes through the skills.
- Every server route lives under `/api`; the Vite proxy has exactly one entry, asserted by `test/vite-proxy.test.ts`.
- Item bodies are served through an allowlist built from the registry (`allow.util.ts`); a file outside every registered `backlog/` 404s.
- Groomed is derived (bug: Cause+Fix filled and not "unknown"; task: Plan non-empty), never stored; status is the directory, never frontmatter.
- Ports 4322/5177 — guide-manager holds 4321/5175/5176 on this machine.
- Container mounts land on host paths, read-only, because the registry stores absolute host paths.
- pnpm only, pinned by `packageManager`, enforced via corepack in the image.
- `allowBuilds` in `pnpm-workspace.yaml` lists `esbuild`; a skipped build surfaces as Vite failing to start.
- Editing `vite.config.ts` needs `docker compose restart client`.
- Backlog items move `open/` → `done/`; `out-of-scope/` is flat.

- [ ] **Step 4: Register this repo for real and run the full gate**

```bash
node skills/backlog/tools/backlog.mjs init
```

Expected: `already initialized` (Task 4 created the store) — and the real `~/.backlog-manager/registry.json` now lists this repo.

Run: `pnpm test && pnpm run test:skills && pnpm run typecheck && pnpm run build`
Expected: everything PASS, both bundles build.

- [ ] **Step 5: Manual smoke — the running board**

Terminal 1: `pnpm run dev` · Terminal 2: `pnpm run dev:web`, open `http://localhost:5177`.
Expected: four columns; this repo's own backlog items visible (capture one first if the store is empty: `node skills/backlog/tools/backlog.mjs new ideas "seed the board"` and write the printed file with the idea headings); clicking a card opens the drawer with the rendered body; Settings switches themes with no flash on reload; the phone breakpoint (narrow the window under 700px) stacks the columns and lays the rail down.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md CLAUDE.md backlog/
git commit -m "chore: docker stack (no db), docs, self-registered store"
```

- [ ] **Step 7: Hand the user the migration steps (do not perform them)**

Print for the user:
1. `claude` → `/plugin marketplace add /Users/andrejajevtic/Documents/custom-projects/backlog-manager` → `/plugin install backlog-manager@backlog-manager-marketplace`.
2. Verify `/backlog` still answers in some project (now served by the plugin).
3. Delete the old copies: `rm -rf ~/.claude/skills/backlog ~/.claude/skills/backlog-capture ~/.claude/skills/backlog-groom ~/.claude/skills/backlog-execute` — only after step 2, otherwise the skills load twice and drift.
4. Existing projects appear on the board the first time any backlog skill runs in them (each `init`/`new` registers). To pre-seed one without capturing: `cd <project> && node <plugin-cache-path>/skills/backlog/tools/backlog.mjs init`.

---

## Self-review notes (run after writing, fixed inline)

- Spec coverage: registration (T4), 3 API routes (T7/T8), board B with toolbar + persisted selects + fail-open project filter (T11), drawer (T12), settings minus bionic (T13), 5 themes (T2/T10), docker no-mongo + ro mounts + tailnet (T14), partial-board errors[] (T7), missing-project flag (T7 + warn line T11), allowlist (T8), vite proxy invariant (T10), migration/rollout (T3 + T14). Self-dogfooding store: T4 smoke + T14.
- Type consistency: `Section`/`ItemStatus`/`BacklogItem`/`ItemsIndex`/`ProjectSummary` defined once in T2 and imported everywhere; `REGISTRY_FILE` token provided in T5's module explicitly so overrides work in T7/T8/T9 suites; drawer placeholder created in T11 so T11 compiles before T12.
- Known judgment calls an executor must not "fix": no database; no polling (focus refetch only); drawer read-only; `out-of-scope` ignores the status select; groomed marker only on bug cards.
