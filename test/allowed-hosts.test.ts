import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { isAllowedHost } from '../server/src/allowed-hosts';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { applySecurityMiddleware } from '../server/src/security';
import { clientDistModules } from '../server/src/static';
import { listenLoopback } from './helpers/app';
import { item, makeProject, makeRegistry } from './helpers/store';

/**
 * bug-22. The origin guard asks whether two headers AGREE — `Origin`'s host
 * against `Host` — and a DNS-rebound page satisfies that with two matching
 * lies, while its own fetch is genuinely same-origin and so sends
 * application/json with no preflight. Both of the guard's checks clear.
 *
 * The question rebinding cannot answer is the identity one: which host was
 * this request ADDRESSED to? The browser derives `Host` from the URL the
 * attacker's own page was loaded from, so the attacker picks its value but
 * cannot make it read `localhost` while the page's origin stays theirs.
 */
describe('isAllowedHost', () => {
  /* An IP literal is not a name and therefore cannot be rebound: for a browser
     to send `Host: 203.0.113.5` here the packet would have to route to that
     address. It is also the shape supertest sends, which is why the existing
     suites stay green without one header being added to them. */
  it.each(['127.0.0.1:4322', '127.0.0.1:53492', '127.0.0.1', '203.0.113.5:4322'])(
    'allows the IP literal %s',
    (host) => {
      expect(isAllowedHost(host, {})).toBe(true);
    }
  );

  /* new URL('http://[::1]:4322').hostname is '[::1]' — brackets included — and
     net.isIP says no to that, so the brackets have to come off first. */
  it('allows an IPv6 literal, whose hostname arrives bracketed', () => {
    expect(isAllowedHost('[::1]:4322', {})).toBe(true);
  });

  it.each(['localhost:4322', 'localhost:5177', 'localhost', 'LOCALHOST:4322', 'localhost.:4322'])(
    'allows %s — the name, any port, any case, trailing dot stripped',
    (host) => {
      expect(isAllowedHost(host, {})).toBe(true);
    }
  );

  /* `pnpm run tailnet` is the one documented remote path, and this mirrors
     vite.config.ts's allowedHosts: ['.ts.net'] so the API and the dev server
     answer to the same set. A tailnet name is minted by Tailscale for a node,
     not by whoever registers a domain. */
  it('allows a tailnet name', () => {
    expect(isAllowedHost('mac.tail1234.ts.net:5177', {})).toBe(true);
  });

  it("refuses the bug's own repro host", () => {
    expect(isAllowedHost('evil.test:4322', {})).toBe(false);
  });

  it.each([
    ['evilts.net:4322', 'the suffix is dot-anchored, not a substring'],
    ['ts.net.evil.test:4322', 'the suffix must be at the END of the hostname'],
    ['127.0.0.1.evil.test:4322', 'the IP test reads the whole hostname, not a prefix of it']
  ])('refuses %s — %s', (host) => {
    expect(isAllowedHost(host, {})).toBe(false);
  });

  /* HTTP/1.1 requires the header and every browser and curl sends it, so
     defaulting an absent one to "allowed" would reopen the hole to a
     hand-rolled client. */
  it.each<[string, string | undefined]>([['empty', ''], ['absent', undefined]])(
    'refuses an %s Host',
    (_label, host) => {
      expect(isAllowedHost(host, {})).toBe(false);
    }
  );

  it('refuses a Host the URL parser cannot parse', () => {
    expect(isAllowedHost('not a host:4322', {})).toBe(false);
  });

  describe('BM_ALLOWED_HOSTS — the escape hatch for a setup this repo does not ship', () => {
    it('allows an exact entry and nothing else', () => {
      const env = { BM_ALLOWED_HOSTS: 'board.example' };
      expect(isAllowedHost('board.example:4322', env)).toBe(true);
      expect(isAllowedHost('other.example:4322', env)).toBe(false);
    });

    it('treats a leading dot as a suffix match on a label boundary', () => {
      const env = { BM_ALLOWED_HOSTS: '.corp.example' };
      expect(isAllowedHost('x.corp.example:4322', env)).toBe(true);
      expect(isAllowedHost('corp.example.evil.test:4322', env)).toBe(false);
    });

    it('trims, lowercases and ignores empty entries', () => {
      const env = { BM_ALLOWED_HOSTS: ' Board.Example , , .Corp.Example ,' };
      expect(isAllowedHost('board.example:4322', env)).toBe(true);
      expect(isAllowedHost('x.corp.example', env)).toBe(true);
    });

    /* Read per request, no cache — the same posture BM_AGENTS has. A value
       memoised at import would make the second call here agree with the
       first. */
    it('is read fresh on every call, so changing the variable changes the verdict', () => {
      const before = { ...process.env };
      try {
        process.env.BM_ALLOWED_HOSTS = 'board.example';
        expect(isAllowedHost('board.example:4322')).toBe(true);
        process.env.BM_ALLOWED_HOSTS = 'elsewhere.example';
        expect(isAllowedHost('board.example:4322')).toBe(false);
      } finally {
        process.env = { ...before };
      }
    });
  });
});

const GROOMED_BUG = item('bug-2', 'a known bug', '## Symptom\n\nx\n\n## Cause\n\na typo\n\n## Fix\n\nfix it\n');
const SECRET_LINE = 'a typo';

let projectPath: string;

