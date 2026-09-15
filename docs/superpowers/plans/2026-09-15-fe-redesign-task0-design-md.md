# FE redesign task 0 — `.claude/DESIGN.md` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `.claude/DESIGN.md` — the dashboard's reference-design analysis §1–7 byte-for-byte, plus this app's own §8 — and the two pointer lines that make it reachable, as docs-only commits on `main`.

**Architecture:** One new Markdown file assembled in two halves: a verbatim copy of `../claude-agents-dashboard/.claude/DESIGN.md` lines 1–157 (everything before its `## 8`), then §8.0–8.8 written new from the spec's numbers in the register the dashboard's §8 uses. `CLAUDE.md` gains one Layout line and `docs/overview.md` one map row. No `.claude/rules/` file — `test/claude-rules.test.ts` pins those to `invariants.md` anchors only.

**Tech Stack:** Markdown, `shasum`, `grep`, `node -e` for content checks, jest + node test runners via `pnpm test`.

**Spec:** `docs/superpowers/specs/2026-09-15-fe-redesign-design.md` — §1 (the file), §§2–6 (the numbers each §8 subsection carries), §11 (the pointer lines), §12 (the one-home component rule §8.2 cites).

**How to read this plan.** This plan specifies **required content and exact
checks**, never prose to transcribe — a plan's sentences get copied verbatim,
and a document copied out of a plan is a document nobody wrote. Each writing
step lists what a subsection must contain (every number, every rule, every
reason the spec names) and the register to write it in; the check step is the
authority on whether the step is done. Where a number is given, it is copied
from the spec and must appear in the file exactly.

## Global Constraints

- §1–7 of the new file are **byte-identical** to lines 3–157 of the dashboard's `.claude/DESIGN.md` at its commit `c179ca4` (2026-09-12) — everything after its own title line and before its `## 8`; SHA-256 of that region: `89a69b26766f0144b740a31229e9c0290fe225701ba6c9af1a09a1a134e640ac`.
- §8's register is the dashboard's §8: numbers first, the rule, then the reason; "recorded here so the next reader does not correct it back" for every deliberate departure.
- 11 px is the type floor; one face; no uppercase but the wordmark kicker (spec §2.3).
- Two tokens added to every theme: `--fill-live`, `--fill-progress` (spec §2.2); daylight values are the spec §2.2 table, exactly.
- Docs only: no file under `client/`, `server/`, `shared/`, `skills/`, `test/` changes in this plan.
- The `<!-- docs-sync:` stamp blocks in `CLAUDE.md` (line ~563) and `docs/overview.md` (line ~116) are **not edited**; re-baselining is `/docs-sync`'s job, not this plan's.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The verbatim half — §1–7 with a provenance line

**Files:**
- Create: `.claude/DESIGN.md`
- Read: `../claude-agents-dashboard/.claude/DESIGN.md:1-157`

**Interfaces:**
- Produces: `.claude/DESIGN.md` whose first line is a title, second a blank, third a one-line provenance note, then a blank, then the dashboard's lines 3–157 unchanged (its own `# Design analysis` title line is replaced by ours, so the byte-identical region is lines 3–157 of theirs = the block after our provenance note). Later tasks append `## 8. Applying this to the board` after it.

- [ ] **Step 1: Confirm the source region and its checksum**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard && git log -1 --format='%h %ad' --date=short -- .claude/DESIGN.md && grep -n '^## 8' .claude/DESIGN.md && sed -n '3,157p' .claude/DESIGN.md | shasum -a 256
```
Expected: `c179ca4 2026-09-12`; `158:## 8. Applying this to the dashboard`; SHA-256 `89a69b26766f0144b740a31229e9c0290fe225701ba6c9af1a09a1a134e640ac` (the Global Constraints figure). A different hash means the dashboard's file moved since this plan was written — stop and re-read the diff before copying.

- [ ] **Step 2: Write the head of the file**

