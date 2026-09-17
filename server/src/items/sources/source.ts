import type { SourceMarker } from './resolve.util';
import type { BacklogItem, Registry, RegistryProject, SourceKind } from '../../../../shared/types';

/**
 * The item-source seam (task-43, spec §4.1): one implementation per
 * `SourceKind`, and `ItemsService` dispatches over them instead of calling the
 * scanner directly. The point of the seam is that phase 2 adds a GitHub
 * adapter by writing one class and appending it to the module's factory — the
 * service's control flow does not change again.
 *
 * Asynchronous throughout, although the only adapter this build ships is
 * synchronous underneath. A tracker adapter reads a cache a poller fills, so
 * the signature has to be async for it; making it async NOW means the
 * controller, the service and every test learned to await in this phase,
 * where nothing else is moving, rather than in the phase that also introduces
 * network I/O, a cache and a poller.
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
}

/**
 * The injection token the module provides `ItemSource[]` under. A token rather
 * than a constructor-built list so phase 2 registers its adapter in
 * `items.module.ts` and edits nothing in the service.
 *
 * No `summary(project)` member yet: the spec defers it to phase 2, the first
 * phase with a value for it (a tracker's connection state). Phase 1 derives
 * counts from `list` in the service, as today.
 */
export const ITEM_SOURCES = Symbol('ITEM_SOURCES');
