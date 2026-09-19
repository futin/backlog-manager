import type { SourceMarker } from './resolve.util';
import type {
  BacklogItem,
  ClaimRefused,
  ClaimResult,
  ItemBodyRequest,
  ItemClaimRequest,
  ItemCommentRequest,
  ItemCreateRequest,
  ItemHeartbeatRequest,
  ItemReleaseRequest,
  ItemStateRequest,
  ProjectSummary,
  Registry,
  RegistryProject,
  SourceKind
} from '../../../../shared/types';

/**
 * The item-source seam (task-43, spec §4.1): one implementation per
 * `SourceKind`, and `ItemsService` dispatches over them instead of calling the
 * scanner directly. The point of the seam is that phase 2 adds a GitHub
 * adapter by writing one class and appending it to the module's factory — the
 * service's control flow does not change again.
 *
 * Asynchronous throughout, which phase 1 chose before it had an adapter that
 * needed it: `FilesSource` is synchronous underneath, and `GithubSource`
 * (task-45) reads a cache a poller fills. Making the signature async in the
 * phase where nothing else was moving is why the controller, the service and
 * every test had already learned to await by the time network I/O, a cache and
 * a poller arrived.
 */
export interface ItemSource {
  /** The marker value this adapter serves — the key the service maps it by. */
  readonly kind: SourceKind;

  /**
   * Every item of one registered project, plus the per-file errors that did
   * not abort the read. Same tolerant contract `scanProject` has: one
   * malformed item is an entry in `errors`, never a thrown request.
   *
   * `marker` is the resolved marker for a tracker (`null` for `files`, which
   * ignores it). It is carried NOW, before any adapter reads it, so the
   * seam's signature does not change when the first tracker arrives — a
   * tracker adapter reads its repo off exactly this object.
   */
  list(project: RegistryProject, marker: SourceMarker | null): Promise<{ items: BacklogItem[]; errors: string[] }>;

  /**
   * One item's Markdown body, or `null` when this adapter will not serve it.
   * For `files` the ref is a filesystem path, checked against the
   * registry-built allowlist exactly as before; for a tracker it will be a
   * URN answered from the cache.
   *
   * The registry travels as an argument rather than being injected into the
   * adapter, so an adapter stays a plain object over its own source and the
   * service keeps the one read of the registry per request.
   */
  body(ref: string, registry: Registry): Promise<string | null>;

  /**
   * The connection half of one project's `ProjectSummary` (spec §5.4) — the
   * four fields that describe how, and how recently, this adapter can see the
   * project's items. Deferred to task-45 by this interface's phase-1 version,
   * which said so outright: phase 2 is the first phase with a VALUE for it,
   * because it is the first with a connection that can be down.
   *
   * `marker` travels for the same reason it travels on `list`: a tracker
   * adapter reads its repo off exactly that object, and a `summary` that had
   * to find the repo another way would be a second resolution path for the
   * one question `resolveSource` already answered.
   *
   * The files adapter answers four `null`s. That is not a stub — it is the
   * true answer: a store on disk has no repo, no poll, no access state and
   * nothing to detail, and the fields exist on every summary so the shape
   * stays total (see `ProjectSummary` in shared/types.ts).
   */
  summary(project: RegistryProject, marker: SourceMarker | null): Promise<SourceSummary>;

  /**
   * One item by the ref that identifies it — a filesystem path for `files`, a
   * `gh:<owner>/<repo>#<n>` URN for a tracker — or `null` when this adapter
   * will not serve it (task-46).
   *
   * The dispatch lift's lookup. `AgentsService` used to own a private
   * `findItem` that walked the registry-built allowlist and scanned every
   * project, which is exactly the files adapter's job stated a second time in a
   * module that has no business knowing what an item file is; it is now a
   * one-line delegate to `ItemsService.find`, which dispatches over these
   * implementations the same way `body` does.
   *
   * Same gating rule as `body`, on each side: the files adapter answers `null`
   * for anything outside a registered `backlog/`, and the tracker adapter
   * answers `null` for a URN naming a repo no registered project is connected
   * to. A caller cannot route its own ref to an adapter by asserting a kind —
   * the REF'S SHAPE decides, in one place, which is the same rule "dispatch
   * derives the action, it never accepts one" states for the agents routes.
   */
  find(ref: string, registry: Registry): Promise<BacklogItem | null>;

