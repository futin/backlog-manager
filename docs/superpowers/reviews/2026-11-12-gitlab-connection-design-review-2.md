## Verdict: APPROVE WITH FIXES

Reviewed: `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` at `4c1b5701` (after review 1's fixes). No Critical findings; 12 Important,
14 Minor. "doc:N" below is a line of that spec.

## What this proposes

The server gets a read-only link to one self-hosted GitLab site, set per machine with `BM_GITLAB_SITE` and `BM_GITLAB_TOKEN` (`read_api`). A new
`server/src/gitlab/` module works out which GitLab project each repository in `jira.json` belongs to from its `origin` remote, sweeps those
projects' merge requests every two minutes into an in-memory cache, and ties each MR to the Jira keys found in its source branch or title with the
existing `keysInBranch` matcher. The client reads that cache once and draws each ticket's "lead" MR as a Delivery pane in Detail, a chip on shelf
and deck cards with totals on the band line, and a Delivery column in the List, plus one three-way quick filter and a GitLab row on the Sources
card. A sub-task with no MR of its own shows its parent's, marked `via <PARENT-KEY>`. CodeRabbit and every GitLab write are left to project 2.

## How the existing system works, per this document

The Jira board already links a ticket to sessions and worktrees by matching branch names against keys (`shared/jira-branch.ts`), and `jira.json`
maps each Jira project to local repository paths, but nothing is known after the push. GitHub and Jira credentials are read from the environment
per call, never cached and never sent to the browser; each has a server poller with an in-memory cache whose age is drawn, and the Sources card
shows one `SettingsRow` with a `StatusPill` per source and a `Read again` that sweeps both. The server runs git only through `runGit`, read-only
and bounded at 10 s. The Board page is an agent deck over status shelves, with a List of the same folded tops and panel filters stored under
`JIRA_FILTERS_KEY`; a filter keeps a top when it or anything folded under it matches. CLAUDE.md names three outbound-calling modules and three
caches whose age is rendered, and pins linked headlines byte-equal to their rule-file copies.

## Facts checked and found true

- doc:120-123 — `branchCarriesKey` / `keysInBranch` and all five example names (`shared/jira-branch.ts:59-88`).
- doc:129 — `type.subtask` and `parent` exist on `JiraIssue` (`shared/types.ts:775`, `:781`); the `Run on` condition is the same one
  (`.claude/DESIGN.md:612`).
- doc:81-83 — the Sources row shape: `SettingsRow` + `StatusPill`, `CARD_WORD` (`client/src/components/settings/SourcesGroup.tsx:148-158`, `:181`).
- doc:99-100 — the foot treats a sweep's 409 as nothing to sweep (`SourcesGroup.tsx:84-99`).
- doc:148-149 — a repos save calls `JiraLiveService.reposChanged` (`.claude/rules/jira.md:25`; `server/src/jira/live.service.ts:343`).
- doc:146-147 — the tracker poller's arm/disarm shape and its three `arm()` callers (`.claude/rules/tracker.md:77-79`).
- doc:158-160 — the headline sits in CLAUDE.md:108 and `.claude/rules/tracker.md:84`, pinned byte-equal (`.claude/rules/tests.md`, first bullet).
- doc:164 — the outbound-modules bullet (CLAUDE.md:159).
- doc:107 — `remote get-url` is one of `runGit`'s read verbs (`.claude/rules/security.md:16-18`).
- doc:229-230 — a deck card has no foot, Run menu or worktree chip, and can stand for a folded child
  (`client/src/components/jira/JiraAgentDeck.tsx:65-106`).
- doc:227 — the shelf card's foot order: repo, match marker, worktree chip, `Run` (`client/src/components/jira/JiraCard.tsx:162-179`;
  `.claude/DESIGN.md:608`, `:614`).
- doc:213 — Detail's Agent column is a sessions band, then History (`.claude/DESIGN.md:624`).
- doc:257-258, doc:261 — `JIRA_FILTERS_KEY`, `clampJiraPanelFilters`, `foldMatches` (`client/src/lib/jira.ts:697`, `:704`, `:373`).
- doc:49-50 — `https://gitlab.timify.io` answers 301 to `https://www.gitlab.timify.io:443/`; `https://www.gitlab.timify.io/api/v4/user` answers 401
  unauthenticated (both fetched).
- Mocks read: `Cards.dc.html`, `List.dc.html`, `OptionC.dc.html`, `Settings.dc.html`. The chip words of doc:199-205 match `Cards.dc.html`; the List
  words match `List.dc.html`.
