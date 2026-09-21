import { Injectable } from '@nestjs/common';

import { claimsByIssue, claimsFor, isLive, liveClaims, newestClaim, renderClaim, winner, type ParsedClaim } from '../../tracker/claim';
import { GithubClient, isRepo, type GithubComment, type GithubIssue, type GithubResponse } from '../../tracker/github.client';
import { issueNumberFor, issueUrn, mapIssue, parseUrn } from '../../tracker/map-issue';
import { TrackerPollerService } from '../../tracker/poller.service';
import { githubToken } from '../../tracker/token.util';
import { resolveSource } from './resolve.util';
import type { SourceMarker } from './resolve.util';
import type { CreatedItem, ItemSource, ItemWriter, SourceSummary, WriteOutcome, WriteRefusal } from './source';
import type {
  BacklogItem,
  ClaimCounters,
  ClaimRecord,
  ClaimResult,
  ItemBodyRequest,
  ItemClaimRequest,
  ItemCommentRequest,
  ItemCreateRequest,
  ItemHeartbeatRequest,
  ItemReleaseRequest,
  ItemStateRequest,
  Registry,
  RegistryProject,
  Section
} from '../../../../shared/types';

/**
 * The second adapter behind the seam (task-45, spec §5): a project whose items
 * are GitHub issues. It is the test of task-43's claim — this class plus two
 * lines in `items.module.ts` is the whole registration, and `items.service.ts`
 * control flow did not change to accept it.
 *
 * **Its READS make no network calls.** Every answer `list`, `body`, `find` and
 * `summary` give comes out of `TrackerPollerService`'s in-memory cache, which
 * is what makes `list` cheap enough to call on every board render: a
 * per-request fetch would spend the hourly rate limit in a few minutes of
 * someone watching the board. The price is that the items are up to one poll
 * interval old, and the price is PAID openly — `summary` carries `polledAt` and
 * the board renders its age (spec §5.5).
 *
 * ## The write half (task-46, spec §6.2)
 *
 * Since phase 3 this class is also its own `ItemWriter`, and the writes DO call
 * the network — every one of them, always. A write has no cache to answer from:
 * it is the event that makes the cache wrong, which is why each one ends by
 * absorbing its own response (`absorbIssue`, `absorbComment`, `forgetComment`)
 * so the next board read shows what just happened without waiting for a poll.
 *
 * Read and write live in ONE class rather than two because they share the two
 * things that would otherwise have to be duplicated and kept in step: the URN
 * vocabulary, and the registry gate that decides whether this process may touch
 * a repo at all. A separate writer would be a second place to get either wrong.
 *
 * **Nothing here throws.** Every refusal is a `WriteRefusal` value, the same
 * posture `GithubClient` takes one layer down; the controller is the only layer
 * that turns one into an HTTP status.
 */
@Injectable()
export class GithubSource implements ItemSource, ItemWriter {
  readonly kind = 'github' as const;

  constructor(
    private readonly poller: TrackerPollerService,
    private readonly client: GithubClient
  ) {}

  /**
   * This adapter IS its own writer — see the class header for why the two
   * halves share one object. A getter rather than a field so the shape stays a
   * plain `ItemWriter | undefined` on the interface and nothing has to reason
   * about a field initialised to `this`.
   */
  get writer(): ItemWriter {
    return this;
  }

  /**
   * How long to wait between the two comment listings of a claim (spec §6.3).
   *
   * GitHub's comment listing is eventually consistent by a fraction of a
   * second: a claim posted by another machine can be absent from a list made
   * immediately after our own POST and present a moment later. One second is
   * the settle window that makes both racers see both comments, which is what
   * makes "lowest live id wins" produce the same verdict on both machines.
   *
   * Mutable so a suite can set it to `0`: the protocol's cases are about which
   * comments are in the union, and making each of them wait a real second would
   * add a minute to the suite to test nothing it is about.
   */
  settleMs = 1_000;

  /**
   * Writes to one item are serialised in this process (spec §6.2): every write
   * to a URN awaits the previous write to the SAME URN.
   *
   * Two local sessions — a groom and an execute in two terminals — otherwise
   * race each other on the network, and the claim protocol's settle window is
   * exactly the kind of interleaving that turns into two live claims nobody
   * resolves. Across MACHINES the protocol itself is the guard; this map is the
   * cheap in-process half of the same guarantee.
   *
   * Per URN rather than global on purpose: two different items have nothing to
   * say to each other, and a global lock would make a board-wide operation as
   * slow as the sum of its parts.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Every cached issue of this project's repo, mapped. Reaching this method at
   * all means `resolveSource` answered `tracker` for a `github` marker, which
   * is the cheapest honest signal that something is connected — so this is
   * also where the poller is armed (see `arm()`'s own comment for why every
   * caller of it is a signal rather than a command). A repo connected after
   * boot is therefore polled from the first board read that touches it.
   *
   * A marker with no usable `repo` is one `errors` entry and no items, the
   * same tolerant shape a malformed item file gets: the marker is on disk in
   * somebody's repo, and a board that 500s because one of five projects has a
   * typo is a worse answer than one that renders the other four.
   */
  async list(project: RegistryProject, marker: SourceMarker | null): Promise<{ items: BacklogItem[]; errors: string[] }> {
    this.poller.arm();

    const repo = marker?.repo;
    if (!isRepo(repo)) {
      return { items: [], errors: [`${project.path}: backlog/source.json names no valid "repo" (expected "owner/name")`] };
    }

    // One pass over the repo's comments for the whole render, rather than one
    // per issue — see `claimsByIssue` for the arithmetic.
    const claims = claimsByIssue(this.poller.comments(repo));
    const items: BacklogItem[] = [];
    const errors: string[] = [];
    for (const issue of this.poller.issues(repo)) {
      const mapped = mapIssue(issue, repo, project, claims.get(issue.number) ?? []);
      // `null` is a pull request, which the issues endpoint returns alongside
      // real issues and which is not an item at all — dropped silently,
      // because there is nothing wrong with the repo containing PRs.
      if (mapped === null) continue;
      items.push(mapped.item);
      errors.push(...mapped.errors);
    }
    return { items, errors };
  }

