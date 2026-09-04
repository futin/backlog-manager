import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { lastCommitDates } from './git-dates.util';
import { ItemParseError, clampPhase, deriveGroomed, parseElapsed, parseFrontmatter } from './parse.util';
import type { BacklogItem, ItemStatus, RegistryProject, Section } from '../../../shared/types';

/**
 * The nine leaf directories a store is defined to have — the same list
 * backlog.mjs's LEAF_DIRS creates. The directory IS the item's section and
 * status; nothing in the file repeats it.
 *
 * This list is the reason "the server picks a new section up from the
 * directory" is only half true. `section` does come from the directory rather
 * than from the file — but from THIS table of directories, not from whatever
 * happens to exist on disk, so a new section is two rows here as well as two
 * entries in LEAF_DIRS. Deliberately still a hand-written mirror: importing
 * LEAF_DIRS would drag a .mjs module into the Nest build to save two lines,
 * and the mirror is asserted by test/items.test.ts scanning a real store.
 */
const LEAVES: { section: Section; status: ItemStatus; rel: string }[] = [
  { section: 'bugs', status: 'open', rel: 'bugs/open' },
  { section: 'bugs', status: 'done', rel: 'bugs/done' },
  { section: 'ideas', status: 'open', rel: 'ideas/open' },
  { section: 'ideas', status: 'done', rel: 'ideas/done' },
  { section: 'tasks', status: 'open', rel: 'tasks/open' },
  { section: 'tasks', status: 'done', rel: 'tasks/done' },
  { section: 'refactors', status: 'open', rel: 'refactors/open' },
  { section: 'refactors', status: 'done', rel: 'refactors/done' },
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
  // Once per scan, not per item: it shells out to git.
  const commits = lastCommitDates(project.path);

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
          // The kebab-to-camel mapping for Task 4's four new keys lives here
          // and only here — see BacklogItem in shared/types.ts for what each
          // field means and why phase/the elapsed buckets clamp instead of
          // rejecting a hand-edited value.
          updated: fm.fields.updated ?? '',
          // Built as a literal POSIX path, not via join(), to match the shape
          // `git log --relative` prints on every platform.
          lastCommit: commits.get(`backlog/${leaf.rel}/${name}`) ?? '',
          phase: clampPhase(fm.fields.phase),
          groomElapsed: parseElapsed(fm.fields['groom-elapsed']),
          executeElapsed: parseElapsed(fm.fields['execute-elapsed']),
          // The token buckets go through the SAME parseElapsed, deliberately
          // rather than a second parser of their own: the shape on disk is
          // identical (a plain unsigned integer the CLI accumulates and
          // refuses to corrupt) and so is the right degrade — a hand-edited
          // value must read as 0, never 500 a board. See BacklogItem.groomTokens
          // in shared/types.ts for what the number counts and, more
          // importantly, what it deliberately does not.
          groomTokens: parseElapsed(fm.fields['groom-tokens']),
          executeTokens: parseElapsed(fm.fields['execute-tokens']),
          // Passed through verbatim, not clamped against 'chore'|'debt' — see
          // BacklogItem.kind in shared/types.ts for why this one differs from
          // `phase` above: the client's badge simply doesn't render for a value
          // it doesn't know, so there is nothing here to collapse an unknown
          // value into.
          kind: fm.fields.kind ?? '',
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