- Not verifiable from the repo: doc:12-13 (this machine's `jira.json`), doc:114-115 (`mr-review-loop` is not in this repository), doc:239 ("the
  existing band-line rule" for a zero part — not located).

## Critical

None.

## Important

1. **doc:194-195 vs doc:206 — a closed MR's Pipeline step has two readings.** The prose says "Pipeline status is not read for merged or closed MRs,
   so their Pipeline step is drawn as reached without a word"; the table's closed row draws the track `on · on · off · Closed end`, Pipeline `off`.
   Fix: pick one (the table's `off` is the honest one — nothing says a closed MR's pipeline was reached) and make the sentence say merged only.

2. **doc:94-95, doc:112-113 — two per-repo lines `runGit` cannot tell apart.** The spec wants `<repo basename>: no origin remote` and
   `<repo basename>: could not read origin` as different lines. `runGit` answers `null` "for every failure alike (timeout, non-zero exit, spawn
   error, oversized output)", stderr dropped, and the rule adds "No call site grew a new branch for a timeout and none may"
   (`.claude/rules/items.md`, the `runGit` bullet; CLAUDE.md:117). A missing `origin` is a non-zero exit, so both cases arrive as the same `null`.
   Fix: one line for both (`<repo basename>: could not read origin`), or name a second read that separates them (`git remote` exits 0 and lists
   nothing) and say so.

3. **doc:85-91, doc:96-98 — the state table misses three states the server will be in.** (a) Configured, identity read not yet answered: the
   read starts at boot (doc:78), and until it lands no row applies. (b) A 401 on a sweep's project call after a good identity read — a token
   revoked or expired mid-run. The identity is re-read only at start or on a config change (doc:78-79), and "the identity read alone decides
   `rejected`" (doc:96), so the row stays green `connected` with every sweep failing and only 403/404 has a line (doc:93-94). (c) A 429 window
   (doc:141-142) has no pill, no hint and no say on whether the sweep counts as failed for "known" (doc:178-182). Fix: a row or a rule for each;
   for (b) the simplest is that a 401 on any call re-runs the identity read.

4. **doc:90-91 vs doc:97-98 — the hint prints a scope the server never checked.** Both the `idle` and `connected` hints read
   `<username> · <site> · read_api`, while doc:97-98 says "The server does not guess scopes". A token created with `api` would be labelled
   `read_api`. The Jira banner's rule for the same case is "scopes are not served and are not drawn" (`.claude/DESIGN.md:640`). Fix: drop
   `· read_api` from the hint, or name the call that reads the token's scopes.