Write `.claude/DESIGN.md` with exactly: line 1 `# Design analysis — the board's visual language`; line 2 blank; line 3 a single sentence stating that §1–7 are copied unchanged from `../claude-agents-dashboard/.claude/DESIGN.md` at commit `c179ca4` (2026-09-12) on 2026-09-15, that they describe the reference design and not this app, and that §8 is this app's own; line 4 blank.

- [ ] **Step 3: Append the verbatim region**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && sed -n '3,157p' ../claude-agents-dashboard/.claude/DESIGN.md >> .claude/DESIGN.md && wc -l .claude/DESIGN.md
```
Expected: `159 .claude/DESIGN.md`.

- [ ] **Step 4: Verify byte identity**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && sed -n '5,159p' .claude/DESIGN.md | shasum -a 256 && sed -n '5,159p' .claude/DESIGN.md | diff - <(sed -n '3,157p' ../claude-agents-dashboard/.claude/DESIGN.md) && echo IDENTICAL
```
Expected: `89a69b26766f0144b740a31229e9c0290fe225701ba6c9af1a09a1a134e640ac`, then `IDENTICAL`. Also `grep -c '^## ' .claude/DESIGN.md` prints `7`.

- [ ] **Step 5: Commit**

```bash
git add .claude/DESIGN.md
git commit -m "docs(design): DESIGN.md §1–7, verbatim from the dashboard at c179ca4"
```
(with the Co-Authored-By trailer)

---

### Task 2: §8.0 Shell and rail, §8.1 Type, §8.2 Tokens and themes

**Files:**
- Modify: `.claude/DESIGN.md` (append after line 159)
- Read: spec §2.1–2.4, §12.1; `../claude-agents-dashboard/client/src/styles.css:160-232` (the rail rules as shipped); `../claude-agents-dashboard/.claude/DESIGN.md:158-230` (the register)

**Interfaces:**
- Produces: headings `## 8. Applying this to the board`, `### 8.0 Shell and rail`, `### 8.1 Type`, `### 8.2 Tokens and themes` — exact strings, later tasks and the checks grep for them.

- [ ] **Step 1: Write `## 8` intro and §8.0**

Required content of the intro (one paragraph): why §8 is rewritten rather than copied — the dashboard's §8 is about pages this app lacks, and nothing in it draws a kanban column, an item card, a run, a stage track or a watchdog console. Then the two carried lessons, stated once for the whole section: nothing on `--board` uses `--strip-hi` as its only separator (two points apart on daylight), and a raised control means a state, not a button.

Required content of §8.0: a departures table like the dashboard's (spec/mock vs this board vs why) with at least these rows — rail 300 → **280 px**; nav row 44 → **36 px** (44 on the phone menu); sub-nav indent 36 → **24 px** (the icon's centreline: 16 px padding + half a 16 px icon); wordmark 20/700 over an 11/500 uppercase kicker. Then the rules: rows 14/500 with 16 px padding-x and 16 px radius, a 16 px outline icon 12 px from the label; active = 3 px ink bar 16 px tall + `--strip-hi` fill, never a label colour change; hover darkens the label and nothing else; icons hold `--ink` at every weight; sub-nav tree drawn only for the open section, Runs › History / Watchdog being the first; Settings under a rule with 24 px either side; `.main` on `--board` with 24 px top margin and a 24 px top-left radius; below 700 px a top bar (wordmark left, ☰ right), every tree open, bar hides on downward scroll and returns on the first upward one, pinned while the menu is open. State that `RUNS_MODE_KEY` is the persisted sub-view key and the segmented control it feeds is replaced by the tree at every width.

- [ ] **Step 2: Write §8.1**

Required content: the eight-row table from spec §2.3 (role / size-weight / where), the 11 px floor, one face named Hanken Grotesk **self-hosted via `@fontsource/hanken-grotesk` (400/500/600/700)** with the CSP reason (served build has `default-src 'self'` and no `font-src`; `style-src` pinned by `test/csp.test.ts`; tailnet/phone wants no third-party fetch) as the one departure from the dashboard's foundation; `--mono` and `--display` deleted not aliased and why (a stale `var(--mono)` must fall back to the inherited face, not keep Plex); `code, kbd, samp, pre { font-family: inherit }`; `tabular-nums` on `body`; uppercase survives on `.rail-kicker` alone; the three faces and the counts they leave behind (80 `--mono` uses, 14 `--display`, 31 uppercase rules, 129 of 130 `font-size` declarations ≤ 12.5 px).

