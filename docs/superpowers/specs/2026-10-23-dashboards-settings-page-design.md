# Settings › Dashboards — its own page, redesigned as a list and a detail

Date: 2026-10-23. Follows [2026-10-22-multi-dashboard-design.md](2026-10-22-multi-dashboard-design.md), whose "Settings" section drew today's card.

## Why

The `Dashboards` card on Shared Settings (`client/src/components/settings/DashboardsGroup.tsx`) draws every machine as a `SettingsRow` whose hint is a stack of
five to seven plain-text lines — `dashboard http://…`, `board http://…`, `machine name Linux`, `BM_AGENTS_TOKEN_LINUX ✓ set`, `account: Pro`, `models: opus,
sonnet, haiku, fable`, `efforts: low, medium, …`. A remote fills in every field, so the Linux row is the worst of it: a wall of text with nothing that reads
at a glance. The card is also the tallest thing on Shared and grows by one such block per machine (up to 8 remotes plus Home), pushing `Trackers` far down,
and its subject — the machines a launch can run on — is not the same kind of thing as the machine-wide knobs beside it (watchdog, tick breaker).

The user's words: "it looks ugly with pure text, especially for Linux." Success is a page where each machine reads at a glance — is it up, how much of its
usage is left, which account, where it sits in the prefer order, what it may run — with the URLs and the token status still there but no longer the whole
picture.

## Decided by the user

- **Its own Settings page, named `Dashboards`** (not "Machines"). The rail's Settings tree becomes `Local`, `Shared`, `Dashboards`.
- **Layout B, list + detail** (picked from three mocks drawn over the live page: A one card per machine, B list + detail, C a table with an expandable row).
  A compact list of every machine on the left, the selected machine's full detail on the right, the suggestion settings in a card above both.
- **At a glance, per machine:** health and the two usage meters (5 h and weekly); the account and the machine's place in the prefer order; models and
  efforts as chips rather than comma text; the URLs and the token's status.
- **Reorder is ↑ ↓ in the detail's header**, as today. No drag and drop.
- **Nothing project-specific on this page.** The mocks drew a `Right now: Home — first in order, under 80%` row under Suggest and an `offered for this project`
  line on a remote; both are answers `GET /api/dashboards/offers?project=` gives for ONE project, and a Settings page has no project. Both are dropped; the
  per-project suggestion stays where it is, in the launch sheet's Run on card.

## Goals

1. A third Settings page, `dashboards`, reached from the rail's Settings tree and from a deep link, carrying everything the `Dashboards` card carries today
   and nothing else. The `Dashboards` card leaves the Shared page.
2. The page draws each machine's **health** and **usage** — today those are read only by the offers, per project, in a launch sheet. That needs one new
   read-only server route (below), because the browser never talks to a dashboard.
3. Every function of today's card survives the move (the parity table below is the checklist). The user wants 100 % of functionality kept through a redesign.

## Non-goals

- No change to `dashboards.json`'s shape, its reader, its four write routes or `DashboardSheet` (the add/edit sheet). The sheet opens from the new page
  exactly as it opens from the card today.
- No drag-and-drop reorder. No project picker. No suggestion preview.
- No token entry, in any form — unchanged from the multi-dashboard spec.
- No change to how the launch sheet's Run on card picks or shows a machine.

## Anti-goals (a failure even if it works)

- Losing anything today's card does (a refusal shown in the server's words, the unreadable-file lock, Home's setup steps while dispatch is unhealthy, the
  one-write-at-a-time guard, the `Confirm` on Remove, the MAX_REMOTES cap on Add).