5. **doc:138-139, doc:197-206 — the pipeline vocabulary is not GitLab's whole list.** The spec names `success`, `failed`, `running`/`pending`,
   `canceled` and none. GitLab also answers `created`, `waiting_for_resource`, `preparing`, `scheduled`, `manual`, `skipped` and `canceling`;
   `manual` (a pipeline blocked on a manual job) and `skipped` are common. None has a row, a word or a tone, and none says whether it counts for
   the `Pipeline failing` filter. The MR state `locked` (review 1's Minor) is still unmapped at doc:135. Fix: one row per status, or a stated
   fold (e.g. `created`/`waiting_for_resource`/`preparing`/`scheduled` read as `running or pending`; `manual`, `skipped`, `canceling` each named),
   plus "any other value reads as none"; `locked` reads as `opened`.

6. **doc:199 vs doc:238, doc:254 — a draft MR with a failed pipeline.** The table's draft row is "any" pipeline → grey `draft`, no pipeline mark.
   The `Pipeline failing` filter is "the lead MR … is opened with a failed pipeline" and the band's `failing` is "the opened ones whose pipeline
   failed", with "drafts … included" said only for `open`. Read literally, the filter returns cards whose chip says grey `draft`, and the band
   counts a failure no card shows red. Fix: say whether a draft counts as failing; if it does, the draft row needs the failed case drawn.

7. **doc:183-185 vs doc:259-260 — the filter's visibility still has two rules.** §7 says the surfaces, filters included, exist "while GitLab is
   configured and the poller is armed". §7.4 says the filter is "Not drawn while GitLab is not configured; a stored value then reads as `all`". In
   `idle` (configured, not armed) the first hides the filter and the second draws it, and a stored `Has MR` is not said to read as `all` — with
   the control hidden, it would empty the board and the List with nothing on screen to clear it. Fix: §7.4 uses §7's condition, and a stored
   value reads as `all` whenever the control is not drawn.

8. **doc:136, doc:178-182 — a project past the page cap is "known", so a truncated list prints a no-MR claim.** A project that exceeds the cap
   shows `first N shown` on the Sources row only (doc:95). Its sweep still succeeded, so every ticket in it is known, and one whose MR fell past
   the cap reads `no merge request for <KEY> in <repo> in the last 30 days` (doc:218) and `no MR` (doc:246). Review 1's Important 3 named the cap;
   only the 30-day half was fixed. Fix: state the read order (opened first, then merged/closed newest first) and what a no-MR ticket in a capped
   project draws — unknown, or copy that names the cap.

9. **doc:160-162 — the new rule file's bullet needs an anchor of its own, and the spec names none.** `test/claude-rules.test.ts` holds "one home
   per anchor" and "each [bullet] citing at most one anchor, an unanchored one at most 80 words" (`.claude/rules/tests.md`, first bullet). The
   renamed four-caches anchor already has its home in `.claude/rules/tracker.md:84`. A `gitlab.md` bullet that links the same anchor is a second
   home and turns the suite red; an unanchored one cannot hold the mechanism in 80 words. Fix: name the new `invariants.md` heading the
   `gitlab.md` bullet links (the GitLab token and poller rule is the natural one), and say whether CLAUDE.md gets its headline — CLAUDE.md is
   under a byte budget.

10. **doc:214-216, doc:240-241 — three ages have no source.** (a) The track draws "each step's word and, where known, its age"; the mock shows
    `Pushed 2h` and `MR open 2h` (`OptionC.dc.html`), but created-at is not among the fields read (doc:138 lists updated-at and merged-at only),
    so no step but Merged has a timestamp. (b) Detail's `polled <age>` (doc:214) does not say which project's `polledAt` — the lead MR's, or the
    oldest across the ticket's projects as the band does; review 1's Important 11 asked. (c) The band's "oldest `polledAt` among the projects the
    board's tickets map" (doc:240) is undefined when one of those projects has never been read. Fix: add created-at to the field list or drop the
    two ages; name Detail's `polledAt`; say what the band prints when a project has none.

11. **doc:180, doc:91, doc:218-219 — two place names in user-facing copy are not the app's.** `GitLab could not be read — Settings › Sources`
    points at a page that does not exist: the card is `Sources · this machine` on Settings › Shared (`SourcesGroup.tsx:19`, `:111`). The connected
    hint's `N repos mapped via Jira › Repositories` is the mock's wording (`Settings.dc.html`); the app's own copy for that place is
    `Jira › Setup › Repositories` (`.claude/DESIGN.md:610`, `:626`). Fix: `Settings › Shared › Sources` and `Jira › Setup › Repositories`, and note
    the second as a mock difference.

12. **doc:141-151 — concurrent sweeps are not specified.** Three things can start a sweep or an `arm()` at once: the timer, `Read again`'s route,
    and a repos save. Not said: whether a sweep request during a sweep in flight joins it or starts a second, whether the route answers after the
    sweep or at once (the foot re-reads every context as soon as the POST answers, `SourcesGroup.tsx:91-98`), and whether the timer is a
    `setTimeout` chain re-armed after the sweep ends (review 1's Minor; the Jira and tracker pollers' shape, `.claude/rules/jira.md:39`,
    `.claude/rules/tracker.md:77`). Two overlapping sweeps can each write the cache, the older last. Fix: one sweep in flight, later callers join
    it; the route awaits it with a bound; a `setTimeout` chain.

## Minor

- doc:81-82 vs doc:87 — "a `StatusPill` whose word is the card's own `CARD_WORD` for its tone" does not hold for the `not configured` row: grey in
  `CARD_WORD` is `not polled yet` (`SourcesGroup.tsx:181`); `not configured` is the Jira row's literal (`SourcesGroup.tsx:151`). The table is
  right; the sentence should say so. The `checking…` / `unavailable` words the other rows draw before the client's first answer are also unsaid.
- doc:76-77 — the status "carries the site and the identity only", yet the row needs the state, the repo count, the per-repo lines and the hosts
  found. "Never the token" is what is meant.
- doc:151 vs doc:67, doc:78-79 — "An env change needs a restart anyway" sits beside "read … again when the configured token or site changes
  (noticed on the next status read or sweep)". One of the two is unreachable.
- doc:99-100 — the foot's `Last read` is "when all three sources last answered" (`SourcesGroup.tsx:55-57`, `:168-171`); whether GitLab's answer
  joins that minimum is not said (review 1's Important 6 asked). `SweepService` is `'github' | 'jira'` (`client/src/lib/sweep.ts:11`) and
  `refusalText` names the service, so the plan should count that type among the edits.
- doc:106-116 — two `jira.json` paths resolving to one GitLab project (two clones, a linked worktree): say the project is swept once and which
  basename the copy uses.
- doc:125-126 — a title that only mentions another ticket ("follow-up to TIMIFY-99") links the MR to it, against doc:54. Review 1 asked for one
  sentence saying it was weighed; still absent.
- doc:138, doc:213 — the MR's web URL from GitLab becomes an href. Building it from the site, the project path and the iid would keep §4's "the
  server builds every GitLab URL" true for links too, or route it through an `http(s)`-only parse (`.claude/rules/board.md`, the `linkBase`
  bullet).
- doc:176 — "a tie goes to the project path" has no direction (ascending?).
- doc:227-228, doc:232 — with the worktree chip, the MR chip and `not merged` on one foot, which ellipsises first is not said; nor whether a deck
  card draws `not merged`.
- doc:236-237 — "after the panel filters" does not say whether the Delivery filter itself narrows the totals.
- doc:88 — `— <GitLab's message, if any>`: say the dash goes with the message when there is none.
- doc:199 vs `List.dc.html` (the TIMIFY-150 row) — the mock's draft track is `on · off · off`; the table's is `on · grey · off`. Not called out.
  The List mock also omits the live table's other columns and carries a footnote line, as review 1 noted.
- doc:163-166 — CLAUDE.md's Layout line (CLAUDE.md:44) lists the server modules and needs `gitlab/`; CLAUDE.md's byte budget
  (`.claude/rules/tests.md`) is worth a word, since two bullets grow and a table row is added.
- doc:214, doc:236 — the mocks write `polled 2m`; the live words are `pollAge`'s (`SourcesGroup.tsx:171`). Say `pollAge` wins.

## Checklist summary

1. Facts: one does not hold against the code (Important 2); the rest checked true or marked unverifiable above.
2. Contradictions: Important 1, 4, 6, 7; Minor on `CARD_WORD` and the restart sentence.
3. Edge cases: Important 3, 5, 8, 10, 12; Minor on duplicate projects.
4. Copy and mocks: Important 11; Minors on the draft track and age words.
5. Scope: out-of-scope items are named (§3, §9); nothing in scope depends on project 2 — the Review step is explicitly not drawn (doc:189-190).
6. Hard rules: token, `/api`, CSP, read-only git and the amended headlines are handled; the gaps are Important 2 (`runGit`'s one failure branch)
   and Important 9 (one anchor, one rule-file home).

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 2-1 | FIX | §7 prose now: merged reached, closed `off`, matching the table. |
| 2-2 | FIX | `.claude/rules/items.md:83` — `runGit` answers `null` for every failure; one line `could not read origin`. |
| 2-3 | FIX | §5.2 adds `checking` and `rate-limited` rows; a 401 on any call re-runs the identity read. |
| 2-4 | FIX | `.claude/DESIGN.md:640` "scopes are not served and are not drawn"; `· read_api` dropped from hints, noted as mock difference. |
| 2-5 | FIX | §6.3 folds every pipeline status into five, unknown → none; `locked` → opened. |
| 2-6 | FIX | §7 "A draft is never failing"; band and filter exclude drafts. |
| 2-7 | FIX | §7 / §7.4: controls drawn under configured+armed; otherwise stored value reads `all`. |
| 2-8 | FIX | §6.3 read order opened-first; capped project → unknown with its own Detail line. |
| 2-9 | FIX | `.claude/rules/tests.md:11-12` one home per anchor; §6.4 names a new invariants.md section and CLAUDE.md headline for `gitlab.md`. |
| 2-10 | FIX | created-at added to fields; Detail ages and `polledAt` named; band reads `GitLab: not read yet` for a never-read project. |
| 2-11 | FIX | `SourcesGroup.tsx:18` Settings › Shared; `.claude/DESIGN.md:626` Jira › Setup › Repositories; copy corrected. |
| 2-12 | FIX | §6.3 one sweep in flight, joined; route awaits with a bound; `setTimeout` chain. |

Round limit for a spec reached (2); stopping.
