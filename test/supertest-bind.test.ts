import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, get as httpGet } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { listenLoopback } from './helpers/app';
import { makeRegistry } from './helpers/store';

/**
 * bug-33 — the merge gate's one false red.
 *
 * supertest dials `http://127.0.0.1:<port>` unconditionally
 * (`serverAddress()` in `node_modules/supertest/lib/test.js`, 7.2.2) but the
 * listener it measures that port from may be bound to the IPv6 wildcard `::`,
 * because a bare `listen(0)` passes no host. Those two addresses are not the
 * same socket: the kernel hands out an ephemeral port against `::` without
 * regard for who already holds that number on `127.0.0.1`, and then routes
 * the IPv4 dial to the MOST SPECIFIC match — the stranger's socket, not ours.
 * The request never reaches the app under test and the assertion runs against
 * whatever some other program on this machine answered: a wrong status, a
 * `Parse Error` off a non-HTTP listener, or a connect timeout.
 *
 * Measured at roughly 1 crossed-over request in 1,500 on a loaded machine,
 * which over a few hundred supertest calls per `pnpm test` is the observed
 * "exactly one failure, green on the very next run" — and `pnpm test`'s exit
 * code is the only thing that green-lights an orchestrator merge.
 *
 * The fix is `listenLoopback` (`test/helpers/app.ts`): listen once per suite,
 * on `127.0.0.1`. This file pins all three halves of it — the helper binds
 * where supertest dials, supertest then re-binds nothing per request, and the
 * platform really does behave the way the paragraph above claims.
 */
describe('listenLoopback', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  /* The host argument IS the fix, so this is the assertion that goes red the
     moment anyone drops it: a wildcard bind reports `::`/IPv6 here. */
  it('binds the server to IPv4 loopback, the address supertest dials', async () => {
    await listenLoopback(app);

    const address = app.getHttpServer().address();
    expect(address).toEqual({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) });
    expect((address as { port: number }).port).toBeGreaterThan(0);
  });

  /* The second effect of listening first, and the reason this is not merely a
     host argument bolted onto supertest's own bind: with `app.address()`
     already non-null, serverAddress's `if (!addr) this._server = app.listen(0)`
     branch never runs, so supertest opens and closes nothing per request. Each
     of those cycles was one more ticket in the port lottery, and
     `orchestrator-runs.test.ts` already blames the churn itself for a separate
     `socket hang up`. With `app.init()` alone both spies below record one call
     per request. */
  it('leaves supertest to re-bind nothing — no listen or close per request', async () => {
    await listenLoopback(app);
    const server = app.getHttpServer();
    const listen = jest.spyOn(server, 'listen');
    const close = jest.spyOn(server, 'close');

    try {
      await request(server).get('/api/health').expect(200);
      await request(server).get('/api/health').expect(200);

      expect(listen).toHaveBeenCalledTimes(0);
      expect(close).toHaveBeenCalledTimes(0);
    } finally {
      /* Restored inside the test, not left to `restoreMocks`: `afterEach`
         calls `app.close()`, which goes through the very `close` spied on
         above, and a spy still in place there would outlive the assertion it
         was taken for. */
      listen.mockRestore();
      close.mockRestore();
    }
  });
});

/**
 * The bug itself, reproduced in one file and in milliseconds — deterministic,
 * no timing, no loop. It exists so the next reader cannot conclude that the
 * host argument in `helpers/app.ts` is decoration: delete it and the suite
 * above goes red, but only this describe block explains WHY that matters, by
 * showing a foreign listener answering a dial meant for us.
 */
