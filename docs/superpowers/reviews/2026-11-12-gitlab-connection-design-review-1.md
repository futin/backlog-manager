## Verdict: APPROVE WITH FIXES

Reviewed: `docs/superpowers/specs/2026-11-12-gitlab-connection-design.md` at `9e6f5419`. No Critical findings; 15 Important, 12 Minor.
"doc:N" below is a line of that spec.

## What this proposes

The server gains a read-only connection to one self-hosted GitLab site, configured per machine through `BM_GITLAB_SITE` and `BM_GITLAB_TOKEN`
(`read_api`). A new `server/src/gitlab/` module resolves each repository `jira.json` maps to a Jira project to a GitLab project through its `origin`
remote, sweeps that project's merge requests every two minutes into an in-memory cache, and links each MR to Jira ticket keys found in its source
branch or title with the existing `keysInBranch` / `branchCarriesKey` matcher. The client reads that cache through one provider and draws a
ticket's "lead" MR in three places: a Delivery pane in the Detail dialog's Agent column, a chip on board cards plus totals on the band line, and a
Delivery column in the List, with a three-way quick filter and a GitLab row on the Settings Sources card. A sub-task with no MR of its own shows
its parent's. CodeRabbit findings and any GitLab write are left to a second project.

## How the existing system works, per this document

The board already knows a Jira ticket's sessions and worktrees by matching branch names against ticket keys (`shared/jira-branch.ts`), and knows
which local repositories belong to a Jira project from `jira.json`'s `repos`, but knows nothing about what happens after a push. Credentials for
GitHub and Jira are read from the environment per call, never cached and never sent to the browser; each has a poller with an in-memory cache
whose age is drawn on the page, and the Jira poller stores one 429 window every caller checks. The server runs git only through `runGit`, read
only, bounded at 10 s. The Jira Board page is an agent deck over status shelves with a List view of the same folded tops, filters persisted
under `JIRA_FILTERS_KEY`, and a filter shows a top when it or anything folded under it matches (F1). CLAUDE.md names three outbound-calling
modules and three caches whose age is rendered, both of which this change must amend.

## Facts checked and found true

- doc:105-107 — `branchCarriesKey` / `keysInBranch` behave as described, including the four example names (`shared/jira-branch.ts:55-88`).
- doc:60, doc:64 — the `BM_JIRA_SITE` hostname rule and per-call, trimmed, never-cached reads (`server/src/jira/env.util.ts:30-53`,
  `server/src/tracker/token.util.ts:1-17`); `.env.example:124-139` and `docker-compose.yml:115-117` are the house style named.
- doc:41 — `closingRule` exists at `server/src/jira/prompt.util.ts:81`.
- doc:114 — `JiraIssue.parent` is `{ key, summary } | null` (`shared/types.ts:781`).
- doc:124 — the Jira poller's one stored 429 window (`server/src/jira/poller.service.ts:72-75`).
- doc:135-140 — both invariants exist as quoted (CLAUDE.md:108, CLAUDE.md:159; `docs/subsystems/invariants.md:3569`, `:4067`); no suite under
  `test/` mentions `outbound-calling`, so "no guard pins that list" holds.
- doc:143 — `PullRequestsProvider` is mounted once by the shell (`.claude/rules/board.md:155`).
- doc:158 — design guard 4 is the uppercase guard (`test/design-guards.test.ts:211`); `--magenta` and `--ink3` are palette tokens
  (`.claude/DESIGN.md:279-280`).
- doc:175-177 — the worktree chip sits on the foot before `Run ▾` and ellipsises first (`.claude/DESIGN.md:614`,
  `client/src/components/jira/JiraCard.tsx:128-179`).
