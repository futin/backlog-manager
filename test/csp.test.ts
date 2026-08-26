import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../server/src/app.module';
import { REGISTRY_FILE } from '../server/src/registry/registry.service';
import { CSP_POLICY, applySecurityHeaders } from '../server/src/security';
import { clientDistModules } from '../server/src/static';
import { makeRegistry } from './helpers/store';

const INDEX_HTML = join(__dirname, '..', 'client', 'index.html');

/**
 * A bundle fixture rather than the real client/dist: the gate runs `pnpm test`
 * before `pnpm run build`, so on a fresh checkout there is nothing at
 * client/dist to serve and a test pointed at it would pass or fail on whether
 * someone had built lately. The real index.html is copied in so the page under
 * test carries the actual pre-paint script.
 */
const distFixture = mkdtempSync(join(tmpdir(), 'bm-dist-'));
copyFileSync(INDEX_HTML, join(distFixture, 'index.html'));

@Module({ imports: [...clientDistModules(distFixture)] })
class StaticFixtureModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applySecurityHeaders(consumer);
  }
}

describe('Content-Security-Policy header', () => {
  let api: INestApplication;
  let page: INestApplication;

  beforeAll(async () => {
    const apiRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REGISTRY_FILE)
      .useValue(makeRegistry([]))
      .compile();
    api = apiRef.createNestApplication();
    await api.init();

    // NestFactory, not Test.createTestingModule, for this one: serve-static
    // picks its loader from a factory that returns a NoopLoader when
    // HttpAdapterHost has no adapter yet, and a testing module builds its
    // instances before any HTTP app exists — so static serving is silently
    // dead there and the assertion below would pass against a 404. This is the
    // path main.ts actually takes.
    page = await NestFactory.create(StaticFixtureModule, { logger: false });
    await page.init();
  });

  afterAll(async () => {
    await api.close();
    await page.close();
  });

  it('rides on every response the real app serves, 404s included', async () => {
    await request(api.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect('content-security-policy', CSP_POLICY);
    // Not route-scoped: a response Nest never routed to a controller carries it
    // too, which is what makes it a property of the server and not of /api.
    await request(api.getHttpServer())
      .get('/api/items/body')
      .expect(404)
      .expect('content-security-policy', CSP_POLICY);
  });

  it('reaches the served index.html, ahead of the static handler', async () => {
    // The ordering assertion: ServeStaticModule streams the file itself, so a
    // middleware registered after it would never run for this request.
    const res = await request(page.getHttpServer())
      .get('/')
      .expect(200)
      .expect('content-security-policy', CSP_POLICY);
    expect(res.text).toContain('<div id="root"></div>');
  });

  it("covers the pre-paint theme script's exact bytes", () => {
    // Recomputed from the source of truth rather than restated: Vite copies
    // this classic inline script into the build verbatim, so an edit here that
    // does not update THEME_SCRIPT_SHA256 would leave the built page loading a
    // script the browser refuses to run — silent until someone changes theme.
    const inline = [...readFileSync(INDEX_HTML, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inline).toHaveLength(1);
    const hash = createHash('sha256').update(inline[0][1], 'utf8').digest('base64');
    expect(CSP_POLICY).toContain(`'sha256-${hash}'`);
  });

  it('states each directive the built page needs, and nothing looser', () => {
    const directives = new Map(
      CSP_POLICY.split('; ').map((d) => {
        const [name, ...value] = d.split(' ');
        return [name, value.join(' ')];
      })
    );
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.get('img-src')).toBe("'self' data:");
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'self'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    // The whole point of hashing the one inline script: script-src must never
    // fall back to 'unsafe-inline', or the drawer's sanitizer is again alone.
    expect(directives.get('script-src')).toMatch(/^'self' 'sha256-[A-Za-z0-9+/]+=*'$/);
  });
});
