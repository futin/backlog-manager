import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

import { RegistryService } from '../registry/registry.service';
import { buildAllowlist, resolveAllowed } from './allow.util';
import { parseFrontmatter } from './parse.util';
import { scanProject } from './scan.util';
import type { ItemsIndex, ProjectSummary, SectionCounts } from '../../../shared/types';

/**
 * All reads walk the registry and the stores per request, like guide-manager's
 * RegistryService: a capture made mid-session shows up on the next fetch
 * without a restart, and the whole corpus is a few hundred small files —
 * nothing worth a cache that could go stale.
 */
@Injectable()
export class ItemsService {
  constructor(private readonly registry: RegistryService) {}

  index(): ItemsIndex {
    const items: ItemsIndex['items'] = [];
    const errors: string[] = [];
    for (const project of this.registry.load().projects) {
      // A missing store is /api/projects' news (flagged there), not a scan
      // error to repeat on every item fetch.
      if (!existsSync(join(project.path, 'backlog'))) continue;
      const scanned = scanProject(project);
      items.push(...scanned.items);
      errors.push(...scanned.errors);
    }
    return { items, errors };
  }

  projects(): ProjectSummary[] {
    return this.registry.load().projects.map((project) => {
      const missing = !existsSync(join(project.path, 'backlog'));
      const counts: SectionCounts = { bugs: 0, ideas: 0, tasks: 0, 'out-of-scope': 0 };
      if (!missing) {
        for (const it of scanProject(project).items) {
          // "open" counts: done items are history. out-of-scope is terminal
          // and counts as itself — its number is how many were declined.
          if (it.status === 'done') continue;
          counts[it.section]++;
        }
      }
      return { name: project.name, path: project.path, createdAt: project.createdAt, missing, counts };
    });
  }

  /**
   * The Markdown body of one item, frontmatter stripped (the client already
   * holds every frontmatter field from the index). Falls back to the raw file
   * when the frontmatter is malformed — the drawer is exactly where you look
   * at a broken file. Returns null for anything outside a registered
   * project's backlog/ — the caller answers 404 without learning why.
   */
  body(requestPath: string): string | null {
    const real = resolveAllowed(requestPath, buildAllowlist(this.registry.load()));
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
}
