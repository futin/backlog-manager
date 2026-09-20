# Instance marker — telling two installs apart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One machine's install of this board can be told apart from another's at a glance — in the browser tab and in the app's own chrome — from a value the
server was started with, because every machine runs its own instance and they are otherwise pixel-identical.

**Architecture:** Two environment variables read by the server (`BM_INSTANCE`, a free-form label; `BM_INSTANCE_MARK`, one of a closed list of hue+shape pairs),
served read-only from a new `GET /api/instance`, and drawn by three client surfaces from **one** home for what a mark looks like: the rail's badge under the
brand, the document title's prefix, and the favicon. A fourth surface reports the raw values on Settings › Shared, which is where an operator looks to confirm
the environment took. Absent `BM_INSTANCE` renders today's app byte for byte.

**Tech Stack:** NestJS controller + module (no service — the route is an env read), React hook + component, TypeScript shared types, jest (`supertest`,
jsdom) for every layer.

**Design:** settled in chat on 2026-09-19 and approved; there is no spec file, because the change adds no subsystem. The approved shape, in full:

- `BM_INSTANCE=mac` — free-form, machine-local, never committed. Absent means the app is exactly what it is today: no badge, stock title, stock favicon.
- `BM_INSTANCE_MARK=cyan-circle` — one of six pairs. It names a **pair** (hue **and** shape) rather than a hue alone, deliberately: the whole reason this
  treatment was picked over a coloured pill is that the marks stay tellable apart at 16 px and without colour vision, which a hue alone cannot do. Naming the
  variable for the hue while deriving the shape elsewhere would let two installs collide on shape and quietly lose that property.
- A label with no mark, or with an unknown mark, renders the label in `--ink2` with no glyph, and the route says so. Never a silent fallback to a hue — the
  same posture `resolveSource` takes toward an `unsupported` marker.
- No palette override, no per-instance theme, no Settings **control**. The marker is host identity; `theme` is a per-device preference in `localStorage`, and
  the two must not fight.

**How to read this plan.** This plan specifies **required behaviour and exact test cases**, never implementation prose to transcribe. Code blocks below are
shell commands to run and expected output to check — not source to copy into the repo. Where a step describes a module, it states what the module must do, the
names it must export and the cases that prove it; the implementer writes the code and is expected to disagree with this document where the code disagrees with
it. Any size figure is a soft target.

## Global Constraints

- **Absent `BM_INSTANCE` is a no-op.** No new element in the DOM, no title change, no favicon swap, no request cost the app did not already pay. This is the
  single most important property in the plan: every machine that does not opt in must be unaffected.
- **`client/index.html` is not edited.** The environment only exists after a fetch, so the title and favicon must be stamped from React regardless — which also
  means `THEME_SCRIPT_SHA256` (`server/src/security.ts`) stays valid and `test/csp.test.ts` stays green. If a step seems to want the pre-paint script, the step
  is wrong.
- **Every route lives under `/api`** — `GET /api/instance`. It is a read, so it is unguarded like every other GET; the origin guard covers POSTs only.
- **The environment is read per request and cached nowhere**, the pattern `server/src/tracker/token.util.ts` already sets.
- **`docker-compose.yml` passes both keys through as interpolations with an empty default, never literals** — bug-25's rule, and `test/compose-env.test.ts` is
  where it is pinned.
- **One home for what a mark looks like.** The rail glyph and the favicon are drawn from the same definition, in `client/src/lib/instance-mark.ts`. Two
  expressions of "what cyan-circle is" would be free to drift, and the drift would be invisible until someone compared a tab to a rail.
- Every new component cites its `.claude/DESIGN.md` subsection in a header comment, per the repo's rule.
- New authored prose (comments, docs, this plan) wraps at 160 columns.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## The six marks

Each mark carries a theme token (what the rail glyph uses, so it follows the palette) **and** a literal hex (what the favicon uses, because a favicon is
painted by browser chrome and never sees the page's CSS variables — `client/index.html`'s own comment makes this argument already). The hex is the **midnight**
block's value of that token, which is the palette the favicon's existing amber was picked from.

| Mark              | Token       | Hex (midnight) | Shape                      |
| ----------------- | ----------- | -------------- | -------------------------- |
| `cyan-circle`     | `--cyan`    | `#55d0dd`      | filled circle              |
| `amber-square`    | `--amber`   | `#ffb03a`      | filled square              |
| `green-triangle`  | `--green`   | `#46d48c`      | filled triangle, point up  |
| `magenta-diamond` | `--magenta` | `#cf6f9e`      | filled square rotated 45°  |
| `mustard-hex`     | `--mustard` | `#d1ba52`      | filled regular hexagon     |
| `red-slab`        | `--red`     | `#e0533f`      | filled 2:1 horizontal slab |