  /**
   * How this adapter WRITES, or `undefined` when it does not write through the
   * API at all (task-46, spec §6.2).
   *
   * `FilesSource` deliberately has none, and the absence is the rule rather
   * than a gap: item files are written by the skills and by nothing else
   * (CLAUDE.md, "Item files are read-only to the server and client"). A files
   * project reaching a write route is a 400 saying so, produced by the ONE
   * check that reads this field — never by seven routes each remembering to
   * ask.
   */
  readonly writer?: ItemWriter;
}

/**
 * Why a write could not happen, as a VALUE (task-46).
 *
 * The same posture `GithubClient` takes one layer down and for the same
 * reason: every one of these is a state of the world a caller has to branch
 * on — a missing credential, an issue somebody closed, a race lost, GitHub
 * being out of budget — rather than an exception a request handler should
 * turn into a 500. The controller maps each `refused` to exactly one status
 * and nothing else decides.
 *
 * `error` is the sentence the route answers with, composed here because the
 * adapter is the only layer that knows what actually happened; the controller
 * chooses the STATUS and copies the sentence.
 */
export interface WriteRefusal {
  refused: 'no-token' | 'not-found' | 'conflict' | 'upstream' | 'rate-limited';
  error: string;
  /** `rate-limited` only: when the budget comes back, as an ISO timestamp.
   *  The reset TIME rather than a duration, the rule `handleFailure`'s
   *  `detail` already follows — a card read four minutes later still reads
   *  true. */
  resetAt?: string;
  /** `upstream` only: GitHub's own status, so a reader can tell a 422 from a
   *  500 without the sentence having to encode it. */
  status?: number;
  /** `conflict` from `claim`/`release` only: who holds the issue. */
  holder?: ClaimRefused['holder'];
  /** `conflict` from `body` only: the issue's `updated_at` as it is NOW, so the
   *  caller can re-read and re-apply without a second round trip to learn it. */
  updatedAt?: string;
}

/** A write's answer: the value, or why not. A discriminated union rather than
 *  `T | null`, because "which of five refusals" is the whole thing the routes
 *  have to tell apart. */
export type WriteOutcome<T> = { ok: true; value: T } | { ok: false; refusal: WriteRefusal };

/** `create`'s answer — every handle the CLI prints, in the three spellings a
 *  caller might need: the short id, the URN that is `BacklogItem.path`, and the
 *  URL a person opens. */
export interface CreatedItem {
  id: string;
  urn: string;
  url: string;
  number: number;
}

/**
 * The write half of one source (task-46, spec §6.2) — seven methods, one per
 * route, each a value-returning call the controller turns into a status.
 *
 * Every method takes the RESOLVED project and marker rather than a project
 * path: `ItemsService.writerFor` has already gated the path against the
 * registry (a raw string compare, deliberately not realpath — the
 * `uncommitted` rule) and resolved the marker per request, so an implementation
 * here never re-asks either question and can never answer it differently.
 */
export interface ItemWriter {
  /** A new item. The section becomes the `type:*` label; `out-of-scope` becomes
   *  an untyped issue closed `not_planned` in the same call. */
  create(project: RegistryProject, marker: SourceMarker, req: ItemCreateRequest): Promise<WriteOutcome<CreatedItem>>;

  /** `move <id> done|out-of-scope`. A non-empty `outcome` is posted as a
   *  comment FIRST, so the issue's timeline reads in the order the work
   *  happened. Labels and claims are untouched — release is the only thing that
   *  clears `in-progress`. */
  state(project: RegistryProject, marker: SourceMarker, req: ItemStateRequest): Promise<WriteOutcome<{ id: string; status: string; url: string }>>;

  /** Take the issue, by the protocol in `server/src/tracker/claim.ts`. */
  claim(project: RegistryProject, marker: SourceMarker, req: ItemClaimRequest): Promise<WriteOutcome<ClaimResult>>;

