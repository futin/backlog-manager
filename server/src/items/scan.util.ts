import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ItemParseError, deriveGroomed, parseFrontmatter } from './parse.util';
import type { BacklogItem, ItemStatus, RegistryProject, Section } from '../../../shared/types';

/**
 * The seven leaf directories a store is defined to have — the same list
 * backlog.mjs's LEAF_DIRS creates. The directory IS the item's section and
 * status; nothing in the file repeats it.
 */
const LEAVES: { section: Section; status: ItemStatus; rel: string }[] = [
  { section: 'bugs', status: 'open', rel: 'bugs/open' },
  { section: 'bugs', status: 'done', rel: 'bugs/done' },
  { section: 'ideas', status: 'open', rel: 'ideas/open' },
  { section: 'ideas', status: 'done', rel: 'ideas/done' },
  { section: 'tasks', status: 'open', rel: 'tasks/open' },
  { section: 'tasks', status: 'done', rel: 'tasks/done' },
  { section: 'out-of-scope', status: 'terminal', rel: 'out-of-scope' }
];

/**
 * Reads one project's whole store. Tolerant the way `backlog.mjs board` is:
 * a malformed file is reported in `errors` (path-prefixed) rather than
 * aborting the scan — one bad fence must not blind the board to the other
 * nine items. A missing leaf directory is a partially-scaffolded store, not
 * an error. readdirSync is sorted so the index is deterministic across
 * filesystems.
 */
export function scanProject(project: RegistryProject): { items: BacklogItem[]; errors: string[] } {
  const items: BacklogItem[] = [];
  const errors: string[] = [];
  const backlog = join(project.path, 'backlog');

  for (const leaf of LEAVES) {
    const dir = join(backlog, leaf.rel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const abs = join(dir, name);
      try {
        const { fm, body } = parseFrontmatter(readFileSync(abs, 'utf8'));
        if (!fm.fields.id || !fm.fields.title) {
          throw new ItemParseError('frontmatter is missing id or title');
        }
        items.push({
          id: fm.fields.id,
          title: fm.fields.title,
          created: fm.fields.created ?? '',
          started: fm.fields.started ?? '',
          tags: fm.tags,
          section: leaf.section,
          status: leaf.status,
          project: project.name,
          projectPath: project.path,
          groomed: deriveGroomed(leaf.section, body),
          path: abs
        });
      } catch (e) {
        errors.push(`${abs}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { items, errors };
}
