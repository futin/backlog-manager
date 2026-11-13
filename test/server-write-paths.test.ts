import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { dashboardsFile } from '../server/src/agents/dashboards/dashboards-file.util';
import { jiraConfigFile } from '../server/src/jira/config.util';
import { jiraLinksFile } from '../server/src/jira/links.store';
import { controlHome } from '../server/src/orchestrator/pause-control.util';
import { watchdogFile } from '../server/src/orchestrator/watchdog-config.util';
import { reviewFile } from '../server/src/settings/review-config.util';
import { timeZoneFile } from '../server/src/settings/timezone-config.util';
import { tickFile } from '../server/src/tick/tick-breaker.util';
import { syncConfigFile } from '../server/src/tracker/sync-config.util';

/**
 * Every file the server writes must sit in a directory the compose stack mounts READ-WRITE. `~/.backlog-manager` is mounted `:ro` and only its `settings/`
 * subtree read-write, so a writer that defaults anywhere else fails every save in the stack with EROFS — and the store that hit this (`jira-links.json`,
 * 2026-11-04) caught and logged the error by contract, so for its whole life it was memory only and every restart dropped every link and unlink.
 *
 * Two halves, so neither a moved mount nor a new writer can slip past: the table below resolves each writer's DEFAULT path (no override variable set) and
 * checks the most specific `docker-compose.yml` mount covering it is read-write; and a scan of `server/src` fails on any file that writes (`writeJsonAtomic`,
 * `renameSync`, `writeFileSync`, `appendFileSync`) and is not in the table, so a new writer is a deliberate row here.
 */

const ROOT = join(__dirname, '..');

/** Each writing module, by path under `server/src`, and the default path(s) it writes to. */
const WRITERS: Record<string, string[]> = {
  'agents/dashboards/dashboards-file.util.ts': [dashboardsFile({})],
  'jira/config.util.ts': [jiraConfigFile({})],
  'jira/links.store.ts': [jiraLinksFile({})],
  'orchestrator/pause-control.util.ts': [join(controlHome({}), 'some-project.json')],
  'orchestrator/watchdog-config.util.ts': [watchdogFile({})],
  'settings/review-config.util.ts': [reviewFile({})],
  'settings/timezone-config.util.ts': [timeZoneFile({})],
  'tick/tick-breaker.util.ts': [tickFile({})],
  'tracker/sync-config.util.ts': [syncConfigFile({})]
};

/** The one helper every writer goes through; it writes wherever it is told and has no default of its own. */
const HELPERS = new Set(['atomic-write.util.ts']);

interface Mount {
  target: string;
  readOnly: boolean;
}

/** The server service's bind mounts under `${HOME}`, with `${HOME}` resolved the way compose resolves it on this host. */
function serverMounts(): Mount[] {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const server = compose.slice(compose.indexOf('\n  server:'), compose.indexOf('\n  client:'));
  const mounts: Mount[] = [];
  for (const m of server.matchAll(/^\s*- (\$\{HOME\}[^:\s]*):(\$\{HOME\}[^:\s]*)(:ro)?\s*$/gm)) {
    mounts.push({ target: m[2].replace('${HOME}', homedir()), readOnly: m[3] !== undefined });
  }
  return mounts;
}

const covers = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + sep);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('server write paths', () => {
  const mounts = serverMounts();

  it('reads the ~/.backlog-manager mounts out of docker-compose.yml: the whole tree read-only, settings/ read-write', () => {
    expect(mounts).toEqual(
      expect.arrayContaining([
        { target: join(homedir(), '.backlog-manager'), readOnly: true },
        { target: join(homedir(), '.backlog-manager', 'settings'), readOnly: false }
      ])
    );
  });

  it.each(Object.entries(WRITERS).flatMap(([mod, files]) => files.map((file) => [mod, file] as const)))(
    '%s writes %s inside a read-write mount',
    (_mod, file) => {
      const covering = mounts.filter((m) => covers(m.target, file)).sort((a, b) => b.target.length - a.target.length);
      expect(covering.length).toBeGreaterThan(0);
      expect(covering[0]).toMatchObject({ readOnly: false });
    }
  );

  it('every server module that writes a file is in the table above', () => {
    const src = join(ROOT, 'server', 'src');
    const writing = sourceFiles(src)
      .filter((f) => /\b(writeJsonAtomic|renameSync|writeFileSync|appendFileSync)\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f).split(sep).join('/'))
      .filter((f) => !HELPERS.has(f));
    expect(writing.sort()).toEqual(Object.keys(WRITERS).sort());
  });
});
