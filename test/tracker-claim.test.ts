import { claimsFor, isLive, newestClaim, parseClaim, renderClaim, winner } from '../server/src/tracker/claim';
import { CLAIM_MARKER, CLAIM_STALE_MS } from '../shared/types';
import type { ClaimRecord } from '../shared/types';
import type { GithubComment } from '../server/src/tracker/github.client';

/**
 * The claim protocol's readable half (task-46, spec §6.3), one case per row.
 *
 * Every function under test is pure over values handed to it, which is the
 * point: the WRITING half is a sequence of network calls with a settle window
 * in the middle, and a suite that could only drive it through that sequence
 * would have no way to state "exactly `CLAIM_STALE_MS` old is dead" as a case.
 * Here it is one line.
 */

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    v: 1,
    session: 'A',
    phase: 'groom',
    at: '2026-09-18T11:50:00.000Z',
    heartbeat: '2026-09-18T11:59:00.000Z',
    counters: { groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0 },
    ...over
  };
}

function comment(over: Partial<GithubComment> = {}): GithubComment {
  return {
    id: 100,
    issue_url: 'https://api.github.com/repos/futin/x/issues/31',
    body: renderClaim(record()),
    html_url: 'https://github.com/futin/x/issues/31#issuecomment-100',
    user: { login: 'futin' },
    created_at: '2026-09-18T11:50:00Z',
    updated_at: '2026-09-18T11:59:00Z',
    ...over
  };
}

describe('renderClaim / parseClaim', () => {
  it('round-trips a plain record', () => {
    const r = record();
    expect(parseClaim(comment({ body: renderClaim(r) }))).toEqual(r);
  });

  /* `released`, `run` and `state` together. `run` became a declared shape in
     task-47 (the server branches on its `runId`); `state` is still carried
     opaque, and the round-trip is what a mixed-version pair of machines rests
     on — a reader of this version has to hand `state` back byte-identical or
     an old build writing one heartbeat erases a newer build's item state. */
  it('round-trips a released record carrying a run and phase 4-s opaque state', () => {
    const r = record({
      released: { at: '2026-09-18T12:01:00.000Z', reason: 'stopped', by: 'A' },
      run: { runId: 'run-1', startedAt: '2026-09-18T11:00:00Z', mergeMode: 'merge', questionMode: 'park', maxItems: null, base: 'main' },
      state: ['anything', 7, null]
    });
    expect(parseClaim(comment({ body: renderClaim(r) }))).toEqual(r);
  });

  /* Once, not twice: `parseClaim`'s membership test is a substring check, so a
     body carrying the marker twice would still parse — but a RENDERED claim
     containing it twice would mean the marker had leaked into the human line or
     the JSON, and a later edit that split on it would then find two halves. */
  it('writes the marker exactly once', () => {
    const body = renderClaim(record());
    expect(body.split(CLAIM_MARKER)).toHaveLength(2);
  });

  it('renders the human sentence for a held claim', () => {
    expect(renderClaim(record())).toContain('session A holds this issue (groom) since 2026-09-18T11:50:00.000Z');
  });

  it('renders the human sentence for a released claim', () => {
    const r = record({ released: { at: '2026-09-18T12:01:00.000Z', reason: 'stale', by: 'B' } });
    expect(renderClaim(r)).toContain('released stale at 2026-09-18T12:01:00.000Z');
  });

  /* bug-46. A session id names a transcript on exactly one machine, so it is
     the one identifier a reader on another machine cannot resolve — and the
     check they CAN run — a listing of `~/.claude/projects` for that id —
     answers "no" for every
     foreign claim, live or dead. The host is what turns that "no" back into
     "made elsewhere" rather than "dead". */
  it('names the host in the human sentence when the record carries one', () => {
    expect(renderClaim(record({ host: 'futin@mac' }))).toContain(
      'session A on futin@mac holds this issue (groom) since 2026-09-18T11:50:00.000Z'
    );
  });

  /* Byte for byte, not merely "similar": every claim written before bug-46 has
     no host, and a hostless one must read exactly as it always did rather than
     acquiring an empty clause a reader has to interpret. */
  it('leaves the sentence exactly as it was when no host was recorded', () => {
    expect(renderClaim(record()).endsWith('session A holds this issue (groom) since 2026-09-18T11:50:00.000Z\n')).toBe(true);
  });

  it('round-trips a record carrying a host', () => {
    const r = record({ host: 'futin@linux-box' });
    expect(parseClaim(comment({ body: renderClaim(r) }))).toEqual(r);
  });

  /* No `v: 2` for this field: a claim an older build wrote parses here with
     `host` simply absent, and absent means "the machine was not recorded" —
     never "local", which is the inference this whole bug is about. */
  it('parses a v-1 claim with no host key, leaving host undefined', () => {
    const parsed = parseClaim(comment());
    expect(parsed?.host).toBeUndefined();
    expect(parsed?.session).toBe('A');
  });

  it('answers null for a comment with no marker', () => {
    expect(parseClaim(comment({ body: 'just a conversation comment' }))).toBeNull();
  });

  it('answers null for a marker with no fenced block', () => {
    expect(parseClaim(comment({ body: `${CLAIM_MARKER}\n\nsomebody deleted the json\n` }))).toBeNull();
  });

  it('answers null for a fenced block that is not JSON', () => {
    expect(parseClaim(comment({ body: `${CLAIM_MARKER}\n\n\`\`\`json\n{ not json\n\`\`\`\n` }))).toBeNull();
  });

  it('answers null for a version this build does not know', () => {
    const body = renderClaim(record()).replace('"v": 1', '"v": 2');
    expect(parseClaim(comment({ body }))).toBeNull();
  });

  it('answers null for a body this app never wrote at all', () => {
    expect(parseClaim(comment({ body: null }))).toBeNull();
  });
});

