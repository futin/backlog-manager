import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds a real on-disk backlog store — the same nine leaf directories
 * backlog.mjs init creates — plus a registry file pointing at it. The e2e
 * suites run against real files because the server's whole job is reading
 * this exact layout; mocking fs here would test the mock.
 */
export interface FixtureItem {
  /** e.g. 'bugs/open' — the leaf directory, verbatim */
  leaf: string;
  filename: string;
  content: string;
}

/**
 * `marker`, when given, is written to `backlog/source.json` VERBATIM — a raw
 * string rather than an object, so a suite can produce a marker that does not
 * parse at all. A helper that took an object could only ever write well-formed
 * JSON, and the resolution table this fixture exists to exercise is mostly
 * about the malformed cases (task-43).
 */
export function makeProject(name: string, items: FixtureItem[], marker?: string): string {
  const root = mkdtempSync(join(tmpdir(), `bm-${name}-`));
  for (const leaf of ['bugs/open', 'bugs/done', 'ideas/open', 'ideas/done', 'tasks/open', 'tasks/done', 'refactors/open', 'refactors/done', 'out-of-scope']) {
    mkdirSync(join(root, 'backlog', leaf), { recursive: true });
  }
  for (const item of items) {
    writeFileSync(join(root, 'backlog', item.leaf, item.filename), item.content);
  }
  if (marker !== undefined) writeFileSync(join(root, 'backlog', 'source.json'), marker);
  return root;
}

export function makeRegistry(projects: { name: string; path: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-registry-'));
  const file = join(dir, 'registry.json');
  writeFileSync(
    file,
    JSON.stringify({
      projects: projects.map((p) => ({ ...p, createdAt: '2026-08-26T00:00:00.000Z' }))
    })
  );
  return file;
}

export function item(id: string, title: string, body: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-08-20\n${extra}---\n\n${body}`;
}
