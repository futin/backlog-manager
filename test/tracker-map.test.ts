import { issueUrn, mapIssue, parseUrn } from '../server/src/tracker/map-issue';
import type { GithubIssue } from '../server/src/tracker/github.client';
import type { ParsedClaim } from '../server/src/tracker/claim';
import { CLAIM_STALE_MS } from '../shared/types';
import type { BacklogItem, ClaimRecord, RegistryProject } from '../shared/types';

/**
 * The issue → `BacklogItem` mapping table, spec §5.3, one case per row
 * (task-45). Driven by fixture issue JSON rather than by a live repo for the
 * reason the spec gives in §12.2: the rows that are easy to get wrong are the
 * ones a real repo almost never has — two type labels, a `duplicate` close, an
 * issue with no labels at all — and a fixture is the only way each of them
 * gets a case.
 *
 * Several cases assert the WHOLE mapped object rather than the one field they
 * are about. That is deliberate and is what caught the fields nobody thought
 * to check: `lastCommit` has to be `''` (the client's `lastTouched`
 * precedence falls through the middle rung on it), `started`/`phase` have to be
 * empty and the four counters zero (phase 2 has no claim protocol), and a
 * field-at-a-time suite would have passed with any of those wrong.
 */

const project: RegistryProject = { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' };
const REPO = 'futin/x';

/** A minimal issue. Every case overrides only what its row is about, so a
 *  field nobody mentions is provably the default rather than a copy. */
function issue(over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number: 31,
    title: 'it breaks',
    body: '## Symptom\n\nx\n',
    html_url: 'https://github.com/futin/x/issues/31',
    state: 'open',
    state_reason: null,
    created_at: '2026-09-01T10:11:12Z',
    updated_at: '2026-09-02T08:00:00Z',
    labels: [{ name: 'type:bug' }],
    assignees: [],
    ...over
  };
}

/** The whole expected item for the default issue above. Cases that change one
 *  input assert `{ ...BASE, <what moved> }`, so every case says exactly what
 *  its row changes and nothing else. */
const BASE: BacklogItem = {
  id: '#31',
  title: 'it breaks',
  created: '2026-09-01',
  started: '',
  updated: '2026-09-02T08:00:00Z',
  lastCommit: '',
  phase: '',
  groomElapsed: 0,
  executeElapsed: 0,
  groomTokens: 0,
  executeTokens: 0,
  kind: '',
  tags: [],
  section: 'bugs',
  status: 'open',
  project: 'alpha',
  projectPath: '/abs/alpha',
  groomed: false,
  path: 'gh:futin/x#31',
  source: 'github',
  url: 'https://github.com/futin/x/issues/31',
  assignee: null,
  untyped: false
};

/** A claim, with only the fields a case cares about spelled out. */
function claim(over: Partial<ClaimRecord> = {}, commentId = 100): ParsedClaim {
  return {
    commentId,
    record: {
      v: 1,
      session: 'A',
      phase: 'groom',
      at: '2026-09-18T10:00:00Z',
      heartbeat: new Date().toISOString(),
      counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
      ...over
    }
  };
}

function map(over: Partial<GithubIssue> = {}, claims: ParsedClaim[] = []): ReturnType<typeof mapIssue> {
  return mapIssue(issue(over), REPO, project, claims);
}

