import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAllowlist, resolveAllowed } from '../server/src/items/allow.util';

describe('body-route allowlist', () => {
  const root = mkdtempSync(join(tmpdir(), 'bm-allow-'));
  const backlog = join(root, 'backlog');
  const inside = join(backlog, 'bugs', 'open', 'bug-1-x.md');
  // The trap: a SIBLING of backlog/ whose name shares the prefix. A bare
  // startsWith(dir) lets it through; startsWith(dir + sep) does not.
  const sibling = join(root, 'backlog-evil', 'bug-1-x.md');

  beforeAll(() => {
    mkdirSync(join(backlog, 'bugs', 'open'), { recursive: true });
    mkdirSync(join(root, 'backlog-evil'), { recursive: true });
    writeFileSync(inside, 'x');
    writeFileSync(sibling, 'x');
  });

  const registry = {
    projects: [
      { name: 'p', path: root, createdAt: '2026-08-26T00:00:00.000Z' },
      { name: 'gone', path: '/nowhere/gone', createdAt: '2026-08-26T00:00:00.000Z' }
    ]
  };

  it('allowlists each registered backlog/ dir and skips vanished projects', () => {
    const dirs = buildAllowlist(registry);
    expect(dirs).toEqual(new Set([realpathSync(backlog)]));
  });

  it('resolves a file inside a registered store', () => {
    expect(resolveAllowed(inside, buildAllowlist(registry))).toBe(realpathSync(inside));
  });

  it('refuses a prefix-sharing sibling, a file outside, and a missing file', () => {
    const dirs = buildAllowlist(registry);
    expect(resolveAllowed(sibling, dirs)).toBeNull();
    expect(resolveAllowed('/etc/hosts', dirs)).toBeNull();
    expect(resolveAllowed(join(backlog, 'bugs', 'open', 'nope.md'), dirs)).toBeNull();
  });
});