- [ ] **Step 3: Write §8.2**

Required content: the daylight token table from spec §2.2 with every value exactly (`#f4f4f3 #ededec #ffffff #f2f2f1`, `rgba(0,0,0,.03) #eaeae8 #dcdcda`, `#131313 #6e6e6e #a0a0a0`, `#5fa92c #c4761f #9a8712 #3f8f14 #b03b28 #6b52a8`, `#ffffff rgba(19,19,19,.28) rgba(0,0,0,.06) rgba(0,0,0,.1)`) and the two mappings the dashboard records (accent = darkened `--green-600`; bright ramp values are fills so `--amber`/`--mustard` take darkened cousins); the two new tokens with their meaning, daylight values `#F5A15C` and `#7DC242`, and `var(--amber)` / `var(--green)` in each dark block; the `.hatch` rule (`repeating-linear-gradient(45deg, rgba(255,255,255,.30) 0 1px, transparent 1px 4px)`); the column ramp — refactors `--amber`, ideas `--mustard`, bugs `--red`, tasks `--green` — and that `--magenta` keeps no job on this screen; the four dark themes unchanged as overrides; the **project-hue rule**: one 8 px dot per card and per modal facts column, never on text, name in `--ink2` beside it, `--proj-N` sets unchanged, class not `style` attribute; the **one-home rule** for primitives (spec §12.1) in two sentences with a pointer to the spec's §12 table until `docs/subsystems/board.md` carries it (spec §11).

- [ ] **Step 4: Check the section**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && grep -c '^## 8\. Applying this to the board$' .claude/DESIGN.md && grep -c '^### 8\.[012] ' .claude/DESIGN.md && node -e '
const t=require("fs").readFileSync(".claude/DESIGN.md","utf8");
const must=["#f4f4f3","#ededec","#ffffff","#f2f2f1","rgba(0,0,0,.03)","#eaeae8","#dcdcda","#131313","#6e6e6e","#a0a0a0","#5fa92c","#c4761f","#9a8712","#3f8f14","#b03b28","#6b52a8","rgba(19,19,19,.28)","rgba(0,0,0,.06)","rgba(0,0,0,.1)","--fill-live","--fill-progress","#F5A15C","#7DC242","@fontsource/hanken-grotesk","280 px","36 px","24 px","--strip-hi","font-family: inherit","tabular-nums",".rail-kicker","RUNS_MODE_KEY"];
const miss=must.filter(s=>!t.includes(s)); console.log(miss.length?"MISSING: "+miss.join(", "):"ALL PRESENT")'
```
Expected: `1`, `3`, `ALL PRESENT`.

- [ ] **Step 5: Commit**

```bash
git add .claude/DESIGN.md
git commit -m "docs(design): DESIGN.md §8.0–8.2 — shell, type, tokens for the board"
```

---

### Task 3: §8.3 Board

**Files:**
- Modify: `.claude/DESIGN.md` (append)
- Read: spec §3; mock `docs/superpowers/specs/2026-09-15-fe-redesign-mockups/01-board-shape.html` (option A, revised 2026-09-15) and `02-runs-on-board.html` (option C, revised); `00-functionality-audit.md` beside them (what each revision restored and why)

**Interfaces:**
- Produces: heading `### 8.3 Board`; the class names it may name are the spec's compositions `ItemCard`, `BoardColumn`, `RunChip` and the primitives `Band`, `Chip`, `Pill`, `Dot`, `Marker` (spec §12) — no others.

- [ ] **Step 1: Write §8.3**