describe('claimsFor', () => {
  /* `/issues/310` is the case: it ENDS with `310`, so a substring test for
     `/issues/31` would match it and mix two issues' claims together. */
  it('keeps only the named issue-s claims, ascending by comment id', () => {
    const claims = claimsFor(31, [
      comment({ id: 40 }),
      comment({ id: 12 }),
      comment({ id: 99, issue_url: 'https://api.github.com/repos/futin/x/issues/310' }),
      comment({ id: 33 }),
      comment({ id: 50, body: 'not a claim' })
    ]);
    expect(claims.map((c) => c.commentId)).toEqual([12, 33, 40]);
  });

  it('answers an empty list for an issue with no claims', () => {
    expect(claimsFor(7, [comment({ id: 1 })])).toEqual([]);
  });
});

describe('isLive', () => {
  it('is live one millisecond inside the window', () => {
    expect(isLive(record({ heartbeat: new Date(NOW - CLAIM_STALE_MS + 1).toISOString() }), NOW)).toBe(true);
  });

  /* Exactly the window is DEAD — the comparison is `<`, not `<=`. Stated as its
     own case because the boundary is the whole difference between "a claim
     expires" and "a claim expires eventually". */
  it('is dead exactly at the window', () => {
    expect(isLive(record({ heartbeat: new Date(NOW - CLAIM_STALE_MS).toISOString() }), NOW)).toBe(false);
  });

  it('is dead once released, however fresh the heartbeat', () => {
    const r = record({ heartbeat: new Date(NOW).toISOString(), released: { at: '2026-09-18T12:00:00Z', reason: 'stopped', by: 'A' } });
    expect(isLive(r, NOW)).toBe(false);
  });

  it('is dead for an unparseable heartbeat', () => {
    expect(isLive(record({ heartbeat: 'whenever' }), NOW)).toBe(false);
  });
});

describe('newestClaim and winner', () => {
  /* Lowest live id wins — posted first. The list is deliberately handed over
     out of order so the answer cannot come from the array's own order. */
  it('picks the lowest live comment id', () => {
    const live = [40, 12, 33].map((id) => ({ commentId: id, record: record() }));
    expect(winner(live)?.commentId).toBe(12);
  });

  it('answers null when nothing is live', () => {
    expect(winner([])).toBeNull();
  });

  /* Highest id, released or not: the newest claim carries the item-s current
     counters whether or not anybody holds it. */
  it('picks the highest comment id for newest, released included', () => {
    const claims = [
      { commentId: 12, record: record() },
      { commentId: 40, record: record({ released: { at: '2026-09-18T11:00:00Z', reason: 'stopped', by: 'A' } }) }
    ];
    expect(newestClaim(claims)?.commentId).toBe(40);
  });

  it('answers null for an issue nobody has claimed', () => {
    expect(newestClaim([])).toBeNull();
  });
});
