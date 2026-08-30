import { readAgentsConfig } from '../server/src/agents/config.util';
import { composePrompt, sessionName } from '../server/src/agents/prompt.util';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0,
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md'
  };
  return { ...base, ...over };
}

describe('readAgentsConfig', () => {
  it('is off with no env at all', () => {
    expect(readAgentsConfig({})).toEqual({
      enabled: false, url: 'http://127.0.0.1:4173', token: ''
    });
  });

  it('accepts on/1/true and nothing else', () => {
    expect(readAgentsConfig({ BM_AGENTS: 'on' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: '1' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: 'TRUE' }).enabled).toBe(true);
    expect(readAgentsConfig({ BM_AGENTS: 'yes' }).enabled).toBe(false);
    expect(readAgentsConfig({ BM_AGENTS: '' }).enabled).toBe(false);
  });

  it('trims the url and strips trailing slashes so path joins never double up', () => {
    expect(readAgentsConfig({ BM_AGENTS_URL: ' http://dash:9/// ' }).url).toBe('http://dash:9');
  });

  it('falls back to the loopback default on an empty url', () => {
    expect(readAgentsConfig({ BM_AGENTS_URL: '   ' }).url).toBe('http://127.0.0.1:4173');
  });
});

describe('composePrompt', () => {
  it('names the groom skill and the promotion for an idea', () => {
    const p = composePrompt(fakeItem({ id: 'idea-3', title: 'Seed the board', section: 'ideas', groomed: null }), 'groom');
    expect(p).toContain('backlog-manager:backlog-groom');
    expect(p).toContain('idea-3');
    expect(p).toContain('"Seed the board"');
    expect(p).toMatch(/promote/i);
    expect(p).toMatch(/plan/i);
  });

  it('asks a bug groom for Cause and Fix, in place', () => {
    const p = composePrompt(fakeItem(), 'groom');
    expect(p).toContain('## Cause');
    expect(p).toContain('## Fix');
    expect(p).toContain('bugs/open/');
  });

  it('asks an unplanned task groom for a plan', () => {
    const p = composePrompt(fakeItem({ id: 'task-4', section: 'tasks', groomed: false }), 'groom');
    expect(p).toContain('backlog-manager:backlog-groom');
    expect(p).toMatch(/plan/i);
  });

  it('asks execute to verify and archive, and never to commit', () => {
    const p = composePrompt(fakeItem({ id: 'task-12', title: 'Add CSP', section: 'tasks', groomed: true }), 'execute');
    expect(p).toContain('backlog-manager:backlog-execute');
    expect(p).toContain('task-12');
    expect(p).toMatch(/archive/i);
    expect(p).toMatch(/do not commit or push/i);
  });

  it('never emits a slash command — headless expansion of those is unverified', () => {
    for (const item of [fakeItem(), fakeItem({ section: 'ideas', groomed: null })]) {
      expect(composePrompt(item, 'groom')).not.toContain('/backlog');
    }
  });

  it('collapses a title that would break the one-line quoting', () => {
    const p = composePrompt(fakeItem({ title: 'line one\nline two' }), 'groom');
    expect(p).toContain('"line one line two"');
    expect(p).not.toContain('\nline two');
  });

  // The no-path-to-the-dashboard rule, asserted on the composed prompt itself.
  // test/agents-dispatch.test.ts checks the outbound body for the project
  // path, but every case there overrides the prompt with its own string, so
  // nothing proved composePrompt's OWN output is path-free — and this is the
  // string that would carry it, since the item's absolute path is right there
  // on the object being formatted.
  it('never puts the item\'s absolute path in the prompt', () => {
    for (const item of [
      fakeItem(),
      fakeItem({ section: 'ideas', groomed: null }),
      fakeItem({ section: 'tasks', groomed: true })
    ]) {
      for (const action of ['groom', 'execute'] as const) {
        expect(composePrompt(item, action)).not.toContain(item.path);
        expect(composePrompt(item, action)).not.toContain(item.projectPath);
      }
    }
  });
});

/**
 * A copy of the dashboard's own `NAME_RE` and `NAME_CAP`
 * (../claude-agents-dashboard/server/lib/spawn.ts). Copied rather than
 * imported: that repo is a sibling checkout, not a dependency, and importing
 * from it would make this repo's tests unrunnable without it.
 *
 * Pinned here because the contract fails SILENTLY on the other side —
 * `parseSpawnRequest` drops an invalid name to `undefined` rather than
 * rejecting the request, so the old `bl:<project>/<id>` spelling (neither `:`
 * nor `/` is in the charset) was discarded on 100% of dispatches and every row
 * fell back to the bare project name. Nothing in either app would have said so.
 */
const DASHBOARD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const DASHBOARD_NAME_CAP = 60;

describe('sessionName', () => {
  it('labels the dashboard row with project and id', () => {
    expect(sessionName(fakeItem({ project: 'alpha', id: 'task-12' }))).toBe('bl alpha task-12');
  });

  it('composes a name the dashboard will actually keep', () => {
    for (const item of [
      fakeItem({ project: 'alpha', id: 'task-12' }),
      fakeItem({ project: 'backlog-manager', id: 'bug-7' }),
      fakeItem({ project: 'guide.manager_2', id: 'idea-1' })
    ]) {
      const name = sessionName(item);
      expect(name).toMatch(DASHBOARD_NAME_RE);
      expect(name.length).toBeLessThanOrEqual(DASHBOARD_NAME_CAP);
    }
  });

  it('stays inside the cap for a project name long enough to blow it', () => {
    const name = sessionName(fakeItem({ project: 'a'.repeat(80), id: 'task-1' }));
    expect(name).toMatch(DASHBOARD_NAME_RE);
    expect(name).toHaveLength(DASHBOARD_NAME_CAP);
  });
});
