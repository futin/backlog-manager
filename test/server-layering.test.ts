import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Source guard, in the shape `test/supertest-bind.test.ts` and `test/fixture-clock.test.ts` already use: read the files, assert on their text.
 *
 * #351 / #388 — the server's two layering inversions, and the one file every other module reached into for a helper. The 2026-10-24 audit found
 * `items-abort.service.ts` importing `writable` and `answer` from `items-write.controller.ts` (a service depending on a controller, so the abort route
 * could not be loaded without dragging the whole write controller in), `AgentsController.watchdogConfig` sequencing the watchdog's own domain steps
 * (write the config, arm, tick, read the status) instead of asking `WatchdogService` to, and `agents.service.ts` doubling as a grab-bag of free
 * functions — session names, dashboard reads, claim probes, a `config.util` re-export — that six other files imported from it. #388 moved each of those
 * to its home: the field and project gates to `items/write-gate.util.ts`, the dashboard reads to `agents/dashboard-sessions.util.ts`, the session names
 * to `agents/prompt.util.ts`, the machine checks to `agents/machine-choice.util.ts`, the orchestrate-request resolvers to `OrchestrateArgsService`, and
 * the watchdog save to `WatchdogService.configure`.
 *
 * Behaviour cannot be the guard: every one of those inversions worked, which is why they accumulated. Nothing fails when the next helper is exported
 * from `agents.service.ts` or the next service imports a controller — so this file reads the source and fails on the shape. The fix for a red here is
 * to put the helper in a util or a service of its own, never to widen the lists below.
 */
const SERVER_DIR = join(__dirname, '..', 'server', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/* Comments are blanked before anything is matched, as in `supertest-bind.test.ts`: the doc comments in these very files explain the old imports
   ("imported from `items-write.controller.ts`"), and a scan of the raw text would report the explanation as the offence. */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/* Every `import … from '<spec>'` and `export … from '<spec>'`, multi-line clauses included, with the names inside its braces (`type` dropped, an
   `as` alias read as its source name). A side-effect `import '<spec>'` names nothing and is not a dependency on a symbol, so it is not listed. */
interface Edge {
  file: string;
  spec: string;
  names: string[];
  text: string;
}

function edges(file: string, source: string): Edge[] {
  return [...source.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => {
    const braces = /\{([^}]*)\}/.exec(m[1]);
    const names = braces
      ? braces[1]
          .split(',')
          .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
      : [];
    return { file, spec: m[2], names, text: m[0].replace(/\s+/g, ' ') };
  });
}

const files = sourceFiles(SERVER_DIR).map((path) => ({
  path,
  rel: relative(SERVER_DIR, path),
  source: blankComments(readFileSync(path, 'utf8')),
}));
const allEdges = files.flatMap((f) => edges(f.rel, f.source));

/* The three names `agents.service.ts` may export: the class, and the two request types the controller and the shared-types assertion read. */
const AGENTS_SERVICE_EXPORTS = ['AgentOrchestrateRequest', 'AgentsService', 'OrchestrateRequestKeysMatch'];

describe('server layering', () => {
  it('finds the sources at all — a move that empties this list must fail loudly', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === join('agents', 'agents.service.ts'))).toBe(true);
    expect(allEdges.length).toBeGreaterThan(100);
  });

  /* A controller is an HTTP edge: only the module that wires it may name it. A service or util that imports one depends on the request layer, and
     anything that reaches for a helper living in a controller should find that helper in a util instead. */
  it('imports a *.controller module from nowhere but a *.module.ts', () => {
    const offenders = allEdges
      .filter((e) => !e.file.endsWith('.module.ts') && /\.controller$/.test(e.spec))
      .map((e) => `${e.file}: ${e.text}`);
    expect(offenders).toEqual([]);
  });

  it('agents.service.ts exports the class and its two request types, and nothing else', () => {
    const source = files.find((f) => f.rel === join('agents', 'agents.service.ts'))!.source;
    const forbidden = [...source.matchAll(/^export\s+(?:async\s+function|function|const|let|\{)[^\n]*/gm)].map((m) => m[0]);
    expect(forbidden).toEqual([]);
    const declared = [...source.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const|let)\s+(\w+)/gm)]
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual(AGENTS_SERVICE_EXPORTS);
  });

  it('imports nothing from agents.service but those three names', () => {
    const offenders = allEdges
      .filter((e) => /(?:^|\/)agents\.service$/.test(e.spec))
      .flatMap((e) => e.names.filter((n) => !AGENTS_SERVICE_EXPORTS.includes(n)).map((n) => `${e.file}: ${n} — ${e.text}`));
    expect(offenders).toEqual([]);
  });

  /* The save sequence — write the config, arm, an unawaited tick, read the status — is one `WatchdogService.configure` call. The controller parses
     the body and nothing else; it holding `writeWatchdogConfig` again is the inversion coming back. */
  it('leaves the watchdog config write to WatchdogService, not the controller', () => {
    const importsOf = (rel: string) => allEdges.filter((e) => e.file === rel).flatMap((e) => e.names);
    expect(importsOf(join('agents', 'agents.controller.ts'))).not.toContain('writeWatchdogConfig');
    expect(importsOf(join('agents', 'watchdog.service.ts'))).toContain('writeWatchdogConfig');
  });
});