  /**
   * One issue's body, by URN, from the cache — no fetch, which is why the item
   * modal can open instantly and why it draws the poll age beside the body
   * (spec §5.5).
   *
   * Gated on the REGISTRY, exactly as the files adapter's allowlist is: a URN
   * naming a repo no registered project is connected to answers `null`, and
   * the route turns that into a 404 without saying why. The gate reads the
   * registry object it was handed rather than asking the poller, so the
   * service keeps its one registry read per request — and so that a repo which
   * is merely IN THE CACHE (connected a minute ago, disconnected since) is not
   * readable through a stale in-memory copy of who is connected.
   */
  async body(ref: string, registry: Registry): Promise<string | null> {
    const issue = this.cachedIssueFor(ref, registry);
    if (issue === null) return null;
    // An issue with an empty body is `''`, not `null`: the item exists and its
    // body is empty, which the modal should render as an empty body rather
    // than as a 404 claiming there is no such item.
    return issue.issue.body ?? '';
  }

  /**
   * One item by URN (task-46) — the dispatch lift's lookup, and the tracker
   * half of `ItemsService.find`.
   *
   * The same three gates `body` above passes, in the same order and for the
   * same reasons — URN shape, registry membership, cache presence — and then
   * the mapper, so what dispatch validates against is the SAME `BacklogItem`
   * the board drew its button from. That identity is the whole point: `plan`
   * and `dispatch` re-derive the action from the item rather than trusting the
   * caller, and re-deriving it from a differently-built object would be a
   * second implementation of "what is this item" in the one place the rule says
   * there must not be one.
   */
  async find(ref: string, registry: Registry): Promise<BacklogItem | null> {
    const found = this.cachedIssueFor(ref, registry);
    if (found === null) return null;
    const project = registry.projects.find((p) => this.repoOf(p) === found.repo);
    if (project === undefined) return null;
    const mapped = mapIssue(found.issue, found.repo, project, claimsFor(found.issue.number, this.poller.comments(found.repo)));
    return mapped === null ? null : mapped.item;
  }

  /** The live connection state (spec §5.4), straight off the poller. A marker
   *  with no usable repo has no connection to describe, so all four fields are
   *  `null` — the same answer a files project gives, because "there is nothing
   *  connected here" is the same fact in both cases. The `errors` entry `list`
   *  produced is where the reason lives. */
  async summary(_project: RegistryProject, marker: SourceMarker | null): Promise<SourceSummary> {
    const repo = marker?.repo;
    if (!isRepo(repo)) return { repo: null, polledAt: null, access: null, detail: null };
    return this.poller.summary(repo);
  }

  /* =====================================================================
   * ItemWriter (task-46, spec §6.2)
   * ===================================================================== */

  /**
   * A new issue.
   *
   * `section` becomes the `type:*` label and nothing else does — the label IS
   * the section (spec §5.3), so creating with the right one is what puts the
   * item in the right column on every machine. `out-of-scope` is the exception
   * and is the tracker's spelling of `oos-N`: no type label at all, and a close
   * with `state_reason: 'not_planned'` in the same call, because "rejected" is
   * a closed state on a tracker rather than a directory.
   *
   * `from` is prepended to the body as `_From #<n>._`, which is GitHub's own
   * cross-link syntax — it renders as a link and shows up in the cited issue's
   * timeline for free. Nothing derived reads it, exactly as nothing derived
   * read `from:` in frontmatter.
   */
  async create(_project: RegistryProject, marker: SourceMarker, req: ItemCreateRequest): Promise<WriteOutcome<CreatedItem>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const labels: string[] = [];
    const typeLabel = TYPE_LABEL_BY_SECTION[req.section];
    if (typeLabel !== undefined) labels.push(typeLabel);
    if (req.kind !== undefined && req.kind !== '') labels.push(`kind:${req.kind}`);
    if (req.runnerFix === true) labels.push('runner-fix');

    const body = req.from === undefined || req.from === '' ? req.body : `_From ${req.from}._\n\n${req.body}`;

    const created = await this.client.createIssue(repo, { title: req.title, body, labels }, { token });
    if (created.status !== 201 || created.data === null) return { ok: false, refusal: refusalFor(created) };
    let issue = created.data;

    // The second call, and only for `out-of-scope`. Two calls rather than one
    // because GitHub's create endpoint takes no `state`: an issue is born open
    // and is closed by a patch. A failure HERE leaves an open untyped issue
    // behind — reported as the refusal it is, rather than cleaned up, because
    // deleting somebody's issue to tidy up a half-finished write is a worse
    // outcome than an issue sitting in the wrong column with a message
    // explaining it.
    if (req.section === 'out-of-scope') {
      const closed = await this.client.updateIssue(repo, issue.number, { state: 'closed', state_reason: 'not_planned' }, { token });
      if (closed.status !== 200 || closed.data === null) return { ok: false, refusal: refusalFor(closed) };
      issue = closed.data;
    }

