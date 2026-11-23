#!/usr/bin/env node
// api-call: one HTTP request to the backlog-manager API on this machine, and
// nothing else (task-47).
//
//   node api-call.mjs GET  /api/items
//   node api-call.mjs POST /api/items/claim '{"project":"/abs/path","id":"#31",…}'
//   node api-call.mjs POST /api/items/claim -            # body on stdin
//
// ## Why this is a separate process
//
// `orchestrate.mjs` is synchronous from top to bottom — every read is
// synchronous `fs`, every child is `spawnSync` — and that is not an accident
// of how it grew. Its entry guard is `process.exitCode = main(...)` and never
// `process.exit()`, which is safe only while nothing holds the event loop
// open (CLAUDE.md: "all three skill CLIs exit through `process.exitCode`");
// `main` returning a number rather than a promise is what makes every one of
// its dozens of commands provably free of a dangling handle.
//
// A tracker project needs `fetch`, which is asynchronous. Making `main` async
// to accommodate it would turn one property that is true by construction into
// one that has to be re-argued for every future command. So the asynchrony is
// exiled into THIS file, which `orchestrate.mjs` runs with `spawnSync` and
// reaps before its own call returns. The parent stays synchronous; the child
// is where the socket lives and where it dies.
//
// ## The contract with the parent
//
// Stdout is the response body, parsed and re-serialised as JSON (`null` for an
// empty body), on every exit code below. Stderr is for a human. The exit code
// is what `orchestrate.mjs`'s `apiCall` branches on:
//
//   0  a 2xx. Stdout carries the parsed body.
//   3  a non-2xx. Stdout STILL carries the body — a 409's `holder` and a 400's
//      `error` are exactly what the caller needs to decide what to do — and
//      stderr names the status.
//   5  no API there at all: ECONNREFUSED, a malformed base, an unreachable
//      host. Stderr names `pnpm run dev` and `pnpm run docker:up`, the same
//      two commands `backlog.mjs` names for the same condition, because a
//      person who sees this has one thing to do and it should read the same
//      from every tool that says it.
//   6  the API took the request and did not answer within API_CALL_TIMEOUT_MS
//      (#586). Stdout is `null`. Distinct from `5` because the fix is not the
//      same: something IS listening, and a write may already have landed, so
//      the caller re-reads before it retries rather than starting the stack.
//
// Those four codes are PRIVATE to this file. `orchestrate.mjs` maps them onto
// its own exit vocabulary (`8` for the stack being down, `9` for an API
// refusal a command cannot absorb) before anything else sees them, because `3`
// and `5` already mean "budget elapsed" and "nothing to verify" there, and
// SKILL.md branches on both.
//
// ## Why it may end `await main(...)` where its two neighbours may not
//
// The invariant is about `process.exit()` truncating a pipe — writing to a
// pipe is asynchronous, so exiting undrained cuts stdout at 65,536 bytes —
// and asynchrony has nothing to do with it. What the rule actually requires is
// that nothing hold the event loop open when `main` returns. This file makes
// exactly one `fetch`, awaits it to completion, and sends `connection: close`
// so no pooled socket outlives the call; there is no server and no child
// process anywhere in it. Its one timer is `AbortSignal.timeout`'s, which
// Node creates unref'd, so it cannot hold the loop open after `main` returns
// either — and it is the reason a stuck API cannot hold this child, and the
// synchronous parent reaping it, forever (#586). The same argument
// `backlog.mjs` records for its own awaited guard, for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place the default port is written, and the same value the two other
// readers of it hold: compose's `BM_API_PORT`, and `backlog.mjs`'s own
// `apiBase`. `4322` is this app's API port (CLAUDE.md, Ports); the variable
// moves the HOST side only, exactly as compose reads it.
function apiBase() {
  const port = process.env.BM_API_PORT || '4322';
  return `http://127.0.0.1:${port}`;
}

const USAGE = 'usage: api-call.mjs <METHOD> <path> [<json body> | -]';

// How long one request may take, body included (#586). Before this there was no bound at all: a server that accepted the socket and never answered — a
// wedged event loop, a GitHub call hung behind a route — held this child, and so `orchestrate.mjs`'s `spawnSync`, and so the driver's Bash call, for as long
// as the hang lasted. 30 s is far past any answer the API gives in health (its own outbound GitHub calls are bounded tighter than that) and short enough
// that `watch`'s eight-minute budget survives a hung heartbeat. `BM_API_CALL_TIMEOUT_MS` exists for the tests alone, so a case can prove the bound in
// milliseconds; it is read per call and ignored unless it is a positive integer.
const API_CALL_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT = 6;

