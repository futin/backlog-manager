# Agent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A click on a backlog card spawns a headless Claude Code session in that item's project, running the skill the item's own state calls for — groom an idea into a task, fill an ungroomed bug's Cause/Fix, execute a groomed bug or task.

**Architecture:** The board calls this repo's own API (`/api/agents/*`); that API validates the item off disk and then calls `../claude-agents-dashboard`'s existing `POST /api/spawn`. The browser never talks to the dashboard, so the bearer token stays server-side and `connect-src 'self'` stays intact. The action is *derived* from the item file, never taken from the request.

**Tech Stack:** NestJS 11 (Express), React 18, TypeScript (strict), jest + ts-jest (`--runInBand`), @testing-library/react for jsdom suites, pnpm.

**Spec:** [`docs/superpowers/specs/2026-08-27-agents-dispatch-design.md`](../specs/2026-08-27-agents-dispatch-design.md)

## Global Constraints

- **Node >= 22.13, pnpm only** (`packageManager: pnpm@11.13.0`). Global `fetch` and `AbortSignal.timeout` are available; add no HTTP dependency.
- **Every controller lives under `/api`.** `test/vite-proxy.test.ts` asserts it from Nest route metadata and pins the controller count — a new controller must be added to its `CONTROLLERS` array or that suite fails.
- **`shared/` is imported by both sides.** `client/src/styles.css` already does `@import '../../shared/theme.css'`, and `tsconfig.json` includes `shared/**/*`, so a runtime module there is legal from client and server alike. One implementation, no drift.
- **Item files stay read-only to this app.** Nothing in this plan writes an item. The spawned session runs the skills, which remain the only writers.
- **Off by default:** `BM_AGENTS` unset ⇒ no outbound request, no buttons, board identical to today.
- **The token never reaches the browser.** No endpoint echoes it, and the dashboard's origin is env-only — never client-supplied (that is what keeps this from being an SSRF surface).
- **Comments explain *why*, at length.** Match the existing density; do not strip it.
- Tests are flat in `test/`, named `*.test.ts` / `*.test.tsx`. Component suites need a `@jest-environment jsdom` docblock.
- Run one suite with `pnpm test -- test/<name>.test.ts`; the whole suite with `pnpm test`; types with `pnpm run typecheck`.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `shared/agent.ts` | The derivation and the permission ladder, shared by both sides: `deriveAction`, `actionLabel`, `PERMISSION_LADDER`, `modesUpTo`, `clampMode`, `dispatchBlock`. Pure, no imports beyond `./types`. |
| `server/src/agents/config.util.ts` | Reads `BM_AGENTS*` env into a typed object. Pure. |
| `server/src/agents/prompt.util.ts` | Composes the prompt and the session name from an item + action. Pure. |
| `server/src/agents/agents.service.ts` | The only file that touches the network: status probe, the 60s project-map cache, item lookup, the spawn call. |
| `server/src/agents/agents.controller.ts` | Three routes, nothing else. |
| `server/src/agents/agents.module.ts` | Wiring. |
| `client/src/lib/agents.ts` | The three `fetch` calls and their error unwrapping. |
| `client/src/hooks/useAgents.ts` | Status on mount + on window focus, mirroring `useBoard`. |
| `client/src/components/board/DispatchButton.tsx` | The per-card button: hidden when there is no action, disabled with a reason when blocked. |
| `client/src/components/board/LaunchSheet.tsx` | The modal: prompt, mode, remote-control, Launch, then the session link. |

**Modified**

| File | Change |
|---|---|
| `shared/types.ts` | `PermissionMode`, `AgentsStatus`, `AgentPlan`, `AgentDispatchRequest`, `AgentDispatchResult` |
| `server/src/app.module.ts` | import `AgentsModule` |
| `client/src/lib/settings.ts` | new flat key `linkBase` + its clamp |
| `client/src/components/board/ItemCard.tsx` | render `DispatchButton` |
| `client/src/components/board/ItemDrawer.tsx` | render `DispatchButton` |
| `client/src/components/board/BoardView.tsx` | own the `useAgents` status and the open sheet |
| `client/src/components/settings/SettingsView.tsx` | the "Claude Agents" group |
| `client/src/styles.css` | `.board-card-dispatch`, `.sheet-*`, `.set-status-*` |
| `test/vite-proxy.test.ts` | 3 controllers |
| `test/settings.test.ts` | `linkBase` clamping |
| `CLAUDE.md`, `README.md`, `.env.example`, `docker-compose.yml` | the new env and the new invariants |

---

### Task 1: Shared contract — types, derivation, permission ladder

The one piece both sides must agree on. It ships first because every later task imports it.

**Files:**
- Create: `shared/agent.ts`
- Modify: `shared/types.ts` (append at end of file)
- Test: `test/agents-shared.test.ts`

**Interfaces:**
- Consumes: `BacklogItem`, `Section`, `ItemStatus` from `shared/types.ts`.
- Produces:
  - `type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'`
  - `interface AgentsStatus { enabled, reachable, remoteAnswer, spawnAvailable, spawnMaxPermission, projectPaths, error? }`
  - `interface AgentPlan { action, prompt, project, allowedModes, defaultMode, blocked? }`
  - `interface AgentDispatchRequest { itemPath, action, prompt, permissionMode, remoteControl }`
  - `interface AgentDispatchResult { sessionId: string }`
  - `type AgentAction = 'groom' | 'execute'`
  - `deriveAction(item: BacklogItem): AgentAction | null`
  - `actionLabel(item: BacklogItem, action: AgentAction): string`
  - `PERMISSION_LADDER: readonly PermissionMode[]`
  - `modesUpTo(ceiling: PermissionMode | null): PermissionMode[]`
  - `clampMode(want: string, ceiling: PermissionMode | null): PermissionMode`
  - `dispatchBlock(item: BacklogItem, status: AgentsStatus): string | null`

- [ ] **Step 1: Write the failing test**

Create `test/agents-shared.test.ts`:

```ts
import {
  PERMISSION_LADDER, actionLabel, clampMode, deriveAction, dispatchBlock, modesUpTo
} from '../shared/agent';
import type { AgentsStatus, BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md'
  };
  return { ...base, ...over };
}

const OK: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

describe('deriveAction', () => {
  it('sends an open idea to groom', () => {
    expect(deriveAction(fakeItem({ section: 'ideas', groomed: null }))).toBe('groom');
  });

  it('grooms an ungroomed bug and executes a groomed one', () => {
    expect(deriveAction(fakeItem({ groomed: false }))).toBe('groom');
    expect(deriveAction(fakeItem({ groomed: true }))).toBe('execute');
  });

  it('executes a planned task and grooms an unplanned one', () => {
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: true }))).toBe('execute');
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: false }))).toBe('groom');
  });

  it('has nothing to dispatch for an archived item or an out-of-scope one', () => {
    expect(deriveAction(fakeItem({ status: 'done', groomed: true }))).toBeNull();
    expect(deriveAction(fakeItem({ section: 'out-of-scope', status: 'terminal', groomed: null })))
      .toBeNull();
  });
});

describe('actionLabel', () => {
  it('names the destination for an idea, since groom moves it', () => {
    expect(actionLabel(fakeItem({ section: 'ideas' }), 'groom')).toBe('groom → task');
    expect(actionLabel(fakeItem(), 'groom')).toBe('groom');
    expect(actionLabel(fakeItem(), 'execute')).toBe('execute');
  });
});

describe('the permission ladder', () => {
  it('runs lowest to highest', () => {
    expect(PERMISSION_LADDER).toEqual(['plan', 'acceptEdits', 'auto', 'bypassPermissions']);
  });

  it('offers only the modes at or below the ceiling', () => {
    expect(modesUpTo('acceptEdits')).toEqual(['plan', 'acceptEdits']);
    expect(modesUpTo('bypassPermissions')).toEqual([...PERMISSION_LADDER]);
  });

  it('offers nothing but plan when the ceiling is unknown', () => {
    expect(modesUpTo(null)).toEqual(['plan']);
  });

  it('clamps a want above the ceiling down to it, and junk down to plan', () => {
    expect(clampMode('bypassPermissions', 'acceptEdits')).toBe('acceptEdits');
    expect(clampMode('plan', 'auto')).toBe('plan');
    expect(clampMode('nonsense', 'auto')).toBe('plan');
    expect(clampMode('auto', null)).toBe('plan');
  });
});

describe('dispatchBlock', () => {
  it('passes a dispatchable item on a healthy dashboard', () => {
    expect(dispatchBlock(fakeItem(), OK)).toBeNull();
  });

  it('reports each gate, most-fundamental first', () => {
    expect(dispatchBlock(fakeItem(), { ...OK, enabled: false })).toMatch(/BM_AGENTS/);
    expect(dispatchBlock(fakeItem(), { ...OK, reachable: false, error: 'ECONNREFUSED' }))
      .toMatch(/unreachable.*ECONNREFUSED/);
    expect(dispatchBlock(fakeItem(), { ...OK, spawnAvailable: false })).toMatch(/CLAUDE_BIN/);
    expect(dispatchBlock(fakeItem(), { ...OK, remoteAnswer: false })).toMatch(/remote answers/);
  });

  it('names the project the dashboard cannot see, and why', () => {
    const blocked = dispatchBlock(fakeItem(), { ...OK, projectPaths: ['/abs/other'] });
    expect(blocked).toContain('/abs/alpha');
    expect(blocked).toMatch(/LOOKBACK_HOURS/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-shared.test.ts`
Expected: FAIL — `Cannot find module '../shared/agent'`

- [ ] **Step 3: Append the wire types to `shared/types.ts`**

Append to the end of `shared/types.ts`:

```ts
/**
 * The dashboard's permission-mode ladder, lowest to highest. Re-declared here
 * rather than imported from ../claude-agents-dashboard: that repo is a sibling
 * checkout, not a dependency, and a cross-repo import would make this app
 * unbuildable without it. Four strings, pinned by test/agents-shared.test.ts.
 */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';

/**
 * `GET /api/agents/status`. Every field is false/empty when `enabled` is false —
 * that case never leaves this process, so there is nothing to report about a
 * dashboard we did not call.
 */
export interface AgentsStatus {
  /** BM_AGENTS is on. False ⇒ no outbound request was made at all. */
  enabled: boolean;
  /** The dashboard answered GET /api/health. */
  reachable: boolean;
  /** Its remote-answer toggle. POST /api/spawn 404s without it. */
  remoteAnswer: boolean;
  /** Its CLAUDE_BIN probe. Also a 404 on spawn when false. */
  spawnAvailable: boolean;
  /** The ceiling every launch is clamped to; null when we could not read it. */
  spawnMaxPermission: PermissionMode | null;
  /**
   * Absolute project paths the dashboard can currently resolve to a session
   * directory — i.e. those with a Claude transcript inside its LOOKBACK_HOURS.
   * A registered project missing from this list cannot be spawned into.
   */
  projectPaths: string[];
  /** Why `reachable` is false. Rendered verbatim in Settings. */
  error?: string;
}

/**
 * `POST /api/agents/plan` — everything the launch sheet needs, and nothing the
 * client could have decided for itself. Deliberately carries no dashboard
 * `dirName`: that key is internal to the spawn call, the client has no use for
 * it, and dispatch re-resolves it from `itemPath` anyway.
 */
export interface AgentPlan {
  action: 'groom' | 'execute';
  /** The composed default. The sheet may edit it before dispatching. */
  prompt: string;
  /** Display name of the project the session will run in. */
  project: string;
  /** The ladder truncated at the dashboard's ceiling — never wider. */
  allowedModes: PermissionMode[];
  defaultMode: PermissionMode;
  /**
   * Set when the item is dispatchable in principle but not right now (the
   * dashboard is off, unreachable, or cannot see the project). Re-checked here
   * rather than trusted from the board's older status read, which may be
   * minutes stale — the sheet renders this instead of a Launch button.
   */
  blocked?: string;
}

/** Body of `POST /api/agents/dispatch`. */
export interface AgentDispatchRequest {
  itemPath: string;
  /** Checked against the server's own derivation, never obeyed. */
  action: 'groom' | 'execute';
  prompt: string;
  permissionMode: PermissionMode;
  remoteControl: boolean;
}

/** 200 body of `POST /api/agents/dispatch` — the dashboard's minted session id. */
export interface AgentDispatchResult {
  sessionId: string;
}
```

