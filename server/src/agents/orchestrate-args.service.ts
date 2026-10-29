import { homedir } from 'node:os';
import { HttpException, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { ItemsService } from '../items/items.service';
import { scanProject } from '../items/scan.util';
import { BASE_BRANCH_SHAPE, resolveBaseBranch } from '../items/base-branch.util';
import { parseUrn } from '../tracker/map-issue';
import { runGit } from '../git-run.util';
import { mergeCheck as checkMergeCoverage } from './merge-check.util';
import { isItemId, isMergeMode, isQuestionMode } from '../../../shared/agent';
import { MERGE_MODES } from '../../../shared/types';
import type { AgentBranchesPayload, MergeCheckResult, MergeMode, QuestionMode } from '../../../shared/types';

/**
 * orchestrate-args.service.ts — the "is this orchestrate request legal" half of `POST /api/agents/orchestrate`: the resolvers `spawnOrchestrate` runs
 * over the request body (`resolveIds`, `resolveMergeMode`, `resolveQuestionMode`, `resolveBase`, with `resolveIds`'s tracker branch behind
 * `resolveTrackerIds` and `trackerRepoOf`), and the two reads behind the Orchestrate sheet, `branches` and `mergeCheck`, which `AgentsController`
 * calls directly.
 *
 * Moved out of `agents.service.ts` in #388 (#351), with no change to any check, wording or status. `AgentsService` still calls the four resolvers in
 * the same order, because that order is the refusal order the route answers in — this file decides what each check says, never which runs first.
 *
 * An injectable rather than a `*.util.ts` like `merge-check.util.ts`, because these read the registry and the item adapters, which are Nest providers: a
 * util taking them as arguments would be a service with its constructor moved into every call site. `resolveQuestionMode` uses neither, and lives here
 * anyway so the four `resolve*` calls in `spawnOrchestrate` read from one place.
 */
@Injectable()
export class OrchestrateArgsService {
  constructor(
    private readonly registry: RegistryService,
    private readonly items: ItemsService
  ) {}

  /**
   * Narrows `POST /api/agents/orchestrate`'s `ids` into the list the prompt
   * is composed from, or `undefined` for "no restriction — drain the whole
   * queue". Throws rather than returning a failure: every rejection below is
   * the caller's answer, and there is no partial success worth reporting.
   *
   * This is what lets a caller influence a prompt at all without weakening
   * the "the orchestrate spawn prompt is a server-side constant" invariant.
   * Two independent checks stand between a request body and that string:
   *
   *   1. `isItemId` (shared/agent.ts) — shape. What survives is a bare
   *      identifier: no whitespace, no path separator, no shell
   *      metacharacter, no newline to split a one-line prompt with.
   *   2. Membership — this project's own scanned items, filtered to open
   *      bugs and tasks. What survives names a file that actually exists in
   *      the store the run is about to be pointed at.
   *
   * Shape alone would be far too weak (`bug-999` passes it), and membership
   * alone would be doing a directory scan over attacker-shaped strings. Both
   * together mean the only thing a caller can put in the prompt is the id of
   * one of this project's real, runnable items.
   *
   * 400 vs 409 follows the split dispatch already makes: 400 when the
   * request is malformed (not a list, an empty list, something that is not
   * an id), 409 when the request is well-formed and the FILES disagree with
   * it (no such item, archived, wrong section, another project's item). The
   * 409s are deliberately uncoded — `RUN_IN_PROGRESS_CODE`, this route's one
   * 409 code, says "a run for this project is alive right now", which is
   * not what an id disagreement means, and nothing here needs to be told
   * apart from the others by a machine.
   */
  async resolveIds(project: string, ids: unknown): Promise<string[] | undefined> {
    if (ids === undefined || ids === null) return undefined;
    if (!Array.isArray(ids)) {
      throw new HttpException({ error: 'ids must be an array of item ids' }, 400);
    }
    if (ids.length === 0) {
      // The one refusal that is easy to get wrong in the other direction.
      // Reading `[]` as "everything" would turn a reader who unchecked every
      // box on the board into a full unattended drain of their backlog —
      // the exact inversion `parseIdsArg`'s own comment (orchestrate.mjs)
      // exists to prevent one layer down.
      throw new HttpException({ error: 'ids must name at least one item — omit ids entirely to run the whole queue' }, 400);
    }
    /* task-47. A TRACKER project's ids take a different proof and a different
       spelling, and both differences are here rather than spread over the
       method:

         * **Shape.** `#31`, this project's own URN and a BARE `31` are all
           accepted. The first two are `isItemId`'s already; bare digits get
           their own check, because `isItemId` deliberately does not admit them
           — `31` on its own is not an item id anywhere else in this app, and
           widening that predicate to accept one would make every caller of it
           accept a number.
         * **Membership.** Proved against `ItemsService`, never `scanProject`:
           a tracker project has no item files, and the files scan would find
           nothing and 409 every id.
         * **Spelling.** Every accepted id is NORMALISED TO BARE DIGITS before
           it reaches the composition. That is what keeps CLAUDE.md's `#`
           paragraph true: the orchestrate prompt is the one composition that
           concatenates caller text, `orchestrate.mjs` reads its argv as
           tokens, and SKILL.md substitutes those tokens into fenced shell
           commands where `#` opens a comment. The refusal that used to stop a
           `#` reaching the prompt is gone; this normalisation is what stands
           in its place, and it is stronger — nothing is refused for carrying a
           `#`, it simply never survives to the prompt.

       A files project takes neither branch and is byte-identical to what it
       was, which O-L3 pins by reusing the existing composition cases. */
    if (this.items.isTrackerProject(project)) return this.resolveTrackerIds(project, ids);

    for (const id of ids) {
      if (!isItemId(id)) {
        // Echoed back truncated and JSON-quoted: a client bug is far easier
        // to find when the error names the value that broke, and this body
        // goes back to the same caller that sent it. Bounded because the
        // value is arbitrary and there is no reason to reflect a megabyte of
        // it into a log.
        const shown = JSON.stringify(typeof id === 'string' ? id.slice(0, 40) : id);
        throw new HttpException({ error: `ids must all be item ids like task-3 — ${shown} is not one` }, 400);
      }
    }

    // Scoped to the ONE project being orchestrated, deliberately unlike
    // findItem's registry-wide walk: an id is only meaningful inside a
    // store, `bug-2` exists in most of them, and accepting another
    // project's item here would hand `--ids` an id that `orchestrate.mjs
    // init` then exits 1 on — inside a headless session that has already
    // been spawned, where nobody is watching. Raw string compare on the
    // path, matching the deliberately-not-realpath rule the dashboard
    // membership check follows (see CLAUDE.md); a `project` naming nothing
    // in the registry simply has no runnable items, and every id then gets
    // the same honest refusal below.
    const entry = this.registry.load().projects.find((p) => p.path === project);
    const runnable = new Set(
      (entry === undefined ? [] : (await scanProject(entry)).items)
        // Exactly orchestrate.mjs's own candidate set: open, and one of the
        // two sections GATE_SECTIONS names. Ideas, refactors and
        // out-of-scope have nothing to execute by definition — the same
        // limit backlog-execute refuses on — and an archived item is not a
        // candidate either. Grooming is NOT checked: an ungroomed item is a
        // legal selection, the run re-gates it and reports it as ungroomed,
        // and that is information rather than an error (see
        // orchestrate-draft.ts's queue comment for the same reasoning on
        // the preview side).
        .filter((it) => it.status === 'open' && (it.section === 'bugs' || it.section === 'tasks'))
        .map((it) => it.id)
    );

    const seen: string[] = [];
    for (const id of ids as string[]) {
      if (!runnable.has(id)) {
        // One message for all four ways this can fail (absent, archived,
        // wrong section, another project's) — telling them apart would be
        // telling the caller what exists where, and none of the four
        // changes what they have to do about it: reopen the board and pick
        // again.
        throw new HttpException({ error: `${id} is not an open bug or task in this project` }, 409);
      }
      // De-duplicated rather than refused, first-seen order kept. A repeated
      // id is not something a caller can act on and the run would work the
      // item once either way, but a prompt naming it twice is a confusing
      // thing to leave in a transcript nobody is watching. Order is load
      // bearing: `--ids` runs items IN THE ORDER GIVEN, overriding the
      // tool's own bugs-then-tasks ordering (orchestrate.mjs, SKILL.md §1),
      // so this loop must never reorder what it was handed.
      //
      // `buildGatedQueue` reserves exactly one exception to that, and it is
      // the tool's to make, never this loop's: an item marked `runner-fix:`
      // is hoisted to the front of whatever list arrives, because executing
      // it repairs machinery the rest of the run depends on. The caller's
      // relative order survives among everything else. That narrowing is
      // deliberate and it is aimed at precisely this code path — the board
      // sends `ids` for any strict subset of its checkboxes, so what arrives
      // here is a *selection*, not an ordering, and nobody chose the
      // sequence it came in. Which is also why the exception belongs in the
      // tool: a second copy of "hoist the runner fix" here would have to
      // re-read every item's frontmatter at `<base>` to know which one that
      // is, and the two copies would drift the first time either rule moved.
      if (!seen.includes(id)) seen.push(id);
    }
    return seen;
  }

  /**
   * `resolveIds` for a TRACKER project (task-47) — the same two-check
   * arrangement (shape, then membership) over a different vocabulary, and one
   * step the files path does not have: normalisation.
   *
   * The three accepted spellings all mean the same issue and all become the
   * same bare number. `#31` is what a person types and what the board draws;
   * `gh:owner/repo#31` is what `BacklogItem.path` carries, which is what the
   * sheet has to hand; `31` is what a run's queue calls it. Accepting all
   * three and emitting one is the whole job — refusing two of them would push
   * the translation onto the board, where a second copy of it would drift.
   *
   * 400 vs 409 follows exactly the split the files path makes: 400 for a shape
   * that is not an id at all, 409 for a well-formed id the project disagrees
   * with. The 409 sentence is the files one, word for word, because it is the
   * same fact and the caller does the same thing about it.
   *
   * Membership comes from `ItemsService.index()` filtered to this project's
   * registry path — a raw string compare, the deliberately-not-realpath rule
   * every membership check in this app follows. It is one read of every
   * registered project rather than a per-project call because the service
   * offers no narrower one; the cost is a cache read per tracker project and
   * a directory scan per files project, on a route that then spawns a headless
   * session.
   */
  /**
   * The `owner/repo` a tracker project's marker names, or `null` — read through
   * `ItemsService.writerFor`, the same per-request marker resolution every item
   * write gates on, rather than a second `resolveSource` call here (bug #270).
   * `null` only for a marker without a usable string `repo`, which no URN can
   * match, so `resolveTrackerIds` refuses every URN for it.
   */
  private trackerRepoOf(project: string): string | null {
    const lookup = this.items.writerFor(project);
    if (lookup.kind !== 'writer') return null;
    const repo = lookup.marker.repo;
    return typeof repo === 'string' && repo !== '' ? repo : null;
  }

  private async resolveTrackerIds(project: string, ids: unknown[]): Promise<string[]> {
    const wanted: string[] = [];
    for (const id of ids) {
      // Bare digits FIRST, and checked here rather than inside `isItemId`: see
      // `resolveIds`' own comment for why that predicate must not learn them.
      const bare = typeof id === 'string' && /^\d+$/.test(id) ? id : null;
      if (bare !== null) {
        wanted.push(bare);
        continue;
      }
      if (!isItemId(id)) {
        const shown = JSON.stringify(typeof id === 'string' ? id.slice(0, 40) : id);
        throw new HttpException({ error: `ids must all be item ids like #31 — ${shown} is not one` }, 400);
      }
      // A URN names its repository as well as its number, and the repository
      // has to be THIS project's (bug #270). Reading only the digits after the
      // `#` turned `gh:other/repo#31` into this project's #31 — an issue the
      // caller never named, worked by a run on this project's credential. Same
      // refusal and sentence as `backlog.mjs`'s `trackerId`, and a 400 beside
      // the file-id one below for the same reason: it is not an id this project
      // could ever name. Case-insensitive, because GitHub resolves `Futin/X`
      // and `futin/x` to one repository, so refusing a case difference would
      // refuse the right issue.
      const urn = parseUrn(id as string);
      if (urn !== null) {
        const own = this.trackerRepoOf(project);
        if (own === null || urn.repo.toLowerCase() !== own.toLowerCase()) {
          throw new HttpException({ error: `${String(id)} names ${urn.repo}, but this project is connected to ${own ?? 'no repository'}` }, 400);
        }
      }
      // `#31` and a URN proved above both end in the number, and `isItemId`
      // has already proved the whole string against an anchored shape — so
      // taking the digits after the last `#` is reading a value that has been
      // proved, never parsing an unproved one.
      const at = (id as string).lastIndexOf('#');
      const digits = at === -1 ? '' : (id as string).slice(at + 1);
      if (!/^\d+$/.test(digits)) {
        // A files-shaped id (`task-3`) in a tracker project — `isItemId`
        // accepts it and this project has nothing it could name. Its own
        // sentence rather than the 409 below, because the caller has the wrong
        // vocabulary rather than the wrong item.
        throw new HttpException({ error: `${String(id)} is a file id — a tracker project's items are named #<n>` }, 400);
      }
      wanted.push(digits);
    }

    const index = await this.items.index();
    const runnable = new Set(
      index.items
        .filter((it) => it.projectPath === project && it.status === 'open' && (it.section === 'bugs' || it.section === 'tasks'))
        .map((it) => String(it.id).replace(/^#/, ''))
    );

    const seen: string[] = [];
    for (const id of wanted) {
      if (!runnable.has(id)) {
        throw new HttpException({ error: `${id} is not an open bug or task in this project` }, 409);
      }
      // De-duplicated, first-seen order kept — the files path's rule and its
      // reasoning verbatim, and it matters more here: three spellings of one
      // issue collapse to one number, so a selection naming `#31` and
      // `gh:owner/repo#31` arrives as a duplicate that no caller can see.
      if (!seen.includes(id)) seen.push(id);
    }
    return seen;
  }

  /**
   * `req.base`, turned into a branch name `orchestrate.mjs init` can be told
   * to run with, or a 400 if it cannot be. Task-44 / design §3.1.
   *
   * - absent (`undefined` or `''`) → `'main'` — today's behaviour, for every
   *   caller written before this field existed.
   * - an existing local branch in THIS project → that value.
   * - anything else, of any type → reject.
   *
   * **This is `resolveIds`' kind of proof, not `resolveMergeMode`'s kind of
   * clamp, and the distinction is the reason this method is as long as it
   * is.** `mergeMode` and `questionMode` each append a COMPILE-TIME LITERAL
   * chosen by a guard: whatever the caller sent, the only text that can reach
   * the prompt is ` --merge-mode branch`, spelled in this file. No
   * caller-supplied character survives that channel, so validating the input
   * is about selecting the right outcome, and a clamp would do. A base is
   * different in kind: the caller's own text is what gets appended. It
   * therefore has to be *proved* the way an id is — against the real world,
   * before composition — rather than merely recognised.
   *
   * Two checks, in this order, mirroring `assertUsableBase` in
   * `orchestrate.mjs` (the tool re-checks because it is also driven by hand;
   * neither copy is redundant, see that function):
   *
   *   1. **It is a legal branch name** (`git check-ref-format --branch`, plus
   *      a leading-`-` refusal in JS before git is asked at all, and since
   *      #343 `BASE_BRANCH_SHAPE` ahead of git — a well-formed ref is not a
   *      shell-inert string, see base-branch.util.ts).
   *
   *      First, deliberately — but the reason is NOT that check 2 would
   *      otherwise read it as an option. It would not: `refs/heads/${base}`
   *      can never begin with a `-` however the caller spells the base, and
   *      measuring confirms membership alone refuses every value this check
   *      does. The ordering earns its place downstream. A base that survives
   *      this method is composed into the spawn prompt and then substituted
   *      for `<base>` in SKILL.md's own shell commands — `git worktree add
   *      … <base>`, `git -C … merge --no-edit <base>` — where a leading `-`
   *      or embedded whitespace genuinely would be read as an option or split
   *      an argument. Proving well-formedness BEFORE composition is what
   *      keeps that safe, and running it first is what makes the refusal say
   *      "that is not a ref name" rather than "no such branch".
   *
   *      So: belt-and-braces for this call, load-bearing for what the value
   *      goes on to do. Both are pinned by message in base-branch.test.ts,
   *      because a status-only assertion cannot tell the two checks apart.
   *   2. **`refs/heads/<base>` exists in this project** (`git show-ref
   *      --verify --quiet`). A tag, a 40-hex SHA and `origin/main` all PASS
   *      check 1 — measured, not assumed — and are refused only here. That is
   *      why neither check alone is the rule. A run merges INTO its base, and
   *      only a local branch can move.
   *
   * The project is resolved through the registry with the same raw string
   * compare `resolveIds` uses, deliberately not realpath (CLAUDE.md). An
   * unregistered `project` has no branches, so every base then gets the same
   * honest refusal — which is the right answer, since such a project cannot
   * be orchestrated at all.
   *
   * **Never creates the branch.** A missing base is a refusal, not an
   * instruction: an endpoint that spawns unattended sessions is not an
   * endpoint that invents refs (design, non-goals).
   *
   * Uncoded 400, like `resolveMergeMode`'s and for the same reason —
   * `RUN_IN_PROGRESS_CODE` stays the one machine-readable answer this route
   * gives.
   */
  async resolveBase(base: string | undefined, project: string): Promise<string> {
    // The two checks live in `resolveBaseBranch` since #254, shared with
    // `GET /api/items/uncommitted`, which must accept exactly the bases this
    // route accepts. The `'main'` short-circuit lives there too, and this is
    // still why it is load-bearing rather than an optimisation: the
    // composition appends NOTHING for `'main'`, so there is no caller text
    // for the two checks to protect — they exist to prove a string that is
    // about to be concatenated into a prompt, and this one never is.
    //
    // Treating it differently would also be a live regression: the
    // Orchestrate sheet sends `base` on EVERY launch, `'main'` included, so a
    // validated `'main'` would run `show-ref refs/heads/main` against the
    // project on every ordinary run — and 400 every one of them in a
    // repository whose trunk is named something else. That board worked
    // before this field existed and must keep working; the client becoming
    // explicit about a default is not a reason to start refusing it.
    //
    // The tool still checks it at `init` (`assertUsableBase`), which is the
    // right place: that is where the run actually happens, and it has the
    // repository in hand rather than a registry entry.
    //
    // Async since #277: the two checks spawn git without blocking the event
    // loop, and a timeout on either is a failed check — the same 400 a missing
    // branch gets.
    return resolveBaseBranch(base, this.registry.load().projects.find((p) => p.path === project)?.path);
  }

  /**
   * This project's local branch names, for the Orchestrate sheet's base
   * picker. `git for-each-ref` rather than `git branch --list`: plumbing with
   * script-shaped output instead of porcelain that marks the checked-out one
   * with an asterisk and may abbreviate.
   *
   * Read per request and cached nowhere — the same rule `uncommitted` follows
   * and for the same reason: a branch created in the seconds since the sheet
   * opened must be pickable without restarting the server.
   *
   * Deliberately NOT annotated with which tree holds which branch. The sheet
   * needs names; "where is this branch checked out" is a question about
   * merge time, and §9 of SKILL.md answers it then, from the run, rather than
   * from a snapshot taken when a picker was drawn.
   *
   * Async and time-bounded since #277 (`runGit`): a timeout answers
   * `{ branches: [] }`, exactly as a non-zero exit does — an empty picker, not
   * a 500 and not a frozen server.
   */
  async branches(project: string): Promise<AgentBranchesPayload> {
    const entry = this.registry.load().projects.find((p) => p.path === project);
    if (entry === undefined) throw new HttpException({ error: 'project is not registered' }, 404);
    const out = await runGit(['-C', entry.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    if (out === null) return { branches: [] };
    // Filtered by the launch's own shape check (#343): a branch `proveBaseBranch` would 400 is never offered, or the sheet disagrees with itself.
    return { branches: out.split('\n').map((b) => b.trim()).filter((b) => BASE_BRANCH_SHAPE.test(b)) };
  }

  /**
   * `req.mergeMode`, turned into a `MergeMode` `orchestrate.mjs init` can be
   * told to run with, or a 400 if it cannot be. Design §2.3
   * (2026-09-04-orchestrator-merge-mode-design.md):
   *
   * - absent (`undefined` or `''`) → `'merge'` — today's behaviour, for
   *   every caller written before this field existed.
   * - a member of `MERGE_MODES` → that value, except that `pr` also needs
   *   the project to be a tracker project (spec P3: a files project has no
   *   remote ruleset to route around, and the tool refuses it too).
   * - anything else → reject.
   *
   * This is deliberately NOT `pickFrom`'s drop-on-unknown rule, even though
   * `model` and `effort` — resolved via `pickFrom` in `orchestrate()`'s own
   * spawn call — use exactly that rule for what looks like the identical
   * shape of problem. The difference is what
   * dropping resolves TO: an unrecognised model or effort falls through to
   * "the CLI's own default", a harmless no-op. An unrecognised `mergeMode`
   * would fall through to the absent branch above and resolve to `'merge'`
   * — and `merge` is the irreversible direction: it commits this run's
   * verified items into `main`, undoable afterwards only by `git revert -m
   * 1`, never `git reset --hard` (see CLAUDE.md's invariant on undoing a
   * completed orchestrator merge, and the data loss that rule exists to
   * prevent). A caller bug — a stale enum on an old board tab, a typo, a
   * future client sending a mode this build has never heard of — must not
   * be able to select that outcome silently. Absent is different from
   * unrecognised and gets the opposite answer for the same reason
   * `permissionMode`'s default-before-clamp treats them oppositely just
   * above in `orchestrate()`: absent is not a bug, it is every request ever
   * written before `mergeMode` existed, so it defaults rather than rejects.
   * Only `undefined` and `''` count as absent, matching `pickFrom`'s own
   * "no pick submits the empty string" convention (see that function) —
   * anything else, including the non-string a `Partial`-typed body cannot
   * rule out, is a real value that simply is not one of `MERGE_MODES`, so
   * it is rejected outright rather than defaulted or floored.
   *
   * Uncoded, like every 400 and most 409s this endpoint throws:
   * `RUN_IN_PROGRESS_CODE` stays the one machine-readable answer this route
   * gives, reserved for the fact that a run is alive (see the two locks in
   * `orchestrate()`, and the code's own doc comment) — nothing about a
   * malformed enum needs telling apart from any other 4xx.
   */
  resolveMergeMode(mergeMode: string | undefined, project: string): MergeMode {
    if (mergeMode === undefined || mergeMode === '') return 'merge';
    if (isMergeMode(mergeMode)) {
      // The source check is by what the project RESOLVES to, through the one
      // `known` set `ItemsService` owns — `github` is the only tracker kind
      // today, and anything else (`files`, a marker this build cannot honour,
      // an unreadable one, no store at all) is refused rather than guessed
      // at. `unsupported` in particular must not read as files-and-therefore-
      // fine: both refusals are the same sentence. Uncoded, like the enum 400
      // below, and after the run locks for the same reason that one is.
      if (mergeMode === 'pr' && this.items.sourceOf(project) !== 'github') {
        throw new HttpException({ error: 'mergeMode pr needs a tracker project — this project\'s backlog is not backed by a GitHub repo' }, 400);
      }
      return mergeMode;
    }
    // Echoed back truncated and JSON-quoted, matching resolveIds's own
    // convention just above: a client bug is far easier to find when the
    // error names the value that broke, and this body goes back to the
    // same caller that sent it. `JSON.stringify` also renders a non-string
    // value (case 7's `42`) sensibly, which a template-literal interpolation
    // would not.
    const shown = JSON.stringify(typeof mergeMode === 'string' ? mergeMode.slice(0, 40) : mergeMode);
    throw new HttpException({ error: `mergeMode must be ${MERGE_MODES.join(', ')} — ${shown} is not one` }, 400);
  }

  /**
   * `req.questionMode`, turned into a `QuestionMode` `orchestrate.mjs init`
   * can be told to run with, or a 400 if it cannot be. Design §2.3
   * (2026-09-05-orchestrate-question-mode-design.md), mirroring
   * `resolveMergeMode` above row for row:
   *
   * - absent (`undefined` or `''`) → `'park'` — today's behaviour, for every
   *   caller written before this field existed.
   * - a member of `QUESTION_MODES` → that value.
   * - anything else, of any type → reject.
   *
   * **400 rather than drop-on-unknown**, and the argument is this field's
   * own rather than a copy of its neighbour's. `model` and `effort` drop an
   * unrecognised value because dropping them means "let the CLI decide",
   * which is a coherent thing to have happen. This value is written verbatim
   * into `run.json` by `init` and read back out of the archive months later,
   * so silently resolving a typo'd `decide` to `park` would put a claim in
   * the archive that no caller ever made — and the archive's whole job here
   * is answering "was this item's plan written by a human or filled in by
   * the runner?". Absent is not a bug: it is every request written before
   * this field existed, which is exactly the distinction a 400 preserves and
   * a clamp destroys.
   *
   * Uncoded, like `resolveMergeMode`'s own 400 and for the same reason:
   * `RUN_IN_PROGRESS_CODE` stays the one machine-readable answer this route
   * gives.
   */
  resolveQuestionMode(questionMode: string | undefined): QuestionMode {
    if (questionMode === undefined || questionMode === '') return 'park';
    if (isQuestionMode(questionMode)) return questionMode;
    // The same truncate-and-JSON.stringify echo convention resolveMergeMode
    // and resolveIds both use — which is also what renders a non-string
    // sensibly (`42`, not `"42"`), something a template-literal
    // interpolation would get wrong.
    const shown = JSON.stringify(typeof questionMode === 'string' ? questionMode.slice(0, 40) : questionMode);
    throw new HttpException({ error: `questionMode must be decide or park — ${shown} is not one` }, 400);
  }

  /**
   * GET /api/agents/merge-check's whole implementation. Registry-gated
   * first, exactly like `resolveIds` above: a raw string compare against
   * the registry's own `path` field, not a realpath compare —
   * matching the "deliberately not realpath" rule CLAUDE.md pins on
   * `dispatchGate`'s membership check. That choice is load-bearing here in
   * a way it merely mirrors there: realpath-ing an unregistered path
   * before comparing it would itself BE the filesystem touch
   * test/merge-check.test.ts's unregistered-project case proves never
   * happens — the gate has to stay a pure in-memory compare against a
   * registry already loaded into this process, or the ordering the test
   * checks collapses back into "eventually degrades to false", which is a
   * weaker guarantee than "never asked at all".
   *
   * `homedir()` is read fresh on every call rather than once at
   * construction, the same "read per call, never cache" posture
   * `RegistryService.load()` and `orchHome()` both take: the developer's
   * actual `~/.claude/settings.json` can change between two clicks of the
   * same sheet, same as the registry file can.
   */
  mergeCheck(project: string): MergeCheckResult {
    const entry = this.registry.load().projects.find((p) => p.path === project);
    if (entry === undefined) throw new HttpException({ error: 'not found' }, 404);
    return checkMergeCoverage(entry.path, homedir());
  }
}