describe('issue → BacklogItem', () => {
  it('maps a type:bug issue whole, with the claim fields empty when nobody has claimed it', () => {
    const mapped = map();
    expect(mapped?.item).toEqual(BASE);
    expect(mapped?.errors).toEqual([]);
    expect(mapped?.runnerFix).toBe(false);
  });

  it('puts an unlabelled issue in ideas, marks it untyped, and reports nothing', () => {
    const mapped = map({ labels: [] });
    // No error: an issue filed through the web UI's blank form is an ordinary
    // state, and the badge is what says so. The `errors` assertion is the
    // point of the case — an entry here would put a complaint on the board for
    // every blank issue in the repo.
    expect(mapped?.item).toEqual({ ...BASE, section: 'ideas', untyped: true, groomed: null });
    expect(mapped?.errors).toEqual([]);
  });

  it('takes the first type label alphabetically when an issue carries two, and reports exactly one error', () => {
    const mapped = map({ labels: [{ name: 'type:task' }, { name: 'type:bug' }] });
    expect(mapped?.item.section).toBe('bugs');
    expect(mapped?.item.untyped).toBe(false);
    expect(mapped?.errors).toHaveLength(1);
    // Naming the issue is the whole value of the entry: `ItemsIndex.errors` is
    // a flat list across every project, and "two type labels" with no subject
    // is a complaint nobody can act on.
    expect(mapped?.errors[0]).toContain('gh:futin/x#31');
    expect(mapped?.errors[0]).toContain('type:bug');
    expect(mapped?.errors[0]).toContain('type:task');
  });

  it('consumes the type and kind labels and leaves every other label a tag', () => {
    const mapped = map({ labels: [{ name: 'type:bug' }, { name: 'kind:debt' }, { name: 'backend' }] });
    expect(mapped?.item.kind).toBe('debt');
    expect(mapped?.item.tags).toEqual(['backend']);
  });

  it('reads runner-fix as the marker the gate reads, and consumes it', () => {
    const mapped = map({ labels: [{ name: 'type:task' }, { name: 'runner-fix' }] });
    expect(mapped?.runnerFix).toBe(true);
    // Consumed, not left standing: a card that drew `runner-fix` as a tag
    // would draw the marker twice once the gate reads it.
    expect(mapped?.item.tags).toEqual([]);
  });

  /* task-47: the marker reached `BacklogItem` when the consumer arrived —
     `orchestrate.mjs`'s tracker gate has no file to read a frontmatter key
     off. `true` or ABSENT and never `false`, which is what keeps every files
     fixture and every unmarked issue's payload byte-identical to what it was.
     `'runnerFix' in item` is the assertion rather than a `toBeUndefined`,
     because the two readings differ for a key present with an `undefined`
     value and only one of them is the rule. */
  it('puts runnerFix on the item when the label is there, and no key at all when it is not', () => {
    const marked = map({ labels: [{ name: 'type:task' }, { name: 'runner-fix' }] });
    expect(marked?.item.runnerFix).toBe(true);

    const plain = map();
    expect('runnerFix' in (plain?.item ?? {})).toBe(false);
    // The whole payload, so the absence is asserted against the shape rather
    // than against one key: `BASE` is this suite's declared expectation for an
    // ordinary issue, and it carries no `runnerFix`.
    expect(plain?.item).toEqual(BASE);
  });

  /* orchestrator:queued (task-52): the same `true | absent` shape `runnerFix`
     has, for the same reason — and CONSUMED, because the card draws it as a
     badge of its own and a tag would draw it twice. */
  it('reads orchestrator:queued as queued: true, consumes it, and puts no key on an unqueued item', () => {
    const queued = map({ labels: [{ name: 'type:task' }, { name: 'orchestrator:queued' }] });
    expect(queued?.item.queued).toBe(true);
    expect(queued?.item.tags).toEqual([]);

    const plain = map({ labels: [{ name: 'type:task' }] });
    expect('queued' in (plain?.item ?? {})).toBe(false);
  });

  it('maps an open issue to open', () => {
    expect(map({ state: 'open' })?.item.status).toBe('open');
  });

  it('maps a completed close to done, section unchanged', () => {
    expect(map({ state: 'closed', state_reason: 'completed' })?.item).toEqual({ ...BASE, status: 'done' });
  });

  it('maps a close with no reason to done — GitHub sent none before 2022', () => {
    expect(map({ state: 'closed', state_reason: null })?.item).toEqual({ ...BASE, status: 'done' });
  });

  it('maps a not_planned close to terminal and out-of-scope, leaving the type label on the issue', () => {
    const source = issue({ state: 'closed', state_reason: 'not_planned' });
    const mapped = mapIssue(source, REPO, project, []);
    expect(mapped?.item.status).toBe('terminal');
    expect(mapped?.item.section).toBe('out-of-scope');
    // The recoverability claim, asserted on the SOURCE rather than on the
    // item: the file store loses an item's type when it moves into the flat
    // out-of-scope directory, and the tracker deliberately does not.
    expect(source.labels).toContainEqual({ name: 'type:bug' });
  });

  it('maps a duplicate close exactly like not_planned', () => {
    const mapped = map({ state: 'closed', state_reason: 'duplicate' });
    expect(mapped?.item.status).toBe('terminal');
    expect(mapped?.item.section).toBe('out-of-scope');
  });

  it('builds id, path and url from the issue number and repo', () => {
    const mapped = map({ number: 7, html_url: 'https://github.com/futin/x/issues/7' });
    expect(mapped?.item.id).toBe('#7');
    expect(mapped?.item.path).toBe('gh:futin/x#7');
    expect(mapped?.item.url).toBe('https://github.com/futin/x/issues/7');
    expect(mapped?.item.source).toBe('github');
  });

  it('reads no assignee as null and two assignees as the first login', () => {
    expect(map({ assignees: [] })?.item.assignee).toBeNull();
    expect(map({ assignees: [{ login: 'futin' }, { login: 'someone' }] })?.item.assignee).toBe('futin');
  });

  it('always reads lastCommit as empty', () => {
    // Explicit, because the client's `lastTouched` precedence
    // (`updated ?? lastCommit ?? created`) falls THROUGH this rung for every
    // tracker row, and a value here would be a git date no git produced.
    expect(map()?.item.lastCommit).toBe('');
    expect(map({ state: 'closed', state_reason: 'completed' })?.item.lastCommit).toBe('');
  });

  it('keeps updated verbatim and takes only the date part of created', () => {
    const mapped = map({ created_at: '2026-09-01T23:59:59Z', updated_at: '2026-09-02T08:00:00Z' });
    expect(mapped?.item.created).toBe('2026-09-01');
    expect(mapped?.item.updated).toBe('2026-09-02T08:00:00Z');
  });

  it('leaves started, phase and the four counters at their phase-2 values', () => {
    // Asserted so phase 3 has a red test the day the claim protocol fills
    // them, rather than a silent widening nobody notices.
    const item = map()?.item;
    expect(item?.started).toBe('');
    expect(item?.phase).toBe('');
    expect(item?.groomElapsed).toBe(0);
    expect(item?.executeElapsed).toBe(0);
    expect(item?.groomTokens).toBe(0);
    expect(item?.executeTokens).toBe(0);
  });

  it('derives groomed from the issue body, by the same rule a file follows', () => {
    const skeleton = map({ body: '## Symptom\n\nx\n\n## Cause\n\nunknown\n\n## Fix\n\nunknown\n' });
    expect(skeleton?.item.groomed).toBe(false);
    const groomed = map({ body: '## Symptom\n\nx\n\n## Cause\n\noff by one\n\n## Fix\n\nuse <=\n' });
    expect(groomed?.item.groomed).toBe(true);
  });

  it('drops a pull request entirely', () => {
    expect(mapIssue(issue({ pull_request: { url: 'https://api.github.com/…' } }), REPO, project, [])).toBeNull();
  });

  it('accepts labels sent as bare strings as well as objects', () => {
    // Both shapes appear in the wild and neither is wrong; a mapper that threw
    // on the string form would fail a whole repo over a shape nobody controls.
    expect(mapIssue(issue({ labels: ['type:task'] }), REPO, project, [])?.item.section).toBe('tasks');
  });
});

