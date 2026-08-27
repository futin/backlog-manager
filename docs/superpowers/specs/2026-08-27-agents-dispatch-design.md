# Agent dispatch — design

**Status: approved 2026-08-27.**

Clicking a card on the board hands that item to a real Claude Code session: an
idea gets groomed into a task, an ungroomed bug gets its Cause and Fix filled
in, a groomed bug or task gets executed. The session is spawned by
`../claude-agents-dashboard`, which already owns that capability, and the board
links to it so you can watch — or answer its questions from a phone.

## Goals

- One click per card dispatches the *right* next step for that item, derived
  from the item's own state rather than chosen by the clicker.
- The board never becomes a writer of item files. The spawned session runs the
  existing skills; they remain the only writers.
- Off by default. Without configuration the board renders exactly as it does
  today and makes no outbound request.
- The bearer token never reaches a browser.
- No changes to `claude-agents-dashboard`. Everything used already exists there.

## Non-goals

- No queue, no scheduler, no batch dispatch. One item, one click, one session.
- No progress mirroring. The dashboard already renders live sessions; the board
  links to it instead of re-implementing it.
- No stop/kill from the board. The dashboard owns the launch's lifecycle.
- No item editing from the UI. Unchanged from v1.

## What the dashboard already provides

Verified by reading `../claude-agents-dashboard` at `f018a42`:

| Capability | Endpoint | Notes |
|---|---|---|
| Spawn a headless session | `POST /api/spawn` | Body `{project, prompt, name, model, effort, permissionMode, remoteControl}`; returns `{sessionId}` |
| Capability probe | `GET /api/health` | Publishes `spawnAvailable`, `spawnMaxPermission`, `remoteAnswer` |
| Project list | `GET /api/management` | `projects: ProjectRef[]`, each with `dirName` **and** absolute `path` |
| Chat deep link | `/?session=<uuid>` | `client/src/lib/deepLink.ts` — consumed once, then stripped |

Four gates stand in front of `POST /api/spawn`, all of them the dashboard's own
and none of them ours to relax:

1. `remoteAnswer` must be on — else `404 remote answers disabled`.
2. `CLAUDE_BIN` must name a runnable binary (`probeSpawn`) — else `404 spawn
   unavailable`.
3. `Authorization: Bearer <ANSWER_TOKEN>` when that token is set — else `403`.
4. At most `MAX_LAUNCHING` launches in flight — else `429`.

And one clamp: `permissionMode` is clamped to `config.spawnMaxPermission`
server-side, so a request can never buy more permission than the host allows.

### The lookback constraint

`SpawnRequest.project` is a `dirName`, resolved by `resolveProject` against
`listRecentProjects`, which only lists projects whose newest transcript falls
inside `LOOKBACK_HOURS` (default 24). **A registered backlog project with no
Claude session in the last day cannot be spawned into.** This is accepted as a
limit rather than worked around: the alternative is teaching the dashboard to
take an absolute path, which widens the widest write surface in that app and
belongs to its own design pass. This is the one block that leaves a control on
screen: the button stays rendered and `aria-disabled`, and the reason — which
names the path, and is stated nowhere else in the UI — rides in its `title` and
in the visually-hidden span its `aria-describedby` points at. Settings carries
the host-level setup list instead, including this one's two fixes: open a
session in that repo once, or raise `LOOKBACK_HOURS` in the dashboard's `.env`.

### Why groom works headlessly

`backlog-groom` is a conversational skill: it asks the user to choose between
promoting, planning in place, and rejecting. Headless, that `AskUserQuestion`
is caught by the dashboard's remote-answer hook and surfaces as a row waiting on
`answer`, which you resolve from the phone. That is the reason this integration
is worth building rather than a novelty — but it depends on the hooks being
installed (`pnpm hooks:install` in the dashboard repo), so Settings must say so.
Without them a groom launch simply stalls until it gives up.

## Architecture

Client → backlog API → dashboard. Never client → dashboard: the token must stay
server-side, and `server/src/security.ts` ships `connect-src 'self'`, which a
cross-origin fetch from the built app would violate.

