# Review 1 — `docs/superpowers/specs/2026-10-15-jira-integration-design.md`

**Date:** 2026-10-15 · **Reviewer:** fresh subagent, checklist-driven · **Companions read:** `2026-10-15-jira-mockups/00-mock-audit.md` and all ten HTML mocks

## Verdict: REVISE

Three Critical findings: the prompt budget is twice what the dashboard accepts, so Start fails *after* writing to Jira; the Setup and Board pages carry
in-page controls that switch the Jira page, which §6.1 and the §13 invariant forbid; and `dispatch-jira` accepts an action from the request body, which
contradicts a CLAUDE.md headline the spec never widens. Most of the Important findings are edge cases the spec leaves to the implementer, with one false
widening of an existing invariant among them.

Line numbers are the spec's unless a file is named.

---

## Critical

**C1 — L76–78, L261: the prompt is trimmed to 8 000, but the dashboard refuses anything over 4 000.**
`PROMPT_MAX = 8_000` (`server/src/agents/agents.service.ts:101`) is this server's own sanity cap. Its header comment (`agents.service.ts:90–100`) records
that the peer's real cap is `PROMPT_CAP = 4000` (`../claude-agents-dashboard/server/lib/spawn.ts:66`). Over that cap the dashboard answers 400 rather
than truncating (`spawn.ts:169–170`). §3 trims every Jira prompt to 8 000 by cutting the description, so a ticket whose prompt lands between 4 001 and
8 000 characters passes the trim. §7 (L212–214) then runs assign → transition → spawn in that order, so the ticket is assigned and moved, and only then is
the spawn refused. Jira descriptions this long are common, and the cut exists precisely for long descriptions. The test case at L261 ("the 8 000 cut") pins
the wrong number.
→ Budget the Jira prompt against the dashboard's cap (4 000, with a note that it is the peer's figure and not published on `/api/health`). Alternatively,
check the composed length before any Jira write and refuse with 400 before assigning. Fix the `jira-prompt` test value to match. Copy prompt may keep a
larger budget, but then the claim that the preview is "byte-for-byte what the session receives" (L77–78, L114) needs the same correction.

**C2 — L180 and L162 vs L143–145 and L296: in-page controls switch the Jira page, which the spec forbids.**
§6.1 says the two pages are "switched by the rail's sub-nav tree ALONE … No in-page control switches them, at any width", and §13's board.md headline
repeats it. §6.4 gives every Boards row an `Open board` control that "switches the Jira page to Board with this board picked". §6.2's empty state draws
"`No boards yet` with a chip to Setup". Both are in-page controls switching between the section's two pages. The existing precedent is Settings' `Live
view` link (`client/src/App.tsx:162–176`), which crosses sections (Settings → Runs › Watchdog) and never switches between the pages of one section.
→ Either drop the two controls, or carve them out in §6.1 and in the §13 headline. A possible wording: "no in-page toggle; a navigation link that picks a
board or opens Setup is allowed, routed through the same setter the rail calls". Whichever you choose, the invariant must be true on the day it ships.

**C3 — L99, L132: `dispatch-jira` accepts the action, contradicting CLAUDE.md's "Dispatch derives the action; it never accepts one."**
CLAUDE.md:188 states this rule, with its mechanism in `.claude/rules/dispatch-watchdog.md:15–17`, which is scoped to `server/src/agents/**`, where
`dispatch-jira` will live. `JiraDispatchRequest.action: JiraAction` is taken from the body and is only checked as being a built-in or a known skill id. A
Jira ticket has no derivable action, so accepting one may be right, but §13's "Widened, not added" paragraph (L299–300) lists two widenings and not this
one. As written, the new route breaks a CLAUDE.md headline.
→ Add this rule to §13's widenings. A possible wording: "Dispatch derives the action for a backlog item; a Jira dispatch takes it from a closed set,
built-ins plus `jira.json` skills, validated server-side". Name the mechanism home (dispatch-watchdog.md).

---

## Important

