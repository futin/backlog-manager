import { readAgentsConfig } from '../server/src/agents/config.util';
import { composePrompt, sessionName } from '../server/src/agents/prompt.util';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '',
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

  // A refactor takes the idea's sentence, not the task fallback it used to
  // fall through to ("give it a plan"). That fallback reads as an instruction
  // to edit the item in place, which is the one thing a promote must not do —
  // and a dispatched session has no human at a terminal to catch it.
  it('names the promotion for a refactor, the same as for an idea', () => {
    const p = composePrompt(fakeItem({ id: 'ref-3', title: 'Split the scanner', section: 'refactors', groomed: null }), 'groom');
    expect(p).toContain('backlog-manager:backlog-groom');
    expect(p).toContain('ref-3');
    expect(p).toMatch(/promote/i);
    expect(p).toMatch(/plan/i);
    // The negative half: the task fallback's wording must not be what a
    // refactor gets, and the two are only one fall-through apart.
    expect(p).not.toMatch(/concrete enough/i);
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

  it('asks execute to verify and archive, then commit', () => {
    const p = composePrompt(fakeItem({ id: 'task-12', title: 'Add CSP', section: 'tasks', groomed: true }), 'execute');
    expect(p).toContain('backlog-manager:backlog-execute');
    expect(p).toContain('task-12');
    expect(p).toMatch(/archive/i);
    expect(p).toMatch(/commit the work/i);
  });

  /*
   * The commit rule rides on EVERY action, so it is asserted per action rather
   * than once against `execute`. Each of these writes files — a groom rewrites
   * an item, a promote creates a task, a capture creates a new item — and a
   * dispatched session that leaves them loose in the working tree has produced
   * nothing that survives on its own.
   */
  it.each(['groom', 'execute', 'capture'] as const)('asks %s to commit, narrowly, and never to push', action => {
    const item = action === 'capture'
      ? fakeItem({ id: 'oos-2', section: 'out-of-scope', status: 'terminal', groomed: null })
      : fakeItem();
    const p = composePrompt(item, action);
    expect(p).toMatch(/commit the work/i);
    // The scope is the load-bearing half: a dispatched session runs in the
    // user's main tree, not a per-item worktree, so a blanket `git add -A`
    // would commit whatever else they had in flight. Naming both spellings of
    // that command is what a session actually reads as a ban.
    expect(p).toContain('git add -A');
    expect(p).toContain('git add .');
    expect(p).toMatch(/only the files this session changed/i);
    expect(p).toMatch(/do not push/i);
  });

  it('asks capture for a NEW item citing the rejection, and to leave the original alone', () => {
    const oos = fakeItem({ id: 'oos-2', title: 'Priority field', section: 'out-of-scope', status: 'terminal', groomed: null });
    const p = composePrompt(oos, 'capture');
    expect(p).toContain('backlog-manager:backlog-capture');
    expect(p).toContain('oos-2');
    expect(p).toContain('from: oos-2');
    // The three things this sentence has to carry, each a way it goes wrong
    // when left out: a NEW item (or the session tries to move a file `moveItem`
    // refuses to move), the citation (or the revival loses its link back to the
    // reasoning that rejected it), and the original left where it is.
    expect(p).toMatch(/new item/i);
    expect(p).toMatch(/leave/i);
    // The citation is stated as REQUIRED, not merely mentioned. A session
    // reading it as one suggestion among several is the failure this whole
    // arm exists to prevent — the revived item with no link back.
    expect(p).toMatch(/required/i);
    // And never the groom or execute wording — capture is neither.
    expect(p).not.toContain('backlog-manager:backlog-groom');
    expect(p).not.toMatch(/concrete enough/i);
  });

  it('names both routes to the citation, so it survives the old capture skill too', () => {
    /*
     * `--from <id>` is the flag that writes the `from:` frontmatter line, and
     * `backlog-capture`'s SKILL.md banned it outright until this change — with
     * a rationale ("capture doesn't do it, even when the new item was clearly
     * inspired by an existing one") that reads as a ban on the citation itself
     * rather than on one spelling of it. The skill now carries a revive
     * exception, but `skills/` is a publishing boundary: an install is a copy
     * of the pushed HEAD, so every session this prompt reaches before the next
     * `plugin:sync` is still running the version that bans the flag.
     *
     * So the prompt names the hand-written frontmatter line as well — a route
     * the OLD skill's own step 3 already models for `tags:` and `kind:` and
     * never bans. This case is what stops the second route being "simplified"
     * away on the grounds that the skill now permits the first one; the two
     * sides ship independently.
     */
    const p = composePrompt(fakeItem({ id: 'oos-2', section: 'out-of-scope', status: 'terminal', groomed: null }), 'capture');
    expect(p).toContain('--from oos-2');
    expect(p).toMatch(/by hand/i);
    expect(p).toMatch(/frontmatter/i);
  });

  it('never emits a slash command — headless expansion of those is unverified', () => {
    for (const item of [fakeItem(), fakeItem({ section: 'ideas', groomed: null })]) {
      expect(composePrompt(item, 'groom')).not.toContain('/backlog');
    }
    // The capture arm included: the item file that settled this action wrote it
    // as "spawns /backlog-capture", which names the skill and does not license
    // the slash spelling — this module's own rule wins.
    expect(composePrompt(fakeItem({ id: 'oos-1', section: 'out-of-scope', status: 'terminal', groomed: null }), 'capture'))
      .not.toContain('/backlog');
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
      fakeItem({ section: 'tasks', groomed: true }),
      fakeItem({ id: 'oos-1', section: 'out-of-scope', status: 'terminal', groomed: null })
    ]) {
      for (const action of ['groom', 'execute', 'capture'] as const) {
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
