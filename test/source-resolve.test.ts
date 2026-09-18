import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SOURCE_MARKER, resolveSource } from '../server/src/items/sources/resolve.util';

/**
 * Real temp directories, not a stubbed `fs` — the same choice
 * test/uncommitted.test.ts makes: what is under test is almost entirely the
 * filesystem's own answers (a marker that is a directory, a file that is not
 * JSON, a store that is not there at all), and a mock would only assert the
 * mock's idea of those.
 *
 * The suite also pins the negative that makes the whole seam safe: an
 * unsupported marker resolves to `unsupported`, NEVER to `files`. See
 * docs/subsystems/invariants.md, "A project's source is a committed marker".
 */

const dirs: string[] = [];

function project(marker?: string, withBacklog = true): string {
  const root = mkdtempSync(join(tmpdir(), 'bm-source-'));
  dirs.push(root);
  if (withBacklog) mkdirSync(join(root, 'backlog'), { recursive: true });
  if (marker !== undefined) writeFileSync(join(root, 'backlog', SOURCE_MARKER), marker);
  return root;
}

function markerPath(root: string): string {
  return join(root, 'backlog', SOURCE_MARKER);
}

const FILES_ONLY = new Set(['files']);

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveSource', () => {
  it('answers missing when the project has no backlog/ at all', () => {
    expect(resolveSource(project(undefined, false), FILES_ONLY)).toEqual({ kind: 'missing' });
  });

  it('answers files when a store exists with no marker — the implicit source', () => {
    expect(resolveSource(project(), FILES_ONLY)).toEqual({ kind: 'files' });
  });

  it('honours an explicit files marker, and does not need files registered', () => {
    const root = project('{"kind":"files"}');
    expect(resolveSource(root, FILES_ONLY)).toEqual({ kind: 'files' });
    // `files` is the implicit source: refusing to answer it because nobody
    // registered an adapter would make the explicit spelling worse than the
    // absent one.
    expect(resolveSource(root, new Set())).toEqual({ kind: 'files' });
  });

  it('answers tracker with the parsed marker for a kind the caller registered', () => {
    const root = project('{"kind":"github","repo":"futin/x"}');
    expect(resolveSource(root, new Set(['files', 'github']))).toEqual({
      kind: 'tracker',
      marker: { kind: 'github', repo: 'futin/x' }
    });
  });

  it('answers unsupported for a kind no registered adapter serves', () => {
    const root = project('{"kind":"github","repo":"futin/x"}');
    const resolved = resolveSource(root, FILES_ONLY);
    expect(resolved.kind).toBe('unsupported');
    if (resolved.kind !== 'unsupported') throw new Error('narrowing');
    expect(resolved.reason.startsWith(markerPath(root))).toBe(true);
    expect(resolved.reason).toContain('github');
  });

  it('answers unsupported for a marker that is not JSON', () => {
    const root = project('{nope');
    const resolved = resolveSource(root, FILES_ONLY);
    expect(resolved.kind).toBe('unsupported');
    if (resolved.kind !== 'unsupported') throw new Error('narrowing');
    expect(resolved.reason.startsWith(markerPath(root))).toBe(true);
    expect(resolved.reason).toContain('JSON');
  });

  it.each([
    ['an array', '[]'],
    ['an object with no kind', '{}'],
    ['a non-string kind', '{"kind":3}']
  ])('answers unsupported for %s', (_label, text) => {
    const root = project(text);
    const resolved = resolveSource(root, FILES_ONLY);
    expect(resolved.kind).toBe('unsupported');
    if (resolved.kind !== 'unsupported') throw new Error('narrowing');
    expect(resolved.reason.startsWith(markerPath(root))).toBe(true);
    expect(resolved.reason).toContain('kind');
  });

  it('answers unsupported when the marker is a directory', () => {
    const root = project();
    mkdirSync(markerPath(root));
    const resolved = resolveSource(root, FILES_ONLY);
    expect(resolved.kind).toBe('unsupported');
    if (resolved.kind !== 'unsupported') throw new Error('narrowing');
    expect(resolved.reason.startsWith(markerPath(root))).toBe(true);
  });

  it('re-reads the marker on every call — nothing is cached', () => {
    const root = project('{"kind":"github","repo":"futin/x"}');
    const known = new Set(['files', 'github']);
    expect(resolveSource(root, known).kind).toBe('tracker');
    writeFileSync(markerPath(root), '{"kind":"files"}');
    expect(resolveSource(root, known).kind).toBe('files');
  });
});
