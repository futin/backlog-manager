import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards #375: every wire shape that crosses the HTTP boundary between `server/src/` and `client/src/` is declared ONCE, in `shared/types.ts`, and both sides
 * import it — so a field renamed on one side fails `pnpm run typecheck` instead of typechecking on both sides and breaking at runtime. Before #375 each of the
 * shapes it moved had a copy on each side (or an inline object type on the server route and an inline cast on the client read), and the two copies agreed only
 * because somebody kept them agreeing.
 *
 * The typecheck is what couples the two sides once the declaration is shared; this suite is what keeps it shared. A second copy re-declared under the same
 * name in either tree would typecheck perfectly — it simply shadows the shared one in that file — so the only way to catch it is to read the source, the same
 * reason `git-run.test.ts` greps `server/src` for a synchronous spawn. It finds a copy by TYPE NAME, so a copy renamed on the way in is the reviewer's to catch.
 *
 * Only declarations count: `interface X` and `type X =` (generic or not). An import — `import type { X }`, or `{ type X }` inside one — names the shared
 * declaration and is exactly what both sides should do.
 *
 * The list is every type `shared/types.ts` exports, derived on each run (#428): a hand-picked one stayed at #375's eight while the file grew past a hundred, so
 * a copy of any newer shape passed. It reads a name a tree uses privately for something else as a copy too — rename the local type, or list it in `HOMONYMS`.
 */

const ROOT = join(__dirname, '..');
const SHARED_TYPES = join(ROOT, 'shared', 'types.ts');
const TREES = [join(ROOT, 'server', 'src'), join(ROOT, 'client', 'src')];

const shared = readFileSync(SHARED_TYPES, 'utf8');

const WIRE_TYPES = [...shared.matchAll(/^export\s+(?:interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);

/** #375's eight, which `WIRE_TYPES` must go on holding: a derivation that stopped matching would drop names quietly. */
const MOVED_BY_375 = [
  'MergeCheckResult',
  'UncommittedItems',
  'StartOrchestrateRequest',
  'AgentBranchesPayload',
  'JiraProjectRef',
  'JiraBoardIssuesPayload',
  'JiraJqlCheckResult',
  'JiraRepoDefaultsWriteResult'
];

/**
 * A name shared with a type that is NOT a copy, and the one file allowed to hold it — so a real copy elsewhere still fails, and renaming the local type fails
 * here until its row goes. `Section` in `shared/types.ts` is an item's directory (bugs, tasks …); in `sections.ts` it is a rail entry (files, github …), and it
 * never crosses the wire.
 */
const HOMONYMS: Record<string, string[]> = { Section: [join('client', 'src', 'lib', 'sections.ts')] };

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
  const files = TREES.flatMap(sourceFiles).map((file) => ({ file, source: readFileSync(file, 'utf8') }));

  it('scans a non-empty server and client tree', () => {
    // A path typo here would make the next case vacuously green.
    for (const tree of TREES) expect(files.some((f) => f.file.startsWith(tree))).toBe(true);
  });

  it('derives its list from every export of shared/types.ts, which still holds #375’s eight', () => {
    expect(WIRE_TYPES).toEqual(expect.arrayContaining(MOVED_BY_375));
    expect(WIRE_TYPES).toEqual(expect.arrayContaining(['PullRequestsPayload', 'PrWriteResult', 'Section']));
    expect(new Set(WIRE_TYPES).size).toBe(WIRE_TYPES.length);
  });

  it.each(WIRE_TYPES)('shared/types.ts declares %s exactly once', (name) => {
    expect(declarations(shared, name)).toBe(1);
  });

  it.each(WIRE_TYPES)('no file under server/src or client/src declares %s', (name) => {
    const copies = files.filter((f) => declarations(f.source, name) > 0).map((f) => relative(ROOT, f.file));
    expect(copies).toEqual(HOMONYMS[name] ?? []);
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
