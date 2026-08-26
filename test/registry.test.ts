import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RegistryService, defaultRegistryFile } from '../server/src/registry/registry.service';

describe('RegistryService', () => {
  function tmpFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bm-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, content);
    return file;
  }

  it('loads a well-formed registry', () => {
    const file = tmpFile(JSON.stringify({
      projects: [{ name: 'p1', path: '/abs/p1', createdAt: '2026-08-26T00:00:00.000Z' }]
    }));
    expect(new RegistryService(file).load().projects).toHaveLength(1);
  });

  it('returns an empty registry for a missing file', () => {
    expect(new RegistryService('/nope/registry.json').load()).toEqual({ projects: [] });
  });

  it('returns an empty registry for corrupt or mis-shaped JSON', () => {
    expect(new RegistryService(tmpFile('not json')).load()).toEqual({ projects: [] });
    expect(new RegistryService(tmpFile('{"projects": 7}')).load()).toEqual({ projects: [] });
  });

  it('drops entries whose name/path/createdAt are not all strings', () => {
    // The shape that used to survive: Array.isArray(projects) held, so
    // {name: 1, path: 2} reached join(2, 'backlog') in ItemsService and 500'd
    // the whole board — which the client rendered as "nothing registered yet".
    const file = tmpFile(JSON.stringify({
      projects: [
        { name: 1, path: 2 },
        { name: 'ok', path: '/abs/ok', createdAt: '2026-08-26T00:00:00.000Z' },
        { name: 'no-createdAt', path: '/abs/x' },
        'not an object',
        null
      ]
    }));
    expect(new RegistryService(file).load().projects).toEqual([
      { name: 'ok', path: '/abs/ok', createdAt: '2026-08-26T00:00:00.000Z' }
    ]);
  });

  it('re-reads the file per call — a project registered mid-session appears', () => {
    const file = tmpFile(JSON.stringify({ projects: [] }));
    const service = new RegistryService(file);
    expect(service.load().projects).toHaveLength(0);
    writeFileSync(file, JSON.stringify({
      projects: [{ name: 'late', path: '/abs/late', createdAt: '2026-08-26T00:00:00.000Z' }]
    }));
    expect(service.load().projects).toHaveLength(1);
  });

  it('defaults to ~/.backlog-manager/registry.json, overridable by BM_REGISTRY_FILE', () => {
    const prev = process.env.BM_REGISTRY_FILE;
    try {
      delete process.env.BM_REGISTRY_FILE;
      expect(defaultRegistryFile()).toMatch(/\.backlog-manager\/registry\.json$/);
      process.env.BM_REGISTRY_FILE = '/x/registry.json';
      expect(defaultRegistryFile()).toBe('/x/registry.json');
    } finally {
      if (prev === undefined) delete process.env.BM_REGISTRY_FILE;
      else process.env.BM_REGISTRY_FILE = prev;
    }
  });
});
