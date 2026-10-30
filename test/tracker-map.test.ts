import { issueUrn, mapIssue, parseUrn } from '../server/src/tracker/map-issue';
import { bodyHash } from '../server/src/tracker/poller.service';
import type { GithubIssue } from '../server/src/tracker/github.client';
import { claimsFor, renderClaim, type ParsedClaim } from '../server/src/tracker/claim';
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
  created: '2026-09-01T10:11:12Z',
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

  /* in-review (execute pr-mode, decision 9): the same `true | absent` shape as
     `queued`, consumed for the same reason — unlike `queued`, gates read it. */
  it('reads in-review as inReview: true, consumes it, and puts no key on an issue without it', () => {
    const reviewed = map({ labels: [{ name: 'type:task' }, { name: 'in-review' }] });
    expect(reviewed?.item.inReview).toBe(true);
    expect(reviewed?.item.tags).toEqual([]);

    const plain = map({ labels: [{ name: 'type:task' }] });
    expect('inReview' in (plain?.item ?? {})).toBe(false);
  });

  /* #411: the poller's `reviewLifted` — a referencing PR merged into the default branch and none open — overrides a label nobody took off. Lifted means the
     key is ABSENT, never `false`, so every `'inReview' in item` reader agrees; and the label is still consumed, never resurfacing as a tag. */
  it('drops inReview when the review is lifted, and lifting without the label adds nothing', () => {
    const labelled = { labels: [{ name: 'type:task' }, { name: 'in-review' }] };
    expect(mapIssue(issue(labelled), REPO, project, [], false)?.item.inReview).toBe(true);

    const lifted = mapIssue(issue(labelled), REPO, project, [], true);
    expect('inReview' in (lifted?.item ?? {})).toBe(false);
    expect(lifted?.item.tags).toEqual([]);

    const plain = mapIssue(issue({ labels: [{ name: 'type:task' }] }), REPO, project, [], true);
    expect('inReview' in (plain?.item ?? {})).toBe(false);
  });

  /* plan-review (backlog-tick): the same `true | absent` shape as `inReview`, consumed for the same reason. The first case carries BOTH labels so a swapped
     mapping fails; unlike `inReview` it has a second writer (the files scan), which is why the flag's doc comment says so. */
  it('reads plan-review as planReview: true beside inReview: true, so a swapped mapping fails', () => {
    const both = map({ labels: [{ name: 'type:task' }, { name: 'in-review' }, { name: 'plan-review' }] });
    expect(both?.item.planReview).toBe(true);
    expect(both?.item.inReview).toBe(true);

    const planOnly = map({ labels: [{ name: 'type:task' }, { name: 'plan-review' }] });
    expect(planOnly?.item.planReview).toBe(true);
    expect('inReview' in (planOnly?.item ?? {})).toBe(false);
  });

  it('puts no planReview key at all on an issue without the label', () => {
    const plain = map({ labels: [{ name: 'type:task' }] });
    expect('planReview' in (plain?.item ?? {})).toBe(false);
  });

  it('never lets plan-review into tags', () => {
    expect(map({ labels: [{ name: 'type:task' }, { name: 'plan-review' }, { name: 'frontend' }] })?.item.tags).toEqual(['frontend']);
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

  // Both stamps verbatim (#237): a date-only `created` tied every same-day issue under "Newest first", and the tie kept API order.
  it('keeps both created and updated verbatim, to the second', () => {
    const mapped = map({ created_at: '2026-09-01T23:59:59Z', updated_at: '2026-09-02T08:00:00Z' });
    expect(mapped?.item.created).toBe('2026-09-01T23:59:59Z');
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
 * `unvetted` (#341): a bug or task whose AUTHOR is outside the repository and whose body no trusted claim has pinned. Every gate that reads `planReview`
 * reads this too, so a case that maps it wrong is an outsider's plan executed on this machine.
 */
describe('unvetted', () => {
  const GROOMED = '## Symptom\n\nx\n\n## Cause\n\nc\n\n## Fix\n\nf\n';
  const outsider = { body: GROOMED, author_association: 'NONE' };

  it('marks a groomed bug filed by an outsider with no claims unvetted, and leaves groomed as the headings say', () => {
    const mapped = map(outsider);
    expect(mapped?.item.unvetted).toBe(true);
    expect(mapped?.item.groomed).toBe(true);
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('puts no unvetted key on an issue whose author is %s', (association) => {
    expect('unvetted' in (map({ body: GROOMED, author_association: association })?.item ?? {})).toBe(false);
  });

  it('puts no unvetted key on an issue with no author_association at all — a hand-built object, never one off the API', () => {
    expect('unvetted' in (map({ body: GROOMED })?.item ?? {})).toBe(false);
  });

  it('clears it when a released groom claim pins exactly this body', () => {
    const pinned = claim({ pin: bodyHash(GROOMED), released: { at: '2026-09-18T10:05:00Z', reason: 'stopped', by: 'A' } });
    expect('unvetted' in (map(outsider, [pinned])?.item ?? {})).toBe(false);
  });

  it('puts it back when the body changes by one character after the pin', () => {
    const pinned = claim({ pin: bodyHash(GROOMED) });
    expect(map({ ...outsider, body: `${GROOMED}!` }, [pinned])?.item.unvetted).toBe(true);
  });

  it('ignores a pin that is not 64 lowercase hex', () => {
    expect(map(outsider, [claim({ pin: bodyHash(GROOMED).toUpperCase() })])?.item.unvetted).toBe(true);
    expect(map(outsider, [claim({ pin: 'abc' })])?.item.unvetted).toBe(true);
  });

  it('compares the NEWEST pinned claim, so an older pin of the current body does not vet a newer groom of another', () => {
    const older = claim({ pin: bodyHash(GROOMED) }, 100);
    const newer = claim({ pin: bodyHash('something else') }, 200);
    expect(map(outsider, [older, newer])?.item.unvetted).toBe(true);
    expect('unvetted' in (map(outsider, [claim({ pin: bodyHash('old') }, 100), claim({ pin: bodyHash(GROOMED) }, 200)])?.item ?? {})).toBe(false);
  });

  it('does not let an outsider vet their own issue with a forged claim comment carrying the pin — parseClaim drops it before the mapper sees it', () => {
    const forged = claim({ pin: bodyHash(GROOMED) }).record;
    const comment = (association: string) => ({
      id: 500,
      issue_url: 'https://api.github.com/repos/futin/x/issues/31',
      body: renderClaim(forged),
      html_url: 'https://github.com/futin/x/issues/31#issuecomment-500',
      author_association: association,
      created_at: '2026-09-18T10:00:00Z',
      updated_at: new Date().toISOString()
    });
    expect(map(outsider, claimsFor(31, [comment('NONE')]))?.item.unvetted).toBe(true);
    // The same comment from a collaborator is a real pin — so the red above is the author check speaking, not a malformed fixture.
    expect('unvetted' in (map(outsider, claimsFor(31, [comment('COLLABORATOR')]))?.item ?? {})).toBe(false);
  });

  it('marks a task the same way', () => {
    expect(map({ body: '## Plan\n\n1. x\n', author_association: 'CONTRIBUTOR', labels: [{ name: 'type:task' }] })?.item.unvetted).toBe(true);
  });

  it.each(['type:idea', 'type:refactor'])('never marks a %s, which nothing executes', (label) => {
    expect('unvetted' in (map({ ...outsider, labels: [{ name: label }] })?.item ?? {})).toBe(false);
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
    const live = claim({ at: '2026-09-18T10:00:00Z', phase: 'execute', counters: COUNTERS });
    const mapped = map({}, [live]);
    expect(mapped?.item).toEqual({
      ...BASE,
      started: '2026-09-18T10:00:00Z',
      phase: 'execute',
      groomElapsed: 5,
      executeElapsed: 30,
      groomTokens: 10,
      executeTokens: 4000,
      // #225 — the holder rides the same live reading; this claim records no host and no run, so neither key is there.
      holder: { session: 'A', heartbeat: live.record.heartbeat }
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

  /* Order is by comment id, never by array position — for both readings: the holder is the LOWEST unreleased id, the counters the HIGHEST id. */
  it('reads the holder and the counters by comment id, whatever order they arrive in', () => {
    const older = claim({ phase: 'groom', at: '2026-09-18T09:00:00Z' }, 40);
    const newer = claim({ phase: 'execute', at: '2026-09-18T10:00:00Z', counters: COUNTERS }, 99);
    const mapped = map({}, [newer, older])?.item;
    expect(mapped?.phase).toBe('groom');
    expect(mapped?.executeTokens).toBe(4000);
  });

  /* #348 — the holder is the claim protocol's: the LOWEST unreleased id (`heldClaim`), the rule `currentClaim` gave the read route in bug-58. In a race
     window the loser's comment is newer and still unreleased until the loser deletes it — for the whole stale window when that delete fails — and a
     mapper reading the newest named the loser: here a groom's phase on an item an execute holds. */
  it('takes started and phase from the lowest unreleased claim, not the newest', () => {
    const winner = claim({ phase: 'execute', at: '2026-09-18T09:00:00Z', session: 'W' }, 100);
    const loser = claim({ phase: 'groom', at: '2026-09-18T09:00:01Z', session: 'L' }, 200);
    const mapped = map({}, [winner, loser])?.item;
    expect(mapped?.started).toBe('2026-09-18T09:00:00Z');
    expect(mapped?.phase).toBe('execute');
    expect(mapped?.holder?.session).toBe('W');
  });

  /* A newer RELEASED claim used to hide an older unreleased holder: `held` was read off the newest claim alone, so the card read free. The two questions
     now read two claims — the hold from 100, the totals from 200. */
  it('reads an older unreleased claim as held under a newer released one, and the counters from the newer', () => {
    const holder = claim({ phase: 'execute', at: '2026-09-18T09:00:00Z' }, 100);
    const released = claim({ phase: 'groom', counters: COUNTERS, released: { at: '2026-09-18T11:00:00Z', reason: 'stopped', by: 'B' } }, 200);
    const mapped = map({}, [holder, released])?.item;
    expect(mapped?.started).toBe('2026-09-18T09:00:00Z');
    expect(mapped?.phase).toBe('execute');
    expect(mapped?.groomElapsed).toBe(5);
    expect(mapped?.executeTokens).toBe(4000);
  });

  it('reads a newer unreleased claim as held under an older released one', () => {
    const released = claim({ phase: 'groom', released: { at: '2026-09-18T09:30:00Z', reason: 'stopped', by: 'A' } }, 100);
    const holder = claim({ phase: 'execute', at: '2026-09-18T10:00:00Z' }, 200);
    const mapped = map({}, [released, holder])?.item;
    expect(mapped?.started).toBe('2026-09-18T10:00:00Z');
    expect(mapped?.phase).toBe('execute');
  });

  it('still holds on one unreleased claim whose heartbeat is a day old — the mapper consults no clock', () => {
    const old = claim({ heartbeat: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    expect(map({}, [old])?.item.started).toBe('2026-09-18T10:00:00Z');
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