- [ ] **Step 4: Write `shared/agent.ts`**

```ts
import type { AgentsStatus, BacklogItem, PermissionMode } from './types';

/**
 * agent.ts — what a card's button does, decided once for both sides.
 *
 * The server is the authority (it re-scans the file and refuses a request whose
 * action disagrees), but the board needs the same answer to label and enable a
 * button without a round trip per card. Two implementations would drift, so
 * this module lives in shared/ and both import it — the same arrangement
 * shared/types.ts already has, and shared/theme.css before it.
 */

/** What a click dispatches. Derived from the item; never chosen by the caller. */
export type AgentAction = 'groom' | 'execute';

/**
 * The next step this item actually has, or null when it has none.
 *
 * `status !== 'open'` covers both archives in one line: a `done/` item is
 * history, and out-of-scope is `terminal` — neither has a next step. Ideas go
 * to groom unconditionally (grooming is what promotes them; `groomed` is null
 * for them by construction). Bugs and tasks turn on the groomed derivation
 * alone, which is exactly the condition backlog-execute refuses to work
 * without: a bug whose Fix still reads "unknown" gets groomed first.
 */
export function deriveAction(item: BacklogItem): AgentAction | null {
  if (item.status !== 'open') return null;
  if (item.section === 'ideas') return 'groom';
  return item.groomed === true ? 'execute' : 'groom';
}

/**
 * The button's word. An idea names its destination because grooming *moves* it
 * out of the column you clicked in — a bug groomed in place does not, so it
 * says only what it does.
 */
export function actionLabel(item: BacklogItem, action: AgentAction): string {
  if (action === 'execute') return 'execute';
  return item.section === 'ideas' ? 'groom → task' : 'groom';
}

/** Lowest to highest. Order is the whole meaning — do not sort this. */
export const PERMISSION_LADDER: readonly PermissionMode[] = [
  'plan', 'acceptEdits', 'auto', 'bypassPermissions'
];

/**
 * The modes a launch may actually ask for. A null ceiling means we never read
 * one (the dashboard was unreachable), and the safe reading of "unknown
 * ceiling" is the floor, not the top.
 */
export function modesUpTo(ceiling: PermissionMode | null): PermissionMode[] {
  if (ceiling === null) return ['plan'];
  const i = PERMISSION_LADDER.indexOf(ceiling);
  // An unrecognised ceiling string is a dashboard newer than this client:
  // treat it as the floor rather than guessing where it sits on the ladder.
  return i === -1 ? ['plan'] : PERMISSION_LADDER.slice(0, i + 1);
}

/**
 * Clamp a requested mode to the ceiling. Takes a `string`, not a
 * `PermissionMode`, because its whole job is to be the place an unvalidated
 * value from a request body becomes a valid one.
 */
export function clampMode(want: string, ceiling: PermissionMode | null): PermissionMode {
  const allowed = modesUpTo(ceiling);
  const i = allowed.indexOf(want as PermissionMode);
  return i === -1 ? allowed[0] : allowed[i];
}

/**
 * Why this item cannot be dispatched right now, or null when it can.
 *
 * Ordered most-fundamental first so the message names the thing to fix rather
 * than a symptom of it: with BM_AGENTS off there is nothing to say about
 * reachability. Shared because the board disables a button with it, the launch
 * sheet re-checks it, and the server refuses with it — one wording, three
 * places.
 */
export function dispatchBlock(item: BacklogItem, status: AgentsStatus): string | null {
  if (!status.enabled) return 'dispatch is off — set BM_AGENTS=on for the API';
  if (!status.reachable) {
    return `dashboard unreachable${status.error ? `: ${status.error}` : ''}`;
  }
  if (!status.spawnAvailable) return 'the dashboard has no CLAUDE_BIN configured';
  if (!status.remoteAnswer) return 'remote answers are off in the dashboard';
  if (!status.projectPaths.includes(item.projectPath)) {
    return `the dashboard cannot see ${item.projectPath} — no Claude session there inside its LOOKBACK_HOURS`;
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/agents-shared.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add shared/agent.ts shared/types.ts test/agents-shared.test.ts
git commit -m "feat: shared action derivation and permission ladder for agent dispatch"
```

---

### Task 2: Server config and prompt composition

Two pure files. No network, no Nest.

**Files:**
- Create: `server/src/agents/config.util.ts`
- Create: `server/src/agents/prompt.util.ts`
- Test: `test/agents-prompt.test.ts`

**Interfaces:**
- Consumes: `deriveAction` from `shared/agent`, `BacklogItem` from `shared/types`.
- Produces:
  - `interface AgentsConfig { enabled: boolean; url: string; token: string }`
  - `readAgentsConfig(env?: NodeJS.ProcessEnv): AgentsConfig`
  - `composePrompt(item: BacklogItem, action: AgentAction): string`
  - `sessionName(item: BacklogItem): string`

- [ ] **Step 1: Write the failing test**

Create `test/agents-prompt.test.ts`:

```ts
import { readAgentsConfig } from '../server/src/agents/config.util';
import { composePrompt, sessionName } from '../server/src/agents/prompt.util';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md'
  };
  return { ...base, ...over };
}

describe('readAgentsConfig', () => {
  it('is off with no env at all', () => {
    expect(readAgentsConfig({})).toEqual({
      enabled: false, url: 'http://127.0.0.1:4173', token: ''
    });
  });

  it('accepts on/1/true and nothing else', () => {
    expect(readAgentsConfig({ BM_AGENTS: 'on' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: '1' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: 'TRUE' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: 'yes' }).enabled).toBe(false);
    expect(readAgentsConfig({ BM_AGENTS: '' }).enabled).toBe(false);
  });

  it('trims the url and strips trailing slashes so path joins never double up', () => {
    expect(readAgentsConfig({ BM_AGENTS_URL: ' http://dash:9/// ' }).url).toBe('http://dash:9');
  });

  it('falls back to the loopback default on an empty url', () => {
    expect(readAgentsConfig({ BM_AGENTS_URL: '   ' }).url).toBe('http://127.0.0.1:4173');
  });
});

describe('composePrompt', () => {
  it('names the groom skill and the promotion for an idea', () => {
    const p = composePrompt(fakeItem({ id: 'idea-3', title: 'Seed the board', section: 'ideas', groomed: null }), 'groom');
    expect(p).toContain('backlog-manager:backlog-groom');
    expect(p).toContain('idea-3');
    expect(p).toContain('"Seed the board"');
    expect(p).toMatch(/promote/i);
    expect(p).toMatch(/plan/i);
  });

  it('asks a bug groom for Cause and Fix, in place', () => {
    const p = composePrompt(fakeItem(), 'groom');
    expect(p).toContain('## Cause');
    expect(p).toContain('## Fix');
    expect(p).toContain('bugs/open/');
  });

  it('asks an unplanned task groom for a plan', () => {
    const p = composePrompt(fakeItem({ id: 'task-4', section: 'tasks', groomed: false }), 'groom');
    expect(p).toContain('backlog-manager:backlog-groom');
    expect(p).toMatch(/plan/i);
  });

  it('asks execute to verify and archive, and never to commit', () => {
    const p = composePrompt(fakeItem({ id: 'task-12', title: 'Add CSP', section: 'tasks', groomed: true }), 'execute');
    expect(p).toContain('backlog-manager:backlog-execute');
    expect(p).toContain('task-12');
    expect(p).toMatch(/archive/i);
    expect(p).toMatch(/do not commit or push/i);
  });

  it('never emits a slash command — headless expansion of those is unverified', () => {
    for (const item of [fakeItem(), fakeItem({ section: 'ideas', groomed: null })]) {
      expect(composePrompt(item, 'groom')).not.toContain('/backlog');
    }
  });

  it('collapses a title that would break the one-line quoting', () => {
    const p = composePrompt(fakeItem({ title: 'line one\nline two' }), 'groom');
    expect(p).toContain('"line one line two"');
    expect(p).not.toContain('\nline two');
  });
});

describe('sessionName', () => {
  it('labels the dashboard row with project and id', () => {
    expect(sessionName(fakeItem({ project: 'alpha', id: 'task-12' }))).toBe('bl:alpha/task-12');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-prompt.test.ts`
Expected: FAIL — cannot find `server/src/agents/config.util`

- [ ] **Step 3: Write both files**

`server/src/agents/config.util.ts`:

```ts
/**
 * config.util.ts — the three environment variables this feature has.
 *
 * Read per call rather than captured at construction, for the same reason
 * RegistryService re-reads its file per request: a test overriding
 * process.env between cases must see the override, and there is nothing here
 * worth caching.
 */
export interface AgentsConfig {
  /** BM_AGENTS is on. Everything else in this feature is gated on it. */
  enabled: boolean;
  /**
   * The dashboard's *API* origin — its PORT (4173 by default), not its Vite
   * port. Env-only, never client-supplied: there is deliberately no request
   * shape in which a browser names the host this server will call.
   */
  url: string;
  /** Sent as `Authorization: Bearer …` when set. Never leaves this process. */
  token: string;
}

/** The dashboard's own default PORT, on loopback. */
const DEFAULT_URL = 'http://127.0.0.1:4173';

/**
 * Only `on`, `1` and `true` enable. A misspelled value means off — the same
 * strictness the dashboard applies to its own `remoteControl === true`, and
 * for the same reason: the failure mode of a typo must be "feature stays off",
 * never "feature quietly on".
 */
export function readAgentsConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig {
  const flag = (env.BM_AGENTS ?? '').trim().toLowerCase();
  const url = (env.BM_AGENTS_URL ?? '').trim();
  return {
    enabled: flag === 'on' || flag === '1' || flag === 'true',
    // Trailing slashes stripped here so every call site can write
    // `${url}/api/health` without producing `//api/health`.
    url: (url || DEFAULT_URL).replace(/\/+$/, ''),
    token: (env.BM_AGENTS_TOKEN ?? '').trim()
  };
}
```

`server/src/agents/prompt.util.ts`:

```ts
import type { AgentAction } from '../../../shared/agent';
import type { BacklogItem } from '../../../shared/types';

/**
 * prompt.util.ts — what the spawned session is actually told to do.
 *
 * Natural language naming the skill, NOT a slash command. Whether `claude -p`
 * expands a `/skill` in a prompt piped on stdin is unverified against this
 * CLI, and the skills' own descriptions are written to trigger on exactly this
 * phrasing ("groom the backlog", "use the backlog-execute skill"), so the
 * documented path is also the safe one. test/agents-prompt.test.ts asserts no
 * slash command ever appears.
 *
 * Lifecycle bookkeeping is not mentioned: backlog-execute runs `backlog.mjs
 * start` itself and backlog-groom does its own `move`. Asking for it here
 * would be a second answer to a question the skills already own.
 */

const SKILL: Record<AgentAction, string> = {
  groom: 'backlog-manager:backlog-groom',
  execute: 'backlog-manager:backlog-execute'
};