Required content, in this order:
1. The shape decision and its two rejected alternatives (sheets with rows; a ledger), one sentence each, and that the mock is `01-board-shape.html` A.
2. **The band**: title 19/500, 13 px `--ink2` count line, 36 px search (12 px radius, `--hairline` stroke), 32 px filter chips (12 px radius, `--hairline2`, 13/500), Orchestrate as the page's one ink chip with hide/disable rules unchanged.
3. **The run chip**: what it replaces (the strip, `StartingStrip`, `RunDrawer`) and the user's reason in their words; dot colours (`--fill-progress` live, `--fill-live` paused or starting, `--red` crashed); the 12/500 count line with the three example strings; the **precedence rule** (crashed over paused/starting over live, count line names each state present); it renders the `starting` array with no client-side filter; a `<button>` calling the rail's section setter; absent when nothing runs or starts.
4. **Columns**: `repeat(4, minmax(0, 1fr))`, 16 px gaps, 2 under 1100, 1 under 700, steps explicit; header = 8 px ramp dot + 15/500 name + 22×20 count pill (`--strip-hi`, 11/500) pushed right; no rule under the header.
5. **The card**: `--strip`, 12 px radius, no stroke, no shadow, hover changes only the cursor and why (§5, a card is a button by role); face padding 14/16/12, 10 px gap; title 14/500 1.35; foot row (8 px `--proj-N` dot + 12/400 `--ink2` name ellipsised, `id · date` 12/400 `--ink3` right, `flex: none`); marker row with the four words and tokens (`groomed` `--green`, `chore`/`debt` `--ink3`, `done` `--ink2`, `stale` `--mustard`, 11/500); the **live strip** — 24 px, `--fill-live` hatched, 11/500 `--ink`, stage word left, elapsed right, one fill for hand session and orchestrator stage with the word carrying the distinction, and the reason the second tone goes (§5: state by ink, never by accent); the **dispatch chip** — 28 px at the right end of the marker row, **always drawn**, never hover-revealed, with the bug-13 reason (a disabled control clicked to re-ask must be visible) and the marker row rendering whenever dispatch is available.
6. **What leaves**: `RunStrip.tsx`, `StartingStrip.tsx`, `RunDrawer.tsx` and their CSS; what stays (`useOrchestratorRuns` polling while any run is `running`, fresh or not; `runClaimBlock` / `runHoldsItem` inputs); pointer to §8.4 for where their rules land.

- [ ] **Step 2: Check the section**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && grep -c '^### 8\.3 Board$' .claude/DESIGN.md && node -e '
const t=require("fs").readFileSync(".claude/DESIGN.md","utf8").split("### 8.3 Board")[1]||"";
const must=["always drawn","hover","bug-13","repeat(4, minmax(0, 1fr))","1100","700","12 px radius","14/500","11/500","--fill-live","--proj-","starting","crashed over","RunStrip.tsx","StartingStrip.tsx","RunDrawer.tsx","useOrchestratorRuns","runClaimBlock","01-board-shape.html"];
const miss=must.filter(s=>!t.includes(s)); console.log(miss.length?"MISSING: "+miss.join(", "):"ALL PRESENT")'
```
Expected: `1`, `ALL PRESENT`.

- [ ] **Step 3: Commit**

```bash
git add .claude/DESIGN.md
git commit -m "docs(design): DESIGN.md §8.3 — the Board: cards in columns, runs off it"
```

---

### Task 4: §8.4 Runs — History, Watchdog, the stage track

**Files:**
- Modify: `.claude/DESIGN.md` (append)
- Read: spec §4, §8 (rules that move); mocks `03-runs-shape.html` (option C, revised 2026-09-15), `04-watchdog.html` (option A, revised); `00-functionality-audit.md` (the Runs and Watchdog tables)

**Interfaces:**
- Produces: headings `### 8.4 Runs`, `#### 8.4.1 History`, `#### 8.4.2 Watchdog`, `#### 8.4.3 The stage track` — exact strings.

- [ ] **Step 1: Write §8.4 and 8.4.1**