/**
 * The claim half of the mapping (task-46). Phase 2 asserted `started`, `phase`
 * and the four counters as empty precisely so this phase would have a red case
 * the day it filled them; these are that case, inverted.
 */
describe('the claim fields', () => {
  const COUNTERS = { groomElapsed: 5, executeElapsed: 30, groomTokens: 10, executeTokens: 4000 };

  it('fills started, phase and the four counters from a live unreleased claim', () => {
    const mapped = map({}, [claim({ at: '2026-09-18T10:00:00Z', phase: 'execute', counters: COUNTERS })]);
    expect(mapped?.item).toEqual({
      ...BASE,
      started: '2026-09-18T10:00:00Z',
      phase: 'execute',
      groomElapsed: 5,
      executeElapsed: 30,
      groomTokens: 10,
      executeTokens: 4000
    });
  });

  /* Released clears the HOLD and keeps the TOTALS — the two questions the
     newest claim answers, and the reason they are read separately. Counters
     that vanished on release would make an item's accumulated cost disappear
     the moment the work finished. */
  it('clears started and phase on release but keeps the counters', () => {
    const released = claim({ phase: 'execute', counters: COUNTERS, released: { at: '2026-09-18T11:00:00Z', reason: 'stopped', by: 'A' } });
    expect(map({}, [released])?.item).toEqual({ ...BASE, groomElapsed: 5, executeElapsed: 30, groomTokens: 10, executeTokens: 4000 });
  });

  /* "ANY stamp, fresh or stale" — the same rule `progressBlock` applies to a
     files item. What retires a stale claim is the PROTOCOL, at the moment
     another session contests the issue; a mapper that expired them on its own
     would show an item as free while `claim` still had to fight for it. */
  it('still reads started for a stale but unreleased claim', () => {
    const stale = claim({ heartbeat: new Date(Date.now() - CLAIM_STALE_MS * 4).toISOString() });
    expect(map({}, [stale])?.item.started).toBe('2026-09-18T10:00:00Z');
  });

  /* The newest is the HIGHEST comment id, not the last one in the array. */
  it('reads the newest claim by comment id, whatever order they arrive in', () => {
    const older = claim({ phase: 'groom', at: '2026-09-18T09:00:00Z' }, 40);
    const newer = claim({ phase: 'execute', at: '2026-09-18T10:00:00Z' }, 99);
    expect(map({}, [newer, older])?.item.phase).toBe('execute');
  });

  /* `in-progress` is CONSUMED since task-46: the claim renders it as the
     in-progress bar, and leaving it in `tags` would draw it twice. */
  it('consumes the in-progress label', () => {
    expect(map({ labels: [{ name: 'type:bug' }, { name: 'in-progress' }] })?.item.tags).toEqual([]);
  });
});

describe('the URN', () => {
  it('round-trips a repo and issue number', () => {
    expect(issueUrn('futin/x', 31)).toBe('gh:futin/x#31');
    expect(parseUrn('gh:futin/x#31')).toEqual({ repo: 'futin/x', number: 31 });
  });

  it('answers null for every filesystem path — which is the shape test itself', () => {
    // `ItemsService.body` dispatches on exactly this function, so "a path is
    // not a URN" is the assertion that keeps a real path from reaching the
    // tracker adapter.
    expect(parseUrn('/abs/alpha/backlog/bugs/open/bug-1.md')).toBeNull();
    expect(parseUrn('C:\\repos\\alpha\\backlog\\bugs\\open\\bug-1.md')).toBeNull();
    expect(parseUrn('gh:futin/x')).toBeNull();
    expect(parseUrn('gh:futin/x#0')).toBeNull();
    expect(parseUrn('gh:futin/x#abc')).toBeNull();
    expect(parseUrn('gh:../../etc/passwd#1')).toBeNull();
  });
});