All six tokens are defined in all five `[data-theme]` blocks of `shared/theme.css` — verified 2026-09-19, five declarations each. The knockout colour inside
the favicon square is `#0c1220`, the same board navy the existing favicon knocks its bars out in.

---

### Task 1: The shared vocabulary

**Files:**

- Modify: `shared/types.ts`
- Create: `test/instance-types.test.ts`

**Interfaces:**

- Exports `INSTANCE_MARKS`, a `readonly` tuple of the six ids above, in the table's order.
- Exports `InstanceMark`, its member union, and `isInstanceMark(value: unknown): value is InstanceMark`.
- Exports `InstanceInfo`, the payload `GET /api/instance` answers with: `{ label: string | null; mark: InstanceMark | null; note: string | null }`.
- `INSTANCE_LABEL_MAX`, the label's clamp (24), exported so the server and the tests read one number.

- [ ] **Step 1: Write the failing cases**

`test/instance-types.test.ts` must cover:

- every member of `INSTANCE_MARKS` passes `isInstanceMark`
- `'cyan'`, `'cyan-square'`, `'CYAN-CIRCLE'`, `''`, `null`, `undefined`, `0` and `{}` all fail it — the uppercase case matters, the guard is case-sensitive
  because the env value is copied from documentation, not typed from memory
- `INSTANCE_MARKS` has six members and no duplicates
- every mark's **shape half** (the text after the first `-`) is distinct across the list, and every **hue half** is distinct too — this is the property the
  whole treatment rests on, and a seventh mark added carelessly is exactly how it would be lost

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- instance-types`

Expected: the suite passes. `pnpm run typecheck` is clean.

---

### Task 2: The route

**Files:**

- Create: `server/src/instance/instance.controller.ts`, `server/src/instance/instance.module.ts`, `server/src/instance/instance.util.ts`
- Modify: `server/src/app.module.ts`
- Create: `test/instance-route.test.ts`

**Interfaces:**

- `readInstance(env = process.env): InstanceInfo` in `instance.util.ts` — the whole of the behaviour, so the controller is a one-line delegate and the cases
  below can drive the function directly as well as through HTTP.
- `GET /api/instance` answers `InstanceInfo`, always 200. A misconfigured environment is a value in `note`, never a status — the same choice the tracker's rate
  limits make.

**Behaviour:**

- `BM_INSTANCE` absent, empty or whitespace-only → `{ label: null, mark: null, note: null }`, **whatever `BM_INSTANCE_MARK` says**. A mark with no label is not
  an error worth reporting; it is an install that did not opt in.
- `BM_INSTANCE` present → `label` is the trimmed value, clamped to `INSTANCE_LABEL_MAX` characters (it lands in a 200 px rail and in a tab title).
- `BM_INSTANCE_MARK` absent or empty with a label present → `mark: null, note: null`. The label alone is a legitimate configuration.
- `BM_INSTANCE_MARK` present but not a member → `mark: null`, and `note` names the offending value, e.g. `unknown BM_INSTANCE_MARK 'cyan-squar'`. Never a
  fallback to a hue.
- Read per request: two requests with `process.env.BM_INSTANCE` changed in between return different labels.

- [ ] **Step 1: Write the failing cases**

`test/instance-route.test.ts` uses `listenLoopback` (`test/helpers/app.ts`) — never a bare `listen(0)`, per the convention — and covers, through supertest:

| `BM_INSTANCE` | `BM_INSTANCE_MARK` | expected body                                                             |
| ------------- | ------------------ | ------------------------------------------------------------------------- |
| unset         | unset              | `{ label: null, mark: null, note: null }`                                 |
| unset         | `cyan-circle`      | `{ label: null, mark: null, note: null }`                                 |
| `'   '`       | `cyan-circle`      | `{ label: null, mark: null, note: null }`                                 |
| `mac`         | unset              | `{ label: 'mac', mark: null, note: null }`                                |
| `  mac  `     | `cyan-circle`      | `{ label: 'mac', mark: 'cyan-circle', note: null }`                       |
| `mac`         | `cyan-squar`       | `{ label: 'mac', mark: null, note: <names 'cyan-squar'> }`                |
| 40 × `x`      | `red-slab`         | `label` is 24 characters long                                             |

Plus: one case that mutates `process.env` between two requests to the same app and asserts the second body reflects the change — the assertion that the value
is cached nowhere.

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- instance-route`

Expected: the suite passes, and `curl -s localhost:4322/api/instance` on a dev server with nothing set prints `{"label":null,"mark":null,"note":null}`.

---

### Task 3: One home for what a mark looks like

**Files:**

