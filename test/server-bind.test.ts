import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `server/src/main.ts` holds the API half of CLAUDE.md's "both processes bind
 * `127.0.0.1` by default; loopback is the access control" — nothing in this
 * stack has auth, and `/api/items/body` reads every registered project's
 * backlog off disk while `/api/agents/*` can spawn Claude Code sessions. A
 * refactor to a bare `app.listen(PORT)` binds the wildcard on the host and
 * every other suite here stays green, which is exactly the gap this file
 * closes. The dev half of the same rule has been pinned since
 * `test/vite-proxy.test.ts`; this is its sibling.
 *
 * It reads the entrypoint's SOURCE rather than importing it. `main.ts:32`
 * calls `bootstrap()` unconditionally at top level with no `require.main`
 * guard, so a plain import starts a real listening server — and the
 * alternative (mock `@nestjs/core`, import the module, assert the recorded
 * `listen` arguments) buys behavioural coverage at the price of either a
 * production guard added to the entrypoint for a test's benefit or an import
 * that runs the whole bootstrap. Reading the file is the same style
 * `vite-proxy.test.ts` already establishes for a config invariant, and it can
 * never open a socket.
 *
 * The weakness of a text assertion is a refactor that keeps the string while
 * moving the logic, so this does not grep for `127.0.0.1`. It locates the
 * `.listen(...)` call, resolves each argument through any `const` it names,
 * and EVALUATES that expression against a fabricated `process.env` — so what
 * is asserted is what the expression computes, for an unset `BM_BIND` and for
 * an overridden one alike, and a bare single-argument `listen` fails on the
 * argument count before it gets that far.
 */
const MAIN_PATH = join(__dirname, '..', 'server', 'src', 'main.ts');

/* Comments are blanked out before anything is located, and that is not
   tidiness: main.ts's own doc comment says the words `app.listen(PORT)` while
   explaining why the real call must not look like that, so a scan of the raw
   text finds the warning instead of the code and reports the bug it was
   written to prevent. Strings and template literals are tracked because the
   log line contains `http://` — a naive line-comment rule would eat it. A
   regex literal would confuse this, and an entrypoint that grows one should
   change this scanner rather than work around it; every failure mode here
   throws, so it cannot pass by accident. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        const closing = src[i] === quote;
        out += src[i];
        i += 1;
        if (closing) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const source = stripComments(readFileSync(MAIN_PATH, 'utf8'));

/* Split an argument list on its top-level commas only: a nested call or object
   literal in either position must stay one argument. */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

/* The arguments the entrypoint hands `listen`, verbatim. Balanced-paren scan
   rather than a `[^)]*` regex, so an inline `process.env.BM_BIND ?? '…'` with
   a call in it still reads as one argument instead of truncating. */
function listenArguments(): string[] {
  const call = source.indexOf('.listen(');
  if (call === -1) {
    throw new Error(`${MAIN_PATH} no longer calls .listen(...) — re-read it before editing this test`);
  }
  const open = call + '.listen'.length;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return splitTopLevel(source.slice(open + 1, i));
    }
  }
  throw new Error(`${MAIN_PATH}'s .listen( call is unbalanced`);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/* An argument may be a bare identifier (`PORT`, `BIND`) or the expression
   itself written inline; both are correct code, so both have to resolve here
   or the test would fail a refactor that changed nothing that matters. Bounded
   hops rather than a loop, so a self-referential const cannot hang the suite. */
function resolveExpression(expr: string): string {
  let current = expr;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!IDENTIFIER.test(current)) return current;
    const declaration = new RegExp(`\\bconst\\s+${current}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(source);
    if (!declaration) {
      throw new Error(`${MAIN_PATH} names ${current} in listen(...) but declares no const for it`);
    }
    current = declaration[1].trim();
  }
  throw new Error(`${MAIN_PATH}'s listen(...) argument ${expr} does not resolve to a value`);
}

/* Evaluate an entrypoint expression against a fabricated environment. The
   real `process.env` is deliberately not used: the suite must answer "what
   would this compute with BM_BIND unset" whether or not the machine running it
   happens to have the variable set. */
function evaluate(expr: string, env: NodeJS.ProcessEnv): unknown {
  return new Function('process', `return (${expr});`)({ env }) as unknown;
}

function listenArgument(index: number, env: NodeJS.ProcessEnv): unknown {
  const args = listenArguments();
  /* Named outright rather than left to fail as `undefined` further down: a
     missing second argument IS the regression, and the message a reader gets
     when this suite goes red should say so instead of describing a const
     lookup that failed for a reason nobody asked about. */
  if (index >= args.length) {
    throw new Error(
      `${MAIN_PATH} calls listen(${args.join(', ')}) — argument ${index} is missing; ` +
        'a bare listen(PORT) binds 0.0.0.0 and exposes this unauthenticated API'
    );
  }
  return evaluate(resolveExpression(args[index]), env);
}

describe('API server bind', () => {
  /* The regression this whole file exists for: `app.listen(PORT)` alone binds
     0.0.0.0. Asserted on the argument count, before any value is computed,
     because a missing argument has no expression to evaluate. */
  it('passes listen an explicit bind address', () => {
    expect(listenArguments()).toHaveLength(2);
  });

  it('binds loopback when BM_BIND is unset', () => {
    expect(listenArgument(1, {})).toBe('127.0.0.1');
  });

  /* The knob still has to work: docker-compose.yml sets BM_BIND=0.0.0.0 in
     both services, because inside a container the published port is what
     constrains reach and a container-loopback bind would make it unreachable. */
  it('uses BM_BIND when it is set', () => {
    expect(listenArgument(1, { BM_BIND: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

/* In scope because the resolver above already makes it two lines: PORT is
   unpinned for the same reason BIND was, and 4322 is not arbitrary —
   guide-manager holds 4321 on this machine. */
describe('API server port', () => {
  it('defaults to 4322', () => {
    expect(listenArgument(0, {})).toBe(4322);
  });

  it('uses PORT when it is set', () => {
    expect(listenArgument(0, { PORT: '5001' })).toBe(5001);
  });
});

describe('this suite', () => {
  /* The one thing a source-reading test must never quietly become is a
     bootstrapping one: importing `main.ts` runs `bootstrap()` at top level and
     opens a real socket, which would make `pnpm test` fail on whatever else
     holds 4322. Nothing can assert "no socket was opened" directly, so this
     asserts the reachable proxy — the entrypoint was never loaded at all. */
  it('never loads the entrypoint', () => {
    const loaded = Object.keys(require.cache).some((id) => id.endsWith(join('server', 'src', 'main.ts')));
    expect(loaded).toBe(false);
  });
});