/**
 * Titles come from item frontmatter, which is a `key: value` line — so a
 * newline cannot legally be in one. Collapsed anyway: this string is piped to
 * a child process as a prompt, and a hand-edited file is exactly the input
 * that would otherwise turn one instruction into two.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function composePrompt(item: BacklogItem, action: AgentAction): string {
  const head = `Use the ${SKILL[action]} skill on ${item.id} — "${oneLine(item.title)}" — in this repo's backlog.`;

  if (action === 'execute') {
    // "verify" and "archive" are the two halves backlog-execute refuses to
    // separate, and the commit ban is belt-and-braces: the skill already says
    // it never commits, but this session has no human at a terminal to stop it
    // if it decides to be helpful.
    return `${head} Work it through to verification, then archive the item. Report what you changed; do not commit or push.`;
  }
  if (item.section === 'ideas') {
    return `${head} Promote it to a task with a real, executable plan.`;
  }
  if (item.section === 'bugs') {
    // "Leave the item in bugs/open/" is the whole difference between grooming a
    // bug and executing it: groom fills the two headings and moves nothing.
    return `${head} Investigate it and fill in ## Cause and ## Fix. Leave the item in bugs/open/.`;
  }
  // A task with no Plan — only reachable from a hand-made file, since
  // backlog-capture refuses to create one without.
  return `${head} Give it a plan concrete enough to execute.`;
}

/**
 * The `-n` name the dashboard row is labelled with. Prefixed `bl:` so a row
 * this board started is recognisable among sessions started from a terminal.
 */
export function sessionName(item: BacklogItem): string {
  return `bl:${item.project}/${item.id}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/agents-prompt.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/agents/config.util.ts server/src/agents/prompt.util.ts test/agents-prompt.test.ts
git commit -m "feat: agent dispatch config and prompt composition"
```

---

### Task 3: `GET /api/agents/status`

The probe the board and Settings both read. First task with a network call, so it establishes the fetch helper, the timeouts, and the project-map cache.

**Files:**
- Create: `server/src/agents/agents.service.ts`
- Create: `server/src/agents/agents.controller.ts`
- Create: `server/src/agents/agents.module.ts`
- Modify: `server/src/app.module.ts`
- Modify: `test/vite-proxy.test.ts`
- Test: `test/agents-status.test.ts`

**Interfaces:**
- Consumes: `readAgentsConfig` (Task 2), `RegistryService`, `AgentsStatus`/`PermissionMode` (Task 1).
- Produces:
  - `class AgentsService` with `status(): Promise<AgentsStatus>`, and (private, used by Tasks 4-5) `projectMap`, `findItem`, `get`.
  - `class AgentsController` with `@Controller('api/agents')` and `@Get('status')`.
  - `class AgentsModule`.

- [ ] **Step 1: Write the failing test**

Create `test/agents-status.test.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { makeRegistry } from './helpers/store';

const HEALTH = {
  ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto'
};
const MANAGEMENT = {
  projects: [
    { dirName: '-abs-alpha', name: 'alpha', path: '/abs/alpha', lastActiveMs: 1 },
    { dirName: '-abs-beta', name: 'beta', path: '/abs/beta', lastActiveMs: 2 },
    // A malformed entry must be dropped, not crash the map build.
    { name: 'nameless' }
  ]
};

/** Answers the dashboard's two GETs and counts what was asked for. */
function stubDashboard() {
  const calls: string[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const payload = url.endsWith('/api/management') ? MANAGEMENT : HEALTH;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
  }) as jest.Mock;
  return calls;
}

describe('GET /api/agents/status', () => {
  let app: INestApplication;
  const env = { ...process.env };

  beforeEach(async () => {
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    delete process.env.BM_AGENTS_TOKEN;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('reports the dashboard probe and the resolvable project paths', async () => {
    stubDashboard();
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body).toEqual({
      enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
      spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha', '/abs/beta']
    });
  });

  it('makes no request at all when BM_AGENTS is off', async () => {
    const calls = stubDashboard();
    process.env.BM_AGENTS = 'off';
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls).toEqual([]);
    expect(res.body).toEqual({
      enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false,
      spawnMaxPermission: null, projectPaths: []
    });
  });

  it('reports why it is unreachable instead of failing the request', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.reachable).toBe(false);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('keeps a good health read when the heavy project scan fails', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      String(input).endsWith('/api/management')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(HEALTH) } as Response)
    ) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.projectPaths).toEqual([]);
  });

  it('reads an unrecognised ceiling as null rather than passing it through', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          String(input).endsWith('/api/management') ? MANAGEMENT : { ...HEALTH, spawnMaxPermission: 'godmode' }
        )
      } as Response)
    ) as jest.Mock;
    const res = await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(res.body.spawnMaxPermission).toBeNull();
  });

  it('fetches the heavy project list once per TTL, health every time', async () => {
    const calls = stubDashboard();
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls.filter((u) => u.endsWith('/api/management'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/api/health'))).toHaveLength(2);
  });

  it('re-fetches the project list once the TTL has passed', async () => {
    const calls = stubDashboard();
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    clock.mockReturnValue(start + 61_000);
    await request(app.getHttpServer()).get('/api/agents/status').expect(200);
    expect(calls.filter((u) => u.endsWith('/api/management'))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-status.test.ts`
Expected: FAIL — 404 on `/api/agents/status` (the route does not exist)

- [ ] **Step 3: Write the service, controller and module**

`server/src/agents/agents.service.ts`:

```ts
import { realpathSync } from 'node:fs';
import { HttpException, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { buildAllowlist, resolveAllowed } from '../items/allow.util';
import { scanProject } from '../items/scan.util';
import { readAgentsConfig, type AgentsConfig } from './config.util';
import { PERMISSION_LADDER } from '../../../shared/agent';
import type { AgentsStatus, BacklogItem, PermissionMode } from '../../../shared/types';

/**
 * agents.service.ts — the only file in this app that makes an outbound call.
 *
 * Everything it talks to belongs to ../claude-agents-dashboard: GET /api/health
 * (cheap, per request), GET /api/management (a full scan of every project's
 * Claude config — cached), and POST /api/spawn. This app has no other network
 * dependency and should not grow one.
 */

/** Health is a few fields off a warm process; a slow one means unreachable. */
const HEALTH_TIMEOUT_MS = 4_000;
/** /api/management walks every recent project's .claude tree. It earns more. */
const MANAGEMENT_TIMEOUT_MS = 15_000;
/**
 * How long a path→dirName map stays good. The list only changes when a Claude
 * session starts somewhere new, and the call behind it is the expensive one in
 * this feature — a minute of staleness costs a disabled button that would have
 * worked, which the sheet's own re-check then corrects.
 */
const PROJECT_TTL_MS = 60_000;

/** Shape we rely on from the dashboard's /api/health. Everything optional: it
 *  is a different app's response and an older build may omit fields. */
interface DashboardHealth {
  remoteAnswer?: unknown;
  spawnAvailable?: unknown;
  spawnMaxPermission?: unknown;
}

interface DashboardManagement {
  projects?: { dirName?: unknown; path?: unknown }[];
}

@Injectable()
export class AgentsService {
  /** Keyed by url so a changed BM_AGENTS_URL cannot be answered from the old
   *  dashboard's map — which in tests is the difference between a pass and a
   *  silent cross-contamination between cases. */
  private cache: { at: number; url: string; map: Map<string, string> } | null = null;

  constructor(private readonly registry: RegistryService) {}

  async status(): Promise<AgentsStatus> {
    const cfg = readAgentsConfig();
    const off: AgentsStatus = {
      enabled: false, reachable: false, remoteAnswer: false,
      spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
    };
    // The short-circuit is the feature's off switch: no fetch, so no egress,
    // so nothing to report about a dashboard we never contacted.
    if (!cfg.enabled) return off;

    let health: DashboardHealth;
    try {
      health = await this.get<DashboardHealth>(cfg, '/api/health', HEALTH_TIMEOUT_MS);
    } catch (e) {
      return { ...off, enabled: true, error: message(e) };
    }

    let projectPaths: string[] = [];
    try {
      projectPaths = [...(await this.projectMap(cfg)).keys()];
    } catch {
      // Swallowed on purpose: health already told us the dashboard is up, and
      // reporting `reachable: false` because the *heavy* call timed out would
      // send the reader to fix a connection that works. An empty list disables
      // the buttons, which is the honest consequence.
    }

    return {
      enabled: true,
      reachable: true,
      remoteAnswer: health.remoteAnswer === true,
      spawnAvailable: health.spawnAvailable === true,
      spawnMaxPermission: asMode(health.spawnMaxPermission),
      projectPaths
    };
  }

  /** Absolute project path → the dashboard's own dirName key. */
  protected async projectMap(cfg: AgentsConfig): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cache && this.cache.url === cfg.url && now - this.cache.at < PROJECT_TTL_MS) {
      return this.cache.map;
    }
    const data = await this.get<DashboardManagement>(cfg, '/api/management', MANAGEMENT_TIMEOUT_MS);
    const map = new Map<string, string>();
    for (const p of data.projects ?? []) {
      // Both fields or neither: a half-shaped entry is one we cannot spawn
      // into, and dropping it is the same posture RegistryService takes on a
      // mis-shaped project — a bad entry, not a bad response.
      if (typeof p.path === 'string' && typeof p.dirName === 'string') map.set(p.path, p.dirName);
    }
    this.cache = { at: now, url: cfg.url, map };
    return map;
  }

  /**
   * The one item at this path, or null. The allowlist runs first and is the
   * same one GET /api/items/body uses — a path outside every registered
   * backlog/ is not an item here either.
   */
  protected findItem(requestPath: string): BacklogItem | null {
    const registry = this.registry.load();
    const real = resolveAllowed(requestPath, buildAllowlist(registry));
    if (real === null || !real.endsWith('.md')) return null;
    for (const project of registry.projects) {
      for (const candidate of scanProject(project).items) {
        // Both sides through realpath: resolveAllowed already resolved
        // symlinks, scanProject did not, and on macOS the temp roots the test
        // fixtures live under are themselves symlinks (/var → /private/var).
        // A plain string compare would find nothing there.
        if (samePath(candidate.path, real)) return candidate;
      }
    }
    return null;
  }

  protected async get<T>(cfg: AgentsConfig, path: string, timeoutMs: number): Promise<T> {
    const res = await fetch(`${cfg.url}${path}`, {
      headers: authHeaders(cfg),
      // Without this an unreachable-but-routable host hangs the board's status
      // call for the OS connect timeout — minutes, on a tailnet address whose
      // peer is asleep.
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  }
}

export function authHeaders(cfg: AgentsConfig): Record<string, string> {
  return cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
}

/** Never throws — used only to build messages and to compare paths. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * A ceiling we do not recognise is a dashboard newer than this client. Read as
 * null, which `modesUpTo` turns into "plan only" — the safe reading, since we
 * cannot know where an unknown string sits on the ladder.
 */
function asMode(value: unknown): PermissionMode | null {
  return typeof value === 'string' && (PERMISSION_LADDER as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Re-exported so the controller can throw with the same body shape. */
export { HttpException };
```

`server/src/agents/agents.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';

import { AgentsService } from './agents.service';
import type { AgentsStatus } from '../../../shared/types';

/**
 * Under /api like every other controller — test/vite-proxy.test.ts asserts it
 * from Nest's own route metadata, because a route outside /api would not 404
 * in dev, it would be answered by Vite's SPA fallback with index.html.
 */
@Controller('api/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /**
   * Read-only and always 200, even when the dashboard is down: "is this wired
   * up" is exactly the question a failing request cannot answer. The reason
   * rides in `error`.
   */
  @Get('status')
  status(): Promise<AgentsStatus> {
    return this.agents.status();
  }
}
```

`server/src/agents/agents.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { RegistryModule } from '../registry/registry.module';

/**
 * The registry is the only injected dependency: item lookup goes through the
 * same allowlist and scanner the items module uses, but as plain function
 * calls (they are pure utilities, not providers), so there is nothing to
 * import from ItemsModule.
 */
@Module({
  imports: [RegistryModule],
  controllers: [AgentsController],
  providers: [AgentsService]
})
export class AgentsModule {}
```

- [ ] **Step 4: Register the module**

In `server/src/app.module.ts`, add the import and the entry:

```ts
import { AgentsModule } from './agents/agents.module';
```

```ts
  imports: [ConfigModule.forRoot({ isGlobal: true }), ItemsModule, AgentsModule, ...clientDistModules()],
```

- [ ] **Step 5: Update the controller-count assertion**

In `test/vite-proxy.test.ts`:

```ts
import { AgentsController } from '../server/src/agents/agents.controller';
```

```ts
const CONTROLLERS = [HealthController, ItemsController, AgentsController];
```

```ts
    expect(CONTROLLERS).toHaveLength(3);
```

- [ ] **Step 6: Run both suites**

Run: `pnpm test -- test/agents-status.test.ts test/vite-proxy.test.ts`
Expected: PASS — 7 status tests, 3 proxy tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/agents server/src/app.module.ts test/agents-status.test.ts test/vite-proxy.test.ts
git commit -m "feat: GET /api/agents/status — dashboard probe and project map"
```

---

### Task 4: `POST /api/agents/plan`

What the launch sheet opens with. No side effect; reads disk and the cached map.

**Files:**
- Modify: `server/src/agents/agents.service.ts`
- Modify: `server/src/agents/agents.controller.ts`
- Test: `test/agents-plan.test.ts`

**Interfaces:**
- Consumes: `findItem`, `status`, `projectMap` (Task 3); `deriveAction`, `modesUpTo`, `clampMode`, `dispatchBlock` (Task 1); `composePrompt` (Task 2).
- Produces: `AgentsService.plan(itemPath: string): Promise<AgentPlan>` — throws `HttpException` with a `{error}` body on 400/404. `@Post('plan')` on the controller.

- [ ] **Step 1: Write the failing test**

Create `test/agents-plan.test.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nit breaks\n\n## Cause\n\na typo\n\n## Fix\n\nfix the typo\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nit breaks\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');
const IDEA = item('idea-1', 'an idea', '## Sketch\n\nsomething\n');
const OOS = item('oos-1', 'declined', '## Why not\n\nno\n');

let projectPath: string;

function stubDashboard(over: Record<string, unknown> = {}) {
  global.fetch = jest.fn((input: RequestInfo | URL) =>
    Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        String(input).endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits', ...over }
      )
    } as Response)
  ) as jest.Mock;
}

