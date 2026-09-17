import { ItemsService } from '../server/src/items/items.service';
import { FilesSource } from '../server/src/items/sources/files.source';
import type { ItemSource } from '../server/src/items/sources/source';
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

/** A second adapter claiming `files`, which is the only kind this build has. */
class DuplicateFilesSource implements ItemSource {
  readonly kind = 'files' as const;
  async list(): Promise<{ items: []; errors: [] }> {
    return { items: [], errors: [] };
  }
  async body(): Promise<null> {
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