Required content of the lead: two pages under one rail entry, History default, both off one `useOrchestratorRuns` payload, Watchdog additionally mounting `useWatchdog` so switching adds no request; the three rejected shapes (split; ledger with expanding row; for Watchdog, folded into cards and an aside).

Required content of 8.4.1, top to bottom: band (`Runs`, `2 live · 29 past`, project select and range control as chips); **one live card per** `running` / `paused` / `starting` — `--strip` sheet, 16 px radius, 24 px padding, two columns with `RunControls` as 28 px chips right — Pause; `Pausing after <id>` + Cancel while a pause is requested (Cancel withdraws the request and takes no accent: nothing stops a run); Resume run for paused, with its hidden / disabled / `Resuming…` states — plus Open ›; left column contents (dot + project 19/500 + run id and start time 12 `--ink3` + mode pill only for branch mode / branch mode (downgraded); §7 progress row 10 px `--fill-progress` hatched over `--steel`, two-tone `2 / 5`, then elapsed, heartbeat (`live` or age), `pausing · finishes <id>`, `N needs attention`, `$ · N turns · N sessions` at 12; hairline; current item head — id 12 `--ink3`, title 14/500, stage chip (glyph + real stage word) and `RowTime` right, the `queue … · preflight …` lead under — and its stage track); the `paused` variant (`paused after <id>`), the `starting` variant (`--fill-live` dot, `starting…`, age, no controls), the **crashed** variant (`--red` dot, `crashed` pill, `no heartbeat for <age>`, the `last heartbeat HH:MM · every stage below is last reported, not current` and `last reported <id> at <stage>` lines, the `run-watchdog.ts` clause as a 13 px sentence, a stalled current node, Resume run exactly when `watchdogStoodDown` allows, and that `watchdog-coupling.test.tsx` drives this card from now on); **figure strip** — one sheet the ground divides, five figures on a 2 px `--board` gap grid wrapping 5→3→2 with the seam drawn both ways, label 13 `--ink2`, value 30/700, a 12 px line only where today's tile has one, the five names and what each reads (runs — its line the five-status glyph + count breakdown; completed / queued — `merged or branched`; avg item work — queue wait excluded; rework / completed — the one-decimal ratio, sentence as title; verify pass — a rate over verification runs), that nothing beyond `aggregateRuns` is drawn, the sixth full-width cell holding `StageBars` at 10 px bar height — seven rows always, `—` for none; **history sheet** — title + subtitle, 13/500 `--ink2` day kickers, 44 px rows (dot plus the `runStatusChip` status word — done / aborted / failed / paused — with tones `--ink3` / `--amber` / `--red` / `--fill-live`; project 14/500; items touched 13 `--ink2`; two-tone count; wall time and cost 12 `--ink3`; mode pill; `›`), load-more as a flat chip, a row opens the run modal (§8.7), live runs not in the list. Then the **rules that moved here**, as a table copied in substance from spec §8: crashed renders as crashed; Resume for crashed lives here alone and paused Resume collapses here; the resume coupling; `starting` visible before its run file exists; the Orchestrate control's hide on starting unchanged; polling unchanged.

- [ ] **Step 2: Write 8.4.2**