describe('POST /api/agents/plan', () => {
  let app: INestApplication;
  const env = { ...process.env };

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG },
      { leaf: 'ideas/open', filename: 'idea-1-an-idea.md', content: IDEA },
      { leaf: 'out-of-scope', filename: 'oos-1-declined.md', content: OOS }
    ]);
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
  });

  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/plan').send(body as object);

  const itemPath = (leaf: string, name: string) => join(projectPath, 'backlog', leaf, name);

  it('plans a groom for an ungroomed bug, offering only modes up to the ceiling', async () => {
    stubDashboard();
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-1-a-fresh-bug.md') }).expect(201);
    expect(res.body.action).toBe('groom');
    expect(res.body.project).toBe('alpha');
    expect(res.body.prompt).toContain('backlog-manager:backlog-groom');
    expect(res.body.allowedModes).toEqual(['plan', 'acceptEdits']);
    expect(res.body.defaultMode).toBe('acceptEdits');
    expect(res.body.blocked).toBeUndefined();
  });

  it('plans an execute for a groomed bug', async () => {
    stubDashboard();
    const res = await post({ itemPath: itemPath('bugs/open', 'bug-2-a-known-bug.md') }).expect(201);
    expect(res.body.action).toBe('execute');
    expect(res.body.prompt).toContain('backlog-manager:backlog-execute');
  });

  it('404s an item with no next step', async () => {
    stubDashboard();
    await post({ itemPath: itemPath('out-of-scope', 'oos-1-declined.md') })
      .expect(404, { error: 'nothing to dispatch for this item' });
  });

  it('404s a path outside every registered backlog', async () => {
    stubDashboard();
    await post({ itemPath: '/etc/passwd' }).expect(404, { error: 'not found' });
  });

  it('400s a missing itemPath', async () => {
    stubDashboard();
    await post({}).expect(400, { error: 'itemPath is required' });
  });

  it('still plans, with a reason, when the dashboard cannot see the project', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          String(input).endsWith('/api/management')
            ? { projects: [{ dirName: '-x', name: 'x', path: '/somewhere/else', lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
      } as Response)
    ) as jest.Mock;
    const res = await post({ itemPath: itemPath('ideas/open', 'idea-1-an-idea.md') }).expect(201);
    expect(res.body.action).toBe('groom');
    expect(res.body.blocked).toContain(projectPath);
  });

  it('plans with plan-only modes when the dashboard is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as jest.Mock;
    const res = await post({ itemPath: itemPath('ideas/open', 'idea-1-an-idea.md') }).expect(201);
    expect(res.body.allowedModes).toEqual(['plan']);
    expect(res.body.blocked).toContain('unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-plan.test.ts`
Expected: FAIL — 404 on `/api/agents/plan`

- [ ] **Step 3: Add `plan` to the service**

Add these imports at the top of `server/src/agents/agents.service.ts`:

```ts
import { deriveAction, dispatchBlock, modesUpTo } from '../../../shared/agent';
import { composePrompt } from './prompt.util';
import type { AgentPlan } from '../../../shared/types';
```

and this method to the class, after `status()`:

```ts
  /**
   * Everything the launch sheet needs. `blocked` is filled rather than thrown
   * because the item IS dispatchable — the environment is what is not, and a
   * sheet that can explain that is more use than a failed request. The two
   * genuine 4xx cases (no such item, no next step) are the ones where there is
   * nothing to show a sheet about.
   */
  async plan(itemPath: string): Promise<AgentPlan> {
    const item = this.findItem(itemPath);
    if (item === null) throw new HttpException({ error: 'not found' }, 404);
    const action = deriveAction(item);
    if (action === null) {
      throw new HttpException({ error: 'nothing to dispatch for this item' }, 404);
    }

    const status = await this.status();
    return {
      action,
      prompt: composePrompt(item, action),
      project: item.project,
      allowedModes: modesUpTo(status.spawnMaxPermission),
      // acceptEdits, not the ceiling: the work is editing files in one repo,
      // and asking for the most a host allows by default is how a convenience
      // becomes an incident. The select is right there if more is wanted.
      defaultMode: clampMode('acceptEdits', status.spawnMaxPermission),
      blocked: dispatchBlock(item, status) ?? undefined
    };
  }
```

Also widen the `shared/agent` import to include `clampMode`:

```ts
import { clampMode, deriveAction, dispatchBlock, modesUpTo, PERMISSION_LADDER } from '../../../shared/agent';
```

(and drop the now-duplicated `PERMISSION_LADDER` import line from Step 3 of Task 3).

- [ ] **Step 4: Add the route**

In `server/src/agents/agents.controller.ts`, extend the imports and add the handler:

```ts
import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
```

```ts
import type { AgentPlan, AgentsStatus } from '../../../shared/types';
```

```ts
  /**
   * POST, not GET, because the item's absolute path is the argument: a path in
   * a query string ends up in access logs and in the browser's history, and
   * this one names a file on a developer's disk.
   */
  @Post('plan')
  plan(@Body() body: { itemPath?: unknown } | undefined): Promise<AgentPlan> {
    const itemPath = typeof body?.itemPath === 'string' ? body.itemPath.trim() : '';
    if (itemPath === '') throw new HttpException({ error: 'itemPath is required' }, 400);
    return this.agents.plan(itemPath);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/agents-plan.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/agents test/agents-plan.test.ts
git commit -m "feat: POST /api/agents/plan — derive the action and compose the launch"
```

---

### Task 5: `POST /api/agents/dispatch`

The launch. The only place this app initiates anything.

**Files:**
- Modify: `server/src/agents/agents.service.ts`
- Modify: `server/src/agents/agents.controller.ts`
- Test: `test/agents-dispatch.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4, plus `sessionName` (Task 2).
- Produces: `AgentsService.dispatch(req: AgentDispatchRequest): Promise<AgentDispatchResult>`; `@Post('dispatch')`.

- [ ] **Step 1: Write the failing test**

Create `test/agents-dispatch.test.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { item, makeProject, makeRegistry } from './helpers/store';

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const RAW_BUG = item('bug-1', 'a fresh bug', '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n');

let projectPath: string;

interface Sent { url: string; init?: RequestInit }

/** Records every outbound call and answers the three the service makes. */
function stubDashboard(spawn: { ok: boolean; status?: number; body?: unknown } = { ok: true }) {
  const sent: Sent[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.endsWith('/api/spawn')) {
      return Promise.resolve({
        ok: spawn.ok, status: spawn.status ?? (spawn.ok ? 200 : 429),
        json: () => Promise.resolve(spawn.body ?? { sessionId: 'sess-1' })
      } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        url.endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('POST /api/agents/dispatch', () => {
  let app: INestApplication;
  const env = { ...process.env };

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-1-a-fresh-bug.md', content: RAW_BUG },
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }
    ]);
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    process.env.BM_AGENTS_TOKEN = 's3cret';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
  });

  const bugPath = (name: string) => join(projectPath, 'backlog', 'bugs/open', name);
  const post = (body: unknown) =>
    request(app.getHttpServer()).post('/api/agents/dispatch').send(body as object);

  const good = {
    itemPath: '',
    action: 'execute' as const,
    prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
    permissionMode: 'acceptEdits' as const,
    remoteControl: true
  };

  it('spawns with the dashboard dirName, the bearer token, and a labelled name', async () => {
    const sent = stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(201);
    expect(res.body).toEqual({ sessionId: 'sess-1' });

    const spawn = sent.find((s) => s.url.endsWith('/api/spawn'));
    expect(spawn).toBeDefined();
    expect((spawn?.init?.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    const body = JSON.parse(String(spawn?.init?.body));
    expect(body.project).toBe('-abs-alpha');
    expect(body.name).toBe('bl:alpha/bug-2');
    expect(body.permissionMode).toBe('acceptEdits');
    expect(body.remoteControl).toBe(true);
    expect(body.prompt).toContain('backlog-execute');
    // A path must never be sent — dirName membership is the dashboard's own
    // contract and this is the assertion that keeps us inside it.
    expect(JSON.stringify(body)).not.toContain(projectPath);
  });

  it('refuses to execute an ungroomed bug and names the step it does have', async () => {
    stubDashboard();
    const res = await post({ ...good, itemPath: bugPath('bug-1-a-fresh-bug.md') }).expect(409);
    expect(res.body.error).toContain('groom');
  });

  it('clamps a mode above the ceiling instead of forwarding it', async () => {
    const sent = stubDashboard();
    await post({
      ...good, itemPath: bugPath('bug-2-a-known-bug.md'), permissionMode: 'bypassPermissions'
    }).expect(201);
    const body = JSON.parse(String(sent.find((s) => s.url.endsWith('/api/spawn'))?.init?.body));
    expect(body.permissionMode).toBe('acceptEdits');
  });

  it('404s an unregistered path without spawning', async () => {
    const sent = stubDashboard();
    await post({ ...good, itemPath: '/etc/passwd' }).expect(404, { error: 'not found' });
    expect(sent.some((s) => s.url.endsWith('/api/spawn'))).toBe(false);
  });

  it('400s an empty prompt', async () => {
    stubDashboard();
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md'), prompt: '   ' })
      .expect(400, { error: 'prompt is required' });
  });

  it('passes the dashboard error through verbatim', async () => {
    stubDashboard({ ok: false, status: 429, body: { error: 'too many launches in flight' } });
    await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') })
      .expect(429, { error: 'too many launches in flight' });
  });

  it('refuses when the dashboard has remote answers off, without spawning', async () => {
    const sent: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(
          url.endsWith('/api/management')
            ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
            : { ok: true, remoteAnswer: false, spawnAvailable: true, spawnMaxPermission: 'auto' }
        )
      } as Response);
    }) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(409);
    expect(res.body.error).toMatch(/remote answers/);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(false);
  });

  it('502s when the dashboard is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as jest.Mock;
    const res = await post({ ...good, itemPath: bugPath('bug-2-a-known-bug.md') }).expect(502);
    expect(res.body.error).toContain('unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-dispatch.test.ts`
Expected: FAIL — 404 on `/api/agents/dispatch`

- [ ] **Step 3: Add `dispatch` to the service**

Extend the imports in `server/src/agents/agents.service.ts`:

```ts
import { composePrompt, sessionName } from './prompt.util';
import type { AgentDispatchRequest, AgentDispatchResult } from '../../../shared/types';
```

Add after `plan()`:

```ts
  /** A prompt longer than this is not a prompt any more. The dashboard's own
   *  body cap is 64KB; this one exists so a runaway paste fails here, with a
   *  message, rather than there, as a truncated instruction. */
  private static readonly PROMPT_MAX = 8_000;

  /**
   * Start the session. Every check that matters re-runs here, because `plan`
   * ran against a different request and the sheet has been open for however
   * long the reader took: the item may have been groomed, archived, or
   * rewritten in between, and the answer must come from the file as it is now.
   */
  async dispatch(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
    if (prompt === '') throw new HttpException({ error: 'prompt is required' }, 400);
    if (prompt.length > AgentsService.PROMPT_MAX) {
      throw new HttpException({ error: 'prompt is too long' }, 400);
    }

    const item = this.findItem(req.itemPath);
    if (item === null) throw new HttpException({ error: 'not found' }, 404);
    const action = deriveAction(item);
    if (action === null) {
      throw new HttpException({ error: 'nothing to dispatch for this item' }, 409);
    }
    // The whole reason this call is proxied rather than relayed: the client
    // said what it wanted, the file says what is legal, and the file wins.
    // Asking to execute a bug whose Fix still reads "unknown" is refused here,
    // which is the groomed invariant enforced on the only side that can read
    // the file.
    if (req.action !== action) {
      throw new HttpException({ error: `this item's next step is ${action}, not ${req.action}` }, 409);
    }

    const status = await this.status();
    const blocked = dispatchBlock(item, status);
    if (blocked !== null) {
      // 502 when the dashboard never answered, 409 when it answered and said
      // no: the first is an infrastructure problem, the second is a state the
      // reader can go and change.
      throw new HttpException({ error: blocked }, status.reachable ? 409 : 502);
    }

    const cfg = readAgentsConfig();
    const dirName = (await this.projectMap(cfg)).get(item.projectPath);
    if (dirName === undefined) {
      // dispatchBlock already covers this from the same map, so reaching here
      // means the cache expired between the two reads. Refuse rather than
      // guess a dirName from the path — deriving one would route around the
      // dashboard's membership check, which is the one thing it asks of us.
      throw new HttpException({ error: 'the dashboard cannot see this project' }, 409);
    }

    const res = await fetch(`${cfg.url}/api/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({
        project: dirName,
        prompt,
        name: sessionName(item),
        permissionMode: clampMode(req.permissionMode, status.spawnMaxPermission),
        // Strictly `=== true`, matching the dashboard's own parse rule for this
        // field: anything else means off.
        remoteControl: req.remoteControl === true
      }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });

    const body = (await res.json().catch(() => null)) as { sessionId?: unknown; error?: unknown } | null;
    if (!res.ok) {
      // Verbatim. The dashboard's rejections are short and specific ("too many
      // launches in flight", "unknown project: …"); paraphrasing them would
      // only lose the one detail the reader needs.
      const error = typeof body?.error === 'string' ? body.error : `spawn answered ${res.status}`;
      throw new HttpException({ error }, res.status);
    }
    if (typeof body?.sessionId !== 'string') {
      throw new HttpException({ error: 'spawn returned no session id' }, 502);
    }
    return { sessionId: body.sessionId };
  }
```

- [ ] **Step 4: Add the route**

In `server/src/agents/agents.controller.ts`:

```ts
import type { AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus } from '../../../shared/types';
```

```ts
  /**
   * The one endpoint in this app that starts something. Validation lives in the
   * service, not here, because it needs the item file — the controller only
   * proves the body has the right shape.
   */
  @Post('dispatch')
  dispatch(@Body() body: Partial<AgentDispatchRequest> | undefined): Promise<AgentDispatchResult> {
    const itemPath = typeof body?.itemPath === 'string' ? body.itemPath.trim() : '';
    if (itemPath === '') throw new HttpException({ error: 'itemPath is required' }, 400);
    if (body?.action !== 'groom' && body?.action !== 'execute') {
      throw new HttpException({ error: 'action must be groom or execute' }, 400);
    }
    return this.agents.dispatch({
      itemPath,
      action: body.action,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      // Unvalidated on purpose: clampMode is the place a junk mode becomes
      // 'plan', and it is applied server-side after the ceiling is known.
      permissionMode: body.permissionMode as AgentDispatchRequest['permissionMode'],
      remoteControl: body.remoteControl === true
    });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/agents-dispatch.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole server side and typecheck**

Run: `pnpm test && pnpm run typecheck`
Expected: all suites pass; typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add server/src/agents test/agents-dispatch.test.ts
git commit -m "feat: POST /api/agents/dispatch — spawn a session for a backlog item"
```

---

### Task 6: Client data layer

The three fetches and the status hook. No UI yet, so the test is a plain unit suite over the module.

**Files:**
- Create: `client/src/lib/agents.ts`
- Create: `client/src/hooks/useAgents.ts`
- Test: `test/agents-client.test.ts`

**Interfaces:**
- Consumes: `AgentsStatus`, `AgentPlan`, `AgentDispatchRequest`, `AgentDispatchResult` (Task 1).
- Produces:
  - `fetchAgentsStatus(): Promise<AgentsStatus>`
  - `fetchAgentPlan(itemPath: string): Promise<AgentPlan>`
  - `dispatchAgent(req: AgentDispatchRequest): Promise<AgentDispatchResult>`
  - `sessionUrl(linkBase: string, sessionId: string): string`
  - `useAgents(): { status: AgentsStatus | null; reload: () => void }`

- [ ] **Step 1: Write the failing test**

Create `test/agents-client.test.ts`:

```ts
import { dispatchAgent, fetchAgentPlan, fetchAgentsStatus, sessionUrl } from '../client/src/lib/agents';
import type { AgentDispatchRequest } from '../shared/types';

const REQ: AgentDispatchRequest = {
  itemPath: '/abs/alpha/backlog/tasks/open/task-1.md',
  action: 'execute',
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  remoteControl: true
};

function stub(res: { ok: boolean; status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve({
      ok: res.ok, status: res.status ?? 200, json: () => Promise.resolve(res.body)
    } as Response);
  }) as jest.Mock;
  return calls;
}

describe('the agents client', () => {
  it('reads status from the same-origin API', async () => {
    const calls = stub({ ok: true, body: { enabled: true } });
    await fetchAgentsStatus();
    expect(calls[0].url).toBe('/api/agents/status');
    expect(calls[0].init).toBeUndefined();
  });

  it('posts the item path as a body, never a query string', async () => {
    const calls = stub({ ok: true, body: { action: 'groom' } });
    await fetchAgentPlan('/abs/alpha/backlog/ideas/open/idea-1.md');
    expect(calls[0].url).toBe('/api/agents/plan');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      itemPath: '/abs/alpha/backlog/ideas/open/idea-1.md'
    });
  });

  it('returns the session id on a successful dispatch', async () => {
    stub({ ok: true, body: { sessionId: 'sess-9' } });
    await expect(dispatchAgent(REQ)).resolves.toEqual({ sessionId: 'sess-9' });
  });

  it('throws the server error string, not the status code', async () => {
    stub({ ok: false, status: 409, body: { error: 'this item\'s next step is groom, not execute' } });
    await expect(dispatchAgent(REQ)).rejects.toThrow('next step is groom');
  });

  it('falls back to the status when the error body is unusable', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) } as Response)
    ) as jest.Mock;
    await expect(dispatchAgent(REQ)).rejects.toThrow('500');
  });
});

describe('sessionUrl', () => {
  it('builds the dashboard deep link', () => {
    expect(sessionUrl('http://127.0.0.1:5174', 'sess-1'))
      .toBe('http://127.0.0.1:5174/?session=sess-1');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(sessionUrl('http://dash/', 'sess-1')).toBe('http://dash/?session=sess-1');
  });

  it('encodes the id rather than interpolating it raw', () => {
    expect(sessionUrl('http://dash', 'a b&c')).toBe('http://dash/?session=a%20b%26c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/agents-client.test.ts`
Expected: FAIL — cannot find module `client/src/lib/agents`

- [ ] **Step 3: Write `client/src/lib/agents.ts`**

```ts
import type {
  AgentDispatchRequest, AgentDispatchResult, AgentPlan, AgentsStatus
} from '../../../shared/types';

/**
 * agents.ts — the board's three calls into its own API.
 *
 * Same-origin, every one of them: the dashboard's origin is server-side
 * configuration this page never learns, which is both why the bearer token
 * stays out of the browser and why `connect-src 'self'` in
 * server/src/security.ts needs no relaxing for this feature.
 */

/**
 * Unwraps the `{ error }` body the API answers failures with, so a caller can
 * render the server's own wording. The status is the fallback, not the message:
 * "409" tells a reader nothing, "this item's next step is groom" tells them
 * everything.
 */
async function unwrap<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as ({ error?: unknown } & T) | null;
  if (!res.ok) {
    const error = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
    throw new Error(error);
  }
  return data as T;
}

export async function fetchAgentsStatus(): Promise<AgentsStatus> {
  return unwrap<AgentsStatus>(await fetch('/api/agents/status'));
}

/** POST, not GET: the argument is an absolute path on someone's disk, and a
 *  query string puts it in history and in logs. */
export async function fetchAgentPlan(itemPath: string): Promise<AgentPlan> {
  return unwrap<AgentPlan>(await fetch('/api/agents/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemPath })
  }));
}

export async function dispatchAgent(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
  return unwrap<AgentDispatchResult>(await fetch('/api/agents/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req)
  }));
}

/**
 * The dashboard's own deep link (`?session=<id>`, read by its
 * client/src/lib/deepLink.ts). Built here rather than server-side because the
 * base is per-device: the laptop reaches the dashboard on loopback, the phone
 * on a tailnet name.
 */
export function sessionUrl(linkBase: string, sessionId: string): string {
  return `${linkBase.replace(/\/+$/, '')}/?session=${encodeURIComponent(sessionId)}`;
}
```

- [ ] **Step 4: Write `client/src/hooks/useAgents.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';

import { fetchAgentsStatus } from '../lib/agents';
import type { AgentsStatus } from '../../../shared/types';

/**
 * The dispatch status, on mount and on window focus — the same cadence
 * `useBoard` uses, and for the same reason: what changes it (a dashboard
 * started, a session opened in another repo) happens outside this tab, and you
 * come back to the tab afterwards. A timer would ask the same question worse,
 * and the server's project-map cache means a focus refetch is nearly free.
 *
 * `null` means "not answered yet". Callers render no button in that state
 * rather than a disabled one, so a board load does not flash a dead control.
 */
export function useAgents(): { status: AgentsStatus | null; reload: () => void } {
  const [status, setStatus] = useState<AgentsStatus | null>(null);

  const reload = useCallback(() => {
    fetchAgentsStatus()
      .then(setStatus)
      // A failing status endpoint is our own API being down, which the board's
      // own error state already covers. Report it as "off" rather than leaving
      // it null forever: null means "still asking".
      .catch(() => setStatus({
        enabled: false, reachable: false, remoteAnswer: false,
        spawnAvailable: false, spawnMaxPermission: null, projectPaths: []
      }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = (): void => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return { status, reload };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/agents-client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/agents.ts client/src/hooks/useAgents.ts test/agents-client.test.ts
git commit -m "feat: client fetchers and status hook for agent dispatch"
```

---

### Task 7: The launch sheet

**Files:**
- Create: `client/src/components/board/LaunchSheet.tsx`
- Modify: `client/src/styles.css`
- Test: `test/launch-sheet.test.tsx`

**Interfaces:**
- Consumes: `fetchAgentPlan`, `dispatchAgent`, `sessionUrl` (Task 6); `AgentPlan` (Task 1); `useSettings` for `linkBase` (Task 9 adds the key — until then read `settings.linkBase` which does not exist yet, so **this task adds `linkBase` to `client/src/lib/settings.ts` as its Step 3**).
- Produces: `LaunchSheet({ item, onClose }: { item: BacklogItem; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

Create `test/launch-sheet.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { LaunchSheet } from '../client/src/components/board/LaunchSheet';
import type { AgentPlan, BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'task-12', title: 'Add CSP', created: '2026-08-20', started: '', tags: [],
  section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, path: '/abs/alpha/backlog/tasks/open/task-12.md'
};

const PLAN: AgentPlan = {
  action: 'execute',
  prompt: 'Use the backlog-manager:backlog-execute skill on task-12.',
  project: 'alpha',
  allowedModes: ['plan', 'acceptEdits'],
  defaultMode: 'acceptEdits'
};

function stub(handlers: { plan?: unknown; dispatch?: { ok: boolean; body: unknown } }) {
  const calls: { url: string; body: unknown }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/plan')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handlers.plan ?? PLAN) } as Response);
    }
    const d = handlers.dispatch ?? { ok: true, body: { sessionId: 'sess-1' } };
    return Promise.resolve({ ok: d.ok, status: d.ok ? 200 : 409, json: () => Promise.resolve(d.body) } as Response);
  }) as jest.Mock;
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});

