import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitlabSyncUnreadableError, gitlabSyncFile, readGitlabInterval, writeGitlabInterval } from '../../server/src/gitlab/sync-config.util';

/** `~/.backlog-manager/settings/gitlab-sync.json` (#527): every case on a file in its own temp directory, never the developer's real one. */

const dirs: string[] = [];
function tempFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-gitlab-sync-config-'));
  dirs.push(dir);
  const file = join(dir, 'gitlab-sync.json');
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('readGitlabInterval', () => {
  it('a missing file reads as the default, 1m', () => {
    expect(readGitlabInterval(tempFile())).toBe('1m');
  });

  it.each([
    ['{"interval":"5m"}', '5m'],
    ['{"interval":"off"}', 'off']
  ])('%s reads as %s', (content, expected) => {
    expect(readGitlabInterval(tempFile(content))).toBe(expected);
  });

  // A bare string is NOT the default token, so a reader that accepted the file's top-level string as the value would answer `5m` and fail.
  it.each(['{"interval":"2m"}', '{"interval":15}', '{}', '[]', 'null', '"5m"'])('%s reads as the default', (content) => {
    expect(readGitlabInterval(tempFile(content))).toBe('1m');
  });

  it('a file that does not parse reads as the default and warns once, naming the file', () => {
    const file = tempFile('{not json');
    expect(readGitlabInterval(file)).toBe('1m');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(file);
  });
});

describe('writeGitlabInterval', () => {
  it('a missing file is written fresh, holding exactly the interval', () => {
    const file = tempFile();
    writeGitlabInterval('15s', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ interval: '15s' });
  });

  it('every other key of a parsed object survives', () => {
    const file = tempFile('{"interval":"1m","note":"keep"}');
    writeGitlabInterval('off', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ interval: 'off', note: 'keep' });
  });

  it('a parsed non-object is replaced by { interval }', () => {
    const file = tempFile('[]');
    writeGitlabInterval('5m', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ interval: '5m' });
  });

  it('a file that does not parse is refused and left byte-identical', () => {
    const file = tempFile('{not json');
    let thrown: unknown = null;
    try {
      writeGitlabInterval('5m', file);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GitlabSyncUnreadableError);
    expect((thrown as Error).message).toContain('does not parse as JSON');
    expect((thrown as Error).message).toContain('nothing was written');
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('gitlabSyncFile', () => {
  it('is BM_GITLAB_SYNC_FILE when set, else the settings path under the home directory', () => {
    expect(gitlabSyncFile({ BM_GITLAB_SYNC_FILE: '/x/y.json' })).toBe('/x/y.json');
    expect(gitlabSyncFile({ BM_GITLAB_SYNC_FILE: '' })).toMatch(/\.backlog-manager\/settings\/gitlab-sync\.json$/);
  });
});
