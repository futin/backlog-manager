import type { SourceMarker } from './resolve.util';
import type { BacklogItem, ProjectSummary, Registry, RegistryProject, SourceKind } from '../../../../shared/types';

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