function callTimeoutMs() {
  const raw = Number(process.env.BM_API_CALL_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : API_CALL_TIMEOUT_MS;
}

// The one sentence a timeout prints, for a write and a read alike: this child cannot tell which routes are idempotent, and "re-read before retrying" is
// harmless advice for a read.
function timeoutText(method, requestPath) {
  return (
    `the backlog-manager API did not answer ${method} ${requestPath} within ${Math.round(callTimeoutMs() / 1000)} s — ` +
    'a write may have landed; re-read before retrying'
  );
}

// `AbortSignal.timeout` rejects with a DOMException named `TimeoutError`; anything else reaching a catch below is a transport failure.
const isTimeout = (e) => e !== null && typeof e === 'object' && e.name === 'TimeoutError';

async function main(argv) {
  const [method, requestPath, bodyArg] = argv;
  if (!method || !requestPath || !requestPath.startsWith('/')) {
    console.error(USAGE);
    return 3;
  }

  // `-` reads stdin, for a body too long to sit safely on a command line — a
  // `state` heartbeat carries a whole queue item, verification tails included.
  // Read synchronously from fd 0 rather than through a stream: this process
  // has one job and nothing to interleave with, and a stream would be a second
  // handle to account for in the exit argument above.
  let body;
  if (bodyArg === '-') {
    try {
      body = fs.readFileSync(0, 'utf8');
    } catch (e) {
      console.error(`could not read the request body from stdin: ${e.message}`);
      return 3;
    }
  } else if (bodyArg !== undefined) {
    body = bodyArg;
  }

  // One signal for the whole exchange, so a server that sends headers and then stalls the body is bounded by the same clock as one that never answers.
  const signal = AbortSignal.timeout(callTimeoutMs());
  let res;
  try {
    res = await fetch(`${apiBase()}${requestPath}`, {
      method,
      signal,
      // No `Origin` header, deliberately: `SameOriginPostGuard` allows an
      // absent origin — a non-browser caller cannot forge its way past a check
      // a browser enforces — and sending a made-up one would be this file
      // claiming to be a page it is not. The same choice `backlog.mjs` makes.
      headers: body === undefined ? { connection: 'close' } : { 'content-type': 'application/json', connection: 'close' },
      body
    });
  } catch (e) {
    if (isTimeout(e)) {
      process.stdout.write('null\n');
      console.error(timeoutText(method, requestPath));
      return EXIT_TIMEOUT;
    }
    // Every transport failure reads the same: ECONNREFUSED for nothing
    // listening, a `TypeError` for a malformed base, EHOSTUNREACH for a
    // half-configured port. All three mean "there is no API here", which is
    // one thing to fix.
    console.error(
      `the backlog-manager API is not running on ${apiBase().replace('http://', '')} — start it with \`pnpm run dev\` or \`pnpm run docker:up\`;` +
        ' a tracker project needs the stack up for every command'
    );
    return 5;
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (!isTimeout(e)) throw e;
    process.stdout.write('null\n');
    console.error(timeoutText(method, requestPath));
    return EXIT_TIMEOUT;
  }
  let payload = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    // A body that is not JSON is carried through as a STRING rather than
    // dropped: `GET /api/items/body` answers `text/plain` and IS the item's
    // Markdown, which is one of the two reads a tracker gate makes.
    payload = text;
  }

  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (res.status >= 200 && res.status < 300) return 0;
  console.error(`the API answered ${res.status} for ${method} ${requestPath}`);
  return 3;
}

export { main };

// Twin of `isMain` in `skills/backlog/tools/backlog.mjs`, which carries the reasoning; `scripts/run-as-main.test.mjs` pins every copy.
function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// The same entry guard the other three carry, so importing this module runs
// nothing — and `await main(...)` inside it, for which see this file's header:
// the rule is about `process.exit()` truncating a pipe, and what it requires
// is that nothing hold the event loop open. One awaited `fetch` with
// `connection: close`, one unref'd abort timer, no server, no child of its own.
if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
