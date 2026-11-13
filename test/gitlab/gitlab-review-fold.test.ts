import { countAddedCommits, foldReview, isTrigger, parseSeverity, type RawDiscussion, type RawNote } from '../../server/src/gitlab/review.util';

const BOT = 'coderabbitai';
const READ = '2026-11-13T15:00:00.000Z';
const at = (hm: string): string => `2026-11-13T${hm}:00.000Z`;

let seq = 0;
function note(o: Omit<Partial<RawNote>, 'author'> & { body: string; author?: string; at?: string }): RawNote {
  seq += 1;
  const created = o.at ?? at('09:00');
  return {
    id: seq,
    body: o.body,
    author: { username: o.author ?? 'ada' },
    system: o.system ?? false,
    resolvable: o.resolvable ?? false,
    resolved: o.resolved,
    created_at: created,
    updated_at: o.updated_at ?? created
  };
}
function disc(...notes: RawNote[]): RawDiscussion {
  seq += 1;
  return { id: `d${seq}`, individual_note: notes.length === 1 && !notes[0].resolvable, notes };
}
const trigger = (hm: string, ackCreated: string, ackUpdated: string): RawDiscussion =>
  disc(
    note({ body: '@coderabbitai review', at: hm, resolvable: true, resolved: false }),
    note({ body: 'Action performed', author: BOT, at: ackCreated, updated_at: ackUpdated })
  );
const landing = (hm: string): RawDiscussion => disc(note({ body: '**Actionable comments posted: 2**', author: BOT, at: hm }));
const finding = (head: string, resolved: boolean, hm = at('10:07')): RawDiscussion =>
  disc(note({ body: `${head}\n\nbody`, author: BOT, at: hm, resolvable: true, resolved }));
const commits = (body: string, hm: string): RawDiscussion => disc(note({ body, system: true, at: hm, author: 'ada' }));

const ZERO = { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 };

describe('isTrigger', () => {
  const by = (body: string, author = 'ada', system = false) => isTrigger({ body, author: { username: author }, system }, BOT);
  it.each([
    '@coderabbitai review',
    '@CodeRabbitAI Review',
    '@coderabbitai review changes',
    '@coderabbitai review chnages',
    '@coderabbitai full review',
    'thanks\n@coderabbitai review changes from the following commits only\nabc123'
  ])('accepts %j', (b) => expect(by(b)).toBe(true));
  it.each(['@coderabbitai reviewer', 'please run @coderabbitai review later'])('rejects %j', (b) => expect(by(b)).toBe(false));
  it('rejects the bot as author and a system note', () => {
    expect(by('@coderabbitai review', 'coderabbitai')).toBe(false);
    expect(by('@coderabbitai review', 'ada', true)).toBe(false);
  });
});

describe('parseSeverity', () => {
  it.each([
    ['**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**', 'major'],
    ['**Minor**', 'minor'],
    ['**🔴 Critical**', 'critical'],
    ['**🔵 Trivial** | x', 'trivial'],
    ['_Nitpick_', 'other'],
    ['intro\n**Major**', 'other']
  ])('%j -> %s', (b, want) => expect(parseSeverity(b)).toBe(want));
});

describe('countAddedCommits', () => {
  it.each([
    ['added 1 commit', 1],
    ['added 3 commits\n\n* abc', 3],
    ['added 91 commits', 91],
    ['changed the description', null]
  ])('%j -> %s', (b, want) => expect(countAddedCommits(b)).toBe(want));
});