describe('the platform behaviour this helper exists for', () => {
  let squatter: NetServer;
  let shadow: ReturnType<typeof createHttpServer> | undefined;
  let accepted: Socket[] = [];

  beforeEach(async () => {
    /* A non-HTTP listener, which is the version of the bug that produces
       `Parse Error: Expected HTTP/, RTSP/ or ICE/` rather than a wrong
       status. Bound explicitly to 127.0.0.1 — it plays the part of the
       stranger (a JetBrains process, Postman, a dev server) that really was
       holding ephemeral-range loopback ports on the machine where this was
       measured. */
    accepted = [];
    squatter = createNetServer((socket) => {
      accepted.push(socket);
      socket.end('NOT-HTTP\r\n\r\n');
    });
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  });

  /* Every accepted socket is destroyed before either server is closed, and
     that is not belt-and-braces: the squatter answers with `socket.end(...)`,
     which only half-closes its side, and a client that just took a parse
     error is under no obligation to close the other half promptly.
     `server.close()` waits for every connection to be gone, so without this
     the teardown never calls back and the case dies on jest's hook timeout
     instead of on its own assertion — which is how this was first seen.
     `http.Server` has `closeAllConnections()` for exactly this; `net.Server`
     has no such method, hence the list. */
  afterEach(async () => {
    for (const socket of accepted) socket.destroy();
    if (shadow) {
      shadow.closeAllConnections();
      await new Promise<void>((resolve) => shadow!.close(() => resolve()));
    }
    shadow = undefined;
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });

  function occupiedPort(): number {
    return (squatter.address() as { port: number }).port;
  }

  it('lets a wildcard listen(port) succeed on a port 127.0.0.1 already holds', async () => {
    shadow = createHttpServer((_req, res) => res.end('ours'));

    await new Promise<void>((resolve, reject) => {
      shadow!.once('error', reject);
      shadow!.listen(occupiedPort(), resolve);
    });

    expect(shadow.address()).toEqual({ address: '::', family: 'IPv6', port: occupiedPort() });
  });

  it('routes the IPv4 dial to the squatter, not to the wildcard listener', async () => {
    shadow = createHttpServer((_req, res) => res.end('ours'));
    await new Promise<void>((resolve, reject) => {
      shadow!.once('error', reject);
      shadow!.listen(occupiedPort(), resolve);
    });

    /* `agent: false` is what superagent passes, and Node turns it into a
       fresh non-keep-alive agent — the same socket setup a supertest request
       gets, so this is the real path and not an approximation of it. */
    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port: occupiedPort(), path: '/', agent: false }, (res) => {
        res.resume();
        reject(new Error(`reached a real HTTP responder (${res.statusCode}) — the squatter did not answer`));
      }).on('error', resolve);
    });

    expect(error.code).toBe('HPE_INVALID_CONSTANT');
  });

  it('refuses the same bind written with the loopback host — which is why the fix works', async () => {
    shadow = createHttpServer();

    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      shadow!.once('error', resolve);
      shadow!.listen(occupiedPort(), '127.0.0.1', () => reject(new Error('bound a port 127.0.0.1 already holds')));
    });

    expect(error.code).toBe('EADDRINUSE');
  });
});

/**
 * Source guard, in the shape `test/server-bind.test.ts` and
 * `test/compose-env.test.ts` already use: read the files, assert on their
 * text. Behavioural coverage cannot reach this — a suite that forgets the
 * helper stays green roughly 1,499 runs out of 1,500, which is precisely the
 * defect.
 *
 * What it cannot catch, stated so nobody reads more into a green: a suite
 * that builds a SECOND app (or a second `NestFactory.create`) and listens
 * only the first still contains `listenLoopback(` and passes here. Two such
 * pairs exist today — `csp.test.ts` and `allowed-hosts.test.ts` — and both
 * call the helper for every app they hand to `request(...)`; a third has to
 * be checked by the reader.
 */
describe('every supertest suite listens through the helper', () => {
  const TEST_DIR = join(__dirname);

  /* Walked rather than globbed: `test/helpers/` and `test/fixtures/` are
     directories under the same root, and the rule is about every file here,
     not only the ones jest's testMatch collects. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
    });
  }

  /* Comments are blanked before anything is matched, the same precaution
     `server-bind.test.ts` takes for the same reason: this very file, and
     `helpers/app.ts`, both quote `app.listen(0)` while explaining why no
     suite may write it, so a scan of the raw text reports the warning as the
     offence. Blanking is also what lets the `.listen(0)` rule have no
     exemptions at all — the helper's own call is `listen(0, '127.0.0.1')`,
     which this pattern does not match, so "nowhere under test/" means
     nowhere. Kept local rather than shared with `server-bind.test.ts`: that
     one resolves consts and evaluates expressions, this one needs a
     substring, and a shared utility built for both would be larger than
     either. Quotes are not tracked because nothing here matches on a string
     literal's contents. */
  function blankComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  }

  const files = sourceFiles(TEST_DIR).map((path) => ({ path, source: blankComments(readFileSync(path, 'utf8')) }));

  it('finds the suites at all — a rename that empties this list must fail loudly', () => {
    expect(files.filter((file) => file.source.includes("from 'supertest'")).length).toBeGreaterThanOrEqual(18);
  });

  it('has no supertest suite that skips listenLoopback', () => {
    const offenders = files
      .filter((file) => file.source.includes("from 'supertest'") && !file.source.includes('listenLoopback('))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  /* `listen(0)` with no host is the exact spelling of the bug, so it may
     exist in precisely one place: the helper, where the host argument makes
     it `listen(0, '127.0.0.1')` and this pattern does not match. */
  it('leaves no bare listen(0) anywhere under test/', () => {
    /* Assembled rather than written out, because a scanner that contains its
       own needle reports itself — and blanking comments cannot save it, since
       this one is code. Splitting the literal is the smallest thing that keeps
       the rule exemption-free: an exemption for "the file doing the checking"
       is an exemption a future suite could claim too. */
    const BARE_LISTEN = '.listen(' + '0)';
    const offenders = files.filter((file) => file.source.includes(BARE_LISTEN)).map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
