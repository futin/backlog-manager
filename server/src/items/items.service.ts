import { HttpException, Inject, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { resolveSource } from './sources/resolve.util';
import { ITEM_SOURCES, type ItemSource } from './sources/source';
import { uncommittedItemPaths, type UncommittedItems } from './uncommitted.util';
import type { ItemsIndex, ProjectSummary, SectionCounts, SourceKind } from '../../../shared/types';

/**
 * All reads walk the registry and the stores per request, like guide-manager's
 * RegistryService: a capture made mid-session shows up on the next fetch
 * without a restart, and the whole corpus is a few hundred small files —
 * nothing worth a cache that could go stale.
 *
 * Since task-43 the scan is reached through the item-source seam rather than
 * called directly: each registered project's source is resolved from its own
 * committed `backlog/source.json` (per request, same rule as the registry) and
 * the matching adapter answers. Today exactly one adapter is registered, so
 * every project resolves to `files` and the payloads are what they always
 * were plus the `source` field — the seam is the change, not the behaviour.
 */
@Injectable()
export class ItemsService {
  /** The registered adapters, keyed by the marker value each one serves. */
  private readonly sources: ReadonlyMap<SourceKind, ItemSource>;
  /** The key set, handed to `resolveSource` as the kinds this build can honour. */
  private readonly known: ReadonlySet<string>;

  constructor(
    private readonly registry: RegistryService,
    @Inject(ITEM_SOURCES) sources: ItemSource[]
  ) {
    const map = new Map<SourceKind, ItemSource>();
    for (const source of sources) {
      // Throw rather than last-wins: the loser would answer nothing, and a
      // board that silently renders one source's items while another's never
      // appear is wrong without ever saying so. A provider that throws fails
      // the boot, with the duplicated kind in the message.
      if (map.has(source.kind)) throw new Error(`two item sources registered for kind "${source.kind}"`);
      map.set(source.kind, source);
    }
    this.sources = map;
    this.known = new Set(map.keys());
  }

  /**
   * The adapter a live resolution names — one implementation, because
   * `index()` and `projects()` both ask it and two copies of "which adapter
   * serves this" is two places for a third source to be forgotten. `missing`
   * and `unsupported` never reach here: neither has an adapter, and both are
   * the CALLER's to render (skipped, or a summary with zero counts).
   */
  private adapterFor(resolved: { kind: 'files' } | { kind: 'tracker'; marker: { kind: string } }): ItemSource | undefined {
    // The cast is the seam's one piece of dishonesty in this phase, and it is
    // contained: `SourceKind` is `'files'` alone today, while the resolver
    // answers `tracker` only for a kind in `known`, which IS this map's key
    // set. So the string is always a registered key at runtime; the compiler
    // simply has no `'github'` to be told about yet. Phase 2 widens the union
    // and this line stops needing it.
    return this.sources.get(resolved.kind === 'files' ? 'files' : (resolved.marker.kind as SourceKind));
  }

  async index(): Promise<ItemsIndex> {
    const items: ItemsIndex['items'] = [];
    const errors: string[] = [];
    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, this.known);
      // A missing store is /api/projects' news (flagged there), not a scan
      // error to repeat on every item fetch.
      if (resolved.kind === 'missing') continue;
      if (resolved.kind === 'unsupported') {
        // Handled here rather than in an adapter, for the obvious reason that
        // there is no adapter to handle it — that IS the case. The reason is
        // already path-prefixed, so it reads like every other scan error.
        errors.push(resolved.reason);
        continue;
      }
      const source = this.adapterFor(resolved);
      // Unreachable while `known` is built from this same map — the resolver
      // only answers `tracker` for a kind it was told about — but the map
      // lookup is still an Option, and a silent `undefined` here would drop a
      // whole project's items with no error at all.
      if (source === undefined) {
        errors.push(`${project.path}: no item source registered for this project`);
        continue;
      }
      const listed = await source.list(project, resolved.kind === 'tracker' ? resolved.marker : null);
      items.push(...listed.items);
      errors.push(...listed.errors);
    }
    return { items, errors };
  }

  async projects(): Promise<ProjectSummary[]> {
    const summaries: ProjectSummary[] = [];
    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, this.known);
      // `missing` keeps exactly its old meaning — no backlog/ directory at
      // all — so an unsupported marker is `missing: false`: the store is
      // there, it is this build that cannot read who owns it.
      const missing = resolved.kind === 'missing';
      // Every section spelled out with a zero rather than built by
      // accumulation: `SectionCounts` is a total Record, so a section missing
      // here is a compile error rather than an `undefined` the client would
      // render as blank. That is the whole point of the annotation — adding
      // `refactors` to `Section` broke this line until it was listed, which is
      // exactly the reminder a new section should get.
      const counts: SectionCounts = { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 };
      let source: ProjectSummary['source'] = null;

      if (resolved.kind === 'unsupported') {
        // Counts stay at zero and the reason is NOT repeated here: it travels
        // in ItemsIndex.errors, which is the one home for "why this project
        // contributed nothing". `'unsupported'` never reads as `'files'`.
        source = 'unsupported';
      } else if (resolved.kind !== 'missing') {
        source = resolved.kind === 'files' ? 'files' : (resolved.marker.kind as SourceKind);
        const adapter = this.adapterFor(resolved);
        if (adapter === undefined) {
          source = 'unsupported';
        } else {
          for (const it of (await adapter.list(project, resolved.kind === 'tracker' ? resolved.marker : null)).items) {
            // "open" counts: done items are history. out-of-scope is terminal
            // and counts as itself — its number is how many were declined.
            if (it.status === 'done') continue;
            counts[it.section]++;
          }
        }
      }

      summaries.push({ name: project.name, path: project.path, createdAt: project.createdAt, missing, counts, source });
    }
    return summaries;
  }

  /**
   * GET /api/items/uncommitted's whole implementation (task-32) — which of
   * this project's item files differ from `main`, i.e. which ones a
   * board-started run will read a DIFFERENT copy of than the board is
   * showing. Deliberately not "which ones the run cannot see": half of them
   * it can, and `uncommitted.util.ts`'s header carries both fates.
   *
   * Registry-gated exactly like `AgentsService.mergeCheck`: a RAW STRING
   * compare against the registry's own `path` field, deliberately not
   * `samePath`'s realpath compare, matching the "deliberately not realpath"
   * rule CLAUDE.md pins on `dispatchGate`'s membership check. That choice is
   * load-bearing rather than merely mirrored: `realpathSync`-ing an
   * unregistered path before comparing it would itself BE the filesystem
   * touch `test/uncommitted.test.ts`'s unregistered case proves never
   * happens, and "gate first" is a stronger guarantee than "eventually
   * degrades to known: false".
   *
   * No cache, per `uncommitted.util.ts`'s own header: the whole point of this
   * read is an event — an edit in the working tree — that no cheap key moves.
   *
   * Untouched by the item-source seam (task-43) and synchronous still: the
   * question is about files in a git working tree, which is what this route
   * means whatever owns the items.
   */
  uncommitted(project: string): UncommittedItems {
    const entry = this.registry.load().projects.find((p) => p.path === project);
    if (entry === undefined) throw new HttpException({ error: 'not found' }, 404);
    return uncommittedItemPaths(entry.path);
  }

  /**
   * The Markdown body of one item, delegated to the files adapter (task-43),
   * which holds the behaviour verbatim: allowlist, `.md` only, frontmatter
   * stripped, `null` on every failure so the caller answers 404 without
   * learning why.
   *
   * Phase 2 dispatches on the ref's SHAPE here — a URN goes to the tracker
   * adapter, a filesystem path to files — and this is the seam's one place for
   * that decision. It is a single delegation today because there is no URN yet
   * to dispatch on, and a shape test with one shape is a guess written down.
   */
  async body(requestPath: string): Promise<string | null> {
    const files = this.sources.get('files');
    if (files === undefined) return null;
    return files.body(requestPath, this.registry.load());
  }
}