    this.poller.absorbIssue(repo, issue);
    return { ok: true, value: { id: `#${issue.number}`, urn: issueUrn(repo, issue.number), url: issue.html_url, number: issue.number } };
  }

  /**
   * Close an issue as done or as rejected.
   *
   * The `outcome` comment goes FIRST, before the close, so the issue's timeline
   * reads in the order the work happened — a reader scrolling it sees the
   * account and then the close, not a close followed by an explanation that
   * appears to have arrived afterwards.
   *
   * Labels and claims are deliberately untouched. `in-progress` is cleared by
   * `release` and by nothing else: an execute session stops (releasing its
   * claim) and then moves the item, so by the time this runs the label is
   * already gone — and on the path where it is not, the honest reading is that
   * something still holds the item, which is worth seeing rather than tidying
   * away. The `type:*` label stays too, which is what makes a rejected issue's
   * original type recoverable where the file store loses it.
   */
  async state(_project: RegistryProject, marker: SourceMarker, req: ItemStateRequest): Promise<WriteOutcome<{ id: string; status: string; url: string }>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(req.id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${req.id} does not name an issue in ${repo}` } };

    return this.serialise(issueUrn(repo, number), async () => {
      const found = await this.issueNow(repo, number, token);
      if (!found.ok) return found;

      if (typeof req.outcome === 'string' && req.outcome.trim() !== '') {
        const posted = await this.client.createComment(repo, number, req.outcome, { token });
        if (posted.status !== 201 || posted.data === null) return { ok: false as const, refusal: refusalFor(posted) };
        this.poller.absorbComment(repo, posted.data);
      }

      const reason = req.status === 'done' ? 'completed' : 'not_planned';
      const closed = await this.client.updateIssue(repo, number, { state: 'closed', state_reason: reason }, { token });
      if (closed.status !== 200 || closed.data === null) return { ok: false as const, refusal: refusalFor(closed) };
      this.poller.absorbIssue(repo, closed.data);
      return { ok: true as const, value: { id: `#${number}`, status: req.status, url: closed.data.html_url } };
    });
  }

  /**
   * Take the issue — the claim protocol (spec §6.3), in full.
   *
   * ## The sequence, and why it is in this order
   *
   * 1. **Refuse a closed issue before writing anything.** There is nothing to
   *    start, and a claim comment on a closed issue is litter nobody will
   *    notice to clean up.
   * 2. **List the comments.** Two things come off this list: the counters to
   *    seed (from the newest prior claim, so ONE comment is a whole history —
   *    see Decision 5 in the item) and the claims already in play.
   * 3. **Post our claim.** Its comment id is our ticket in the race.
   * 4. **Wait `settleMs`, then list again, and take the UNION of both lists.**
   *    GitHub's listing is eventually consistent by a fraction of a second, so
   *    a concurrent claimant can be absent from one list and present in the
   *    other. The union is what decides, never the second list alone — the
   *    tests drive exactly that case.
   * 5. **Lowest live comment id wins.** Ours → set the assignee, add
   *    `in-progress`, and RELEASE (never delete) every other unreleased claim
   *    whose heartbeat has gone stale. Not ours → delete our own comment and
   *    refuse with the holder named.
   *
   * The plan for this item wrote step 2 as happening after step 3. It is done
   * before, and the difference is the counters: a seed read from a list made
   * after our own post would have to come from the cache (up to a poll interval
   * stale) or force a second edit of the comment we just wrote. Listing first
   * costs nothing — the request count is identical, two listings either way —
   * and the union still spans both, so the race semantics are untouched.
   */
  async claim(_project: RegistryProject, marker: SourceMarker, req: ItemClaimRequest): Promise<WriteOutcome<ClaimResult>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(req.id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${req.id} does not name an issue in ${repo}` } };

    return this.serialise(issueUrn(repo, number), async () => {
      const found = await this.issueNow(repo, number, token);
      if (!found.ok) return found;
      /* This is the one precondition in this file read from the CACHE rather
         than fresh (`issueNow` prefers it), so it can be up to one poll interval
         behind: a claim can slip onto an issue closed seconds ago, or be refused
         on one reopened seconds ago. Left that way on purpose — the alternative
         is a guaranteed extra request on every `start` to narrow a window the
         protocol's own writes do not depend on. Nothing downstream trusts this:
         the claim comment lands either way, `release` does not care about state,
         and a person who closed an issue out from under a session sees the claim
         comment on it. Make it fresh only if a real sequence is found that this
         gets wrong. */
      if (found.value.state === 'closed') {
        return { ok: false as const, refusal: { refused: 'conflict' as const, error: `#${number} is done — nothing to start` } };
      }

      const before = await this.allClaims(repo, number, token);
      if (!before.ok) return before;
      const seed = newestClaim(before.value)?.record.counters ?? ZERO_COUNTERS;

      const at = new Date().toISOString();
      const record: ClaimRecord = { v: 1, session: req.session, phase: req.phase, at, heartbeat: at, counters: { ...seed } };
      // `run` only when the caller sent one, never `run: undefined`: this
      // record is `JSON.stringify`d into a comment body, so an undefined key
      // would vanish there anyway — but it would be PRESENT on the object the
      // response carries, and `'run' in record` is how a reader tells a skill
      // claim from a run's. Keeping the two spellings identical means the
      // comment and the response say the same thing.
      if (req.run !== undefined) record.run = req.run;
      const posted = await this.client.createComment(repo, number, renderClaim(record), { token });
      if (posted.status !== 201 || posted.data === null) return { ok: false as const, refusal: refusalFor(posted) };
      const mine = posted.data;
      this.poller.absorbComment(repo, mine);

      await sleep(this.settleMs);

      const after = await this.allClaims(repo, number, token);
      /* The posted comment is deliberately NOT deleted on this path. A failure
         here is a rate limit or a transport error, not a lost race, and the two
         want opposite things: a loser knows it lost and cleans up after itself,
         while this call does not know whether it won. Deleting would throw away
         a claim that may be the only one, and on a second machine mid-protocol
         that is the claim somebody is about to rely on.

         The cost is an issue that reads as claimed by a session whose `start`
         reported failure, until something contests it — which the protocol
         handles on its own, because the heartbeat never moves and the next
         claimant retires it as stale. Self-healing in fifteen minutes beats a
         delete that can be wrong immediately. */
      if (!after.ok) return after;

      // The union, keyed by comment id, with our own claim included
      // unconditionally: a listing that has not caught up with our own POST
      // must not make us invisible to ourselves.
      const union = new Map<number, ParsedClaim>();
      for (const claim of [...before.value, ...after.value]) union.set(claim.commentId, claim);
      union.set(mine.id, { commentId: mine.id, record });

      const now = Date.now();
      const all = [...union.values()];
      const live = liveClaims(all, now);

      /* **Same-run takeover** (task-47). A resumed driver re-claims every
         in-flight item before it touches one, and the claim it is contesting
         is ITS OWN RUN'S — posted by the session that crashed, still live
         because it was heartbeating minutes ago, and holding the lowest id.
         Under the plain protocol the resumed session loses to a session that
         no longer exists, and the item is unreachable until the claim goes
         stale fifteen minutes later — once per item, on every resume.

         So a live claim carrying THIS REQUEST'S `runId` is not a contestant:
         it is this run's previous session, which is gone by definition (only
         one driver holds a run's lease at a time — `orchestrate.mjs`'s exit
         `7`, the layer above this one). Dropping it from the live set lets the
         lowest-id rule decide among everything else, which is exactly the
         question that matters: has another RUN taken the item meanwhile?

         Three things this deliberately does not do:

           * It never drops OUR OWN comment (`mine.id`), which carries the same
             `runId` and would otherwise take itself out of the race.
           * It never matches a claim with no `run` — a hand `backlog.mjs
             start` is somebody working the item at a terminal, and a run has
             no standing to evict them.
           * It never DELETES. The dropped claim is released below, with the
             counters it accumulated intact, because it is the permanent record
             of work that session actually did. */
      const sameRun =
        req.run === undefined
          ? []
          : live.filter((c) => c.commentId !== mine.id && typeof c.record.run?.runId === 'string' && c.record.run.runId === req.run?.runId);
      const sameRunIds = new Set(sameRun.map((c) => c.commentId));
      const held = winner(live.filter((c) => !sameRunIds.has(c.commentId)));

      if (held === null || held.commentId !== mine.id) {
        // Lost. Our comment is deleted — the ONE thing this protocol ever
        // deletes, and only ever a comment this same call posted seconds ago.
        await this.client.deleteComment(repo, mine.id, { token });
        this.poller.forgetComment(repo, mine.id);
        // `held === null` cannot normally happen (our own claim was live a
        // moment ago), but a clock that jumped could make it so; refusing with
        // ourselves named is the honest answer rather than a 500.
        const holder = held ?? { commentId: mine.id, record };
        return {
          ok: false as const,
          refusal: {
            refused: 'conflict' as const,
            error: `#${number} is already in progress (session ${holder.record.session})`,
            holder: {
              session: holder.record.session,
              heartbeat: holder.record.heartbeat,
              ageMs: ageMsOf(holder.record.heartbeat, now),
              commentId: holder.commentId
            }
          }
        };
      }

      // Won. The assignee is REPLACED rather than appended: it says who holds
      // the issue now, and a list that accumulated every past holder would say
      // nothing. A login this process could not read is simply not set — the
      // claim comment is the claim, and the assignee is a courtesy to a person
      // reading the issue in the web UI.
      const login = await this.poller.viewerLogin(token);
      if (login !== null) {
        const assigned = await this.client.updateIssue(repo, number, { assignees: [login] }, { token });
        if (assigned.status === 200 && assigned.data !== null) this.poller.absorbIssue(repo, assigned.data);
      }
      await this.client.addLabels(repo, number, ['in-progress'], { token });

      // Every OTHER unreleased claim that has gone stale is RELEASED, never
      // deleted (spec §6.3 step 5). The distinction is the whole reason a claim
      // is a comment: a released claim is a permanent record of work somebody
      // did — with the counters to prove it — and deleting it would erase that
      // to tidy up a flag.
      for (const other of all) {
        if (other.commentId === mine.id) continue;
        if (other.record.released !== undefined) continue;
        if (isLive(other.record, now)) continue;
        const retired: ClaimRecord = { ...other.record, released: { at: new Date().toISOString(), reason: 'stale', by: req.session } };
        const edited = await this.client.updateComment(repo, other.commentId, renderClaim(retired), { token });
        if (edited.status === 200 && edited.data !== null) this.poller.absorbComment(repo, edited.data);
      }

      /* The same-run claims this call stepped over (task-47), released rather
         than left live — a run that has taken the item back must not leave a
         second live claim of its own on the issue, or the NEXT contestant
         reads two live holders and `winner` hands the item to a session that
         is not driving it.

         `reason: 'resumed'`, distinct from `'stale'` directly above, and the
         distinction is the record rather than the mechanism: a stale claim is
         one nobody came back for, and this one is one whose own run came back.
         Both keep their counters, and neither is ever deleted.

         A failed edit is swallowed for the same reason the stale loop's is —
         by this point the claim is WON and reporting a failure would report a
         claim that happened as one that did not. The leftover then goes stale
         on its own within `CLAIM_STALE_MS`, which is the protocol's own repair
         for exactly this shape. */
      for (const other of sameRun) {
        const resumed: ClaimRecord = { ...other.record, released: { at: new Date().toISOString(), reason: 'resumed', by: req.session } };
        const edited = await this.client.updateComment(repo, other.commentId, renderClaim(resumed), { token });
        if (edited.status === 200 && edited.data !== null) this.poller.absorbComment(repo, edited.data);
      }

      return { ok: true as const, value: { commentId: mine.id, record } };
    });
  }

  /**
   * Give the issue back, and bill what the session spent.
   *
   * `counters` are written VERBATIM. The CLI is the biller — it holds the
   * clock the session started on and the transcript the tokens are read from,
   * exactly as `stopItem` does for a files item — and a server that recomputed
   * them would be a second implementation of billing, in the process with the
   * least information about what happened.
   *
   * Who may release: **the holder always, the RUN that owns the claim, ANYONE
   * once the claim is dead.** The last clause is the same rule `claim`
   * enforces from the other side — a stale claim is not somebody's property,
   * it is litter, and requiring the original session to come back and clear it
   * would wedge an issue on the crash of a process that is never coming back.
   *
   * The MIDDLE clause is bug-42's, and it is not a new concept: it is
   * task-47 §7.6's same-run takeover, which `claim` has enforced since phase
   * 4a and this route never learned. `POST /api/agents/stop` records a stop
   * and then spawns a FRESH `/backlog-orchestrate --abort` session; that
   * session takes the run's driver lease (`takeOverRun`, before it walks the
   * queue) and then releases every claim the run still holds — as its own
   * session, which under the holder-only rule is a stranger to every one of
   * those claims. So the force stop built for a driver that is dead or hung
   * left exactly the state bug-40 removed: an unreleased claim, the
   * `in-progress` label, and `started`/`phase` on every machine's board. The
   * claim going stale does not repair it — the mapper reads `started` off ANY
   * unreleased claim, fresh or stale.
   */
  async release(_project: RegistryProject, marker: SourceMarker, req: ItemReleaseRequest): Promise<WriteOutcome<ClaimResult>> {
    return this.editClaim(marker, req.id, req.commentId, (existing, now, number) => {
      if (existing.released !== undefined) {
        return { refused: 'conflict', error: `claim ${req.commentId} on #${number} is already released` };
      }
      /* The `typeof` and `length` guards are load-bearing, not ceremony.
         Written as the tempting `existing.run?.runId !== req.runId`, a request
         with no `runId` against a HAND claim with no `run` compares
         `undefined !== undefined` → `false`, the refusal disappears, and any
         session on the machine could rip a live `backlog.mjs start` out from
         under the person holding it. `claim`'s own same-run filter guards the
         same shape with `typeof c.record.run?.runId === 'string'`, and the two
         are meant to read alike.

         So a claim with no `run` is never same-run with anything — the same
         sentence `claim` makes about a hand claim, for the same reason: a run
         has no standing to evict somebody working the item at a terminal. */
      const sameRun = typeof req.runId === 'string' && req.runId.length > 0 && existing.run?.runId === req.runId;
      if (isLive(existing, now) && existing.session !== req.session && !sameRun) {
        return {
          refused: 'conflict',
          error: `#${number} is held by session ${existing.session}`,
          holder: { session: existing.session, heartbeat: existing.heartbeat, ageMs: ageMsOf(existing.heartbeat, now), commentId: req.commentId }
        };
      }
      return {
        ...existing,
        counters: req.counters === undefined ? existing.counters : req.counters,
        released: { at: new Date(now).toISOString(), reason: req.reason, by: req.session }
      };
    }, async (repo, number, token) => {
      /* The label comes off after the comment is edited, and the RESULT IS
         DELIBERATELY NOT CHECKED — which is a decision rather than an oversight,
         so it is worth the three lines.

         A 404 means the label was not on the issue, and that is a SUCCESS for
         this caller: the contract is "`in-progress` is not there", and it is not
         there. Two sessions releasing the same dead claim, and a person who
         removed the label by hand, both land on it. Nor would any OTHER status
         justify failing: by the time this runs the claim comment is already
         edited and the release has happened, so refusing here would report a
         release that did occur as one that did not — and the caller's retry
         would then hit `claim … is already released`, wedging the item shut.

         `test/tracker-write.test.ts` pins the 404 half against an issue with no
         `in-progress` label, because "the result is ignored" is exactly the
         shape a green suite cannot protect: adding a plausible-looking
         `if (removed.status !== 200) return refusal` here would break every
         release of an already-clean claim with nothing going red. */
      await this.client.removeLabel(repo, number, 'in-progress', { token });
      // The assignee is deliberately left alone. It records who last worked the
      // issue, which stays true after they stop, and clearing it would throw
      // away the one field a person scanning the repo's issue list can see.
    });
  }

  /**
   * Say the session is still alive. Refuses a released claim — a heartbeat on
   * one would be a session insisting it holds something it gave back, which is
   * a bug in the caller rather than a state to tolerate.
   *
   * With ONE exception (task-48): a request carrying `finished` is accepted on
   * a released claim, and there it sets `finished` and nothing else. `finish`
   * stamps the run's LAST-TOUCHED claim, and by then that item's terminal stage
   * has normally released it — so refusing would make the stamp impossible on
   * exactly the claim it belongs on. It is a fact about the run riding on the
   * comment, not a claim to be alive: `heartbeat` and `state` stay where the
   * release left them (a moved heartbeat would read as the item being worked
   * again) and `released` is never touched, because release is permanent.
   *
   * ## Who may beat (bug-45)
   *
   * `release`'s triple minus its last clause: the HOLDER always, the RUN that
   * owns the claim, and NOT "anyone once the claim is dead". The first two
   * clauses are `release`'s word for word — including the `typeof`/`length`
   * guards, which are load-bearing there for a reason that applies here
   * unchanged: a claim with no `run` must never be same-run with anything.
   *
   * The dropped clause is the whole point. `release` lets anyone retire a dead
   * claim because retiring one is tidying; REVIVING one is the harm this route
   * had — a session heartbeating a rival's claim holds it live forever, so the
   * fifteen-minute staleness repair never fires for the one issue that needs
   * it. Retiring a dead claim stays `claim`'s business, answered by the lowest
   * live comment id.
   *
   * The check runs BEFORE the released branch, `finished` included: a stamp is
   * still a write to somebody else's record. `finish` sends its run's `runId`,
   * so the driver's own claims pass the same-run clause whether or not their
   * terminal stage already released them.
   */
  async heartbeat(_project: RegistryProject, marker: SourceMarker, req: ItemHeartbeatRequest): Promise<WriteOutcome<ClaimResult>> {
    return this.editClaim(marker, req.id, req.commentId, (existing, now, number) => {
      const sameRun = typeof req.runId === 'string' && req.runId.length > 0 && existing.run?.runId === req.runId;
      if (existing.session !== req.session && !sameRun) {
        return {
          refused: 'conflict',
          error: `claim ${req.commentId} on #${number} belongs to session ${existing.session}`,
          holder: { session: existing.session, heartbeat: existing.heartbeat, ageMs: ageMsOf(existing.heartbeat, now), commentId: req.commentId }
        };
      }
      if (existing.released !== undefined) {
        if (req.finished !== undefined) return { ...existing, finished: req.finished };
        return { refused: 'conflict', error: `claim ${req.commentId} on #${number} is released — nothing to heartbeat` };
      }
      if (req.finished !== undefined) {
        const beat = { ...existing, heartbeat: new Date(now).toISOString(), finished: req.finished };
        return req.state === undefined ? beat : { ...beat, state: req.state };
      }
      // `state` is the driver's and is written verbatim when given, left exactly
      // as it was when not — an old build heartbeating a record a newer one
      // wrote must not erase it.
      return req.state === undefined
        ? { ...existing, heartbeat: new Date(now).toISOString() }
        : { ...existing, heartbeat: new Date(now).toISOString(), state: req.state };
    });
  }

  /**
   * Rewrite one issue's body — groom's route, and the only route that does
   * (§6.4).
   *
   * Optimistic concurrency, not a lock: one FRESH read, a comparison of
   * `updated_at` against what the caller last saw, and a patch only if they
   * match. Fresh rather than cached because the cache is up to a poll interval
   * old and a stale stamp would compare equal to a body somebody has since
   * rewritten — the exact overwrite this check exists to prevent.
   *
   * A mismatch is a 409 carrying the CURRENT stamp, so the caller can re-read
   * and re-apply without a second round trip to learn it.
   */
  async patchBody(_project: RegistryProject, marker: SourceMarker, req: ItemBodyRequest): Promise<WriteOutcome<{ id: string; updatedAt: string }>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(req.id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${req.id} does not name an issue in ${repo}` } };

    return this.serialise(issueUrn(repo, number), async () => {
      const fresh = await this.client.issue(repo, number, { token });
      if (fresh.status !== 200 || fresh.data === null) return { ok: false as const, refusal: refusalFor(fresh) };
      this.poller.absorbIssue(repo, fresh.data);

      if (fresh.data.updated_at !== req.ifUpdatedAt) {
        return {
          ok: false as const,
          refusal: { refused: 'conflict' as const, error: `#${number} changed since you read it`, updatedAt: fresh.data.updated_at }
        };
      }

      const patched = await this.client.updateIssue(repo, number, { body: req.body }, { token });
      if (patched.status !== 200 || patched.data === null) return { ok: false as const, refusal: refusalFor(patched) };
      this.poller.absorbIssue(repo, patched.data);

      /* The `runner-fix` marker, moved by the same call (task-47) — after the
         body patch, never before it, so a failed patch leaves the label
         exactly as it was. The reverse order would relabel an issue whose
         text never changed.

         AFTER the concurrency check too, and that is the real reason this
         rides `body` at all: the marker is a groom's judgement about the plan
         it just wrote, and a caller that lost the `ifUpdatedAt` race has not
         written that plan. Its opinion about the label is as stale as its
         body was.

         Neither result is checked, and each for its own reason. A 404 from
         `removeLabel` means the label was not there, which IS this caller's
         contract ("`runner-fix` is not on the issue") — the same reasoning
         `release` spells out at length for `in-progress`. `addLabels` is
         idempotent on GitHub's side, so calling it on an issue that already
         carries the label is a 200 and not an error to absorb. And for both:
         the body is already patched, so failing here would report a patch
         that happened as one that did not, and the caller's retry would hit
         the `ifUpdatedAt` check against the stamp it no longer holds.

         The `updatedAt` answered below is therefore the PATCH's stamp, not the
         label change's, and a label write does move `updated_at` on GitHub.
         Left that way knowingly: it is the stamp of the write this route is
         about, the CLI prints it and nothing re-uses it, and the next groom
         re-reads the issue through `show --json` rather than remembering a
         number from a previous session. Re-reading the issue here to report a
         fresher stamp would be a third request for a value nobody holds on
         to. */
      if (req.runnerFix === true) await this.client.addLabels(repo, number, ['runner-fix'], { token });
      else if (req.runnerFix === false) await this.client.removeLabel(repo, number, 'runner-fix', { token });

      return { ok: true as const, value: { id: `#${number}`, updatedAt: patched.data.updated_at } };
    });
  }

  /** Append a comment and nothing else. */
  async comment(_project: RegistryProject, marker: SourceMarker, req: ItemCommentRequest): Promise<WriteOutcome<{ commentId: number; url: string }>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(req.id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${req.id} does not name an issue in ${repo}` } };

    return this.serialise(issueUrn(repo, number), async () => {
      const found = await this.issueNow(repo, number, token);
      if (!found.ok) return found;
      const posted = await this.client.createComment(repo, number, req.body, { token });
      if (posted.status !== 201 || posted.data === null) return { ok: false as const, refusal: refusalFor(posted) };
      this.poller.absorbComment(repo, posted.data);
      return { ok: true as const, value: { commentId: posted.data.id, url: posted.data.html_url } };
    });
  }

  /**
   * The newest claim on one item — the eighth route's whole implementation, and
   * the only read on `ItemWriter`.
   *
   * **Cache first, then one fresh read on a miss.** The cache is the fast path
   * and the common one: a claim this server posted is in it before the POST
   * that made it returned, so `stop` learns its own `start`'s comment id
   * without a request. The FALLBACK is what makes the answer trustworthy, and
   * it exists because of a Critical this branch's review caught — a cache miss
   * here is not "nobody holds it", it is "this process has not seen it", and
   * those are opposite answers to the one question `stop` and `heartbeat` ask.
   *
   * A miss is an ordinary state, not an exotic one: this process may have
   * started after the claim was posted, the poller is armed only once something
   * reads the board, and a second machine's server has never seen the first
   * machine's comments at all. Answering `null` there orphans the claim — the
   * CLI prints "not in progress", the counters only it can compute are lost,
   * `in-progress` and the assignee stay set, and the board draws a held item as
   * free. `issueNow` already handles exactly this shape for ISSUES, one line
   * over, and `allClaims` already paginates and absorbs what it reads.
   *
   * A genuinely unclaimed item costs one request per `stop` on a cold cache and
   * none afterwards, which is the right way round: the expensive case is the
   * one where being wrong is free, and the cheap case is the one where being
   * wrong loses a session's work.
   */
  async readClaim(_project: RegistryProject, marker: SourceMarker, id: string): Promise<WriteOutcome<ClaimResult | null>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${id} does not name an issue in ${repo}` } };

    const cached = newestClaim(claimsFor(number, this.poller.comments(repo)));
    if (cached !== null) return { ok: true, value: { commentId: cached.commentId, record: cached.record } };

    // The fallback. Serialised on this item's chain like every other call that
    // touches it, so a `stop` cannot read the comments while the `claim` that
    // is about to post one is mid-flight.
    return this.serialise(issueUrn(repo, number), async () => {
      const fresh = await this.allClaims(repo, number, token);
      if (!fresh.ok) return fresh;
      const newest = newestClaim(fresh.value);
      return { ok: true as const, value: newest === null ? null : { commentId: newest.commentId, record: newest.record } };
    });
  }

  /* ---------------------------------------------------------------------
   * The shared machinery the seven share.
   * ------------------------------------------------------------------- */

  /**
   * The two things every write needs, or the refusal in their place: a usable
   * repo off the marker, and a token.
   *
   * `no-token` is its own refusal (a 503) rather than an upstream failure,
   * because it is a fact about THIS machine that the person reading the message
   * can fix — and because sending an empty Authorization header would earn a
   * 401 that reads like a revoked credential.
   */
  private ready(marker: SourceMarker): WriteOutcome<{ repo: string; token: string }> {
    const repo = marker.repo;
    if (!isRepo(repo)) {
      return { ok: false, refusal: { refused: 'upstream', error: `backlog/source.json names no valid "repo" (expected "owner/name")`, status: 0 } };
    }
    const token = githubToken();
    if (token === null) {
      return { ok: false, refusal: { refused: 'no-token', error: 'BM_GITHUB_TOKEN is not set on this machine' } };
    }
    return { ok: true, value: { repo, token } };
  }

  /**
   * One issue, from the cache when it is there and from a fresh `GET` when it
   * is not — the "issue not found (fresh GET 404 after a cache miss)" rule.
   *
   * A cache miss is the ordinary case for an issue filed on another machine in
   * the last fifteen seconds, so a miss must not read as "no such issue". One
   * request answers both that and "does it exist at all".
   */
  private async issueNow(repo: string, number: number, token: string): Promise<WriteOutcome<GithubIssue>> {
    const cached = this.poller.issue(repo, number);
    if (cached !== undefined) return { ok: true, value: cached };
    const fetched = await this.client.issue(repo, number, { token });
    if (fetched.status !== 200 || fetched.data === null) return { ok: false, refusal: refusalFor(fetched) };
    this.poller.absorbIssue(repo, fetched.data);
    return { ok: true, value: fetched.data };
  }

  /** Every claim on one issue, fresh off the network and paginated to the end.
   *  Fresh because the protocol's whole job is to see a comment posted a second
   *  ago, which no cache can promise. */
  private async allClaims(repo: string, number: number, token: string): Promise<WriteOutcome<ParsedClaim[]>> {
    const comments: GithubComment[] = [];
    let page = await this.client.issueComments(repo, number, { token });
    for (;;) {
      if (page.status !== 200) return { ok: false, refusal: refusalFor(page) };
      if (Array.isArray(page.data)) comments.push(...page.data);
      if (page.next === null) break;
      page = await this.client.page<GithubComment[]>(page.next, { token });
    }
    for (const comment of comments) this.poller.absorbComment(repo, comment);
    return { ok: true, value: claimsFor(number, comments) };
  }

  /**
   * `release` and `heartbeat` are one shape — find the claim, decide, rewrite
   * the comment — so they share one implementation and differ only by the
   * `decide` callback. Two copies of "list the comments, find this one, refuse
   * if it is not there" is two places for the not-found case to read
   * differently.
   */
  private async editClaim(
    marker: SourceMarker,
    id: string,
    commentId: number,
    decide: (existing: ClaimRecord, now: number, number: number) => ClaimRecord | WriteRefusal,
    after?: (repo: string, number: number, token: string) => Promise<void>
  ): Promise<WriteOutcome<ClaimResult>> {
    const ready = this.ready(marker);
    if (!ready.ok) return ready;
    const { repo, token } = ready.value;

    const number = issueNumberFor(id, repo);
    if (number === null) return { ok: false, refusal: { refused: 'not-found', error: `${id} does not name an issue in ${repo}` } };

    return this.serialise(issueUrn(repo, number), async () => {
      const claims = await this.allClaims(repo, number, token);
      if (!claims.ok) return claims;
      const existing = claims.value.find((c) => c.commentId === commentId);
      if (existing === undefined) {
        return { ok: false as const, refusal: { refused: 'not-found' as const, error: `no claim ${commentId} on #${number}` } };
      }

      const decided = decide(existing.record, Date.now(), number);
      if ('refused' in decided) return { ok: false as const, refusal: decided };

      const edited = await this.client.updateComment(repo, commentId, renderClaim(decided), { token });
      if (edited.status !== 200 || edited.data === null) return { ok: false as const, refusal: refusalFor(edited) };
      this.poller.absorbComment(repo, edited.data);
      if (after !== undefined) await after(repo, number, token);
      return { ok: true as const, value: { commentId, record: decided } };
    });
  }

  /**
   * Run `fn` after every write already queued for this URN. The chain is kept
   * alive through failures (`then(fn, fn)`): one write refusing must not strand
   * every later write to the same item behind a rejected promise.
   *
   * The entry is dropped once it is the tail again, so the map is bounded by
   * the number of items being written RIGHT NOW rather than by every item this
   * process has ever written.
   */
  private serialise<T>(urn: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(urn) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(urn, settled);
    void settled.then(() => {
      if (this.chains.get(urn) === settled) this.chains.delete(urn);
    });
    return next;
  }

  /** The URN → cached issue lookup `body` and `find` share: shape, registry
   *  gate, cache — in that order, so an unconnected repo's URN never reaches
   *  the cache at all. */
  private cachedIssueFor(ref: string, registry: Registry): { repo: string; issue: GithubIssue } | null {
    const urn = parseUrn(ref);
    if (urn === null) return null;
    if (!connectedRepos(registry).has(urn.repo)) return null;
    const issue = this.poller.issue(urn.repo, urn.number);
    return issue === undefined ? null : { repo: urn.repo, issue };
  }

  /** One registered project's repo, or `null` — the registry side of the gate,
   *  read per call for the reason `connectedRepos` gives. */
  private repoOf(project: RegistryProject): string | null {
    const resolved = resolveSource(project.path, KNOWN);
    if (resolved.kind !== 'tracker') return null;
    return isRepo(resolved.marker.repo) ? resolved.marker.repo : null;
  }
}

