import { authHeaders, readAgentsConfig } from '../server/src/agents/config.util';
import { dashboardError, orchestrateSessionName, resumeSessionName } from '../server/src/agents/agents.service';
import { appendFinishClause, composePrompt, sessionName } from '../server/src/agents/prompt.util';
import { COMMIT_RULE, FINISH_FLAG, defuseFinishFlags, finishClause } from '../shared/agent';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: '2026-08-20',
    started: '',
    tags: [],
    updated: '',
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: false,
    path: '/abs/alpha/backlog/bugs/open/bug-1.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false
  };
  return { ...base, ...over };
}

describe('readAgentsConfig', () => {
  it('is off with no env at all', () => {
    expect(readAgentsConfig({})).toEqual({
      enabled: false,
      url: 'http://127.0.0.1:4173',
      token: ''
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

/* An empty token must send no header at all: `Bearer ` with nothing after it is a credential the dashboard would reject, where no header is the
   unauthenticated call a token-less dashboard accepts. */
describe('authHeaders', () => {
  it('sends no authorization header for an empty token', () => {
    expect(authHeaders(readAgentsConfig({ BM_AGENTS: 'on' }))).toEqual({});
  });

  it('sends the token as a bearer when one is set', () => {
    expect(authHeaders(readAgentsConfig({ BM_AGENTS_TOKEN: 's3cret' }))).toEqual({ authorization: 'Bearer s3cret' });
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

  it('asks execute to verify and archive, and ends on the instruction — the finish clause is the server dispatch\'s to append, never the plan\'s', () => {
    const p = composePrompt(fakeItem({ id: 'task-12', title: 'Add CSP', section: 'tasks', groomed: true }), 'execute');
    expect(p).toContain('backlog-manager:backlog-execute');
    expect(p).toContain('task-12');
    expect(p).toMatch(/archive/i);
    expect(p.endsWith('Report what you changed.')).toBe(true);
    expect(p).not.toContain(COMMIT_RULE);
    expect(p).not.toContain('--finish');
  });

  /*
   * The commit rule rides on capture alone. An execute's and a groom's closing clause is appended by `AgentsService.dispatch` from the sheet's validated
   * finish pick (`finishClause`), so their plan text carries none — for `in-place` that clause IS this sentence, asserted in agents-dispatch.test.ts. A
   * capture creates a new item, and a dispatched session that leaves it loose in the working tree has produced nothing that survives on its own.
   */
  it.each(['capture'] as const)('asks %s to commit, narrowly, and never to push', (action) => {
    const item = fakeItem({ id: 'oos-2', section: 'out-of-scope', status: 'terminal', groomed: null });
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
    expect(composePrompt(fakeItem({ id: 'oos-1', section: 'out-of-scope', status: 'terminal', groomed: null }), 'capture')).not.toContain('/backlog');
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
  it("never puts the item's absolute path in the prompt", () => {
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

describe('orchestrateSessionName', () => {
  it('labels the row with the project path-s basename', () => {
    expect(orchestrateSessionName('/abs/alpha')).toBe('orchestrate alpha');
  });

  it('stays inside the cap for a project path long enough to blow it', () => {
    const name = orchestrateSessionName(`/abs/${'a'.repeat(80)}`);
    expect(name).toMatch(DASHBOARD_NAME_RE);
    expect(name).toHaveLength(DASHBOARD_NAME_CAP);
  });
});

/**
 * `resumeSessionName` is the one place this codebase has already gotten this
 * wrong once: the plan it was built from specified a middle dot (`·`,
 * U+00B7) as the prefix/basename separator, which is just as outside
 * `NAME_RE`'s charset as the `:`/`/` the comment above already guards
 * against, and would have been silently dropped by the dashboard on every
 * resumed run for both origins. Pinning both origins' output against the
 * same `DASHBOARD_NAME_RE`/`DASHBOARD_NAME_CAP` `sessionName` is checked
 * against above is the whole point of this suite — it is what stops the
 * next edit from reintroducing a character the dashboard drops, rather than
 * relying on a reader noticing prose that says not to.
 */
describe('resumeSessionName', () => {
  it('composes a name the dashboard will actually keep, for both origins', () => {
    for (const origin of ['board', 'watchdog'] as const) {
      const name = resumeSessionName('/abs/alpha', origin);
      expect(name).toMatch(DASHBOARD_NAME_RE);
      expect(name.length).toBeLessThanOrEqual(DASHBOARD_NAME_CAP);
    }
  });

  it('stays inside the cap for a project path long enough to blow it, for both origins', () => {
    const longPath = `/abs/${'a'.repeat(80)}`;
    for (const origin of ['board', 'watchdog'] as const) {
      const name = resumeSessionName(longPath, origin);
      expect(name).toMatch(DASHBOARD_NAME_RE);
      expect(name).toHaveLength(DASHBOARD_NAME_CAP);
    }
  });
});

/* bug-26. The three e2e suites prove the two seams answer 502 with a readable
   `error`; these pin the wording rules themselves, one per branch, including
   the fall-through — the branch no route can reach without a dashboard that
   fails in a way none of the stubs above can stage. */
describe('dashboardError', () => {
  it('names the call and its budget for an abort, since the exception names neither', () => {
    const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(dashboardError(timedOut, 'the dashboard spawn call', 10_000)).toBe('the dashboard spawn call timed out after 10000ms');
    // A caller-side abort reads the same to a reader: nothing came back.
    expect(dashboardError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'x', 5)).toBe('x timed out after 5ms');
  });

  it('reaches into .cause, where a connection failure keeps its only detail', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:4173' }
    });
    expect(dashboardError(refused, 'the dashboard project list', 15_000)).toBe('the dashboard project list failed: ECONNREFUSED');
    // No `code` — some causes carry only a message, and that is still more
    // than the bare `fetch failed` the outer error offers.
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { message: 'getaddrinfo ENOTFOUND dash' } });
    expect(dashboardError(dns, 'x', 1)).toBe('x failed: getaddrinfo ENOTFOUND dash');
  });

  it('leaves anything else exactly as message() reads it', () => {
    // The shape `get()` throws for a non-ok answer: already a sentence, and
    // re-wording it would only lose the status it carries.
    expect(dashboardError(new Error('/api/configs answered 500'), 'x', 1)).toBe('/api/configs answered 500');
    expect(dashboardError('a bare string', 'x', 1)).toBe('a bare string');
    expect(dashboardError(null, 'x', 1)).toBe('null');
  });
});

/*
 * The execute and groom prompts carry no closing clause (the finish pick is the sheet's, appended at dispatch), while capture keeps `COMMIT_RULE` in the
 * editable text. composePrompt takes exactly (item, action): nothing about the finish mode is read at plan time — it is the sheet's pick.
 */
describe('composePrompt closing clause', () => {
  it('execute ends with the instruction sentence and carries neither COMMIT_RULE nor a --finish token', () => {
    const p = composePrompt(fakeItem({ id: 'task-12', section: 'tasks', groomed: true }), 'execute');
    expect(p.endsWith('Report what you changed.')).toBe(true);
    expect(p).not.toContain(COMMIT_RULE);
    expect(p).not.toContain('--finish');
    expect(p).not.toContain('Do not push');
  });

  it('capture still ends with COMMIT_RULE', () => {
    const it_ = fakeItem({ id: 'oos-2', section: 'out-of-scope', status: 'terminal', groomed: null });
    expect(composePrompt(it_, 'capture').endsWith(COMMIT_RULE)).toBe(true);
  });

  it('groom no longer carries COMMIT_RULE — the finish clause is appended at dispatch, like an execute\'s', () => {
    const p = composePrompt(fakeItem({ groomed: false }), 'groom');
    expect(p).not.toContain(COMMIT_RULE);
    expect(p).not.toContain('Do not push');
  });

  it.each([
    ['a bug', fakeItem({ id: 'bug-1', section: 'bugs', groomed: false })],
    ['an idea', fakeItem({ id: 'idea-1', section: 'ideas', groomed: null })],
    ['a refactor', fakeItem({ id: 'ref-1', section: 'refactors', groomed: null })],
    ['a task', fakeItem({ id: 'task-1', section: 'tasks', groomed: false })]
  ])('the groom prompt for %s carries no FINISH_FLAG match', (_name, it_) => {
    expect(FINISH_FLAG.test(composePrompt(it_, 'groom'))).toBe(false);
  });
});

/*
 * A title is free text, and one that spells `--base` or `--finish` (this repo's own history has one) would make the untouched composed execute prompt trip
 * dispatch's token refusal. composePrompt defuses the two tokens inside the quoted title with U+2011 hyphens — same look, no flag — through the one pattern
 * the refusal itself uses.
 */
describe('composePrompt title flag tokens', () => {
  const NB = '\u2011\u2011';
  it('an execute title with --base and --finish composes a prompt the token refusal would not match, the words still readable', () => {
    const p = composePrompt(fakeItem({ id: 'task-3', title: 'Fix --base handling and --finish flags', section: 'tasks', groomed: true }), 'execute');
    expect(FINISH_FLAG.test(p)).toBe(false);
    expect(p).toContain(`"Fix ${NB}base handling and ${NB}finish flags"`);
  });

  it('leaves longer words alone: --finished and --base-ref are not tokens', () => {
    const p = composePrompt(fakeItem({ id: 'task-3', title: 'Rename --finished and --base-ref', section: 'tasks', groomed: true }), 'execute');
    expect(p).toContain('"Rename --finished and --base-ref"');
  });

  it('applies to groom and capture too, one rule for every action', () => {
    const p = composePrompt(fakeItem({ title: 'About --finish' }), 'groom');
    expect(p).toContain(`"About ${NB}finish"`);
  });
});

/* The pattern learned two more tokens with the auto-merge and fix checkboxes: a body spelling either is as much a smuggled flag as `--finish` is. The same
   boundary rule applies — a longer word (`--fix-up`, `--auto-merged`) or a word character before it is not a flag. */
describe('FINISH_FLAG and the auto-merge / fix tokens', () => {
  it.each(['--auto-merge', '--fix'])('matches %s bare, quoted and parenthesised', (flag) => {
    expect(FINISH_FLAG.test(`Run with ${flag} now`)).toBe(true);
    expect(FINISH_FLAG.test(`Run with "${flag}" now`)).toBe(true);
    expect(FINISH_FLAG.test(`Run with (${flag}) now`)).toBe(true);
    expect(FINISH_FLAG.test(flag)).toBe(true);
  });

  it.each(['--fixed', '--fix-up', '--auto-merged', 'prefix--fix', '--auto-merge-queue'])('does not match %s', (word) => {
    expect(FINISH_FLAG.test(`about ${word} here`)).toBe(false);
  });

  it('defuseFinishFlags rewrites both, leaves no match and keeps the visible words', () => {
    const out = defuseFinishFlags('Use --fix and --auto-merge');
    expect(FINISH_FLAG.test(out)).toBe(false);
    expect(out).toBe('Use \u2011\u2011fix and \u2011\u2011auto-merge');
    expect(out.replace(/\u2011/g, '-')).toBe('Use --fix and --auto-merge');
  });
});

/*
 * The groom strip: a groom's editable body ends in `COMMIT_RULE`, and dispatch swaps that trailing sentence for the finish clause — never a copy of the rule a
 * person moved to the middle of their text, and never the text around it.
 */
describe('appendFinishClause', () => {
  const PR = finishClause('groom', 'pr', 'main');

  it('swaps a trailing commit rule for the clause, trailing whitespace and all', () => {
    expect(appendFinishClause(`Groom bug-3. ${COMMIT_RULE}`, 'groom', 'pr', 'main', {})).toBe(`Groom bug-3. ${PR}`);
    expect(appendFinishClause(`Groom bug-3. ${COMMIT_RULE}  \n\n`, 'groom', 'pr', 'main', {})).toBe(`Groom bug-3. ${PR}`);
  });

  it('leaves a commit rule in the middle of the text where it is', () => {
    const body = `Groom bug-3. ${COMMIT_RULE} Then say hello.`;
    expect(appendFinishClause(body, 'groom', 'pr', 'main', {})).toBe(`${body} ${PR}`);
  });

  it('an empty body, or one that was only the rule, is the clause alone', () => {
    expect(appendFinishClause('', 'groom', 'pr', 'main', {})).toBe(PR);
    expect(appendFinishClause(COMMIT_RULE, 'groom', 'in-place', 'main', {})).toBe(COMMIT_RULE);
  });

  it('capture keeps its own text untouched', () => {
    expect(appendFinishClause(`Capture. ${COMMIT_RULE}`, 'capture', 'in-place', 'main', {})).toBe(`Capture. ${COMMIT_RULE}`);
  });
});