/** As in test/agents-origin-guard.test.ts: an assertion of [] against this
 *  array is the real subject — a request that got past the gate still meets a
 *  plausible dashboard, so it fails on the fetch log rather than on a rejected
 *  promise that could be mistaken for the gate working. */
function recordFetches(): string[] {
  const sent: string[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    sent.push(url);
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(
        url.endsWith('/api/management')
          ? { projects: [{ dirName: '-abs-alpha', name: 'alpha', path: projectPath, lastActiveMs: 1 }] }
          : url.endsWith('/api/spawn')
            ? { sessionId: 'sess-1' }
            : { ok: true, remoteAnswer: true, spawnAvailable: true, spawnMaxPermission: 'acceptEdits' }
      )
    } as Response);
  }) as jest.Mock;
  return sent;
}

describe('the Host gate, over the whole app', () => {
  let app: INestApplication;
  const env = { ...process.env };
  const realFetch = global.fetch;

  beforeEach(async () => {
    projectPath = makeProject('alpha', [
      { leaf: 'bugs/open', filename: 'bug-2-a-known-bug.md', content: GROOMED_BUG }
    ]);
    process.env.BM_AGENTS = 'on';
    process.env.BM_AGENTS_URL = 'http://dash.test:4173';
    delete process.env.BM_ALLOWED_HOSTS;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([{ name: 'alpha', path: projectPath }]))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await listenLoopback(app);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...env };
    global.fetch = realFetch;
  });

  const bugPath = (): string => join(projectPath, 'backlog', 'bugs/open', 'bug-2-a-known-bug.md');
  const body = (): Record<string, unknown> => ({
    itemPath: bugPath(),
    action: 'execute',
    prompt: 'Use the backlog-manager:backlog-execute skill on bug-2.',
    permissionMode: 'acceptEdits',
    remoteControl: true
  });

  /* The bug itself. Both headers are the attacker's and they agree perfectly,
     so the origin guard is satisfied; before the gate existed this returned
     201 and spawned a session carrying the attacker's prompt. */
  it('403s the rebound dispatch the origin guard lets through, without any outbound call', async () => {
    const sent = recordFetches();
    const res = await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .set('host', 'evil.test:4322')
      .set('origin', 'http://evil.test:4322')
      .send(body())
      .expect(403);
    expect(res.body.error).toMatch(/Host/);
    expect(sent).toEqual([]);
  });

  /* The read half, and the case that fails if the gate is scoped to the agents
     routes: /api/items/body reads any registered project's backlog file
     straight off disk, which is precisely what the loopback bind exists to
     protect. */
  it('403s a rebound read of an item body, disclosing none of the file', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/items/body')
      .query({ path: bugPath() })
      .set('host', 'evil.test:4322')
      .expect(403);
    expect(res.text).not.toContain(SECRET_LINE);
  });

  it('403s a rebound GET /api/health — the gate is a property of the server, not of /api/agents', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .set('host', 'evil.test:4322')
      .expect(403);
  });

  /* The documented remote path has to keep working, and over both schemes: a
     tailscale serve terminates TLS and sends https:// in Origin while the
     request arriving here is still HTTP, which is why the origin guard
     deliberately does not compare schemes. */
  it.each(['http', 'https'])('still spawns for a tailnet Host with an %s origin', async (scheme) => {
    const sent = recordFetches();
    await request(app.getHttpServer())
      .post('/api/agents/dispatch')
      .set('host', 'mac.tail1234.ts.net:5177')
      .set('origin', `${scheme}://mac.tail1234.ts.net:5177`)
      .send(body())
      .expect(201);
    expect(sent.some((u) => u.endsWith('/api/spawn'))).toBe(true);
  });

  it('lets an operator name their own host through BM_ALLOWED_HOSTS', async () => {
    process.env.BM_ALLOWED_HOSTS = 'board.example';
    await request(app.getHttpServer())
      .get('/api/health')
      .set('host', 'board.example:4322')
      .expect(200);
  });
});

/**
 * The ordering assertion, behaviourally rather than by reading source:
 * ServeStaticModule streams index.html itself, so a gate registered after it
 * would never run for this request — the page would come back 200 with its
 * contents. Same fixture shape as test/csp.test.ts, and for the same reason
 * (the gate rides on the applier that registers the CSP, so it cannot be
 * carried without it).
 */
describe('the Host gate against the static handler', () => {
  let page: INestApplication;

  beforeAll(async () => {
    const distFixture = mkdtempSync(join(tmpdir(), 'bm-dist-'));
    copyFileSync(join(__dirname, '..', 'client', 'index.html'), join(distFixture, 'index.html'));

    @Module({ imports: [...clientDistModules(distFixture)] })
    class StaticFixtureModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        applySecurityMiddleware(consumer);
      }
    }

    page = await NestFactory.create(StaticFixtureModule, { logger: false });
    await page.init();
    await listenLoopback(page);
  });

  afterAll(async () => {
    await page.close();
  });

  it('403s a rebound GET / ahead of the file being streamed', async () => {
    const res = await request(page.getHttpServer())
      .get('/')
      .set('host', 'evil.test:5177')
      .expect(403);
    expect(res.text).not.toContain('<div id="root"></div>');
  });

  it('still serves the page to an allowed Host', async () => {
    const res = await request(page.getHttpServer())
      .get('/')
      .set('host', 'localhost:5177')
      .expect(200);
    expect(res.text).toContain('<div id="root"></div>');
  });
});
