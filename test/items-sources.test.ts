import { rmSync } from 'node:fs';
import { ItemsService } from '../server/src/items/items.service';
import { FilesSource } from '../server/src/items/sources/files.source';
import type { ItemSource, SourceSummary } from '../server/src/items/sources/source';
import type { RegistryService } from '../server/src/registry/registry.service';
import { makeProject } from './helpers/store';

/**
 * The adapter map `ItemsService` builds in its constructor (task-43). Two
 * adapters claiming one kind is a boot-time failure with the kind named, never
 * a silent last-wins: whichever adapter lost would answer nothing, and the
 * board would render one source's items while the other's simply never
 * appeared — a wrong board that never says it is wrong. A Nest provider throws
 * at startup, so the failure is a stack trace at boot rather than a mystery at
 * request time.
 */

/** Enough of RegistryService for a constructor that never reads it here. */
const registry = { load: () => ({ projects: [] }) } as unknown as RegistryService;

/** A second adapter claiming `files` — the duplicate this suite exists to
 *  refuse. `github` is a real kind since task-45, so the duplicate is spelled
 *  `files` deliberately: the rule is one adapter per kind, and the case has to
 *  collide with an adapter the module actually registers. */
class DuplicateFilesSource implements ItemSource {
  readonly kind = 'files' as const;
  async list(): Promise<{ items: []; errors: [] }> {
    return { items: [], errors: [] };
  }
  async body(): Promise<null> {
    return null;
  }
  async summary(): Promise<SourceSummary> {
    return { repo: null, polledAt: null, access: null, detail: null, interval: null };
  }
  /* task-46: the seam grew `find`, so a stub adapter has to answer it too.
     Deliberately not a spy — this suite is about the module refusing two
     adapters of one kind at BOOT, which happens before anything is called. */
  async find(): Promise<null> {
    return null;
  }
}

describe('ItemsService construction', () => {
  it('refuses two adapters of one kind, naming the kind', () => {
    expect(() => new ItemsService(registry, [new FilesSource(), new DuplicateFilesSource()])).toThrow(/files/);
  });

  it('accepts one adapter per kind', () => {
    expect(() => new ItemsService(registry, [new FilesSource()])).not.toThrow();
  });
});

/**
 * `sourceOf` (PR-mode Task 2): the one public answer to "what is this project's source", so a caller outside `ItemsService` never builds a second
 * `known` set. Real marker files on disk, because the resolution table is about what a marker says.
 */
describe('ItemsService.sourceOf', () => {
  /** An adapter that only has to carry a kind; `sourceOf` never calls it. */
  class StubSource implements ItemSource {
    constructor(readonly kind: 'files' | 'github') {}
    async list(): Promise<{ items: []; errors: [] }> {
      return { items: [], errors: [] };
    }
    async body(): Promise<null> {
      return null;
    }
    async summary(): Promise<SourceSummary> {
      return { repo: null, polledAt: null, access: null, detail: null, interval: null };
    }
    async find(): Promise<null> {
      return null;
    }
  }

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function serviceWith(marker: string | undefined): { service: ItemsService; path: string } {
    const path = makeProject('src', [], marker);
    dirs.push(path);
    const reg = { load: () => ({ projects: [{ name: 'p', path, createdAt: '2026-01-01' }] }) } as unknown as RegistryService;
    return { service: new ItemsService(reg, [new StubSource('files'), new StubSource('github')]), path };
  }

  it("answers 'github' for a tracker marker, 'files' for no marker, and 'unsupported' for a kind no adapter serves", () => {
    const tracker = serviceWith(JSON.stringify({ kind: 'github', repo: 'o/r' }));
    expect(tracker.service.sourceOf(tracker.path)).toBe('github');
    const files = serviceWith(undefined);
    expect(files.service.sourceOf(files.path)).toBe('files');
    const odd = serviceWith(JSON.stringify({ kind: 'gitlab' }));
    expect(odd.service.sourceOf(odd.path)).toBe('unsupported');
  });

  it('answers null for a project the registry does not hold', () => {
    const { service } = serviceWith(undefined);
    expect(service.sourceOf('/not/registered')).toBeNull();
  });
});