  /** Give it back, billing the counters the caller computed. The CLI is the
   *  biller — it holds the clock and the transcript — so `counters` is written
   *  verbatim and this layer computes none of it. */
  release(project: RegistryProject, marker: SourceMarker, req: ItemReleaseRequest): Promise<WriteOutcome<ClaimResult>>;

  /** Say the session is still alive, and carry phase 4's opaque `state` when
   *  one is given. */
  heartbeat(project: RegistryProject, marker: SourceMarker, req: ItemHeartbeatRequest): Promise<WriteOutcome<ClaimResult>>;

  /**
   * Groom's route, and the ONE route that rewrites an item's body (§6.4),
   * behind an `ifUpdatedAt` check against a FRESH read.
   *
   * Named `patchBody` rather than `body` so an adapter can implement BOTH
   * halves of its source in one class: `ItemSource.body(ref, registry)` reads
   * and this writes, and TypeScript has no way to give one method name two
   * signatures across two interfaces. The ROUTE is still `/api/items/body` —
   * this name is an implementation constraint and is deliberately not visible
   * in the HTTP surface.
   */
  patchBody(project: RegistryProject, marker: SourceMarker, req: ItemBodyRequest): Promise<WriteOutcome<{ id: string; updatedAt: string }>>;

  /** Append a comment. Execute's failure path: the Outcome is recorded and the
   *  item does not move. */
  comment(project: RegistryProject, marker: SourceMarker, req: ItemCommentRequest): Promise<WriteOutcome<{ commentId: number; url: string }>>;

  /**
   * The newest claim on one item, or `null` for an item nobody has ever
   * claimed — the one READ on this interface, and the eighth route
   * (`GET /api/items/claim`) behind the seven the spec names.
   *
   * It is here rather than on `ItemSource` because the claim IS the writer's:
   * the protocol writes it, the protocol's vocabulary describes it, and the
   * same project gate that decides whether this process may write to a repo is
   * the one that decides whether it may be told who holds an item.
   *
   * It exists because `start` and `stop` are TWO PROCESSES. `claim` answers the
   * comment id that identifies the claim, and `stop` — a separate `backlog.mjs`
   * invocation, possibly minutes later — has to rediscover it in order to
   * `release` or `heartbeat` it. Without this the CLI could take an item and
   * never give it back. The spec's §6.2 names seven write routes and does not
   * name this one; the deviation is recorded in the task item's Outcome.
   *
   * Answered from the CACHE when it is there, and from ONE fresh read when it
   * is not. The cache is the fast path — a claim this server posted is in it
   * before the POST that made it returned — but a miss is not "nobody holds
   * it", it is "this process has not seen it", and those are opposite answers
   * to the question `stop` asks. A process that started after the claim was
   * posted, or a second machine's server, has every right to a miss; answering
   * `null` there orphans the claim and loses the counters only the CLI can
   * compute. (Task-46's review caught exactly that, one layer down in the
   * poller's own comment cache.)
   */
  readClaim(project: RegistryProject, marker: SourceMarker, id: string): Promise<WriteOutcome<ClaimResult | null>>;
}

/**
 * The four connection fields of `ProjectSummary`, as their own type so the
 * adapter contract and the payload cannot drift: `ItemsService` spreads this
 * straight into the summary it builds, so a field added here has to be
 * answered by every adapter and appears on the payload in one edit rather
 * than three.
 */
export type SourceSummary = Pick<ProjectSummary, 'repo' | 'polledAt' | 'access' | 'detail'>;

/**
 * The injection token the module provides `ItemSource[]` under. A token rather
 * than a constructor-built list so phase 2 registers its adapter in
 * `items.module.ts` and edits nothing in the service.
 *
 * `summary` arrived in task-45, exactly where phase 1 said it would. Counts
 * are still derived from `list` in the service rather than asked for here:
 * they are a fact about the items an adapter already returned, not about the
 * connection, and two ways to count one project's sections is one too many.
 */
export const ITEM_SOURCES = Symbol('ITEM_SOURCES');