async function openSheet() {
  render(<LaunchSheet item={ITEM} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled());
}

describe('LaunchSheet', () => {
  it('shows the composed prompt, the project, and only the allowed modes', async () => {
    stub({});
    await openSheet();
    expect(screen.getByLabelText('Prompt')).toHaveValue(PLAN.prompt);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    const modes = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect([...modes.options].map((o) => o.value)).toEqual(['plan', 'acceptEdits']);
    expect(modes.value).toBe('acceptEdits');
  });

  it('dispatches the edited prompt with the derived action', async () => {
    const calls = stub({});
    await openSheet();
    const prompt = screen.getByLabelText('Prompt');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'do it my way');
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(sent).toEqual({
      itemPath: ITEM.path, action: 'execute', prompt: 'do it my way',
      permissionMode: 'acceptEdits', remoteControl: true
    });
  });

  it('replaces the form with a link to the session once it launches', async () => {
    stub({});
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ linkBase: 'http://dash:5174' }));
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    const link = await screen.findByRole('link', { name: /open in dashboard/ });
    expect(link).toHaveAttribute('href', 'http://dash:5174/?session=sess-1');
    expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
  });

  it('renders the server error verbatim and leaves the form usable', async () => {
    stub({ dispatch: { ok: false, body: { error: 'too many launches in flight' } } });
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    expect(await screen.findByText('too many launches in flight')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled();
  });

  it('offers no launch at all when the plan comes back blocked', async () => {
    stub({ plan: { ...PLAN, blocked: 'remote answers are off in the dashboard' } });
    render(<LaunchSheet item={ITEM} onClose={() => {}} />);
    expect(await screen.findByText('remote answers are off in the dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    stub({});
    const onClose = jest.fn();
    render(<LaunchSheet item={ITEM} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/launch-sheet.test.tsx`
Expected: FAIL — cannot find module `LaunchSheet`

- [ ] **Step 3: Add `linkBase` to the settings model**

In `client/src/lib/settings.ts`, add to the `Settings` interface:

```ts
  /**
   * Where *this device* reaches ../claude-agents-dashboard, used only to build
   * the link to a launched session. Per-device because it genuinely differs:
   * the laptop reaches it on loopback, the phone on a tailnet name. The API's
   * own outbound call uses BM_AGENTS_URL server-side and never this.
   */
  linkBase: string;
```

to `DEFAULT_SETTINGS`:

```ts
  linkBase: 'http://127.0.0.1:5174'
```

and a clamp — add this helper next to `clampInt`:

```ts
/**
 * An http(s) origin, or the fallback. Narrow on purpose: this string becomes an
 * href, so a hand-edited `javascript:` in localStorage must not survive to
 * reach the DOM. URL parsing, not a regex — the browser's own parser is the
 * one that decides what an href means.
 */
function clampOrigin(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname.replace(/\/+$/, '')}`
      : fallback;
  } catch {
    return fallback;
  }
}
```

and the field in `clampSettings`:

```ts
    linkBase: clampOrigin(s.linkBase, DEFAULT_SETTINGS.linkBase),
```

- [ ] **Step 4: Write `client/src/components/board/LaunchSheet.tsx`**

```tsx
import { useEffect, useState } from 'react';

import { dispatchAgent, fetchAgentPlan, sessionUrl } from '../../lib/agents';
import { useSettings } from '../../hooks/useSettings';
import type { AgentPlan, BacklogItem, PermissionMode } from '../../../../shared/types';

/**
 * LaunchSheet — the one extra tap between a card and a running Claude.
 *
 * It exists because dispatch is not a read: an `execute` launch edits code in
 * another repo with no human at a terminal. The sheet is where the prompt can
 * be read before it is sent, where the permission mode is chosen inside the
 * ceiling the host allows, and where "the dashboard cannot see this project"
 * surfaces before anything spawns rather than as a failed launch.
 *
 * The plan is re-fetched on open rather than passed down from the board's
 * status: the board's read may be minutes old, and the item may have been
 * groomed or archived in a terminal since.
 */
export function LaunchSheet({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const { settings } = useSettings();
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('plan');
  const [remoteControl, setRemoteControl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAgentPlan(item.path)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setPrompt(p.prompt);
        setMode(p.defaultMode);
      })
      .catch((e: unknown) => {
        if (alive) setPlanError(e instanceof Error ? e.message : String(e));
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

  const launch = (): void => {
    if (plan === null) return;
    setBusy(true);
    setError(null);
    dispatchAgent({
      itemPath: item.path,
      // The server's derivation, echoed back — and re-derived there before
      // anything spawns. Sending it makes a stale sheet fail loudly ("this
      // item's next step is groom") instead of quietly doing the wrong work.
      action: plan.action,
      prompt,
      permissionMode: mode,
      remoteControl
    })
      .then((r) => setSessionId(r.sessionId))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const blocked = plan?.blocked ?? planError;

  return (
    <>
      <div className="sheet-backdrop" data-testid="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={`dispatch ${item.id}`}>
        <div className="sheet-head">
          <span className="sheet-kicker">{plan === null ? 'dispatch' : plan.action}</span>
          <span className="sheet-title">{item.id} · {item.title}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>

        {sessionId !== null ? (
          /* The form is gone on purpose: the session exists, and a second
             Launch would start a second one on the same item. */
          <div className="sheet-body">
            <div className="sheet-ok">launched · {sessionId}</div>
            <a className="sheet-link" href={sessionUrl(settings.linkBase, sessionId)} target="_blank" rel="noreferrer">
              open in dashboard ↗
            </a>
            <div className="sheet-note">
              Its questions appear there — and on your phone, if the dashboard's hooks are installed.
            </div>
          </div>
        ) : blocked !== null && blocked !== undefined ? (
          <div className="sheet-body">
            <div className="sheet-blocked">{blocked}</div>
          </div>
        ) : plan === null ? (
          <div className="sheet-body"><div className="drawer-empty">loading…</div></div>
        ) : (
          <div className="sheet-body">
            <label className="sheet-field">
              <span className="set-name">Project</span>
              <span className="sheet-static">{plan.project}</span>
            </label>

            <label className="sheet-field">
              <span className="set-name">Prompt</span>
              <textarea
                aria-label="Prompt"
                className="sheet-prompt"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            <label className="sheet-field">
              <span className="set-name">Permission mode</span>
              <select
                aria-label="Permission mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as PermissionMode)}
              >
                {/* Only what the host's ceiling can actually deliver: offering
                    a mode the dashboard would clamp is a promise this app
                    cannot keep. */}
                {plan.allowedModes.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>

            <label className="sheet-check">
              <input
                type="checkbox"
                checked={remoteControl}
                onChange={(e) => setRemoteControl(e.target.checked)}
              />
              <span>remote control — the Claude phone app can see and drive it</span>
            </label>

            {error !== null && <div className="sheet-error">{error}</div>}

            <div className="sheet-actions">
              <button className="drawer-close" onClick={onClose}>cancel</button>
              <button className="sheet-launch" onClick={launch} disabled={busy || prompt.trim() === ''}>
                {busy ? 'launching…' : 'launch'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Add the styles**

Append to `client/src/styles.css`:

```css
/* ---- dispatch: the card button and the launch sheet -------------------
   z-index above the item drawer (60/61): the sheet is opened FROM the
   drawer as well as from a card, so it has to sit over it. */
.sheet-backdrop { position: fixed; inset: 0; z-index: 70; background: var(--scrim) }
.sheet {
  position: fixed; z-index: 71;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  /* Same /--font-scale division the drawer needs — without it the sheet
     overflows the viewport at any text size but 100%. */
  width: min(520px, calc(100vw / var(--font-scale, 1) - 24px));
  max-height: calc(100dvh / var(--font-scale, 1) - 24px);
  display: flex; flex-direction: column;
  background: var(--strip); border: 1px solid var(--hairline); border-radius: 3px;
  box-shadow: 0 18px 48px var(--shadow2);
}
.sheet-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 12px 14px; border-bottom: 1px solid var(--hairline);
  background: var(--strip-hi); box-shadow: inset 0 1px 0 var(--edge);
}
.sheet-kicker {
  font-family: var(--mono); font-size: 10px; text-transform: uppercase;
  letter-spacing: .08em; color: var(--cyan); flex: none;
}
.sheet-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.sheet-body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px }
.sheet-field { display: flex; flex-direction: column; gap: 4px }
.sheet-static { font-family: var(--mono); font-size: 11px; color: var(--ink2) }
.sheet-prompt {
  font-family: var(--mono); font-size: 11px; line-height: 1.5; color: var(--ink);
  background: var(--steel); border: 1px solid var(--hairline); border-radius: 2px;
  padding: 8px; resize: vertical;
}
.sheet-prompt:focus { outline: none; border-color: var(--cyan) }
.sheet-field select {
  font-family: var(--font); font-size: 11.5px; color: var(--ink);
  background: var(--steel); border: 1px solid var(--hairline); border-radius: 2px; padding: 5px 8px;
  align-self: flex-start;
}
.sheet-check { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--ink2) }
.sheet-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px }
.sheet-launch {
  font-family: var(--font); font-size: 11.5px; font-weight: 600; color: var(--bg);
  background: var(--cyan); border: 1px solid var(--cyan); border-radius: 2px;
  padding: 5px 12px; cursor: pointer;
}
.sheet-launch:disabled { opacity: .45; cursor: default }
.sheet-error, .sheet-blocked { font-family: var(--mono); font-size: 10.5px; line-height: 1.5; color: var(--amber) }
.sheet-ok { font-family: var(--mono); font-size: 10.5px; color: var(--green, var(--cyan)) }
.sheet-link { font-size: 12px; color: var(--cyan) }
.sheet-note { font-size: 10.5px; color: var(--ink3); line-height: 1.45 }

/* The card's own button. Unshrinkable, like the in-progress mark beside it —
   the meta line's ellipsis gives up the room. */
.board-card-dispatch {
  flex: none; font-family: var(--mono); font-size: 10px;
  color: var(--ink2); background: var(--steel);
  border: 1px solid var(--hairline); border-radius: 2px; padding: 2px 6px; cursor: pointer;
}
.board-card-dispatch:hover:not(:disabled) { color: var(--ink); border-color: var(--cyan) }
.board-card-dispatch:disabled { opacity: .4; cursor: default }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- test/launch-sheet.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/board/LaunchSheet.tsx client/src/lib/settings.ts client/src/styles.css test/launch-sheet.test.tsx
git commit -m "feat: launch sheet for dispatching a backlog item"
```

---

### Task 8: The card button, wired into the board

**Files:**
- Create: `client/src/components/board/DispatchButton.tsx`
- Modify: `client/src/components/board/ItemCard.tsx`
- Modify: `client/src/components/board/ItemDrawer.tsx`
- Modify: `client/src/components/board/BoardView.tsx`
- Test: `test/dispatch-button.test.tsx`

**Interfaces:**
- Consumes: `deriveAction`, `actionLabel`, `dispatchBlock` (Task 1); `useAgents` (Task 6); `LaunchSheet` (Task 7).
- Produces: `DispatchButton({ item, status, onDispatch }: { item: BacklogItem; status: AgentsStatus | null; onDispatch: () => void })`. `ItemCard` and `ItemDrawer` both gain optional `status` and `onDispatch` props (optional so existing callers and tests keep working).

- [ ] **Step 1: Write the failing test**

Create `test/dispatch-button.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import BoardView from '../client/src/components/board/BoardView';
import { DispatchButton } from '../client/src/components/board/DispatchButton';
import type { AgentsStatus, BacklogItem, ItemsIndex, ProjectSummary } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'task-1', title: 'a task', created: '2026-08-20', started: '', tags: [],
    section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1.md'
  };
  return { ...base, ...over };
}