Required content: band `Runs · Watchdog` with the state line as subtitle and a flat `Policy in Settings ›` chip (policy edited there only); **three-figure strip** — Sweeper (phase as a 24/700 word, 6 px sweep meter in `--fill-progress` hatched, `next sweep in … · every 10m`), Watching (count, `1 crashed · 1 heartbeating`), Policy (`check every / leave alone for / give up after` as 12-over-14/500 pairs, the enabled switch's state as the 12 px line); **Watching sheet** — one row per `running` run in the runs payload annotated from `watching`, skew rendered not hidden (`· not yet watched`; a placeholder row for a watched id with no run), with dot, project 14/500, run id 12 `--ink3`, verdict (`● ok` / `⚠ crashed`), `last reported <id> · <stage>` or `between items`, the heartbeat meter against `RUN_STALE_MS` with its `stale at 10m` / `past the 10m stale line` labels, and for a crashed run the attempts dots, the `watchdogClause` sentence, `→ session <id>`, `leave alone Nm more` in grace; `Resume now` chip only when `watchdogStoodDown` allows; the row opens the run modal; **Activity sheet** — today's five columns `time · kind · project · run · what the sweeper did` with full run ids, the in-memory / last-`WATCHDOG_EVENT_CAP` caveat as its subtitle, th 12/400 `--ink2`, td 13, time 12 `--ink3`, kind cell = `WATCHDOG_KIND_GLYPH` + word coloured by `WATCHDOG_KIND_TONE` (`live` `--green`, `done` `--green`, `bad` `--red`, `warn` `--amber`, `muted` `--ink3`), scrolls inside its own sheet under 700 px. State why it stays a page (the user's pick over folding into cards): the console is read during a run, and its Watching set is the sweeper's, one tick of skew aside.

- [ ] **Step 3: Write 8.4.3**

Required content: `StageTrack` keeps seven equal columns and its data; 12 px nodes on a 2 px `--steel` rail; reached `--fill-progress`; current `--fill-live` with a 3 px 30 % ring that pulses; not reached `--steel` with `--hairline2` ring; skipped (`fixing` with no fix loop) dashed `--hairline2` ring; names 11 `--ink2`, durations 12/500, `×N` fix-loop badge as an 11/500 pill on the `fixing` node; verification line under it (`✓`/`✕`, command as inline code `--ink` on `--steel` 4 px corner inheriting the face, summary 12 `--ink2`).

- [ ] **Step 4: Check the section**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && grep -c '^### 8\.4 Runs$' .claude/DESIGN.md && grep -c '^#### 8\.4\.[123] ' .claude/DESIGN.md && node -e '
const t=require("fs").readFileSync(".claude/DESIGN.md","utf8").split("### 8.4 Runs")[1]||"";
const must=["useWatchdog","RunControls","--fill-progress","--steel","30/700","2 px","1100","700","44 px","StageBars","watchdogStoodDown","watchdog-coupling.test.tsx","Runs · Watchdog","Policy in Settings","WATCHDOG_KIND_GLYPH","WATCHDOG_KIND_TONE","not yet watched","StageTrack","×N","--hairline2","03-runs-shape.html","04-watchdog.html","aggregateRuns","runStatusChip","runUsageTotals","Pausing after","watchdogClause","RUN_STALE_MS","last reported"];
const miss=must.filter(s=>!t.includes(s)); console.log(miss.length?"MISSING: "+miss.join(", "):"ALL PRESENT")'
```
Expected: `1`, `3`, `ALL PRESENT`.

- [ ] **Step 5: Commit**

```bash
git add .claude/DESIGN.md
git commit -m "docs(design): DESIGN.md §8.4 — Runs live-first, Watchdog page, stage track"
```

---

### Task 5: §8.5 Archive, §8.6 Settings, §8.7 Overlays, §8.8 Motion

**Files:**
- Modify: `.claude/DESIGN.md` (append)
- Read: spec §5, §6; mock `05-run-modal.html` (the run modal, every `RunDetail` reading); `../claude-agents-dashboard/.claude/DESIGN.md` §8.2, §8.6, §8.7 (the passages being restated)

**Interfaces:**
- Produces: headings `### 8.5 Archive`, `### 8.6 Settings`, `### 8.7 Overlays`, `### 8.8 Motion` — exact strings. Component names it may use: `Modal`, `FormSheet`, `ItemModal`, `RunModal`, `LaunchSheet`, `OrchestrateSheet`, `SettingsRow`, `SettingsGroup`, `Segmented`, `Select`, `NumberField`, `Switch`.

- [ ] **Step 1: Write §8.5 and §8.6**

§8.5 required: the Board's card and columns under the four Archive columns (refactoring, ideas, bugs, out of scope), month groups with a sticky 13/500 `--ink2` kicker on the `--board` ground, project select and search only in the band, out-of-scope dot `--ink3`, no live strips, `capture` the only derivable dispatch action.

§8.6 required: the dashboard's §8.2 restated — band header (title 19/500, 13 px line); borderless `--strip` cards, 16 px radius, 24 px padding, title + one-line subtitle each, the four groups named (`Board · this device`, `Display · this device`, `Orchestrator · this device`, `Claude Agents · this machine`); boxless rows (16 px vertical padding, hairline between, 15/500 name over 13 px hint left, control right); the 36 px control family (select / number / text / button, 12 px radius, `--hairline2` stroke); pill switch (recessed `--steel` track, raised `--strip` option) for on/off and the theme/density pickers; 24 px theme swatches at 8 px radius; two hand-balanced columns folding under 1100; the watchdog group's four rows kept and its `Live view` link opening Runs › Watchdog through the rail's section setter.

- [ ] **Step 2: Write §8.7 and §8.8**

§8.7 required: both shapes adopted from the dashboard after its five drawings each, not re-litigated. **Sidecar modal** (`Modal`; item and run): scrim everywhere, `--strip` shell 16 px radius with the one shell lift `0 24px 64px` at `--shadow2`, 290 px facts column left, body right with a clean top edge, max width 1080 px and `calc(100vw / var(--font-scale) - 48px)` below, full-screen under 700 with facts folding above the body; item facts list (project dot + name, id, section, created / updated / last commit, groomed, tags, `in progress since <started>` with elapsed while held, elapsed and token counters when present, path, dispatch control) and body (Markdown at the §8.1 scale — 15/400 body, 19/500 headings, code on `--steel`); run facts list (project dot + name, run id, started / finished / wall, status chip, mode pill + downgrade note, question mode, `$ · turns · sessions`, today's chips — merged / branched / skipped / attention / fix loops — as a two-column list, attention entries with their questions) and body in today's order (Machine time by stage as `StageBars` over `runStageTotals`; `Branches to merge` for branch mode; items with head + `RowTime`, `queue · preflight` lead, stage track, per-item usage, assumptions, last verification as a disclosure open when failed; the `couldn't load verification output` line); no `RunControls` — a live run is a card. Drawn in `05-run-modal.html`. **Sheet** (`FormSheet`; launch and orchestrate): every step and field kept, 620 px, scrim, air, shell lift, full-screen under 700, §8.6's control family, a 13/500 stepper on a hairline for the three steps, Start on the last step alone, the `uncommitted` chip as an 11/500 `--amber` pill with both consequences in words. `useDialogEscape` untouched: one owner, LIFO, topmost closes.

§8.8 required: live dot breathes a ring; current stage node pulses; a needs-you control fades in place; all off under `prefers-reduced-motion` through the existing reduced-motion block.

- [ ] **Step 3: Check the whole §8 outline against the spec**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && grep '^##' .claude/DESIGN.md | sed -n '8,$p' && node -e '
const t=require("fs").readFileSync(".claude/DESIGN.md","utf8");
const heads=["### 8.0 Shell and rail","### 8.1 Type","### 8.2 Tokens and themes","### 8.3 Board","### 8.4 Runs","#### 8.4.1 History","#### 8.4.2 Watchdog","#### 8.4.3 The stage track","### 8.5 Archive","### 8.6 Settings","### 8.7 Overlays","### 8.8 Motion"];
const miss=heads.filter(h=>!t.includes("\n"+h+"\n")); console.log(miss.length?"MISSING: "+miss.join(" | "):"OUTLINE OK");
const tail=t.split("### 8.5 Archive")[1]||"";
const must=["capture","--ink3","Board · this device","Claude Agents · this machine","36 px","--steel","1100","Live view","290 px","1080","calc(100vw / var(--font-scale) - 48px)","620","useDialogEscape","prefers-reduced-motion","Branches to merge","uncommitted","runStageTotals","runUsageTotals","RowTime","tags","05-run-modal.html"];
const m2=must.filter(s=>!tail.includes(s)); console.log(m2.length?"MISSING: "+m2.join(", "):"ALL PRESENT")'
```
Expected: the twelve headings in order; `OUTLINE OK`; `ALL PRESENT`.

- [ ] **Step 4: Re-verify the verbatim half is still intact**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && sed -n '5,159p' .claude/DESIGN.md | diff -q - <(sed -n '3,157p' ../claude-agents-dashboard/.claude/DESIGN.md) && echo IDENTICAL
```
Expected: `IDENTICAL`.

- [ ] **Step 5: Commit**

```bash
git add .claude/DESIGN.md
git commit -m "docs(design): DESIGN.md §8.5–8.8 — Archive, Settings, overlays, motion"
```

---

### Task 6: The two pointer lines

**Files:**
- Modify: `CLAUDE.md:50-53` (the `client/src/` Layout bullet)
- Modify: `docs/overview.md:17-24` (the map table)

**Interfaces:**
- Consumes: `.claude/DESIGN.md` from tasks 1–5, its headings as anchors.

- [ ] **Step 1: Add the CLAUDE.md line**

After the existing `client/src/` bullet's `→ [docs/subsystems/board.md]` line (line 53), add one bullet of at most three lines: `.claude/DESIGN.md` is the client's visual language — §1–7 the reference design copied from the dashboard, §8 how this board applies it — and every component drawn from it cites its subsection in a header comment; it is deliberately not a `.claude/rules/` file because those are pinned to `invariants.md` anchors. Link the file as `[.claude/DESIGN.md](.claude/DESIGN.md)`. Do not touch the `<!-- docs-sync:` block at the file's foot.

- [ ] **Step 2: Add the overview row**

Insert a row after the `subsystems/board.md` row (line 20): `| [.claude/DESIGN.md](../.claude/DESIGN.md) | the client's visual language: the reference design (§1–7, copied from the dashboard) and how this board applies it (§8) |`. Do not touch the `<!-- docs-sync:` block.

- [ ] **Step 3: Check links resolve and stamps are untouched**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && test -f .claude/DESIGN.md && grep -c 'DESIGN.md' CLAUDE.md docs/overview.md && git diff -U0 CLAUDE.md docs/overview.md | grep -c 'docs-sync' ; grep -n 'DESIGN.md' CLAUDE.md docs/overview.md
```
Expected: `CLAUDE.md:1` (or more only if a component citation was added), `docs/overview.md:1`; the `docs-sync` grep count is `0`; the two lines print.

- [ ] **Step 4: Run the whole suite**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && pnpm test 2>&1 | tail -15
```
Expected: both runners green — jest's summary line shows `failed: 0` / no `FAIL`, node's shows `# fail 0`. `test/claude-rules.test.ts` in particular still passes: no rule file was added.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/overview.md
git commit -m "docs: point CLAUDE.md and the docs map at .claude/DESIGN.md"
```

---

### Task 7: Final read-through

**Files:**
- Read: `.claude/DESIGN.md` whole; spec §1.3, §§2–6

- [ ] **Step 1: Placeholder and register scan**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && grep -n -i 'TBD\|TODO\|later\b\|tbd' .claude/DESIGN.md; grep -c '' .claude/DESIGN.md
```
Expected: no matches from the first grep (the word `later` is allowed only in "recorded here so the next reader…" style sentences — inspect any hit); a line count between 380 and 560 — §8 alone should be 220–400 lines, the dashboard's §8 is 287.

- [ ] **Step 2: Spec coverage by number**

For each number in spec §2.2's daylight table, §2.3's type table, §3.4's card, §4.1's live card and figure strip, §6.1's modal geometry: confirm it appears in `.claude/DESIGN.md` verbatim. Run the three `node -e` checks from tasks 2, 4 and 5 again; each must print `ALL PRESENT`.

- [ ] **Step 3: Confirm the working tree is clean and the commits are on main**

Run:
```bash
cd /Users/andrejajevtic/Documents/custom-projects/backlog-manager && git status --short && git log --oneline -6 && git branch --show-current
```
Expected: empty status; six `docs(design)`/`docs:` commits above `f2ce61f`; `main`.
