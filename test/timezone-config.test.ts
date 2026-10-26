import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTimeZone, timeZoneFile, writeTimeZone } from '../server/src/settings/timezone-config.util';

/**
 * `settings/timezone.json`'s reader and writer (#241). Every way the file can fail to name a zone reads as `null` — each browser's own zone — and never
 * throws; the writer is temp file plus rename and leaves no temp behind.
 */
describe('timezone-config.util', () => {
  let dir: string;
  let file: string;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-timezone-'));
    file = join(dir, 'timezone.json');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file reads null', () => {
    expect(readTimeZone(file)).toBeNull();
  });

  it.each([
    ['not json', 'not json'],
    ['an array', '[]'],
    ['an unknown zone', JSON.stringify({ timeZone: 'Mars/Olympus' })],
    ['a missing key', '{}']
  ])('%s reads null without throwing', (_label, text) => {
    writeFileSync(file, text);
    expect(readTimeZone(file)).toBeNull();
  });

  it('reads a zone back canonical', () => {
    writeFileSync(file, JSON.stringify({ timeZone: 'europe/belgrade' }));
    expect(readTimeZone(file)).toBe('Europe/Belgrade');
  });

  it('writes a zone that reads back, ends in a newline, and leaves no temp file', () => {
    expect(writeTimeZone('Europe/Belgrade', file)).toBe('Europe/Belgrade');
    expect(readTimeZone(file)).toBe('Europe/Belgrade');
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    expect(readdirSync(dir)).toEqual(['timezone.json']);
  });

  it('writes null, which reads back null', () => {
    writeTimeZone('Europe/Belgrade', file);
    writeTimeZone(null, file);
    expect(readTimeZone(file)).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ timeZone: null });
  });

  it('creates a directory that does not exist yet', () => {
    const nested = join(dir, 'settings', 'timezone.json');
    writeTimeZone('UTC', nested);
    expect(existsSync(nested)).toBe(true);
    expect(readTimeZone(nested)).toBe('UTC');
  });

  it('honours BM_TIMEZONE_FILE', () => {
    expect(timeZoneFile({ BM_TIMEZONE_FILE: file })).toBe(file);
    expect(timeZoneFile({})).toMatch(/\.backlog-manager\/settings\/timezone\.json$/);
  });
});
