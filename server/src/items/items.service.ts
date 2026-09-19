import { HttpException, Inject, Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { resolveSource } from './sources/resolve.util';
import type { SourceMarker } from './sources/resolve.util';
import { parseUrn } from '../tracker/map-issue';
import { ITEM_SOURCES, type ItemSource, type ItemWriter, type SourceSummary } from './sources/source';
import { uncommittedItemPaths, type UncommittedItems } from './uncommitted.util';
import type { BacklogItem, ClaimResult, ItemsIndex, ProjectSummary, RegistryProject, SectionCounts } from '../../../shared/types';

/**
 * All reads walk the registry and the stores per request, like guide-manager's
 * RegistryService: a capture made mid-session shows up on the next fetch
 * without a restart, and the whole corpus is a few hundred small files —
 * nothing worth a cache that could go stale.
 *
 * Since task-43 the scan is reached through the item-source seam rather than
 * called directly: each registered project's source is resolved from its own
 * committed `backlog/source.json` (per request, same rule as the registry) and
 * the matching adapter answers. Two adapters are registered since task-45 —
 * `files` and `github` — and this file did not change to accept the second
 * one, which was the seam's whole claim. What it did gain is the body route's
 * shape test (see `body` below), which phase 1 named this phase as the place
 * for.
 */
@Injectable()
export class ItemsService {
  /**
   * The registered adapters, keyed by the marker value each one serves. Keyed
   * by `string` rather than by `SourceKind`, deliberately: the lookup key is a
   * `kind` read off a marker file on disk, which is a string until an adapter
   * claims it, and typing the key as the union forced a cast at every call
   * site that could never be anything but true. The VALUES still carry their
   * own `kind: SourceKind`, so the union is where it belongs — on the adapter
   * that has to be in it — and `adapter.kind` is the typed answer to "which
   * kind produced this", with no cast anywhere (task-45).
   */
  private readonly sources: ReadonlyMap<string, ItemSource>;
  /** The key set, handed to `resolveSource` as the kinds this build can honour. */
  private readonly known: ReadonlySet<string>;

  constructor(
    private readonly registry: RegistryService,
    @Inject(ITEM_SOURCES) sources: ItemSource[]
  ) {
    const map = new Map<string, ItemSource>();
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
    // No cast since task-45 widened `SourceKind`: the map is keyed by a string
    // union, `get` takes a string, and the resolver only ever answers
    // `tracker` for a kind in `known` — which IS this map's key set — so a
    // lookup that misses is the unreachable case the callers already report
    // rather than a type hole.
    return this.sources.get(resolved.kind === 'files' ? 'files' : resolved.marker.kind);
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
      // The four connection fields default to their non-tracker answer, which
      // is also the right answer for `missing` and for `unsupported`: neither
      // has an adapter to ask, and neither has a connection.
      let connection: SourceSummary = { repo: null, polledAt: null, access: null, detail: null };

      if (resolved.kind === 'unsupported') {
        // Counts stay at zero and the reason is NOT repeated here: it travels
        // in ItemsIndex.errors, which is the one home for "why this project
        // contributed nothing". `'unsupported'` never reads as `'files'`.
        source = 'unsupported';
      } else if (resolved.kind !== 'missing') {
        const adapter = this.adapterFor(resolved);
        if (adapter === undefined) {
          // Unreachable while `known` is built from this same map, and the
          // same belt `index()` wears: a kind nobody serves reads as
          // `unsupported` here rather than as a summary claiming a source
          // that answered nothing.
          source = 'unsupported';
        } else {
          // The adapter's own `kind`, not the marker's string — the summary
          // field means "which adapter produced this project's items", so
          // reading it off the adapter that just produced them is the honest
          // answer AND the one the compiler can check. This is where the
          // second of task-43's two casts used to be (task-45).
          source = adapter.kind;
          const marker = resolved.kind === 'tracker' ? resolved.marker : null;
          for (const it of (await adapter.list(project, marker)).items) {
            // "open" counts: done items are history. out-of-scope is terminal
            // and counts as itself — its number is how many were declined.
            if (it.status === 'done') continue;
            counts[it.section]++;
          }
          // The connection half (spec §5.4), asked of the same adapter in the
          // same pass: four nulls from files, the live tracker state from a
          // tracker. Spread rather than copied field by field, so a fifth
          // field on `SourceSummary` reaches the payload without an edit here.
          connection = await adapter.summary(project, marker);
        }
      }

      summaries.push({ name: project.name, path: project.path, createdAt: project.createdAt, missing, counts, source, ...connection });
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
    // A tracker project has no item files, so "which of them differ from
    // `main`" is not a question with a wrong answer — it is a question with no
    // meaning, and `known: false` is precisely the shape this endpoint already
    // has for that (task-45, spec §5.5). The sheet's existing `known` gate
    // keeps the chip off; nothing new was added on the client for this.
    //
    // Note what does NOT change: `uncommitted` stays a sibling endpoint rather
    // than a `BacklogItem` field, nothing derived reads it, and it still
    // changes no default selection. The rule this answers is CLAUDE.md's, and
    // answering it earlier for one kind of project does not move it.
    if (resolveSource(entry.path, this.known).kind === 'tracker') return { paths: [], known: false };
    return uncommittedItemPaths(entry.path);
  }

  /**
   * The Markdown body of one item, delegated to the files adapter (task-43),
   * which holds the behaviour verbatim: allowlist, `.md` only, frontmatter
   * stripped, `null` on every failure so the caller answers 404 without
   * learning why.
   *
   * Since task-45 it dispatches on the ref's SHAPE, exactly where phase 1 said
   * it would: a `gh:<owner>/<repo>#<n>` URN goes to the tracker adapter, and
   * anything else is a filesystem path and goes to files. This is the seam's
   * ONE home for that decision — the controller does not repeat it, and
   * neither does any adapter: each still answers `null` for a ref it will not
   * serve, which is what makes an unconnected repo's URN a 404 rather than a
   * files-allowlist lookup.
   *
   * The shape test is the ref's, never the caller's: nothing in the request
   * says which source to ask, so a caller cannot route its own path to an
   * adapter by asserting a kind. That is the same rule "dispatch derives the
   * action, it never accepts one" states for the agents routes.
   */
  async body(requestPath: string): Promise<string | null> {
    const adapter = this.adapterForRef(requestPath);
    if (adapter === undefined) return null;
    return adapter.body(requestPath, this.registry.load());
  }

  /**
   * One item by the ref that names it (task-46) — the same dispatch `body`
   * above makes, over the same one decision, for the agents routes' lookup.
   *
   * This is the ONE home for "which adapter owns this ref", and it is why
   * `AgentsService.findItem` is now a one-line delegate: that method used to
   * hold a second copy of the files adapter's allowlist-and-scan, which meant
   * `plan` and `dispatch` could only ever see a file. Nothing in `agents/`
   * knows what a URN is any more.
   */
  async find(ref: string): Promise<BacklogItem | null> {
    const adapter = this.adapterForRef(ref);
    if (adapter === undefined) return null;
    return adapter.find(ref, this.registry.load());
  }

  /**
   * Does this project's items come from a tracker (task-46)?
   *
   * One question, asked by one caller: `AgentsService.resolveIds`, which since
   * task-47 uses it to decide which VOCABULARY an `ids` list is in — a tracker
   * project's ids are issue numbers, proved against `ItemsService` and
   * normalised to bare digits, where a files project's are `<prefix>-<n>`
   * proved against a directory scan. Until then the caller was
   * `orchestrate()`'s own refusal, which phase 4a removed.
   *
   * It is a separate method from `writerFor` below because it is a different
   * question — "which vocabulary do this project's ids use" rather than "may
   * these routes write to it" — and folding them would make the id check
   * accidentally depend on whether an adapter happens to ship a writer.
   *
   * Registry compare and `resolveSource` per request, the same two reads every
   * other method here makes, cached nowhere.
   */
  isTrackerProject(projectPath: string): boolean {
    const entry = this.registry.load().projects.find((p) => p.path === projectPath);
    if (entry === undefined) return false;
    return resolveSource(entry.path, this.known).kind === 'tracker';
  }

  /**
   * How, if at all, one registered project's items may be WRITTEN through this
   * API (task-46, spec §6.2) — the one gate the seven write routes share.
   *
   * Four answers rather than a boolean, because the routes owe four different
   * HTTP statuses and the difference between them is the whole of what a caller
   * can act on: a path nobody registered (404), a project whose items are files
   * and are the skills' to write (400), a marker this build cannot honour (400,
   * carrying `resolveSource`'s own reason), and an adapter that can write (the
   * call).
   *
   * Registry-gated by a RAW STRING COMPARE against the registry's own `path`,
   * deliberately not `samePath`'s realpath compare — the identical rule
   * `uncommitted` above and `dispatchGate` follow, and load-bearing for the
   * identical reason: realpath-ing an unregistered path before comparing it
   * would itself be a filesystem touch on a path this server was never given.
   *
   * `resolveSource` per request, never cached, exactly as `index()` and
   * `projects()` do it — connecting a project takes effect on the next request,
   * not on the next restart.
   */
  writerFor(projectPath: string): WriterLookup {
    const entry = this.registry.load().projects.find((p) => p.path === projectPath);
    if (entry === undefined) return { kind: 'unregistered' };

    const resolved = resolveSource(entry.path, this.known);
    if (resolved.kind === 'unsupported') return { kind: 'unsupported', reason: resolved.reason };
    // `missing` reads as `files` here, and that is the right answer rather than
    // a fifth case: a project with no `backlog/` at all is a project whose
    // items would be files if it had any, and the sentence a caller needs —
    // "this project's items are files; the skills write them directly" — is the
    // same one. A tracker project always has a `backlog/` (the marker lives in
    // it), so `missing` can never be a tracker.
    if (resolved.kind === 'missing' || resolved.kind === 'files') return { kind: 'files' };

    const adapter = this.adapterFor(resolved);
    // No adapter, or an adapter that does not write: both are "this build
    // cannot write to that", and the marker's own reason is the honest thing to
    // say. Unreachable for `files` (which is answered above) and for `github`
    // (which writes), so this covers only a kind registered without a writer —
    // the shape a future read-only adapter would have.
    if (adapter?.writer === undefined) {
      return { kind: 'unsupported', reason: `${entry.path}: source kind "${resolved.marker.kind}" cannot be written to by this build` };
    }
    return { kind: 'writer', writer: adapter.writer, project: entry, marker: resolved.marker };
  }

  /**
   * Who holds one item right now, or `null` — `GET /api/items/claim`'s whole
   * implementation (task-46).
   *
   * Gated through `writerFor`, not through a second lookup of its own: the
   * question "may this caller be told who holds this item" has exactly the same
   * answer as "may this caller write to it", and the claim is the writer's to
   * describe. A files project and an unregistered path both answer 404 here —
   * neither has a claim, and the two failures are not worth telling apart to a
   * caller that is asking about a tracker item.
   */
  async readClaim(projectPath: string, id: string): Promise<ClaimResult | null> {
    const lookup = this.writerFor(projectPath);
    if (lookup.kind !== 'writer') throw new HttpException({ error: 'not found' }, 404);
    const outcome = await lookup.writer.readClaim(lookup.project, lookup.marker, id);
    if (!outcome.ok) throw new HttpException({ error: outcome.refusal.error }, outcome.refusal.refused === 'not-found' ? 404 : 502);
    return outcome.value;
  }

  /**
   * Which adapter owns a ref, by the ref's SHAPE and nothing else — a
   * `gh:<owner>/<repo>#<n>` URN is the tracker's, anything else is a
   * filesystem path and is the files adapter's.
   *
   * The shape test is the ref's, never the caller's: nothing in a request says
   * which source to ask, so a caller cannot route its own path to an adapter by
   * asserting a kind. That is the same rule "dispatch derives the action, it
   * never accepts one" states for the agents routes, and it is stated once here
   * rather than in each of the two methods that dispatch.
   */
  private adapterForRef(ref: string): ItemSource | undefined {
    return this.sources.get(parseUrn(ref) === null ? 'files' : 'github');
  }
}

/**
 * `writerFor`'s four answers. A discriminated union rather than
 * `ItemWriter | null`, because the three failures are three different HTTP
 * statuses with three different sentences and collapsing them would make every
 * route guess which one happened.
 */
export type WriterLookup =
  | { kind: 'unregistered' }
  | { kind: 'files' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'writer'; writer: ItemWriter; project: RegistryProject; marker: SourceMarker };
