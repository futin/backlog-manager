import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No import cycle among `client/src/lib/*.ts`, counting `import type` too (#600). The one cycle there was `jira.ts` ↔ `delivery.ts`: `delivery.ts`
 * value-imported two helpers from `jira.ts`, and `jira.ts` type-imported `DeliveryFilter` back — which is why `jira.ts` kept a hand-typed second copy of the
 * five Delivery filter values, since "a value import back would cycle". A type-only edge erases at build time, so the bundle never saw that cycle; it is
 * counted anyway because it is what turns the next value import into a real one, and the workaround (a duplicated list) is the cost a cycle charges first.
 *
 * Source, not behaviour, for the usual guard reason: nothing at runtime goes red when a cycle closes — ES modules resolve one by handing the second module a
 * binding that is still in its temporal dead zone, which fails only if a top-level statement reads it — so a cycle sits green until the day it does not.
 */

const LIB = join(__dirname, '..', '..', 'client', 'src', 'lib');

/**
 * The sibling modules one file imports, as file names (`./tracker` → `tracker.ts`): every `import` / `export … from` statement naming a `./x` path,
 * `import type` and multi-line statements included, and the bare `import './x'`. Comments are dropped first, so a doc comment quoting an import is not an
 * edge. `../` paths leave the directory and are not edges here.
 */
function siblingImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [
    ...[...code.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"](\.\/[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bimport\s*['"](\.\/[^'"]+)['"]/g)].map((m) => m[1])
  ];
  return [...new Set(specs.map((s) => `${s.slice(2).replace(/\.ts$/, '')}.ts`))];
}

/** Every cycle in a file → imports graph, as the sorted member list of each strongly connected component that holds one (Tarjan's DFS), sorted. */
function importCycles(graph: Record<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph[v] ?? []) {
      if (!(w in graph)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop() as string;
      onStack.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1 || (graph[v] ?? []).includes(v)) cycles.push(scc.sort());
  };
  for (const v of Object.keys(graph)) if (!index.has(v)) visit(v);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

describe('client/src/lib import cycles', () => {
  it('the detector reports a two-file cycle, and only it', () => {
    expect(importCycles({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'], 'c.ts': [] })).toEqual([['a.ts', 'b.ts']]);
  });

  it('the parser counts type-only and multi-line imports as edges', () => {
    expect(siblingImports(`import type { X } from './y';\nimport {\n  a,\n  type B\n} from './z';\n`)).toEqual(['y.ts', 'z.ts']);
    expect(siblingImports(`// import { a } from './gone'\n/** import { b } from './also-gone' */\nimport { c } from '../../../shared/types';\n`)).toEqual([]);
  });

  it('no file in client/src/lib is part of an import cycle', () => {
    const files = readdirSync(LIB).filter((f) => f.endsWith('.ts'));
    const graph = Object.fromEntries(files.map((f) => [f, siblingImports(readFileSync(join(LIB, f), 'utf8')).filter((t) => existsSync(join(LIB, t)))]));
    // Guards the reader, not the rule: a parser that matched nothing would pass the last line on an empty graph.
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(Object.values(graph).flat().length).toBeGreaterThan(0);
    expect(importCycles(graph)).toEqual([]);
  });
});