/** `bugs` → `type:bug`. The four sections that ARE a label; `out-of-scope` is
 *  deliberately absent — it is a closed state, not a type (see `labels.ts`). */
const TYPE_LABEL_BY_SECTION: Partial<Record<Section, string>> = {
  bugs: 'type:bug',
  ideas: 'type:idea',
  tasks: 'type:task',
  refactors: 'type:refactor'
};

const ZERO_COUNTERS: ClaimCounters = { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 };

/**
 * One failed `GithubResponse` → the refusal a route answers with. ONE mapping,
 * for the reason `handleFailure` in the poller gives for its own: every request
 * in this file can fail the same handful of ways, and a copy per method is how
 * one of them ends up reporting a rate limit as an upstream error.
 */
function refusalFor(res: GithubResponse<unknown>): WriteRefusal {
  if (res.secondary) {
    return { refused: 'rate-limited', error: 'secondary rate limit — try again in a minute' };
  }
  const limited = (res.status === 403 || res.status === 429) && (res.rate.remaining === 0 || res.retryAfter !== null);
  if (limited) {
    const resetMs = res.retryAfter !== null ? Date.now() + res.retryAfter * 1000 : res.rate.reset !== null ? res.rate.reset * 1000 : Date.now() + 60_000;
    // The reset TIME, never a duration — the rule `handleFailure`'s `detail`
    // already follows, for the same reason: a message read four minutes later
    // still reads true.
    const resetAt = new Date(resetMs).toISOString();
    return { refused: 'rate-limited', error: `rate limit reached — resets ${resetAt}`, resetAt };
  }
  if (res.status === 404) return { refused: 'not-found', error: res.error ?? 'not found' };
  return { refused: 'upstream', error: res.error ?? `HTTP ${res.status}`, status: res.status };
}