- The browser calling a dashboard or a remote board directly ([invariants.md § the browser never talks to the dashboard](../../subsystems/invariants.md#the-browser-never-talks-to-the-dashboard)).
- A slow or dead remote holding the page hostage: the machine list and every control must draw from `GET /api/dashboards` alone, at today's speed, with
  health and usage filling in when they arrive.
- A token's value reaching the payload or the DOM.
- A second look for an existing primitive (`test/design-guards.test.ts` guard 7): meters are `Meter`, dots `Dot`, pills `Pill`, buttons `Chip`, the
  cards `Sheet`/`SettingsGroup`.

## The page

Drawn to `.claude/DESIGN.md` §8.6 (Settings), which gains a paragraph for this page (see Docs).

**Band.** The title stays `Settings` on all three pages, as today; only the subtitle and the scope pill change per page. The Dashboards subtitle along the lines of "The machines a launch can run on, in prefer order, and how the launch sheet picks one. Saved on the API
host — change it here and it changes for everyone." Right slot: the scope pill `this machine`, `tone="neutral"`, exactly as Shared draws it.

**Suggest card** — full width, above the list and detail. Today's two rows, restyled:
- `Strategy`: today's three radios (`Prefer order`, `Most headroom`, `Least likely to run out`), kept as radios — `Segmented` is a `role="group"` of
  `aria-pressed` buttons and rejects radiogroup semantics — and restyled under the page's own class as three side-by-side option tiles, each drawing its
  name and its own one-line explanation (today's `STRATEGIES[].line`). All three lines survive, each still the `aria-describedby` of its own radio, and the
  `role="radiogroup"` with its accessible name stays. Accessibility outranks the look.
- `Threshold`: the 1–100 `NumberField` with its `%` unit and its refused-value re-seed (`thresholdNonce`), unchanged.
- The `suggest`-scope refusal row under them, as today.

**List** (left column, ~360 px). One row per machine, in prefer order (today's `ids` derivation, including its "a row the order lacks is drawn last" and
"home is always present" repairs). Each row: the order number in a small outlined box, the health `Dot`, the name, `this machine` pill on Home, the account
`Pill` (or a muted `no account set` on a machine without one), and under them the two `Meter`s side by side, `5 H` and `WEEK`. The selected row sits on the
`--steel` well. The list ends with `+ Add dashboard` (`Chip`), disabled at `MAX_REMOTES` with today's `at most 8 dashboards` title and disabled while the file
is unreadable. Rows are buttons (keyboard-selectable); the list is not a dialog and does not join the Escape stack.

**Detail** (right column, a `Sheet`). For the selected machine:
- **Head:** the same order box, dot, name and pills as its list row, then on the right `↑` `↓` `Edit` and — remotes only — `Remove`, with today's disabled
  rules (`locked`, first/last) and today's `aria-label`s (`Move Linux up`, `Edit Linux`, …). Remove asks through `Confirm` in place of the controls, with
  today's sentence ("Remove Linux? Launches can no longer go there; its token stays in .env.").
- **Status line:** Home — `dispatch` + `AgentsStatusLines` (today's first Home line, read by `useAgents`), with `DispatchSetupSteps` under it while dispatch
  is unhealthy. A remote — the same reading in the same words where it applies (answers / cannot take a launch and why / unreachable with the error in the
  server's words).

**The health dot means "a launch could go there now"** (decided by the user). Four rungs, checked in this order: no answer yet (`null`) or `!enabled` →
quiet (no tone); `enabled && !reachable` → red (`Dot` tone `crashed`); `reachable && !(spawnAvailable && remoteAnswer)` → amber (tone `paused`; the reason is
the status line); otherwise green (tone `live`). One predicate decides it, in `shared/` beside the other dispatch predicates, and every dot on the page reads
it. It REPLACES today's two disagreeing readings in `DispatchStatus.tsx` — `dispatchDotTier` (green on `reachable && remoteAnswer`, blind to
`spawnAvailable`) and `dispatchHealthy` (which gates `DispatchSetupSteps`) — and that file's local `Dot`/`.set-dot` gives way to `ui/Dot`, so
`AgentsStatusLines`' dot, `DispatchSetupSteps`' gate and the page's dots are one function, not agreeing expressions. (Those lines draw nowhere else:
today their only home is the Dashboards card's `Dispatch` row, which moves to this page.) An unreachable dashboard's dot turns from gray to red with them. *My call:* Home's dot reads `useAgents`' status through that predicate —
the same status its status line and setup steps read — so Home can never show a green dot above open setup steps; the remotes' dots read the new route's
answer through the same predicate.
- **Usage:** both `Meter`s full width, each with its reset time under it as an absolute local clock time: `resets 23:39` when the reset falls today,
  `resets Sun 05:59` otherwise, `resets now` once the stamp has passed, and no reset line for a window with no (or an unparseable) reset time. That is a NEW
  helper in `lib/dashboards.ts` taking one window's `resetsAt` and the caller's clock, used for both windows; `fiveHourResetText` (relative, 5 h only) stays
  as the launch sheet's and is not reused here. The meter's tone follows the percent through the existing `usageTone`. With no figure the meters are
  replaced by ONE generic muted line, specific only where the server already knows: `unreachable` for a machine that does not answer,
  `no fresh figure · usage 14 min ago` for a figure past `USAGE_FRESH_MS` (the second half is the existing `usageAgeText`, unchanged), and plain
  `no usage figure` otherwise (signed out, `SHOW_USAGE` off and a failed account read are not told apart — **decided by the user**,
  so `UsageService` and its cache stay as they are).
- **Models and efforts:** `Models` and `Efforts`, every member of `MODELS` / `EFFORTS` drawn as a `Pill` — they are facts, not controls, and `Chip` is the
  clickable primitive — the allowed ones in the normal look and the others visibly off. "Off" is a new prop on `Pill` itself (one home; the mock struck
  them through on a dashed outline — the builder may pick another treatment from existing tokens), never a page-local class. Home's are drawn the same way and, as today, narrow
  nothing; no hint suggests otherwise.
- **Facts:** a two-column label/value grid under a hairline, values in monospace, each one wrapping anywhere: `Dashboard` (Home: its URL plus a small
  `BM_AGENTS_URL` tag naming where it comes from), `Board` and `Machine name` (remotes only), `Token` — the var's name and `✓ set`, or today's "not set —
  needed only if that dashboard does not trust this machine; then add it to .env and restart" sentence, never drawn as a fault.
- The `list`-scope refusal row (a failed move or remove) under the head.

**Footer.** `Saved to <file>` as today. The old card's lead line ("Listed in prefer order — move a machine with ↑ ↓. Tokens are never entered here…") may
move into the band subtitle or the footer; its meaning must stay on the page.

**Selection.** Defaults to the first machine in prefer order. Not stored (no new settings key). It follows a machine through a reorder; when the selected
machine is no longer in the view the page draws (removed here), it falls back to the first. The view is read as today — `useDashboards` once on mount,
deliberately no focus trigger, plus each write's answer — so another tab's edit shows on the next reload, unchanged from the card. Add selects the new machine once the server's view
contains it.

**Widths.** Under Settings' own 1100 px fold the two columns stack: list above detail, full width. Under 700 px the list rows stay as drawn and the detail's
head wraps its controls onto a second line; no horizontal page scroll at any width.

**States.**
- `GET /api/dashboards` not answered yet / failed: today's null-view card, unchanged in content — the dispatch status line, the setup steps, and
  `checking…` or, on failure, the row named `Unavailable` with the hint `Could not read the dashboards — <error>. This page will fill in once the API
  answers GET /api/dashboards again.` (today's sentence with "card" → "page").
- `source: 'unreadable'`: a banner row at the top of the page naming the file and the one fix by hand (today's sentence); every control disabled; the list
  still draws Home.
- Machine status not answered yet: dots in the quiet (no-tone) `Dot`, meters absent, and the detail's usage area says `checking…`. The config parts draw
  regardless.

## Server: one new read

`GET /api/dashboards/machines` (name is the builder's call; it must sit under `/api/dashboards`, read-only, Host-allowlisted and without `SameOriginPostGuard` like every GET). It answers, per
configured machine (in `machines()`' order — the client's `ids` derivation is what puts the list in prefer order):

- `machine` (id), `reachable` and, when not, the `error` sentence, plus the dispatch-health fields the dot's predicate needs (whatever `/api/health` gives
  — `spawnAvailable`, `remoteAnswer`, `spawnMaxPermission` — in the shape Home's `AgentsStatus` already uses, so one predicate reads both). Every machine,
  Home included, is judged by ONE new health-only method on `DashboardStatusService` that reads `/api/health` and nothing else: `statusOf` and
  `remoteStatusOf` both also read the project map (`/api/configs`, up to 15 s), which this route never needs and which would make a remote's health depend
  on a project. Home's health budget is its existing 4 s, a remote's the 5 s `REMOTE_BUDGET`. `projectPaths` is not in the answer. The page reads Home's
  dot and status line from `useAgents` (above) and ignores the route's Home health, which exists only to gate Home's usage read.
- `usage` and `usageAgeMs` from `UsageService.read` — the same in-memory cache the offers use, so opening Settings and opening a launch sheet share one fetch
  per machine per `USAGE_TTL_MS`. Usage is read only once that machine's health answer is `enabled && reachable`, otherwise it is `null`/`null` — the offers'
  order (judge, then read). `UsageService.read` has no `enabled` check of its own, so this gate is what keeps `BM_AGENTS` off egress-free for Home too. The
  two reads are therefore sequential per machine — worst case one health budget plus one 5 s usage budget (about 9 s for Home, 10 s for a remote) — and
  machines run in parallel.
- Never a token, never a URL (the view already carries URLs).

It is always a 200 once it runs: an unreachable machine is an answer, not an error — the offers route's rule. Unlike the offers, it reads Home's usage
even when the file's source is `default` (home only): the offers skip it because no picker is drawn, while this page draws Home's meters either way. With `BM_AGENTS` off, remotes are not called at
all (the feature's off switch) and read as not enabled. With an unreadable `dashboards.json` only Home is answered, matching `machines()`.

This is a new outbound read inside `agents/` (the dashboards submodule already calls remote dashboards), so no fourth outbound-calling module appears.

**Client polling.** A hook on `useCoalescedFetch` via `useRefreshing` (mount + window focus), armed with a timer while the Dashboards page is the one on screen
— 60 s is the suggested period, matching `USAGE_TTL_MS`. It never runs while another page is shown.

## Changes to existing pieces

- `client/src/lib/settings.ts`: `SettingsScope` becomes `local | shared | dashboards`; `SETTINGS_SCOPES` gains it; `clampSettings` keeps routing through
  `pickOne`, so an old stored value still clamps.
- `client/src/components/SideRail.tsx`: `RAIL_SCOPE_LABEL.dashboards = 'Dashboards'`. The tree stays the only switch.
- `client/src/lib/deep-link.ts`: `settings=dashboards` is accepted the moment `SETTINGS_SCOPES` grows (it checks `SETTINGS_SCOPES.includes`); the work is its
  doc comment ("`shared` or `local`", "points at the Dashboards card") and `test/deep-link.test.ts`.
- `client/src/lib/dashboards.ts`: `SETTINGS_HREF` (the Run on card's Settings link) becomes `/?section=settings&settings=dashboards`.
- `client/src/components/settings/SettingsView.tsx`: a third page component; the band's subtitle and pill per page; the Shared page drops `DashboardsGroup`
  and rebalances — the watchdog and tick breaker on the left, `Trackers` on the right — with its header comment rewritten to say why.
- `DashboardsGroup.tsx` is replaced by the page's components (names are the builder's); its header comment's content (what the card draws, why a token is
  never on the page, why Home's lists narrow nothing, the one-write-at-a-time guard, the unreadable lock, the threshold re-seed) moves with the code it
  describes — none of it is dropped.
- Styles: the `.dash-*` rules in `client/src/styles.css` that `DashboardSheet` does not use go — `.dash-machine` (its three rules), `.dash-line`,
  `.dash-strategies`, `.dash-strategy`, `.dash-strategy input`, `.dash-strategy-text`, `.dash-threshold`, and the `.dash-strategy input` half of the shared
  `.dash-check input, .dash-strategy input` rule unless the restyled radios keep it; the sheet's `.dash-field/-text/-checks/-check/-actions/-sheet-*` stay.
  New rules live beside them. The `.set-dot-*` rules go with the local `Dot`, and `test/daylight-contrast.test.ts`'s `.set-dot-green`/`.set-dot-amber`
  entries follow.

## Invariants and docs touched

- **"Settings is two pages, the page is the scope, and the rail is the only thing that switches them."** Becomes three pages. The rule that survives: a page
  is ONE scope and no card mixes two — Dashboards and Shared are both `this machine`, which is allowed (two pages may share a scope; a page may never hold two).
  The headline changes in all three homes at once — `CLAUDE.md`, `.claude/rules/board.md` and `docs/subsystems/invariants.md` — because
  `test/claude-rules.test.ts` holds the headlines byte-equal.
- `.claude/DESIGN.md` §8.6: a paragraph for the Dashboards page (list + detail, the Suggest card on top, the fold), and the Shared page's balance sentence
  updated now that `Dashboards · this machine` is no longer on it.
- `docs/subsystems/board.md` (Settings), `docs/subsystems/api.md` (the new route). The mechanism and body text that say two pages also change:
  `.claude/rules/board.md`'s "`settingsScope` … is `local | shared`", `invariants.md`'s section body and its "Settings (Local, Shared)" mention, and
  `.claude/DESIGN.md`'s "Settings is TWO pages". CLAUDE.md's Layout line does not name Settings' pages, so only its headline changes.
  `.claude/rules/dispatch-watchdog.md`'s `dashboards.json` bullet gains the new route beside the others and a clause that it, unlike the offers, reads
  Home's usage under a `default` source (the same note in `offers.service.ts`' header stays true of the offers).
  Renaming the headline renames the `invariants.md` anchor, so its links in `CLAUDE.md`, `.claude/rules/board.md` and `docs/subsystems/board.md` move with
  it. Also stale: `.claude/DESIGN.md`'s "Settings' Local and Shared (§8.6)" and `docs/subsystems/board.md`'s "Settings (Local, Shared)"; the mentions of
  "the Dashboards card's add/edit sheet" read "page" for "card".

## Parity checklist — today's card against the page

| Today (`DashboardsGroup.tsx`) | On the page |
| --- | --- |
| Null-view card: dispatch line, setup steps, `checking…` / `Unavailable` | Same content, page-level |
| Unreadable file: hint naming the file, every control disabled | Banner row, every control disabled |
| Lead line: prefer order, ↑ ↓, tokens live in .env | Band subtitle or footer |
| `Add dashboard` in the card head, MAX_REMOTES cap + title, disabled when unreadable | End of the list, same rules |
| Rows in prefer order, order-lacks-a-row and home-always repairs | List, same derivation |
| ↑ ↓ (disabled when locked / at an end), Edit, Remove (remotes), aria-labels | Detail head, same |
| Remove → inline `Confirm` with its sentence | Same, in the detail head |
| Home: `dispatch` + `AgentsStatusLines`, `DispatchSetupSteps` when unhealthy | Detail status line |
| Home: `BM_AGENTS_URL` + URL | `Dashboard` fact + `BM_AGENTS_URL` tag |
| Remote: dashboard URL, board URL, machine name | `Dashboard`, `Board`, `Machine name` facts |
| Token line, set / not-set sentence | `Token` fact, same words |
| Account line | Account `Pill` in list row and head |
| Models / efforts comma lines (`ticked`) | `Pill`s, allowed normal, the rest `off` |
| `DashboardSheet` for Home, Add and Edit; error in the sheet | Unchanged |
| Notices scoped `form` / `list` / `suggest`, server's words | Same three scopes, placed as above |
| One write in flight (`busyRef` + `busy`), fresh view after every write | Unchanged |
| Strategy radios with name + line | Same radios, restyled as tiles, every line kept |
| Threshold `NumberField`, commit on blur, re-seed on refusal | Unchanged |
| `Saved to <file>` | Footer |
| — (new) | Health dot, usage meters + resets, per machine |

## Settled during the builder check (calls, not the user's — check them while reading)

- With `BM_AGENTS` off, no machine is called — Home's usage included — and every machine reads as not enabled (quiet dot). The off switch is "no egress".
- An unreachable machine's usage is not read, and a cached figure for it is not shown: unreachable wins, as in the offers, which read usage only for an
  offered machine.
- `Segmented` is a `role="group"` of `aria-pressed` buttons and its header deliberately rejects radiogroup semantics, so the strategy picker keeps today's
  radios, restyled under the page's own class (the fallback the Suggest card section already allows).
- Health then usage per machine (usage gated on the health answer), machines in parallel: the route's worst case is two budgets, about 10 s.
- Selection follows a rename made through the Edit sheet (the save knows the new name).
- After any write, the machines read is triggered at once rather than waiting for the timer.
- The new wording of the Settings headline and its anchor are the builder's, kept byte-equal across its three homes.

## Left to the builder

- The new route's name and response type name (in `shared/types.ts`), and which call proves a remote "answers".
- Component and file names for the page, its list and its detail; whether the list row and detail head share one component.
- The `Pill`'s "off" treatment, from existing tokens.
- Where the old lead line lands (subtitle or footer).
- Test layout, following `CLAUDE.md`'s rules on where a test sits. Expected at least: the rail tree's three items and labels; the deep link; `SETTINGS_HREF`;
  the moved Dashboards-card assertions (today's `test/settings-dashboards.test.tsx`, plus the page-level ones in `test/settings-view.test.tsx`); the old href
  pinned at `test/run-on.test.tsx`; the route (unreachable remote is a 200 with an error; no token in the body; `BM_AGENTS` off calls no remote and none of
  Home's usage endpoints; an unreadable file answers Home only; an unreachable machine's usage is not read); the health predicate's four rungs; the reset
  helper (today, another day, passed, missing); selection fallback after a remove.