const READY: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

describe('DispatchButton', () => {
  it('labels the action the item actually has', () => {
    render(<DispatchButton item={fakeItem()} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeEnabled();
  });

  it('names the destination for an idea', () => {
    render(<DispatchButton item={fakeItem({ id: 'idea-1', section: 'ideas', groomed: null })} status={READY} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'groom → task' })).toBeInTheDocument();
  });

  it('renders nothing for an item with no next step', () => {
    const { container } = render(
      <DispatchButton item={fakeItem({ status: 'done' })} status={READY} onDispatch={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the status is still unknown', () => {
    const { container } = render(<DispatchButton item={fakeItem()} status={null} onDispatch={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disables with the reason when the dashboard cannot see the project', () => {
    render(
      <DispatchButton item={fakeItem()} status={{ ...READY, projectPaths: ['/abs/other'] }} onDispatch={() => {}} />
    );
    const btn = screen.getByRole('button', { name: 'execute' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringContaining('/abs/alpha'));
  });

  it('disables when dispatch is off', () => {
    render(<DispatchButton item={fakeItem()} status={{ ...READY, enabled: false }} onDispatch={() => {}} />);
    expect(screen.getByRole('button', { name: 'execute' })).toBeDisabled();
  });
});

const ITEMS: ItemsIndex = { items: [fakeItem(), fakeItem({ id: 'idea-1', section: 'ideas', groomed: null, path: '/abs/alpha/backlog/ideas/open/idea-1.md' })], errors: [] };
const PROJECTS: ProjectSummary[] = [
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z', missing: false,
    counts: { bugs: 0, ideas: 1, tasks: 1, 'out-of-scope': 0 } }
];

describe('the board wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes('/api/agents/status') ? READY
        : url.includes('/api/agents/plan') ? {
          action: 'execute', prompt: 'do it', project: 'alpha',
          allowedModes: ['plan', 'acceptEdits'], defaultMode: 'acceptEdits'
        }
        : url.includes('/api/projects') ? PROJECTS : ITEMS;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) } as Response);
    }) as jest.Mock;
  });

  it('opens the sheet from a card without opening the item drawer', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: /dispatch task-1/ })).toBeInTheDocument());
    // The card's own onClick must not have fired: two overlapping dialogs is
    // the bug this assertion exists for.
    expect(screen.queryByRole('dialog', { name: 'a task' })).not.toBeInTheDocument();
  });

  it('closes the sheet on cancel', async () => {
    render(<BoardView />);
    await waitFor(() => expect(screen.getByText('a task')).toBeInTheDocument());
    const card = screen.getByText('a task').closest('.board-card') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'execute' }));
    await userEvent.click(await screen.findByRole('button', { name: 'cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /dispatch task-1/ })).not.toBeInTheDocument()
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/dispatch-button.test.tsx`
Expected: FAIL — cannot find module `DispatchButton`

- [ ] **Step 3: Write `client/src/components/board/DispatchButton.tsx`**

```tsx
import { actionLabel, deriveAction, dispatchBlock } from '../../../../shared/agent';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * DispatchButton — the click that hands this item to a Claude session.
 *
 * Three states, and the absent one matters most: an item with no next step
 * (archived, or out of scope) gets no control at all rather than a disabled
 * one, because there is nothing here to enable. A status that has not arrived
 * yet is also nothing — otherwise every board load flashes a dead button.
 *
 * The derivation is `shared/agent.ts`, the same module the server validates
 * with, so the label can never promise an action the API would refuse.
 */
export function DispatchButton(
  { item, status, onDispatch }: {
    item: BacklogItem;
    status: AgentsStatus | null;
    onDispatch: () => void;
  }
) {
  const action = deriveAction(item);
  if (action === null || status === null) return null;

  const blocked = dispatchBlock(item, status);

  return (
    <button
      className="board-card-dispatch"
      // The reason, not a generic tooltip: "no Claude session in that repo
      // inside LOOKBACK_HOURS" is a fixable thing, and nowhere else says it.
      title={blocked ?? `dispatch ${action} to a Claude session`}
      disabled={blocked !== null}
      onClick={(e) => {
        // The whole card is a role="button" that opens the drawer. Without
        // this, one click opens both.
        e.stopPropagation();
        onDispatch();
      }}
    >
      {actionLabel(item, action)}
    </button>
  );
}
```

- [ ] **Step 4: Render it in `ItemCard`**

Add the import and two optional props, then the button as the last child of `.board-card-foot`:

```tsx
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';
```

```tsx
export function ItemCard(
  { item, hues, onOpen, agents, onDispatch }: {
    item: BacklogItem;
    hues: ProjectHues;
    onOpen: () => void;
    /** null until the status probe answers; absent when the board is rendered
     *  without dispatch at all (older tests, and any future read-only view). */
    agents?: AgentsStatus | null;
    onDispatch?: () => void;
  }
) {
```

and, immediately after the `inProgress ? … : null` block inside `.board-card-foot`:

```tsx
        {onDispatch && (
          <DispatchButton item={item} status={agents ?? null} onDispatch={onDispatch} />
        )}
```

- [ ] **Step 5: Render it in `ItemDrawer`**

Add the same two optional props to the component signature and the import, then put the button in `.drawer-head`, before `close`:

```tsx
        {onDispatch && (
          <DispatchButton item={item} status={agents ?? null} onDispatch={onDispatch} />
        )}
          <button className="drawer-close" onClick={onClose}>close</button>
```

- [ ] **Step 6: Own the state in `BoardView`**

```tsx
import { useAgents } from '../../hooks/useAgents';
import { LaunchSheet } from './LaunchSheet';
```

```ts
  const { status: agents } = useAgents();
  /* Separate from `open`: the sheet can be opened from a card (drawer closed)
     or from inside the drawer (drawer stays open behind it), so one piece of
     state cannot serve both. */
  const [dispatching, setDispatching] = useState<BacklogItem | null>(null);
```

pass them to the card:

```tsx
                  {colItems.map((item) => (
                    <ItemCard
                      key={item.path}
                      item={item}
                      hues={hues}
                      onOpen={() => setOpen(item)}
                      agents={agents}
                      onDispatch={() => setDispatching(item)}
                    />
                  ))}
```

to the drawer:

```tsx
      {open !== null && (
        <ItemDrawer
          item={open}
          hues={hues}
          onClose={() => setOpen(null)}
          agents={agents}
          onDispatch={() => setDispatching(open)}
        />
      )}
      {dispatching !== null && (
        <LaunchSheet item={dispatching} onClose={() => setDispatching(null)} />
      )}
```

- [ ] **Step 7: Run the board suites**

Run: `pnpm test -- test/dispatch-button.test.tsx test/board.test.tsx test/drawer.test.tsx`
Expected: PASS — 8 new tests, and the two existing suites unchanged (the new props are optional, so their fixtures still compile).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/board test/dispatch-button.test.tsx
git commit -m "feat: dispatch button on cards and in the item drawer"
```

---

### Task 9: Settings ▸ Claude Agents

**Files:**
- Modify: `client/src/components/settings/SettingsView.tsx`
- Modify: `test/settings.test.ts`
- Test: `test/settings-view.test.tsx` (extend)

**Interfaces:**
- Consumes: `useAgents` (Task 6), `linkBase` + `clampOrigin` (Task 7 Step 3), `SettingsGroup`/`SettingsRow` (existing).
- Produces: no new exports — a new `SettingsGroup` in the existing default-exported view.

- [ ] **Step 1: Write the failing tests**

Append to `test/settings.test.ts`:

```ts
describe('linkBase', () => {
  it('defaults to the dashboard on loopback', () => {
    expect(clampSettings({}).linkBase).toBe('http://127.0.0.1:5174');
  });

  it('keeps an http(s) origin and drops a trailing slash', () => {
    expect(clampSettings({ linkBase: 'https://box.ts.net:5174/' }).linkBase)
      .toBe('https://box.ts.net:5174');
  });

  it('refuses a non-http scheme — this value becomes an href', () => {
    expect(clampSettings({ linkBase: 'javascript:alert(1)' }).linkBase)
      .toBe('http://127.0.0.1:5174');
    expect(clampSettings({ linkBase: 'not a url' }).linkBase)
      .toBe('http://127.0.0.1:5174');
    expect(clampSettings({ linkBase: 42 }).linkBase).toBe('http://127.0.0.1:5174');
  });
});
```

(`clampSettings` is already imported by that file.)

Append to `test/settings-view.test.tsx`:

```tsx
describe('the Claude Agents group', () => {
  it('reports a healthy dashboard and the project count', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({
        enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
        spawnMaxPermission: 'auto', projectPaths: ['/a', '/b']
      })
    } as Response)) as jest.Mock;

    render(<SettingsView />);
    expect(await screen.findByText(/connected/)).toBeInTheDocument();
    expect(screen.getByText(/ceiling: auto/)).toBeInTheDocument();
    expect(screen.getByText(/2 projects/)).toBeInTheDocument();
    // No setup steps when everything is green — the panel should not nag.
    expect(screen.queryByText(/BM_AGENTS=on/)).not.toBeInTheDocument();
  });

  it('shows the setup steps when dispatch is off', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({
        enabled: false, reachable: false, remoteAnswer: false, spawnAvailable: false,
        spawnMaxPermission: null, projectPaths: []
      })
    } as Response)) as jest.Mock;

    render(<SettingsView />);
    expect(await screen.findByText(/BM_AGENTS=on/)).toBeInTheDocument();
    expect(screen.getByText(/hooks:install/)).toBeInTheDocument();
  });

  it('stores an edited dashboard link and refuses a bad scheme', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({
        enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
        spawnMaxPermission: 'auto', projectPaths: []
      })
    } as Response)) as jest.Mock;

    render(<SettingsView />);
    const field = await screen.findByLabelText('Dashboard link');
    await userEvent.clear(field);
    await userEvent.type(field, 'https://box.ts.net:5174');
    await userEvent.tab();
    expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
      .toBe('https://box.ts.net:5174');

    await userEvent.clear(field);
    await userEvent.type(field, 'javascript:alert(1)');
    await userEvent.tab();
    expect(JSON.parse(localStorage.getItem('backlog-manager.settings') ?? '{}').linkBase)
      .toBe('http://127.0.0.1:5174');
  });
});
```

If `test/settings-view.test.tsx` does not already import `userEvent`, add:

```tsx
import userEvent from '@testing-library/user-event';
```

and add a `beforeEach(() => { localStorage.clear(); })` if it has none.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- test/settings.test.ts test/settings-view.test.tsx`
Expected: FAIL — `linkBase` undefined; no "Claude Agents" group in the view.

- [ ] **Step 3: Add the group to `SettingsView.tsx`**

Add the imports:

```tsx
import { useAgents } from '../../hooks/useAgents';
import type { AgentsStatus } from '../../../../shared/types';
```

Add above the component:

```tsx
/**
 * One line per gate, in the order dispatchBlock checks them, so the first red
 * dot is also the thing to fix first. Read-only: every one of these lives on a
 * host — in this API's env or in the dashboard's — and a switch here that
 * wrote to a browser's localStorage would just be a lie about where the
 * setting is.
 */
function AgentsStatusLines({ status }: { status: AgentsStatus | null }) {
  if (status === null) return <span className="set-hint">checking…</span>;
  if (!status.enabled) return <span className="set-hint">● off — dispatch is not enabled on the API</span>;
  if (!status.reachable) {
    return <span className="set-hint">● unreachable{status.error ? ` — ${status.error}` : ''}</span>;
  }
  const gaps = [
    status.spawnAvailable ? null : 'no CLAUDE_BIN',
    status.remoteAnswer ? null : 'remote answers off'
  ].filter((g): g is string => g !== null);
  return (
    <span className="set-hint">
      ● connected{gaps.length > 0 ? ` — ${gaps.join(', ')}` : ' · spawn on'}
      {' · '}ceiling: {status.spawnMaxPermission ?? 'unknown'}
      {' · '}{status.projectPaths.length} projects
    </span>
  );
}
```

Add inside the component, after the existing `SettingsGroup`:

```tsx
      <AgentsGroup />
```

and define it below the default export:

```tsx
/**
 * The integration's only editable field is the link base, because it is the
 * only part of it that is genuinely per-device: the API's own outbound call
 * uses BM_AGENTS_URL on the host, and the bearer token must never be in a
 * browser at all. Everything else here is a report on where that host config
 * currently stands.
 */
function AgentsGroup() {
  const { settings, update } = useSettings();
  const { status } = useAgents();
  const healthy =
    status !== null && status.enabled && status.reachable &&
    status.spawnAvailable && status.remoteAnswer;

  return (
    <SettingsGroup title="Claude Agents · this machine">
      <SettingsRow name="Dispatch" hint={<AgentsStatusLines status={status} />}>
        <a className="sheet-link" href={settings.linkBase} target="_blank" rel="noreferrer">
          open dashboard ↗
        </a>
      </SettingsRow>

      <SettingsRow
        name="Dashboard link"
        hint="Where THIS device reaches the dashboard — the laptop on loopback, a phone on its tailnet name. Used only for the link; the API calls it over BM_AGENTS_URL."
      >
        <input
          type="text"
          aria-label="Dashboard link"
          defaultValue={settings.linkBase}
          key={settings.linkBase}
          onBlur={(e) => update({ linkBase: e.currentTarget.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </SettingsRow>

      {!healthy && (
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Setting it up</span>
            <span className="set-hint">
              1 · <code>BM_AGENTS=on</code> and <code>BM_AGENTS_URL</code> in this app's <code>.env</code>, then restart the API.<br />
              2 · <code>CLAUDE_BIN</code> in the dashboard's <code>.env</code> — that is its spawn gate.<br />
              3 · Turn its remote-answer pill on; spawning is refused without it.<br />
              4 · Run its <code>pnpm hooks:install</code>, or a groom that asks you a question will stall with nowhere to ask.<br />
              5 · A project needs one Claude session inside the dashboard's <code>LOOKBACK_HOURS</code> before it can be dispatched to.
            </span>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- test/settings.test.ts test/settings-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/SettingsView.tsx test/settings.test.ts test/settings-view.test.tsx
git commit -m "feat: Claude Agents status and dashboard link in Settings"
```

---

### Task 10: Documentation, CSP check, and full verification

The feature is only real once the env is documented and the invariants are written down where the next session will read them.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Test: existing `test/csp.test.ts` (must stay green, unchanged)

- [ ] **Step 1: Confirm the CSP needs no change**

Run: `pnpm test -- test/csp.test.ts`
Expected: PASS unchanged. Every request the page makes is same-origin, so `connect-src 'self'` still covers the feature; the dashboard link is an `<a href>`, which no directive in the policy governs. **If this suite fails, stop** — something added an inline script or a cross-origin fetch, and that is a design violation, not a constant to update.

- [ ] **Step 2: Document the env in `.env.example`**

Append:

```bash
# --- dispatching backlog items to ../claude-agents-dashboard -------------
# Off unless BM_AGENTS is on/1/true. Off means the board makes no outbound
# request at all and shows no dispatch buttons.
# BM_AGENTS=on

# The dashboard's API origin — its PORT (4173 by default), NOT its Vite port.
# Env-only on purpose: no request shape lets a browser name the host this
# server will call, which is what keeps the proxy from being an SSRF surface.
# In the compose stack this must be host.docker.internal, not loopback.
# BM_AGENTS_URL=http://127.0.0.1:4173

# Sent as `Authorization: Bearer …` when the dashboard sets ANSWER_TOKEN. Never
# reaches the browser — the board calls this API, and this API calls the
# dashboard.
# BM_AGENTS_TOKEN=
```

- [ ] **Step 3: Note the compose override in `docker-compose.yml`**

In the `server` service's `environment:` block, add:

```yaml
      # Dispatch is off unless you turn it on. Inside the stack the dashboard
      # is on the host, not on this container's loopback — hence
      # host.docker.internal rather than the 127.0.0.1 default that is right
      # for `pnpm run dev` on the host.
      # BM_AGENTS: 'on'
      # BM_AGENTS_URL: 'http://host.docker.internal:4173'
```

- [ ] **Step 4: Add a README section**

After the existing `### Configuration` section, add:

```markdown
### Dispatching to Claude (optional)

With `../claude-agents-dashboard` running, a card's button hands that item to a
real Claude Code session: an idea gets groomed into a task, an ungroomed bug
gets its Cause and Fix filled in, a groomed bug or task gets executed. The
board calls this API, this API calls the dashboard's `POST /api/spawn`, and the
session shows up in the dashboard a poll later — where you can watch it, and
answer its questions from a phone if its hooks are installed.

Off until you set `BM_AGENTS=on` (plus `BM_AGENTS_URL`, and `BM_AGENTS_TOKEN`
if the dashboard sets `ANSWER_TOKEN`). **Settings ▸ Claude Agents** reports
exactly which gate is closed and what to do about it. The action is derived
from the item file, not from the click, so an ungroomed bug cannot be executed
by asking nicely — and nothing here ever writes an item: the spawned session
runs the skills, which remain the only writers.
```

- [ ] **Step 5: Add the invariants to `CLAUDE.md`**

In the **Layout** list, extend the `server/src/` entry with `agents/` and add the two client files:

```markdown
- `server/src/` — Nest. `health/` (`GET /api/health`), `items/`
  (`GET /api/items`, `GET /api/projects`, `GET /api/items/body`), `agents/`
  (`GET /api/agents/status`, `POST /api/agents/plan`,
  `POST /api/agents/dispatch` — the one outbound call in the app), `registry/`
  (read-only view of the registry file), `static.ts` …
```

and in **Invariants**, add:

```markdown
- **Dispatch derives the action; it never accepts one.** `shared/agent.ts` is
  the single derivation (`deriveAction`), imported by the board to label a
  button and by the server to validate a request — one implementation, so a
  button can never promise what the API refuses. `POST /api/agents/dispatch`
  re-scans the item file and 409s when the request's action disagrees, which is
  the groomed invariant enforced on the only side that can read the file. The
  prompt is the one client-supplied field, because editing it in the launch
  sheet is the point.
- **The browser never talks to the dashboard.** `connect-src 'self'` forbids it
  and the bearer token must not be in a page, so every call goes board → this
  API → dashboard. `BM_AGENTS_URL` is env-only and never client-supplied:
  there is deliberately no request shape in which a browser names the host this
  server will call. `BM_AGENTS` defaults to off, so an unconfigured install
  makes no outbound request at all.
- **Dispatch still writes no item files.** The spawned session runs the skills,
  which remain the only writers — the read-only invariant above holds
  literally, not by exception.
- **A project the dashboard cannot see cannot be dispatched to.** Its
  `POST /api/spawn` takes a `dirName` resolved against projects active inside
  its `LOOKBACK_HOURS` (24 by default), so a quiet repo has no key to send.
  Accepted, not worked around: the alternative is teaching that app to take an
  absolute path, which widens the widest write surface it has. The button
  disables with the reason; Settings names both fixes. Never derive a `dirName`
  from a path to route around this.
- **`linkBase` is per-device and becomes an href**, so `clampSettings` rejects
  any non-`http(s)` scheme — it is the one settings key a hand-edited
  localStorage value could turn into script execution.
```

- [ ] **Step 6: Full verification**

Run: `pnpm test`
Expected: every suite passes.

Run: `pnpm run typecheck`
Expected: silent, exit 0.

Run: `pnpm run build`
Expected: a clean Vite build — this is what proves the runtime import of `shared/agent.ts` from client code actually bundles (the jsdom tests go through ts-jest, not Vite).

- [ ] **Step 7: Manual smoke test**

Start the dashboard (`pnpm dev` in `../claude-agents-dashboard`), then here:

```bash
BM_AGENTS=on BM_AGENTS_URL=http://127.0.0.1:4173 pnpm run dev
```

Check, in this order:
1. `curl -s localhost:4322/api/agents/status | jq` — `reachable: true`, `spawnAvailable: true`, and this repo's path in `projectPaths`.
2. Open `http://localhost:5177`, confirm Settings ▸ Claude Agents reads connected.
3. Dispatch a **groom** on a real idea and watch the session appear in the dashboard. Grooming asks a question — confirm it surfaces there as `answer`.
4. Confirm the item file changed on disk afterwards, and that nothing was committed.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md README.md .env.example docker-compose.yml
git commit -m "docs: agent dispatch env, setup and invariants"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Endpoints (`status` / `plan` / `dispatch`) | 3, 4, 5 |
| Allowlist + re-scan guard, `dirName` never a path | 5 (asserted), 4 |
| 60s project-map cache | 3 |
| Action table, all seven rows | 1 |
| Prompt shape, no slash command, `-n` name | 2 |
| Card button, hidden vs disabled | 8 |
| Launch sheet incl. verbatim dashboard errors | 7 |
| Settings panel, status + setup steps | 9 |
| `linkBase` per-device + clamp | 7 (model), 9 (UI + test) |
| Env, off by default, no SSRF | 2 (config), 10 (docs) |
| CSP unchanged | 10 Step 1 |
| Docker note | 10 |
| Test list | every task |

Two deliberate deviations from the spec, both tightenings:

1. **`AgentPlan` carries no `projectDirName`.** The client has no use for it and `dispatch` re-resolves it from `itemPath`; exposing an internal dashboard key to a browser bought nothing. The spec's flow diagram lists it — treat the type in Task 1 as authoritative.
2. **`plan` takes no `action`.** It derives one; letting a caller name one there would be a second answer to a question the file already answers.

**Placeholder scan:** none. Every code step carries the code; every test step carries the assertions and the exact command with its expected result.

**Type consistency:** `deriveAction`/`actionLabel`/`clampMode`/`modesUpTo`/`dispatchBlock` are declared in Task 1 and used with those exact names in Tasks 4, 5, 8. `readAgentsConfig`/`composePrompt`/`sessionName` from Task 2 are used in 3, 4, 5. `fetchAgentsStatus`/`fetchAgentPlan`/`dispatchAgent`/`sessionUrl` from Task 6 are used in 7. `AgentsStatus`/`AgentPlan`/`AgentDispatchRequest`/`AgentDispatchResult` are declared once in Task 1 and imported by both sides throughout. `linkBase` is added in Task 7 Step 3 (the sheet is its first consumer) and consumed again in Task 9 — the ordering matters, so do not reorder those two tasks.