describe('foldReview', () => {
  const base = { triggeredAt: null, landedAt: null, commitsSince: 0, capped: false, failed: false, readAt: READ };

  it('folds an empty list to zeros and nulls', () => {
    expect(foldReview([], BOT, false, READ)).toEqual({ open: 0, resolved: 0, worst: null, bySeverity: ZERO, ...base });
  });

  it('folds a round with findings, landing at the edit', () => {
    const d = [
      trigger(at('10:00'), at('10:00'), at('10:07')),
      landing(at('10:07')),
      finding('**🟠 Major**', false),
      finding('**Minor**', true)
    ];
    expect(foldReview(d, BOT, false, READ)).toEqual({
      ...base, open: 1, resolved: 1, worst: 'major', bySeverity: { ...ZERO, major: 1 }, triggeredAt: at('10:00'), landedAt: at('10:07')
    });
  });

  it('takes the earlier of the two landing signals', () => {
    const d = [trigger(at('10:00'), at('10:00'), at('10:07')), landing(at('10:06'))];
    expect(foldReview(d, BOT, false, READ).landedAt).toBe(at('10:06'));
  });

  it('lands a zero-findings round at the ack edit', () => {
    expect(foldReview([trigger(at('08:28'), at('08:28'), at('08:35'))], BOT, false, READ)).toEqual({
      ...base, bySeverity: ZERO, open: 0, resolved: 0, worst: null, triggeredAt: at('08:28'), landedAt: at('08:35')
    });
  });

  it('does not land when the ack was never edited and no landing note exists', () => {
    expect(foldReview([trigger(at('08:28'), at('08:28'), at('08:28'))], BOT, false, READ).landedAt).toBeNull();
  });

  it('sums added-commit notes after the landing only', () => {
    const d = [
      commits('added 5 commits', at('09:00')),
      trigger(at('10:00'), at('10:00'), at('10:07')),
      landing(at('10:07')),
      commits('added 2 commits', at('11:00')),
      commits('added 1 commit', at('12:00'))
    ];
    expect(foldReview(d, BOT, false, READ).commitsSince).toBe(3);
  });

  it('reports no commitsSince without a landing', () => {
    expect(foldReview([commits('added 2 commits', at('11:00'))], BOT, false, READ).commitsSince).toBe(0);
  });

  it('keeps the earlier landing when a later round never lands', () => {
    const d = [trigger(at('10:00'), at('10:00'), at('10:07')), trigger(at('14:00'), at('14:00'), at('14:00'))];
    const r = foldReview(d, BOT, false, READ);
    expect([r.triggeredAt, r.landedAt]).toEqual([at('14:00'), at('10:07')]);
  });

  it('gives a landing note to the round whose window holds it (round 1 never acked)', () => {
    const d = [trigger(at('10:00'), at('10:00'), at('10:00')), trigger(at('10:05'), at('10:05'), at('10:05')), landing(at('10:07'))];
    const r = foldReview(d, BOT, false, READ);
    expect([r.triggeredAt, r.landedAt]).toEqual([at('10:05'), at('10:07')]);
  });

  it('does not let round 1 claim a landing note created after round 2 triggered', () => {
    const d = [trigger(at('10:00'), at('10:00'), at('10:00')), trigger(at('14:00'), at('14:00'), at('14:00')), landing(at('14:20'))];
    const r = foldReview(d, BOT, false, READ);
    expect([r.triggeredAt, r.landedAt]).toEqual([at('14:00'), at('14:20')]);
  });

  it('counts a resolvable bot note whose resolved is undefined as open', () => {
    const d = disc(note({ body: '**Major**', author: BOT, resolvable: true }));
    expect(foldReview([d], BOT, false, READ)).toMatchObject({ open: 1, resolved: 0, worst: 'major' });
  });

  it("does not count the trigger's own discussion as a finding", () => {
    expect(foldReview([trigger(at('10:00'), at('10:00'), at('10:00'))], BOT, false, READ)).toMatchObject({ open: 0, resolved: 0 });
  });

  it('counts a half-resolved bot thread as open and an all-resolved one as resolved', () => {
    const half = disc(
      note({ body: '**Minor**', author: BOT, resolvable: true, resolved: true }),
      note({ body: 'reply', resolvable: true, resolved: false })
    );
    const done = disc(
      note({ body: '**Minor**', author: BOT, resolvable: true, resolved: true }),
      note({ body: 'reply', resolvable: true, resolved: true })
    );
    expect(foldReview([half, done], BOT, false, READ)).toMatchObject({ open: 1, resolved: 1, worst: 'minor' });
  });

  it('counts an unparseable finding as other with no worst', () => {
    expect(foldReview([finding('_Nitpick_', false)], BOT, false, READ)).toMatchObject({
      open: 1, worst: null, bySeverity: { ...ZERO, other: 1 }
    });
  });

  it('copies capped through', () => {
    expect(foldReview([], BOT, true, READ).capped).toBe(true);
  });
});