- doc:195-199 — `JIRA_FILTERS_KEY`, `clampJiraPanelFilters` and F1's `foldMatches` (`client/src/lib/jira.ts:369-384`, `:697`, `:704`).
- doc:12 — `https://www.gitlab.timify.io/api/v4/user` answers 401 unauthenticated (fetched), so the host is a GitLab API.
- Not verifiable from the repo: doc:12-13 (what this machine's `jira.json` maps), doc:99-100 (`mr-review-loop` is not in this repo).

## Critical

None.

## Important

1. **doc:128-129 — the GitHub precedent is misquoted.** The spec cites "the GitHub poller's 'armed only while a client is connected' rule". No
   such rule exists: `TrackerPollerService` is "armed only while a registered project resolves to `github` AND a token is present"
   (`.claude/rules/tracker.md:77-78`), and the PR cache has no timer at all — it is read when a client asks (`.claude/rules/board.md:155`). A
   builder told to "match that precedent" has two different mechanisms to pick from and neither is the one named. Fix: name the precedent that is
   meant (most likely the PR cache's client-driven read) or drop the sentence and decide: timer-armed per doc:125, full stop.

2. **doc:135-137 — the "three caches" amendment names two of its three homes.** The headline is also a bullet in `.claude/rules/tracker.md:84`,
   and `test/claude-rules.test.ts` pins a linked CLAUDE.md headline byte-equal with its rule-file copy (`.claude/rules/tests.md`, first bullet).
   Amending only `invariants.md` and CLAUDE.md, as written, turns that suite red; the `invariants.md` heading is also the anchor both links use
   (CLAUDE.md:109). Fix: list `tracker.md`'s bullet and the anchor rename in the same sentence, and say which rule file is the home of the GitLab
   cache's mechanism.

3. **doc:167, doc:182, doc:189 — "not known" is drawn as "no MR".** The spec has three states for a ticket (has MRs / none / not drawn because
   unconfigured) but the cache has a fourth: unknown. Before the first sweep finishes, after a first sweep that failed (doc:130), while the token
   is `rejected` (doc:81), for a project in `no access` (doc:82), for an MR merged more than 30 days ago (doc:118) and past the page cap
   (doc:119), Detail would print `no merge request for <KEY> in <repo>` and the List `no MR` — statements the server cannot stand behind. Fix:
   define what each surface draws when a ticket's project has no successful sweep (nothing, or a `not polled yet` reading), and soften or scope
   the Detail sentence for the window and the cap.

4. **doc:167 vs doc:184, doc:189, doc:198 — the "idle" state is drawn inconsistently.** Detail's pane is not drawn when "no GitLab configured,
   or no mapped repo on the site"; the band line, the List column and the filters are "not drawn while GitLab is not configured" only. In the
   `idle` state of doc:85 the List would carry a Delivery column of `no MR` and a filter that can match nothing. The per-ticket case is missing
   too: a ticket whose Jira project maps no repo on the site while another project does (doc:167's `<repo basenames>` is then empty). Fix: one
   rule for all four surfaces, stated once in §7, plus the per-ticket case.

5. **doc:81 vs doc:82 vs doc:87 — 403 has two readings.** `rejected` is defined as "GitLab answered 401"; a too-narrow scope "reads as
   `rejected`", but GitLab answers that with 403 `insufficient_scope`, and a 403 on a mapped project is `no access`. Fix: say which call's
   status decides — e.g. 401 or 403 on the identity read is `rejected`; 403/404 on a project read after a good identity read is `no access`.

6. **doc:79-86, doc:203 — the Sources row's copy is not exact and the mock's shape is not the live card's.** Only `no token` has its sentence.
   `rejected` ("with the site named" — the mock reads `www.gitlab.timify.io answered 401 — token invalid or expired`), `no access`,
   `unreachable` ("its own sentence") and the per-repo notes of doc:97-98 (no `origin`, read failed) and doc:130 (last sweep failed) have none.
   The live card draws a `SettingsRow` with a `StatusPill` whose words are `connected` / `late` / `down` / `not polled yet` / `not configured`
   (`client/src/components/settings/SourcesGroup.tsx:150-154`, `:185`), not the mock's dot-and-username row, and its foot reads "when all three
   sources last answered" with a `Read again` that sweeps GitHub and Jira (`SourcesGroup.tsx:84-98`, `:171-177`). Fix: give each state's exact
   pill word and hint line in the live row's shape, say whether `no token` or the house `not configured` is the word, and whether GitLab joins
   `Read again` and the foot's age.

7. **doc:175-178 — the chip's place on a deck card is undefined.** The placement is "in the card foot, before `Run ▾`, after the worktree chip",
   and the chip is drawn "on both shelf cards and agent-deck cards". A deck card has no foot, no `Run ▾` and no worktree chip
   (`client/src/components/jira/JiraAgentDeck.tsx:68-102`), and it can stand for a session on a folded child (`FoldMark`,
   `JiraAgentDeck.tsx:11`) — which ticket's lead MR it shows is not said. Fix: name the deck card's slot and whose MR it draws.

8. **doc:175-177, doc:188 — the status-word table is incomplete and differs between surfaces without saying so.** Five chip words are listed.
   Missing: lead MR `closed`, pipeline `canceled`, pipeline `pending` (doc:121 groups it with `running` only for tone), an open MR with no
   pipeline, and a merged MR's Pipeline step, whose status is never read (doc:121). The List's "one status word" is not listed at all; the mock
   uses different words from the chip (`pipeline passed` vs `✓ pipeline`, `List.dc.html:41` vs `Cards.dc.html:43`) and replaces the word with
   `not merged` on a done ticket (`List.dc.html:53`), which §7.3 does not mention. Fix: one table — MR state × pipeline status → chip word, List
   word, tone, and each track step's state.

9. **doc:150 — "newest" has no key.** The lead MR is "the newest `opened` MR" among MRs that can sit in different GitLab projects, where `iid`
   does not compare. Created-at is not among the fields read (doc:120); updated-at moves on every comment. Fix: name the field (and the
   tie-break).

10. **doc:112-114 — who inherits is ambiguous.** The rule says "a sub-task", the mechanism says "the issue's `parent`". A story under an epic
    has a `parent` too (`shared/types.ts:775`, `:781`); read by the mechanism, every story would show its epic's MRs. Fix: say
    `type.subtask === true` (or the hierarchy level), and whether inheritance goes one level only.

11. **doc:183, doc:152, doc:245 — the band totals cannot be computed from the text.** Not said: whether `failing` is a subset of `open`,
    whether a draft or a `closed` lead counts anywhere, whether an inherited lead counts (two sub-task tops under one parent would count one MR
    twice), what is drawn when all three are zero, and which `polledAt` the single `polled <age>` shows when the board spans several GitLab
    projects (the cache is per project, doc:137; Detail's head at doc:163 has the same question). "The board's tickets" (doc:183) and "tops"
    (doc:152, doc:245) should be one word. Fix: define each count, the all-zero line, and "oldest of the projects involved" or similar.

12. **doc:194 — two of the three filters do not say how they treat an inherited MR.** `Done, not merged` excludes inherited MRs (doc:179-181).
    `Has MR` and `Pipeline failing` say nothing, so with doc:112 every sub-task under a story with an MR matches `Has MR`, and with doc:199 so
    does every top folding one. Also unsaid: whether a `closed` lead counts as `Has MR`. Fix: one sentence per filter.

13. **doc:125-126, doc:101, doc:76 — nothing re-evaluates arming while the poller is idle.** Mappings are "re-derived on every sweep", but in
    `idle` (doc:85) and before configuration no sweep runs, and the status read is "from memory and env" with no git call (doc:73). A repo
    mapped in Jira › Repositories after boot would then never arm the poller without a restart, against doc:101. The existing hook is a repos
    save calling `JiraLiveService.reposChanged` (`.claude/rules/jira.md:25`). Fix: name the trigger (the repos save, a status read, or a slow
    idle re-check) and keep it off the request path.

14. **doc:47-48, doc:97 — host matching is exact and silent, and the named site redirects.** A repo "whose host is not `BM_GITLAB_SITE`" is
    skipped silently. `https://gitlab.timify.io` answers 301 (fetched), so remotes cloned as `git@gitlab.timify.io:…` — or through an SSH alias
    or `ssh://host:port/…` — would not equal `www.gitlab.timify.io`, and the user would see `idle` with nothing saying why. Fix: state the
    comparison (case-insensitive, port ignored), and make the `idle` row name the hosts it did find, or say explicitly that a `www.` difference
    is a mismatch the row reports.

15. **doc:47-48, doc:119 — "the server builds every URL" does not by itself keep the token on the named host.** Two paths dial a URL the server
    did not build: a followed redirect (GitLab's `PRIVATE-TOKEN` header is not dropped on a cross-origin redirect the way `Authorization` is)
    and pagination that follows the response's `Link: rel="next"` URL. Fix: require redirects to be refused (a redirect is `unreachable`, with
    its target host named) and pages to be requested by number from the server's own base.

## Minor

- doc:186-190 — `List.dc.html:38` omits the live table's Type, Priority, Sprint and Run columns (`JiraIssueList.tsx:58-67`) and carries a
  footnote line (`List.dc.html:57`); neither difference is called out the way §7.2's is.
- doc:23-24, doc:201 — the card lives on Settings › Shared as `Sources · this machine` (`SourcesGroup.tsx:19`); "Settings › Sources" is not a
  page.
- doc:118 — GitLab has a fourth MR state, `locked`; say it reads as `opened` (or is ignored).
- doc:123 — say the sweep is a `setTimeout` chain so a sweep longer than two minutes never overlaps the next (the Jira and tracker pollers'
  shape, `.claude/rules/jira.md:39`).
- doc:110 — scanning titles can link an MR that only mentions another ticket ("follow-up to TIMIFY-99"), in tension with doc:51's "a false link
  is worse than a missing one". A design call; worth one sentence saying it was weighed.
- doc:162, doc:165 — the MR `web_url` becomes an href from remote data; `.claude/rules/board.md:169` routes the one other such value through an
  `http(s)`-only parse. Building the link from the site, project path and iid would also satisfy doc:47.
- doc:176-177 — with two words on the foot (worktree chip, MR chip) and possibly a third (`not merged`), say which ellipsises first.
- doc:163, doc:183 — the mocks write `polled 2m`; the live band writes `polled 12 s ago` through `pollAge` (`client/src/lib/jira.ts:483`,
  `:506`). Say `pollAge`'s words win.
- doc:138-141 — CLAUDE.md's Layout line (CLAUDE.md:44) lists the server modules and needs `gitlab/` too; CLAUDE.md is under a byte budget
  (`.claude/rules/tests.md`), worth a word since two headlines grow.
- doc:99 vs `Settings.dc.html:59` — the example project paths differ (`development/backend/microservice`, `development/dev-api-graphql-proxy`);
  harmless, but one of them is presumably not the real namespace.
- doc:99-100 — `mr-review-loop` is not in this repository, so "the same trick" cannot be checked from here.
- doc:195-196 — the comments on `JiraBoardFilters` say "the four panel filters" (`client/src/lib/jira.ts:665`); the plan should count that
  doc comment among the edits.

## Checklist summary

1. Facts: one false (Important 1), one incomplete (Important 2); the rest checked true or marked unverifiable above.
2. Contradictions: Important 4, 5; totals wording in 11.
3. Edge cases: Important 3, 8, 9, 10, 12, 13, 14, 15.
4. Copy and mocks: Important 6, 7, 8; Minor on the List mock and age words.
5. Scope: out-of-scope items are named (§3, §9); nothing in scope depends on project 2.
6. Hard rules: the token, `runGit`, `/api`, CSP and read-only-git rules are respected; the gap is Important 2 (the rule-file copy of an amended
   headline).

## Rulings

| id | outcome | evidence |
| -- | ------- | -------- |
| 1-1 | FIX | `.claude/rules/tracker.md:77` arms on project+token; no client-connected rule. Sentence replaced with the tracker poller's shape. |
| 1-2 | FIX | `.claude/rules/tracker.md:84` copy confirmed; §6.4 now lists all three homes, the anchor rename, and a new `gitlab.md` rule file. |
| 1-3 | FIX | §7 gains known vs unknown; Detail/List copy split; 30-day copy added. |
| 1-4 | FIX | §7 "Which tickets draw delivery at all" — one rule for all four surfaces. |
| 1-5 | FIX | §5.2: identity read decides rejected (401/403); project call decides `cannot read`. |
| 1-6 | FIX | `SourcesGroup.tsx:150,185` confirmed; §5.2 table in live SettingsRow/StatusPill shape with hint copy; Read again joins. |
| 1-7 | FIX | `JiraAgentDeck.tsx:68-102` confirmed no foot; deck chip on its own line, session's issue. |
| 1-8 | FIX | §7 state × pipeline table. |
| 1-9 | FIX | newest = `updated_at`, tie project path then iid. |
| 1-10 | FIX | `shared/types.ts:775,781`; sub-task = `type.subtask` + parent, one level. |
| 1-11 | FIX | §7.2 band totals defined. |
| 1-12 | FIX | §7.4 one sentence per filter. |
| 1-13 | FIX | `.claude/rules/jira.md:25` repos save → `reposChanged`; `arm()` called from bootstrap, repos save, sweep route. |
| 1-14 | FIX | §6.1 exact case-insensitive host match; idle row names hosts found. |
| 1-15 | FIX | §4 redirects refused, paging by number. |
