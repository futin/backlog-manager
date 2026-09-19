import { ItemsService } from '../server/src/items/items.service';
import { FilesSource } from '../server/src/items/sources/files.source';
import type { ItemSource, SourceSummary } from '../server/src/items/sources/source';
import type { RegistryService } from '../server/src/registry/registry.service';

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
    return { repo: null, polledAt: null, access: null, detail: null };
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
