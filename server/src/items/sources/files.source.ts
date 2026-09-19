import { readFileSync, realpathSync } from 'node:fs';
import { Injectable } from '@nestjs/common';

import { buildAllowlist, resolveAllowed } from '../allow.util';
import { parseFrontmatter } from '../parse.util';
import { scanProject } from '../scan.util';
import type { ItemSource, SourceSummary } from './source';
import type { SourceMarker } from './resolve.util';
import type { BacklogItem, Registry, RegistryProject } from '../../../../shared/types';

/**
 * The first adapter behind the seam (task-43): the store on disk, which is
 * every project on every machine until a tracker is connected. It is a wrapper
 * and nothing more — `list` is today's `scanProject`, `body` is the body
 * reader lifted out of `ItemsService` with its behaviour unchanged down to
 * which failures return `null`.
 *
 * Deliberately no caching, no state and no constructor dependencies: this
 * class exists to give the files source the same shape a tracker will have,
 * not to change what the files source does.
 */
@Injectable()
export class FilesSource implements ItemSource {
  readonly kind = 'files' as const;

  /** The marker is ignored: a files project's items are wherever the store is,
   *  and nothing in a marker could move them. */
  async list(project: RegistryProject, _marker: SourceMarker | null): Promise<{ items: BacklogItem[]; errors: string[] }> {
    return scanProject(project);
  }

  /**
   * Four nulls, and they are the true answer rather than a stub (task-45): a
   * store on disk has no repo, no poll, no access state that could be down and
   * nothing to detail. The fields exist on every summary — including this one —
   * so `ProjectSummary` stays a total shape; see its doc comment for why that
   * was chosen over four optional keys.
   */
  async summary(_project: RegistryProject, _marker: SourceMarker | null): Promise<SourceSummary> {
    return { repo: null, polledAt: null, access: null, detail: null };
  }

  /**
   * One item's body, frontmatter stripped (the client already holds every
   * frontmatter field from the index). Falls back to the raw file when the
   * frontmatter is malformed — the drawer is exactly where you look at a
   * broken file. Returns null for anything outside a registered project's
   * backlog/ — the caller answers 404 without learning why.
   */
  async body(ref: string, registry: Registry): Promise<string | null> {
    const real = resolveAllowed(ref, buildAllowlist(registry));
    if (real === null || !real.endsWith('.md')) return null;

    let text: string;
    try {
      text = readFileSync(real, 'utf8');
    } catch {
      // Inside the try, not above it. A DIRECTORY named `x.md` inside a
      // registered store passes both checks above and then throws EISDIR; an
      // unreadable file throws EACCES. Either escaping here is a 500 with a
      // stack trace — and a 500 where every other rejected path gets a 404 is
      // an oracle telling the caller their path IS inside an allowlisted
      // store, which is exactly what the 404 above exists to withhold.
      return null;
    }
    try {
      return parseFrontmatter(text).body;
    } catch {
      return text;
    }
  }

  /**
   * One item by its absolute path (task-46) — `AgentsService.findItem`'s body,
   * moved here unchanged down to the realpath compare.
   *
   * It belongs on this adapter and nowhere else: "resolve a ref against the
   * allowlist, then scan every registered project for the file it names" is a
   * statement about ITEM FILES, and `agents/` holding a private copy of it was
   * the reason the dispatch routes could not see a tracker item at all. Now the
   * ref's shape picks an adapter (`ItemsService.find`) and each one answers for
   * its own source.
   *
   * No `writer` on this class, deliberately — see `ItemSource.writer`: item
   * files are the skills' to write, and the absence of the field is what makes
   * a write route answer "this project's items are files" in ONE place.
   */
  async find(ref: string, registry: Registry): Promise<BacklogItem | null> {
    const real = resolveAllowed(ref, buildAllowlist(registry));
    if (real === null || !real.endsWith('.md')) return null;
    for (const project of registry.projects) {
      for (const candidate of scanProject(project).items) {
        // Both sides through realpath: resolveAllowed already resolved
        // symlinks, scanProject did not, and on macOS the temp roots the test
        // fixtures live under are themselves symlinks (/var → /private/var).
        // A plain string compare would find nothing there.
        if (samePath(candidate.path, real)) return candidate;
      }
    }
    return null;
  }
}

/** Two paths naming one file, symlinks resolved on both sides. `false` rather
 *  than a throw for a path that does not exist, which is the ordinary case when
 *  an item was archived between two requests. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