**I1 — L300, L250: "every spawn prompt is composed server-side" is false for the existing item dispatch.**
`POST /api/agents/dispatch` takes `req.prompt` from the client (`agents.service.ts:424–428`), and the launch sheet's prompt is an editable textarea
(`client/src/components/board/LaunchSheet.tsx:158`). The rule file says so outright: "The prompt is the only client field taken outright"
(`dispatch-watchdog.md:16`). The invariants entry calls dispatch's prompt "a client-editable default … by design".
→ Widen it to "the orchestrate and Jira spawn prompts are composed server-side", and keep item dispatch named as the exception.

**I2 — L77–78, L114 vs L212: the "byte-for-byte" preview is broken whenever Assign or Move is on.**
The ticket block carries status and assignee (the Dispatch mock's preview reads "story · Backlog", and "currently unassigned" sits beside it). Start writes
the assignee and the status first and spawns second. Compose the block after the writes and the session gets text that differs from the preview. Compose it
before and the session is told a stale status.
→ State when the block is composed relative to the writes, and narrow the byte-for-byte claim to match. A description edited in Jira between the preview and
Start is the same gap.

**I3 — L45–48: jira.json does not follow tracker-sync.json's write contract "to the letter".**
`writeSyncInterval` merges one key into the raw parsed file and keeps every other key, invalid ones included (`server/src/tracker/sync-config.util.ts:94–96,
125`). `writeJiraConfig(next)` writes a whole config. With "each malformed part falls back on its own" on read, the next save after a hand edit silently
deletes the malformed board, repo list or skill. That is #270's failure, moved down from the file to the entry. "Part" also has no stated granularity: is it
the whole `boards` array or one board?
→ Define the part as one entry (one board, one project's list, one skill). The writer should merge the change into the raw parsed file and keep entries it
cannot validate. Say which state a parsed non-object file is in (tracker-sync replaces it).

**I4 — L122, L251: under `docker:up`, "an existing directory at save time" refuses most checkouts.**
The server container mounts only `${BM_PROJECT_ROOT:-~/Documents/custom-projects}` (`docker-compose.yml:167`). A checkout anywhere else exists on the host
but not in the container. That covers `~/Documents/timify-projects` and the mocks' `~/work/payments-api`, so the save is refused with a misleading "not an
existing directory". The server never reads the repository, and the dashboard's visibility gate at dispatch is the check that matters.
→ Drop the existence check (keep "absolute"), or name the container case in the refusal and in the Repositories hint (point at `BM_PROJECT_ROOT`).

**I5 — L68–70, L293: a Done window keyed on `resolutiondate` alone gets both directions wrong.**
Workflows that never set a resolution, which is common in team-managed projects, leave Done issues with a null `resolutiondate`, so they never leave — the
pile-up the window exists to stop. Workflows that reopen without clearing the resolution leave an open issue with an old `resolutiondate`, and the window
drops it from To Do or In Progress.
→ Apply the window only when `statusCategory = done`, and name a fallback for a null `resolutiondate` (for example `statuscategorychangedate`). Add both
cases to `jira-map-issue`'s test list.

**I6 — L151 vs L68: the Done window has two homes.**
§3 says "The Done window lives here" (`map-issue.ts`). §6.1 puts "the Done-window predicate for tests" in `lib/jira.ts`, which is described as the ONE home
of every derivation. No client surface consumes that predicate, and `jira-lib`'s test list (L263) does not name it. Where `JIRA_DONE_WINDOW_DAYS` lives is
also unstated.
→ Keep one implementation (in `shared/` if both sides need it, otherwise server only) and drop the client copy.

**I7 — L89–90 vs L160–161: the card draws data `JiraIssue` does not carry.**
The crumb is `↳ PAY-120 Refund flows` (parent key *and summary*) and the marker row has `N subtasks`. `JiraIssue` has only `parent key | null` and no
subtask count. A query result's parent is often not on the board, so the summary cannot be looked up client-side. Jira's search returns
`fields.parent.fields.summary` and `fields.subtasks`.
→ Make it `parent { key, summary } | null` plus a `subtasks` count, or `{ total, done }` if the mock's "1 of 3 subtasks done" is wanted. Add both to the
fixed field list.

**I8 — L111, L247–248, L294: free text goes into JQL with no escaping rule.**
`summary ~ "q*"` interpolates the user's search text. A `"` or `\` in `q` breaks the query or splices in JQL, and JQL text search also reserves `+ - & | !
( ) { } [ ] ^ ~ * ? \ :`. §10 and the §13 headline cover keys only.
→ Specify how `q` is escaped (or how its reserved characters are stripped) before it is quoted, and extend the JQL invariant to "every value the server puts
into JQL".

**I9 — L141–142: `resolveSection` runs before `GET /api/jira` can answer.**
`resolveSection` is pure and runs once, in `AppShell`'s `useState` initializer (`client/src/App.tsx:46, 83`). "Treats `jira` as unrecognised while it is not
configured" therefore resolves a stored or landing `jira` to Board on every load, because the status is unknown at first paint. A configured machine never
reopens on Jira. Separately, `LANDINGS = ['last', ...SECTIONS]` (`client/src/lib/settings.ts:277`) offers "Opens on: Jira" on machines with no Jira at all.
→ Say whether the shell holds the section until `/api/jira` answers, or renders Jira optimistically and falls back. Say whether the Opens-on option is
filtered while unconfigured.

**I10 — L61–62 (and the mocks): what `off` means for a Jira board is unstated, and "re-aimed" is undefined.**
For GitHub, `off` means one cold-boot sync per process (`shared/types.ts:509–511`), and the poller stays armed until that sync is done. The Jira poller is
"armed only while … some board's interval is not `off`", and its cache is memory-only. Read literally, an `off` board, or a machine whose every board is
off, is empty after every restart. The mocks show "sync off · 0 issues · last polled 2 h ago". The sheets promise "polled again right after you save" and
"Polled right after you create it", while §5 only says "the poller is re-aimed".
→ State `off` as GitHub's (one cold sync per boot) or as something else. Define "re-aimed" as an immediate sweep of the saved board, if that is the intent.

**I11 — L64–65, L156: roots are fetched in one batch, but failures are reported per root.**
One `key in (…)` call fetches every root, and JQL rejects the whole query when one key no longer exists or cannot be seen. So one deleted or moved-away root
blanks every root on the board, while §6.2 and the audit (`00-mock-audit.md:38`) promise "a query or root that failed" is reported individually. The
"capped at 200 per root" rule can't be enforced on a batched `parent in (…)` either, and the 500-issue truncation (L65) does not say which issues survive.
→ Say how a failing root is isolated (retry per key on a 400, or per-root queries), how the per-root cap is applied, and the truncation order (for example
by `updated` descending, the card sort).

**I12 — L213 vs L126, L221–229: the error mapping for a Jira write inside `dispatch-jira` contradicts itself.**
§7 says a failed Jira write is "a 502 naming the step". §5 and §8 make "transition not offered" a 400, and 401 and 429 a 503. A partial write (assign
succeeded, transition failed) is not covered either: "the writes stand" is only stated for a failed spawn.
→ Give one table for `dispatch-jira`: per step, per Jira status → HTTP status and text. State that an earlier successful write stands when a later step fails.

**I13 — L132, L80–81: nothing stops two dispatches of one key.**
The live-session 409 is checked before assign → transition → spawn, which takes seconds, and the live map is written only after a successful spawn. A
double-click or two tabs pass the check together and start two sessions. The second transition may also fail as "not offered". Item dispatch has the claim
protocol as a backstop; Jira has nothing.
→ Reserve the key (a starting entry in the live map, or an in-flight set) before the first write. Release it on any failure.

**I14 — L214–215, L146–147: the live strip may not appear "on the next poll" for a minute, or at all.**
`live` rides in `GET /api/jira`, whose client timer aims at the soonest board's next poll (default `1m`). If it copies `useTrackers`, it has no timer at all
when no board syncs (`client/src/hooks/useTrackers.ts:20`). `useJiraBoard`'s 15 s poll reads `boards/:id/issues`, which does not carry `live`.
→ Refetch `GET /api/jira` when Start or Stop succeeds, or carry each issue's live entry in the board payload.

**I15 — L319 (P12): the session-status question is already answered by the code.**
`dashboardSessionStatus` reads per-session `status` from the dashboard's `GET /api/sessions` (`server/src/agents/agents.service.ts:1969–1980`), and
`ItemsAbortService.abort` already uses it (`server/src/agents/items-abort.service.ts:105`).
→ Record the answer in P12, and decide in this spec whether phase 5 reconciles the live map against it rather than relying on the 8 h expiry.

**I16 — L72, L228: the identity and 401 lifecycle is underspecified.**
"`GET myself` once per boot (and again after a 401)" leaves three gaps:
- No retry when the boot-time call fails as `unreachable` (`me` stays null).
- No answer on whether sweeps continue while `access` is `unauthorized`, which re-sends bad credentials every tick until a restart.
- No account of what `me: null` does to `Assign to me`, the `Assigned to me` crumb and the assignee filter.

Loops are possible too: a 401 triggers `myself`, which 401s.
→ State the retry cadence, whether the poller disarms on 401 until restart, and the `me: null` behaviour on each surface.

**I17 — L236: `jira.mjs` has no exit code for the server's 5xx answers.**
Exit `5` covers stack down, `2` covers "the server's 4xx" and `1` covers usage. The 503 answers this design defines (unconfigured, unauthorized,
rate-limited) and the 502s (a Jira write failed) map to nothing, and "unconfigured" is the likeliest state on a machine that has the plugin but no
`BM_JIRA_*`.
→ Map 5xx explicitly (for example to `2` with the server's message), and make "Jira not configured" its own sentence.

**I18 — L272–278 vs L280–281: the phases leave gaps and contradict the docs rule.**
`POST /api/jira/boards`, `boards/delete` and `repos` are in no phase: phase 1 is reads only and phase 3 is assign/transition. Phase 2's board sheet and
Repositories card cannot save without them. Phase 1 also lands "CLAUDE.md and invariants entries for §13's server rules", and those include the writes and
splice (phase 3), `jira.mjs` (phase 4) and the live map (phase 5). That contradicts L280–281: "every phase lands its own docs … with the mechanism it
introduces".
→ Put the config write routes in phase 2 (or 1), and land each §13 rule with the phase that builds its mechanism.

**I19 — L167: a second `Modal` composer contradicts DESIGN.md §8.7 and the Escape invariant's text.**
DESIGN.md §8.7 says the item modal is "the only modal anywhere in this app … and none is added here" (`.claude/DESIGN.md:394`). `invariants.md` says §8.7
"keeps `Modal` to one composer" and counts three dialogs (`docs/subsystems/invariants.md:1694, 1698`), and `.claude/rules/board.md:9` names the three.
This design adds `JiraIssueModal`, `JiraLaunchSheet` and `JiraBoardSheet`.
→ List the DESIGN.md §8.7 change and the dialog-count updates (rule bullet, invariants, `dialog-escape` test) in §12's phase docs.

**I20 — L73, L244–252: untrusted ticket text goes into a write-capable session's prompt, and §10 says nothing about it.**
The ticket block embeds the description and subtasks verbatim. Any colleague, or an external reporter, can write those. The existing `composePrompt` collapses
even a one-line title for this reason (`server/src/agents/prompt.util.ts:25–33`). Skill templates also interpolate `{summary}` and `{description}` with no
rule.
→ State in §10 how the block is framed: as data, delimited, with an instruction that its content is not instructions. State whether `{summary}` is collapsed
to one line, as `oneLine` does today.

**I21 — L246 vs L56: the format of `BM_JIRA_SITE` is ambiguous.**
§3 builds `https://<site>/rest/api/3/…`, which implies a bare hostname. §10 validates "`https`, a hostname with no path or query", which implies a URL. The
Connection mock shows `acme.atlassian.net`. How a Server/DC site is "reported in `detail` as unsupported" is also unstated, since a hostname check cannot
tell (Cloud sites can use custom domains).
→ Fix one format for `.env.example`, and name the detection (for example `GET /rest/api/3/serverInfo` → `deploymentType`).

**I22 — L186–187 vs L202: two behaviours for an unmapped project.**
The Repositories warning row says "`PAY cards draw no dispatch control`", and the Setup mock says the same. §7 says the chip "draws on every card", with
`no-repo` → dashed and a title.
→ Align the copy with §7. For example: "no repository yet — PAY cards can't start a session".

**I23 — L120–124: what "400 malformed" means for a board or a skill is not specified.**
The server-side rules are unstated for:
- an interval outside `isSyncInterval`;
- an empty name;
- zero roots and zero queries (only the client disables Create);
- an empty JQL string;
- who mints query ids (§3 mints only `b_`/`s_`);
- duplicate roots;
- an upsert carrying an id that no longer exists (deleted in another tab): create, or 404?
- delete of an unknown id;
- a maximum template length for skills (relevant to C1).

→ List the validations per route.

**I24 — L221–223: the splice can be overwritten by a stale sweep.**
A sweep already in flight when the write lands, or a sweep served by Jira's eventually-consistent enhanced search (which offers `reconcileIssues` for
read-after-write), can replace the spliced issue with its pre-write state. The card then snaps back until the next sweep.
→ Add this to P2 (does `search/jql` reflect a write at once, and does `reconcileIssues` exist?). Say whether the splice wins over a sweep that started before
it.

**I25 — L224–227 (P10 at L317): ADF `inlineCard` is probed but not handled, so smart links vanish.**
`inlineCard` is how Jira Cloud stores most pasted URLs. It has no text content, so under "an unknown node renders its text content" every smart link
disappears from the description.
→ Add `inlineCard` (and `blockCard`/`embedCard`) → `<url>` as a Markdown link to the handled list.

---

## Minor

- **L41–44:** §2 places the picked board id and the Jira page under "`client/src/lib/settings.ts`". They live in `usePersistedState` and
  `lib/jira-page.ts` (as §6.1 says, and as `backlog-manager.runs-mode` lives in `client/src/lib/runs-mode.ts:37`). Only `jiraDefaultAction` is a
  settings key.
- **L171:** "the one targeted improvement to existing code" overclaims. The design also hoists `stopSession`, promotes `SettingsRow` to `ui/`, hoists `Fact`,
  and widens `BoardColumnSlug` and `SECTIONS`.
- **L133:** the hoisted `stopSession`'s 502 text ends "— the claim is untouched" (`server/src/agents/items-abort.service.ts:136`). A Jira stop has no claim,
  so the hoist needs a parameterised tail.
- **L237 vs L73–74:** §9 says the execute prompt "ends with" the `jira.mjs transition` line, while §3 says every prompt ends with the ticket block. One is
  the built-in's text and the other the whole prompt; say so.
- **L75–76:** the existing dispatch prompts all end with `COMMIT_RULE` (`server/src/agents/prompt.util.ts:60–63`). The Jira `execute` built-in ("branch,
  implement, verify") is silent on committing; state the intent.
- **L76:** a skill template with `{description}` gets the description twice, since the block also carries it. Which copy the 8 000 (or 4 000) cut trims is
  unstated.
- **L114, L99:** `JiraAction` is `'execute' | 'context' | { skill: id }` in the body, a bare skill id in the setting, and an unspecified encoding in
  `GET /api/jira/prompt?action=`. Name the query encoding.
- **L67–68:** the sprint field's value is an array (an issue carried over sits in several sprints), but `sprint | null` is singular, with no rule for which
  one wins. Field discovery "once per boot" has no retry when it fails at boot.
- **L224:** ADF text needs Markdown escaping, or a literal `snake_case_name` or `*` in a description renders as emphasis.
- **L160:** "avatar" should say initials. A Jira `avatarUrls` image would be a browser request to Atlassian, against "the browser never talks to Jira" and
  the CSP.
- **L152, L190:** the CALLS reading's `/ 100` is unexplained. "No 429 today" and the Trackers mock's "1 refused today" need a count, and the payload carries
  only `last429At`.
- **L81:** the live map is "capped at 100" with no eviction rule (oldest first?).
- **L229:** "a write answers 503 with the retry instant" doesn't say whether a write inside a known back-off window is refused pre-emptively or only after
  Jira 429s it. L228's "every write 503" under 401 doesn't say whether config writes (boards, repos, skills) are included.
- **L157:** "`showing 500 of more`" reads oddly. Also, the band and row copy need a singular/plural rule (the mocks use "1 query" and omit "0 queries").
- **L169–170:** `Stop session` with agents off, `Assign to me` with `me: null`, and `runChipState` for a project with two mapped repos (which repo's gate
  decides?) are unstated. So is what the sheet does with a `disabled` (visibility) gate rather than a `hidden` one.
- **L290:** `jira.md`'s `paths` is `server/src/jira/**` only, but its token rule governs `jira.mjs` too. A session editing `skills/jira/tools/jira.mjs`
  gets `skills.md`, not this rule. Consider adding `skills/jira/**`. CLAUDE.md's "nine path-scoped files" count also changes.
- **L177, L154, L167:** CLAUDE.md requires every component to cite its DESIGN.md subsection. No DESIGN.md section for the Jira surfaces is planned in §12.
- **L45, L272:** `.env` works in the stack because the container's ConfigModule reads the bind-mounted `.env`. A key exported from the host shell (the user's
  `~/.zshenv` habit) won't reach the container without a compose passthrough, as `BM_GITHUB_TOKEN` has (`docker-compose.yml:109`). Worth one line in
  `.env.example`.
- **L256–266:** no test is listed for `jira-stop` (200 and 404 both clear the entry), for `useJira`'s timer, or for the Done-window cases in I5.
- **Mock differences not called out in the spec or the audit:**
  - The session name is `jira:PAY-131` in IssueModal and Dispatch, but the spec's `jira <KEY>` is right: the dashboard's
    `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` rejects `:`.
  - Dispatch's Move-to is preselected to "In Progress", where the spec defaults to `leave as is`.
  - BoardB's Done cards read "resolved Oct 11" where the spec says age.
  - BoardB draws a `root` crumb the spec does not list.
  - BoardB shows "1 of 3 subtasks done" where the spec says `N subtasks`.
  - BoardB has a "Sort: Updated (desc)" control the spec does not have.
  - BoardsTen sorts the Boards card "by name · off boards last", which the spec does not state.
  - BoardsTen still says "rows instead of tiles once there are more than four", and NewBoard's hint still says "the picker and the tiles".
  - The Connection mock asserts the token scopes as "all three", which the server cannot verify.
  - The Trackers mock's row copy differs from the audit's `site · N boards · intervals live on Jira › Setup`.
  - The spec gives no labels for the two built-ins. The mocks use "Work it end to end" and "Open with the ticket loaded".
- **Mock arithmetic:**
  - BoardB's In Progress header reads 5 over six cards (131, 132, 148, 133, 163, 160).
  - The band says 14 issues while 15 cards are drawn, and the root epic PAY-120 itself is not drawn at all, though roots are fetched.
  - BoardSheet says PAY-120 has "7 under it", but the board shows eight descendants (134, 140, 131, 128 and 136, 132, 133, 129).
  - RunMenu lists "Draft test plan" as a saved skill, while Setup shows it still in the unsaved add row.
- **Audit L25:** "nine imports updated" is wrong. Three source files import `./SettingsRow` (SettingsView, TrackersGroup, WatchdogGroup), and
  `test/settings-view.test.tsx:661` asserts the `./SettingsRow` import path by regex, so it will fail when the file moves.