```
ItemCard / ItemDrawer
   │  click
   ▼
POST /api/agents/plan  { itemPath }  ──► allowlist + re-scan + project match
   │  ← { action, prompt, project, allowedModes, defaultMode, blocked? }
   ▼
LaunchSheet  (prompt editable, mode select, remote-control toggle)
   │  Launch
   ▼
POST /api/agents/dispatch ──► re-validate, clamp ──► dashboard POST /api/spawn
   │                                                   (Bearer BM_AGENTS_TOKEN)
   ◄─ { sessionId }
   ▼
"session 4f2a… ↗ open in dashboard"  →  <linkBase>/?session=<sessionId>
```

### Module layout

`server/src/agents/`:

| File | Charter |
|---|---|
| `agents.module.ts` | Wires the controller and service; imports `RegistryModule` and the items scanner |
| `agents.controller.ts` | The three routes, nothing else |
| `agents.service.ts` | Validation, project resolution, the two outbound calls, the 60s project cache |
| `prompt.util.ts` | Pure: `(item) → {action, prompt}`. The action table lives here |
| `config.util.ts` | Pure: reads `BM_AGENTS*` env into a typed object with defaults |

`prompt.util.ts` and `config.util.ts` are pure and carry the tests. The service
is the only file that touches the network.

### Endpoints

**`GET /api/agents/status`**

```ts
interface AgentsStatus {
  enabled: boolean;            // BM_AGENTS on
  reachable: boolean;          // dashboard answered /api/health
  remoteAnswer: boolean;       // its toggle — spawn 404s without it
  spawnAvailable: boolean;     // its CLAUDE_BIN probe
  spawnMaxPermission: PermissionMode | null;   // declared in our own shared/types.ts
  projectPaths: string[];      // absolute paths the dashboard can resolve
  error?: string;              // why reachable is false, for Settings to show
}
```

`PermissionMode` is re-declared in this repo's `shared/types.ts` rather than
imported: the dashboard is a sibling checkout, not a dependency, and a
cross-repo import would make this app unbuildable without it. The ladder is four
strings and a test pins them.

`enabled: false` short-circuits: no fetch, no egress, everything else falsy.
`projectPaths` comes from `GET /api/management`, which is a heavy scan (every
skill, agent, command and hook per project scope) — so the service caches the
derived `path → dirName` map for **60 seconds**. The board reads status on mount
and on window focus, never on a timer; the dashboard's own 3s poll is the thing
that watches sessions, and duplicating it here would buy nothing.

**`POST /api/agents/plan`** — `{itemPath}` → the sheet's contents. It takes no
`action`: the action is *derived*, and letting the caller name one here would
create a second answer to a question the file already answers.
Pure with respect to the world: it reads disk and the cached project map and
launches nothing. `blocked` is set (with a reason) instead of erroring when the
item is dispatchable in principle but not right now — the unresolvable-project
case — so the sheet can explain rather than fail.

**`POST /api/agents/dispatch`** — `{itemPath, action, prompt, permissionMode, remoteControl}` → `{sessionId}`. No dashboard `dirName` crosses to the browser in either direction: dispatch re-resolves it from `itemPath`, so the client never holds a key it has no use for.

Both write paths run the same guard, in this order:

1. `itemPath` through the existing `allow.util.ts` allowlist built from the
   registry. A path outside every registered `backlog/` is a 404, exactly as it
   is for `GET /api/items/body`. One allowlist, one meaning.
2. Re-scan the file with `parse.util.ts` and re-derive `section`, `status`,
   `groomed` **from disk**. The client's `action` is checked against that
   derivation, never trusted: asking to execute a bug whose Fix still reads
   `unknown` is a `409`, not a launch. This is the groomed invariant being
   enforced on the only side that can read the file, and it is the reason the
   dispatch is proxied rather than relayed.
3. Resolve the owning project's registry `path` against the cached project map;
   send the matching `dirName`. A path is never sent — `dirName` membership is
   the dashboard's own contract and we do not route around it.
4. Clamp `permissionMode` to `spawnMaxPermission` from the probe. The dashboard
   clamps again; ours is so the sheet cannot offer what cannot be delivered.

The prompt text is client-supplied because the sheet lets you edit it, and that
is deliberate: everything that *matters* — which item, whether the action is
legal, which project, which permission ceiling — is derived server-side. The
prompt is the one field where a human's edit is the point.

## Action table

Derived in `prompt.util.ts` from the item as scanned:

| Section | Condition | Action | Skill invoked |
|---|---|---|---|
| ideas | `status === 'open'` | `groom` | `backlog-groom` — promote to a task with a plan |
| bugs | `open`, `groomed === false` | `groom` | `backlog-groom` — fill Cause and Fix in place |
| bugs | `open`, `groomed === true` | `execute` | `backlog-execute` |
| tasks | `open`, `groomed === true` | `execute` | `backlog-execute` |
| tasks | `open`, `groomed === false` | `groom` | `backlog-groom` |
| out-of-scope | any | none | — |
| any | `status === 'done'` | none | — |

One button per card, label from the action. Out-of-scope and archived items get
no button at all rather than a disabled one — there is no next step to disable.

### Prompt shape

Natural language naming the skill, **not** a slash command. Whether `claude -p`
expands a `/skill` in a piped prompt is unverified against this CLI, and the
skill descriptions are written to trigger on exactly this phrasing, so the
documented path is the safe one:

```
Use the backlog-manager:backlog-groom skill on idea-3 — "Seed the board" —
in this repo's backlog. Promote it to a task with a real, executable plan.
```

```
Use the backlog-manager:backlog-execute skill on task-12 — "Add CSP" — in this
repo's backlog. Work its plan, verify it, then archive the item.
```

Lifecycle stays with the skills: `backlog-execute` runs `backlog.mjs start`
itself, `backlog-groom` does its own `move`. The prompt asks for the work, never
for the bookkeeping.

`SpawnRequest.name` is set to `bl <project> <id>` so the dashboard's row is
legible at a glance, and `effort` is left unset — the session inherits the host
default. Spaces rather than the `bl:<project>/<id>` first drafted here: that
app's `NAME_RE` (`server/lib/spawn.ts`) allows neither `:` nor `/`, and it
fail-softs an invalid name to `undefined`, so the punctuated form was silently
dropped on every dispatch and every row fell back to the bare project name.
`test/agents-prompt.test.ts` now asserts the composed name against a copy of
that regex.

## UI

**Card.** One action button in the `ItemCard` footer, with `stopPropagation` on
click — and on `Enter`/`Space` only, never on every key, or the sheet's own
window-level Escape listener never sees the keydown while focus is still on this
button. Rendered only when `status.enabled && reachable && spawnAvailable &&
remoteAnswer`: those four are environment-level, true of every card at once, and
a disabled control on all of them would be noise, so the control is absent
instead (`dispatchGate`, `shared/agent.ts`). When the item's project is not in
`projectPaths` it renders `aria-disabled` — focusable, so a keyboard user can
actually reach the reason — with the reason in `title` and in an
`aria-describedby` span. `ItemDrawer` repeats the same button.

**Launch sheet.** A small modal: project name, the composed prompt in an
editable textarea, a permission-mode select whose options are the ladder
truncated at `spawnMaxPermission`, a remote-control checkbox (default on — it is
what lets the phone app drive the session), Cancel and Launch. On success the
sheet collapses to the session id and a link to
`<linkBase>/?session=<sessionId>`, which is the dashboard's existing deep link.
On failure it shows the dashboard's own error string verbatim; those strings are
short and specific (`too many launches in flight`, `unknown project: …`) and
paraphrasing them would only lose information.

**Settings ▸ Claude Agents.** A status block — reachable, spawn available,
remote answers, ceiling, resolvable project count — plus the per-device link
base field, plus setup steps rendered when a dot is red: set `BM_AGENTS_URL`,
set `CLAUDE_BIN` in the dashboard's `.env`, flip its remote-answer pill, run its
`pnpm hooks:install`.

`linkBase` is the only new key in `client/src/lib/settings.ts`. It stays
per-device on purpose, and it is the one piece of this feature that genuinely
differs per device: the laptop reaches the dashboard at `127.0.0.1:5174`, the
phone at its tailnet name. It is clamped like every other key — a value that is
not an `http(s)` origin falls back to the default, so a hand-edited
`javascript:` never becomes an href.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BM_AGENTS` | `off` | Master switch. Off ⇒ no egress, no buttons |
| `BM_AGENTS_URL` | `http://127.0.0.1:4173` | The dashboard's **API** origin (its `PORT`, not its Vite port) |
| `BM_AGENTS_TOKEN` | *(empty)* | Sent as `Authorization: Bearer …` when set |

The URL is env-only and never client-supplied, which is what keeps this from
being an SSRF surface: there is no request shape in which a browser names the
host the server will call.

