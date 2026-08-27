import { readAgentsConfig } from '../server/src/agents/config.util';
import { composePrompt, sessionName } from '../server/src/agents/prompt.util';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
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
});

describe('sessionName', () => {
  it('labels the dashboard row with project and id', () => {
    expect(sessionName(fakeItem({ project: 'alpha', id: 'task-12' }))).toBe('bl:alpha/task-12');
  });
});