- Create: `client/src/lib/instance-mark.ts`
- Create: `test/instance-mark.test.ts`

**Interfaces:**

- `MARK_LOOK: Record<InstanceMark, { token: string; hex: string; path: string }>` — the table above, where `path` is the SVG geometry of the shape inside a
  `0 0 10 10` box. One table; both consumers read it.
- `faviconHref(mark: InstanceMark): string` — the full `data:image/svg+xml,…` URI for the tab icon: the existing rounded square, filled in the mark's **hex**,
  with the shape knocked out of it in `#0c1220`. The URI is percent-encoded the way `client/index.html`'s existing one is.
- The rail glyph is drawn by the component from `MARK_LOOK[...].path` and `.token`, so the rail follows the active palette while the favicon cannot.

- [ ] **Step 1: Write the failing cases**

`test/instance-mark.test.ts` covers:

- `MARK_LOOK` has an entry for every member of `INSTANCE_MARKS` and no extra keys — driven off `INSTANCE_MARKS` so a seventh mark fails here rather than
  rendering blank
- every `hex` is distinct, every `path` is distinct, every `token` is distinct
- every `token` is declared in all five theme blocks of `shared/theme.css` — a source read of that file, the way `test/project-hue.test.ts` already checks its
  own tokens. This is what stops a mark being added against a token only the dark themes define.
- every `hex` matches its `token`'s value in the **midnight** block of `shared/theme.css`, read from the file. The favicon's colour and the rail's colour must
  be the same colour, and this is the only mechanical check that can say so.
- `faviconHref` returns a string beginning `data:image/svg+xml,`, containing the mark's hex percent-encoded, and two different marks return two different
  strings
- the returned URI parses: `decodeURIComponent` of its body is well-formed SVG with a single root `<svg>` element

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- instance-mark`

---

### Task 4: The hook

**Files:**

- Create: `client/src/hooks/useInstance.ts`
- Create: `test/use-instance.test.tsx` (jsdom docblock)

**Interfaces:**

- `useInstance(): { data: InstanceInfo | null; loading: boolean }` — one fetch of `/api/instance` at mount, **no polling and no refocus re-read**. The
  environment cannot change under a running server, which is the whole reason this is not shaped like `useAgents`.

**Behaviour:**

- A failed request is `data: null`, not an error surface. Nothing on screen depends on this succeeding, and an install with no label is the same render as a
  failed read — which is the correct render in both cases.

- [ ] **Step 1: Write the failing cases**

- mount → exactly one `fetch` to `/api/instance`; a re-render does not make a second
- a 200 with a body sets `data`; `loading` goes false
- a rejected fetch and a 500 both leave `data: null` and log nothing that fails the test run

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- use-instance`

---

### Task 5: The rail badge

**Files:**

- Modify: `client/src/components/SideRail.tsx`
- Modify: `client/src/styles.css`
- Modify: `.claude/DESIGN.md` (a new §8 subsection for the marker)
- Create: `test/instance-badge.test.tsx` (jsdom docblock)

**Interfaces:**

- The badge sits under `.rail-brand`, inside the existing `brand` element so it travels to the narrow `.rail-bar` layout with it.
- An **outline** plate — 1 px `--hairline` border, `--ink2` text, the glyph filled in the mark's token — never a filled pill. A fill would read as status, and
  DESIGN.md §8.0 reserves the rail's only ornament for decoration that means nothing.
- The glyph is `aria-hidden`; the label text carries the meaning. No `role`, no live region: this never changes while the page is open.

**Behaviour:**

- `label === null` → **nothing rendered**. Not an empty element, not a hidden one.
- `label` with `mark: null` → the plate with the label and no glyph.
- `label` with a mark → plate, glyph, label.

- [ ] **Step 1: Write the failing cases**

- no label → the rail contains no element matching the badge's class
- label, no mark → badge present, text is the label, contains no `<svg>`
- label + mark → badge present, contains one `<svg>` carrying `aria-hidden="true"`, and the glyph's fill resolves through the mark's token
- the badge is inside the element that the narrow layout moves — assert it is a descendant of `.rail-brand`, so the mobile bar cannot lose it

- [ ] **Step 2: Implement until green, then write the DESIGN.md subsection**

The subsection states: what the marker is, that it is outline and why (status vs decoration), that the glyph differs in shape and not only hue and why (16 px,
no colour vision), and that absent is the default.

Run: `pnpm run test:jest -- instance-badge`

---

### Task 6: The tab — title prefix and favicon

**Files:**