Docker: the API container reaches the dashboard on the host, so
`BM_AGENTS_URL=http://host.docker.internal:4173` there. Documented in
`docker-compose.yml` as a comment, not defaulted — the loopback default is right
for the host-side `pnpm run dev`, which is how this is normally run.

## Security posture

This is the first outbound call and the first initiated action in an app whose
v1 posture was "read-only, loopback, no auth". What it adds is a button that
starts a Claude Code session with file-write permission in another repo. Three
things bound it:

- **Off by default**, and the switch is an env variable on the host, not a
  toggle in the browser.
- **The ceiling is the dashboard's**, and the dashboard's ceiling is its host's
  `SPAWN_MAX_PERMISSION`. Nothing in this app can raise it; the sheet can only
  offer modes at or below it.
- **The action is derived, not requested.** A crafted POST cannot pick the
  work: the server re-scans the item file and 409s a request whose `action`
  disagrees, so `execute` on an ungroomed bug is refused. This bounds the
  *action* and the *project* — and nothing else. It does **not** bound the
  instructions: no `action` field is ever sent to the dashboard, and `prompt` is
  forwarded verbatim, which is the whole point of the launch sheet's editable
  textarea. So the honest statement is that a caller who can post at all can
  make the session do whatever a prompt can make it do, inside the permission
  mode the ceiling allows.
- **Who may post at all is therefore the real bound**, and it is
  `server/src/agents/origin.guard.ts`: the two POST routes accept
  `application/json` only, and refuse a present `Origin` that is not the
  request's own host. Without it, `express.urlencoded` — which Nest registers
  unconditionally — plus the no-preflight status of
  `application/x-www-form-urlencoded` meant any page in the developer's browser
  could auto-submit a hidden form and spawn a session with its own prompt. The
  loopback bind does not help there: the browser is already inside it.

What it does *not* add: item writes from the server (still none), user auth
(still none — the bind plus the POST guard above are the whole access control;
see the `BM_BIND` invariant), or a CSP relaxation (`connect-src 'self'` still
holds, because every request the page makes is same-origin).

## Testing

Flat in `test/`, jest, dashboard calls stubbed — no test ever spawns anything.

| Test | Covers |
|---|---|
| `agents-prompt.test.ts` | The action table, every row, including `done` and out-of-scope returning none |
| `agents-prompt.test.ts` | Prompt composition: item id, title and skill name present; no slash command |
| `agents-dispatch.test.ts` | Ungroomed bug + `execute` ⇒ 409; foreign `itemPath` ⇒ 404; unknown item ⇒ 404 |
| `agents-dispatch.test.ts` | Mode clamping against a stubbed `spawnMaxPermission` |
| `agents-origin-guard.test.ts` | A urlencoded POST and a cross-origin/`null`-origin POST are 403 with **zero** outbound fetches; same-origin JSON, the Vite-proxy header pair, and a no-origin caller still work; `GET status` stays open |
| `agents-shared.test.ts` | `dispatchGate`: the four environment reasons hide the control, the project one disables it; `dispatchBlock` flattens the same ladder |
| `agents-status.test.ts` | `BM_AGENTS=off` ⇒ all-falsy status and **zero** fetches; unreachable ⇒ `error` populated |
| `agents-status.test.ts` | The 60s project-map cache: two calls, one `/api/management` fetch |
| `agents-dispatch.test.ts` | Happy path sends `dirName` (never a path) and the bearer header when the token is set |
| `launch-sheet.test.tsx` | jsdom: options truncated at the ceiling; error string rendered verbatim |
| `dispatch-button.test.tsx` | jsdom: no button at all when dispatch is off/unreachable; `aria-disabled` with a reachable, described reason for an unresolvable project; click and Enter do not open the drawer; Escape closes the sheet with focus still on the card's button |
| `settings.test.ts` | `linkBase` clamping, including a non-`http(s)` value falling back |

## Accepted limits

- A project quiet for more than `LOOKBACK_HOURS` is undispatchable. Named in the
  UI, not worked around.
- No feedback loop: the board learns nothing about how the session went. You
  watch it in the dashboard, and the item's own state is the record. Refreshing
  the board after the session lands shows the result, which is the whole point of
  the store being files.
- A groom launch stalls if the dashboard's hooks are not installed. Settings
  warns; nothing here can detect it beyond that.
- `MAX_LAUNCHING` is the dashboard's rail, not ours. A burst of clicks surfaces
  as its `429`, rendered verbatim.