/**
 * How old a heartbeat is at `now`, in milliseconds, never negative and never
 * `NaN`.
 *
 * A number rather than the timestamp alone because the caller's clock is not
 * the one the liveness decision was made on: a CLI a few seconds out of step
 * with the server would print a different age than the one the refusal was
 * computed from, and the age is exactly what a person reads to decide whether
 * the holder is really still there. An unparseable heartbeat reads as `0` —
 * a claim whose heartbeat cannot be parsed is not live (`isLive`), so it never
 * reaches this as a holder; `0` is the honest "we cannot say" rather than a
 * fabricated duration.
 */
function ageMsOf(heartbeat: string, now: number): number {
  const beat = Date.parse(heartbeat);
  if (Number.isNaN(beat)) return 0;
  return Math.max(0, now - beat);
}

/** `unref`'d so a settle window never keeps the process alive on its own — the
 *  same treatment the poller's and the watchdog's timers get. */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The repos the registry says someone is connected to, right now. Built from
 *  the registry handed in, one `resolveSource` per project — the same per
 *  request read `ItemsService` already makes, and deliberately not a cached
 *  set: connecting or disconnecting a project must take effect on the next
 *  request, like every other registry-shaped change in this server. */
function connectedRepos(registry: Registry): Set<string> {
  const out = new Set<string>();
  for (const project of registry.projects) {
    const resolved = resolveSource(project.path, KNOWN);
    if (resolved.kind !== 'tracker') continue;
    if (isRepo(resolved.marker.repo)) out.add(resolved.marker.repo);
  }
  return out;
}

const KNOWN: ReadonlySet<string> = new Set(['github']);
