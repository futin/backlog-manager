import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards #375: every wire shape that crosses the HTTP boundary between `server/src/` and `client/src/` is declared ONCE, in `shared/types.ts`, and both sides
 * import it — so a field renamed on one side fails `pnpm run typecheck` instead of typechecking on both sides and breaking at runtime. Before #375 each of the
 * shapes below had a copy on each side (or an inline object type on the server route and an inline cast on the client read), and the two copies agreed only
 * because somebody kept them agreeing.
 *
 * The typecheck is what couples the two sides once the declaration is shared; this suite is what keeps it shared. A second copy re-declared under the same
 * name in either tree would typecheck perfectly — it simply shadows the shared one in that file — so the only way to catch it is to read the source, the same
 * reason `git-run.test.ts` greps `server/src` for a synchronous spawn. It finds a copy by TYPE NAME, so a copy renamed on the way in is the reviewer's to catch.
 *
 * Only declarations count: `interface X` and `type X =` (generic or not). An import — `import type { X }`, or `{ type X }` inside one — names the shared
 * declaration and is exactly what both sides should do.
 */

const ROOT = join(__dirname, '..');
const SHARED_TYPES = join(ROOT, 'shared', 'types.ts');
const TREES = [join(ROOT, 'server', 'src'), join(ROOT, 'client', 'src')];

/** Every wire type #375 moved into shared/types.ts. `AgentBranchesPayload` is the one its step-5 sweep found beyond the seven the plan listed. */
const WIRE_TYPES = [
  'MergeCheckResult',
  'UncommittedItems',
  'StartOrchestrateRequest',
  'AgentBranchesPayload',
  'JiraProjectRef',
  'JiraBoardIssuesPayload',
  'JiraJqlCheckResult',
  'JiraRepoDefaultsWriteResult'
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** How many times `source` DECLARES `name` — as an interface, or as a type alias with or without type parameters. */
function declarations(source: string, name: string): number {
  const re = new RegExp(`\\binterface\\s+${name}\\b|\\btype\\s+${name}\\s*(?:<[^>]*>)?\\s*=`, 'g');
  return (source.match(re) ?? []).length;
}

describe('cross-boundary wire types are declared once, in shared/types.ts (#375)', () => {
  const shared = readFileSync(SHARED_TYPES, 'utf8');
  const files = TREES.flatMap(sourceFiles);

  it('scans a non-empty server and client tree', () => {
    // A path typo here would make the next case vacuously green.
    for (const tree of TREES) expect(files.some((f) => f.startsWith(tree))).toBe(true);
  });

  it.each(WIRE_TYPES)('shared/types.ts declares %s exactly once', (name) => {
    expect(declarations(shared, name)).toBe(1);
  });

  it.each(WIRE_TYPES)('no file under server/src or client/src declares %s', (name) => {
    const copies = files.filter((f) => declarations(readFileSync(f, 'utf8'), name) > 0).map((f) => relative(ROOT, f));
    expect(copies).toEqual([]);
  });

  it('counts an import as no declaration, and either declaration form as one', () => {
    // Pins the regex itself, so a loosened pattern cannot turn the two cases above into ones that pass on everything or fail on every importer.
    expect(declarations("import { fetchX, type MergeCheckResult } from './agents';", 'MergeCheckResult')).toBe(0);
    expect(declarations("import type { MergeCheckResult } from '../shared/types';", 'MergeCheckResult')).toBe(0);
    expect(declarations('export interface MergeCheckResult {', 'MergeCheckResult')).toBe(1);
    expect(declarations('type JiraJqlCheckResult = A | B;', 'JiraJqlCheckResult')).toBe(1);
    expect(declarations('export type UncommittedItems<T> = T;', 'UncommittedItems')).toBe(1);
  });
});