- Modify: `client/src/App.tsx` (or a small effect module it calls — implementer's call, one home either way)
- Create: `test/instance-tab.test.tsx` (jsdom docblock)

**Behaviour:**

- `label === null` → `document.title` stays `Backlog Manager` and the `<link rel="icon">` href is untouched.
- `label` present → title becomes `<label> · Backlog Manager`. **Prefix, not suffix**: a narrow tab truncates the tail, so a suffix is the first thing lost,
  and the tab strip is the surface this was asked for.
- `mark` present → the `<link rel="icon">` href is replaced with `faviconHref(mark)`. `mark: null` leaves the stock amber icon in place.

- [ ] **Step 1: Write the failing cases**

- no label → title unchanged, icon href unchanged (compare against the value read before mount)
- label only → title is `mac · Backlog Manager`, icon href unchanged
- label + mark → title prefixed **and** icon href equals `faviconHref(mark)`
- unmounting does not leave a half-applied state (title restored or left as-is, whichever the implementation commits to — assert the one it does)

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- instance-tab`

---

### Task 7: The Shared Settings card

**Files:**

- Create: `client/src/components/settings/InstanceGroup.tsx`
- Modify: `client/src/components/settings/SettingsView.tsx`
- Create: `test/instance-settings.test.tsx` (jsdom docblock)

**Interfaces:**

- A `SettingsGroup` titled `Instance`, `scope="this machine"`, **first in the Shared page's right column**, above `AgentsGroup` — it identifies the host the
  two cards under it report on.
- Two rows: `Label` (the value, or `not set`) and `Mark` (the mark id with its glyph, or `not set`). Read-only, like `TrackersGroup` and for the same reason:
  the value lives in the server's environment and a control here would be a second writer of it.
- When `note` is non-null it is shown as the `Mark` row's hint, verbatim. This is the surface the route's `note` exists for.

- [ ] **Step 1: Write the failing cases**

- nothing set → both rows read `not set`, and the card is still rendered (unlike the rail badge — Settings is where you go to find out that nothing is set)
- label only → `Label` shows it, `Mark` reads `not set`
- label + valid mark → both shown, glyph present
- unknown mark → `Mark` row's hint contains the route's `note` text
- the card is on the Shared page and **not** on the Local page

- [ ] **Step 2: Implement until green**

Run: `pnpm run test:jest -- instance-settings`

---

### Task 8: The environment — compose, example, docs

**Files:**

- Modify: `docker-compose.yml`, `.env.example`, `test/compose-env.test.ts`
- Modify: `CLAUDE.md`, `docs/subsystems/invariants.md`
- Modify: `docs/subsystems/api.md` and `docs/subsystems/board.md` (one line each — the new route, the new surface)

**Behaviour:**

- Compose passes both through as interpolations with an empty default, on the **server** service only (the client never sees them):
  `BM_INSTANCE: '${BM_INSTANCE:-}'` and `BM_INSTANCE_MARK: '${BM_INSTANCE_MARK:-}'`.
- `.env.example` documents both, commented out, in the register the file already uses: what it is, that it is per-machine and never committed, the six marks by
  name, and that absent means the app is unchanged.
- `CLAUDE.md` gains one Invariants entry and `invariants.md` the anchor it links to. The rule worth pinning is the pair: **absent `BM_INSTANCE` renders today's
  app exactly**, and **an unknown mark is reported, never defaulted**.

- [ ] **Step 1: Extend the compose guard**

`test/compose-env.test.ts` gains: `assignments('BM_INSTANCE')` equals `['${BM_INSTANCE:-}']` and `assignments('BM_INSTANCE_MARK')` equals
`['${BM_INSTANCE_MARK:-}']` — whole-key matching, so `BM_INSTANCE` never collects `BM_INSTANCE_MARK` (the existing `assignments` helper already matches whole
keys; assert that it does, since this is the first key pair in the file where one name is a prefix of another).

- [ ] **Step 2: Write the docs**

Run: `pnpm test`

---

### Task 9: Verification

- [ ] **Step 1: The full suite, both runners**

```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && pnpm test && pnpm run typecheck && pnpm run build
```

Expected: jest green, node's runner green, no type errors, a built bundle.

- [ ] **Step 2: The no-op check — the most important one in the plan**

With no `BM_INSTANCE` in the environment, start the app and confirm: no badge in the rail, title reads `Backlog Manager`, favicon is the stock amber board.
Then `git stash` the branch and compare a screenshot of the rail against the same view on `main` — they must be identical.

- [ ] **Step 3: The real thing**

Set `BM_INSTANCE=mac` and `BM_INSTANCE_MARK=cyan-circle` in `.env`, restart, and confirm the badge, the `mac · Backlog Manager` title, the cyan-circle favicon
at 16 px, and the Instance card on Settings › Shared. Then set `BM_INSTANCE_MARK=nonsense` and confirm the label still renders, the glyph does not, and the
Settings card names the bad value.
