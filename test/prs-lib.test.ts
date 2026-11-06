import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyUpdateOutcome,
  defaultMethod,
  findPr,
  groupRepos,
  autoMergeBlock,
  mergeBlock,
  mergeMain,
  outcomeLine,
  parsePrKey,
  prChips,
  prKey,
  PR_KEYS,
  REPO_REASONS,
  updateBlock,
  updateTransition,
  UPDATING_MS,
  whyLine
} from '../client/src/lib/prs';
import type { PrOutcome } from '../client/src/lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../shared/types';

/**
 * The PRs page's derivations. Fixtures discriminate: two repos, a distinct number, title, head, SHA, author and timestamp per PR, so a reading that crossed
 * a field or a row would not pass by coincidence.
 */

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 17,
    title: 'Teach the board to merge',
    url: 'https://github.com/futin/x/pull/17',
    author: 'ada',
    draft: false,
    head: 'feature/merge-it',
    headSha: 'a'.repeat(40),
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T10:00:00Z',
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'none',
    autoMerge: null,
    canUpdateBranch: true,
    ...over
  };
}

function repo(over: Partial<PrRepoView> = {}): PrRepoView {
  return {
    repo: 'futin/x',
    polledAt: '2026-10-29T10:10:00Z',
    access: 'ok',
    detail: null,
    syncOff: null,
    methods: ['squash', 'merge'],
    autoMergeAllowed: true,
    prs: [],
    total: 0,
    truncated: false,
    checksDetail: null,
    ...over
  };
}

const SYNC_OFF = 'sync is off for futin/x — turn it on in GitHub › Settings';

describe('prChips', () => {
  it('draws one chip per fact, in reading order, with the tone each means', () => {
    const chips = prChips(
      pr({
        draft: true,
        review: 'changes-requested',
        checks: 'failure',
        mergeable: 'conflicting',
        mergeState: 'behind',
        autoMerge: { method: 'rebase', enabledAt: '2026-10-29T09:00:00Z' }
      })
    );
    expect(chips).toEqual([
      { label: 'draft', tone: 'neutral' },
      { label: 'changes requested', tone: 'bad' },
      { label: 'checks failing', tone: 'bad', glyph: 'cross' },
      { label: 'conflicts', tone: 'bad', glyph: 'cross' },
      { label: 'behind base', tone: 'warn' },
      // The `done` tint, as the mock's `auto-merge on` — not the solid `live` fill, which reads as a running thing.
      { label: 'auto-merge · rebase', tone: 'done' }
    ]);
  });

  it('maps the other review and check values', () => {
    expect(prChips(pr({ review: 'approved', checks: 'success' }))).toEqual([
      { label: 'approved', tone: 'done' },
      { label: 'checks passing', tone: 'done', glyph: 'tick' }
    ]);
    expect(prChips(pr({ review: 'review-required', checks: 'pending' }))).toEqual([
      { label: 'review required', tone: 'warn' },
      { label: 'checks pending', tone: 'warn', glyph: 'clock' }
    ]);
  });

  it('checks the token may not read are a neutral chip — said, because silence would read as "no checks"', () => {
    expect(prChips(pr({ checks: 'unknown' }))).toEqual([{ label: 'checks unknown', tone: 'neutral' }]);
  });

  it('draws no checks chip for checks: none, and nothing for a clean PR with no review', () => {
    expect(prChips(pr({ checks: 'none', review: null }))).toEqual([]);
  });
});

describe('the write blocks', () => {
  it('mergeBlock: first match wins, in order', () => {
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ syncOff: SYNC_OFF, methods: [] }))).toBe('sync off');
    expect(mergeBlock(pr({ draft: true, mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('draft');
    expect(mergeBlock(pr({ mergeable: 'conflicting', checks: 'failure' }), repo({ methods: [] }))).toBe('not mergeable');
    expect(mergeBlock(pr({ checks: 'failure' }), repo({ methods: [] }))).toBe('checks failing');
    expect(mergeBlock(pr(), repo({ methods: [] }))).toBe('no merge method allowed');
    expect(mergeBlock(pr({ mergeable: 'unknown', checks: 'pending' }), repo())).toBeNull();
  });

  it('checks the token may not read block nothing: merge and arming auto-merge both stay open', () => {
    expect(mergeBlock(pr({ checks: 'unknown' }), repo())).toBeNull();
    expect(autoMergeBlock(pr({ checks: 'unknown' }), repo())).toBeNull();
  });

  it('updateBlock: sync off, then a fork that forbids edits, then up to date', () => {
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo({ syncOff: SYNC_OFF }), false)).toBe('sync off');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: false, canUpdateBranch: false }), repo(), false)).toBe('fork does not allow edits');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true, canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ crossRepository: true, maintainerCanModify: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: a PR that cannot be updated reads up to date only when it is not behind its base', () => {
    expect(updateBlock(pr({ mergeState: 'behind', canUpdateBranch: false }), repo(), false)).toBe('no permission to update');
    expect(updateBlock(pr({ mergeState: 'clean', canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ mergeState: 'behind', canUpdateBranch: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: while an update is in flight the reason is updating…, whatever canUpdateBranch says (GitHub flips it false once the update lands)', () => {
    // Two PRs, two heads: the mark is the caller's business, so the block must answer from `updating` alone and never from the head it is looking at.
    const updatable = pr({ number: 31, headSha: 'd'.repeat(40), mergeState: 'behind', canUpdateBranch: true });
    const refused = pr({ number: 32, headSha: 'e'.repeat(40), mergeState: 'behind', canUpdateBranch: false });
    expect(updateBlock(updatable, repo(), true)).toBe('updating…');
    expect(updateBlock(refused, repo(), true)).toBe('updating…');
    // The same two rows with no update in flight keep their own answers, so `updating` is the only thing that moved.
    expect(updateBlock(updatable, repo(), false)).toBeNull();
    expect(updateBlock(refused, repo(), false)).toBe('no permission to update');
  });

  it('updateBlock: not behind, not updatable, not updating reads already up to date; up to date but updatable reads null', () => {
    expect(updateBlock(pr({ number: 33, headSha: 'f'.repeat(40), mergeState: 'clean', canUpdateBranch: false }), repo(), false)).toBe('already up to date');
    expect(updateBlock(pr({ number: 34, headSha: '1'.repeat(40), mergeState: 'clean', canUpdateBranch: true }), repo(), false)).toBeNull();
  });

  it('updateBlock: sync off outranks updating…, and updating… outranks the fork rule', () => {
    expect(updateBlock(pr({ number: 35, headSha: '2'.repeat(40), mergeState: 'behind' }), repo({ syncOff: SYNC_OFF }), true)).toBe('sync off');
    // `updating…` sits right after `sync off` and before the fork rule: a mark exists only because an update was accepted, so the fork rule cannot have held.
    expect(updateBlock(pr({ number: 36, headSha: '3'.repeat(40), crossRepository: true, maintainerCanModify: false }), repo(), true)).toBe('updating…');
    expect(updateBlock(pr({ number: 36, headSha: '3'.repeat(40), crossRepository: true, maintainerCanModify: false }), repo(), false)).toBe(
      'fork does not allow edits'
    );
  });

  it('autoMergeBlock: enabling needs the repo setting; disabling an armed one never does', () => {
    const armed = pr({ autoMerge: { method: 'squash', enabledAt: '2026-10-29T09:00:00Z' } });
    expect(autoMergeBlock(pr(), repo({ autoMergeAllowed: false }))).toBe('auto-merge not enabled on the repo');
    expect(autoMergeBlock(armed, repo({ autoMergeAllowed: false }))).toBeNull();
    expect(autoMergeBlock(pr(), repo())).toBeNull();
    expect(autoMergeBlock(armed, repo({ syncOff: SYNC_OFF }))).toBe('sync off');
    expect(autoMergeBlock(pr(), repo({ syncOff: SYNC_OFF, autoMergeAllowed: false }))).toBe('sync off');
  });

  it('autoMergeBlock, unarmed: the same order as mergeBlock — sync off, draft, not mergeable, checks failing — then the repo setting', () => {
    // One fixture that is at once draft, conflicting and failing, on a repo with the setting off and under sync off; peel one condition per line.
    const everything = pr({ number: 41, headSha: '4'.repeat(40), draft: true, mergeable: 'conflicting', checks: 'failure' });
    const off = repo({ repo: 'futin/auto-a', syncOff: SYNC_OFF, autoMergeAllowed: false });
    expect(autoMergeBlock(everything, off)).toBe('sync off');
    expect(autoMergeBlock(everything, { ...off, syncOff: null })).toBe('draft');
    expect(autoMergeBlock({ ...everything, draft: false }, { ...off, syncOff: null })).toBe('not mergeable');
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable' }, { ...off, syncOff: null })).toBe('checks failing');
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable', checks: 'none' }, { ...off, syncOff: null })).toBe(
      'auto-merge not enabled on the repo'
    );
    const allowed = { ...off, syncOff: null, autoMergeAllowed: true };
    expect(autoMergeBlock({ ...everything, draft: false, mergeable: 'mergeable', checks: 'none' }, allowed)).toBeNull();
  });

  it('autoMergeBlock, armed: only sync off blocks — a failing, conflicting draft on a repo with the setting off can still be disarmed', () => {
    const armed = pr({
      number: 42,
      headSha: '5'.repeat(40),
      draft: true,
      mergeable: 'conflicting',
      checks: 'failure',
      autoMerge: { method: 'rebase', enabledAt: '2026-10-29T09:30:00Z' }
    });
    expect(autoMergeBlock(armed, repo({ repo: 'futin/auto-b', autoMergeAllowed: false }))).toBeNull();
    expect(autoMergeBlock(armed, repo({ repo: 'futin/auto-b', autoMergeAllowed: false, syncOff: SYNC_OFF }))).toBe('sync off');
  });
});

describe('PR_KEYS', () => {
  it('is the strip in its order: merge, auto-merge, update, open', () => {
    expect([...PR_KEYS]).toEqual(['merge', 'auto-merge', 'update', 'open']);
  });
});

describe('REPO_REASONS', () => {
  it('holds exactly the six reasons that belong to the repo, and none of the row’s own facts', () => {
    const six = ['sync off', 'no merge method allowed', 'auto-merge not enabled on the repo', 'fork does not allow edits'];
    expect([...REPO_REASONS].sort()).toEqual([...six, 'no permission to update', 'updating…'].sort());
    for (const fact of ['draft', 'not mergeable', 'checks failing', 'already up to date']) expect(REPO_REASONS.has(fact)).toBe(false);
  });
});

describe('whyLine', () => {
  it('says sync off once, however many of the three blocks say it, and nothing else behind it', () => {
    const behind = pr({ number: 51, headSha: '6'.repeat(40), mergeState: 'behind', canUpdateBranch: false });
    const off = repo({ repo: 'futin/why-a', syncOff: SYNC_OFF, methods: [], autoMergeAllowed: false });
    expect(whyLine(behind, off, false, undefined)).toEqual(['sync off']);
  });

  it('a quiet clean PR on a repo with auto-merge off says only that', () => {
    expect(whyLine(pr({ number: 52, headSha: '7'.repeat(40) }), repo({ repo: 'futin/why-b', autoMergeAllowed: false }), false, undefined)).toEqual([
      'auto-merge not enabled on the repo'
    ]);
  });

  it('a repo with no merge method and no auto-merge says both, merge first', () => {
    const bare = repo({ repo: 'futin/why-c', methods: [], autoMergeAllowed: false });
    const line = whyLine(pr({ number: 53, headSha: '8'.repeat(40) }), bare, false, undefined);
    expect(line).toEqual(['no merge method allowed', 'auto-merge not enabled on the repo']);
  });

  it('keeps the three blocks in order — merge, auto-merge, update — across a repo that fails all of them', () => {
    const fork = pr({ number: 54, headSha: '9'.repeat(40), crossRepository: true, maintainerCanModify: false });
    expect(whyLine(fork, repo({ repo: 'futin/why-d', methods: [], autoMergeAllowed: false }), false, undefined)).toEqual([
      'no merge method allowed',
      'auto-merge not enabled on the repo',
      'fork does not allow edits'
    ]);
  });

  it('a fork whose maintainers cannot edit it says so', () => {
    const fork = pr({ number: 55, headSha: 'a1'.repeat(20), crossRepository: true, maintainerCanModify: false });
    expect(whyLine(fork, repo({ repo: 'futin/why-e' }), false, undefined)).toEqual(['fork does not allow edits']);
  });

  it('a behind PR this token may not update says no permission to update; a clean one that cannot be updated says nothing', () => {
    const own = repo({ repo: 'futin/why-f' });
    const behind = pr({ number: 56, headSha: 'b2'.repeat(20), mergeState: 'behind', canUpdateBranch: false });
    const clean = pr({ number: 57, headSha: 'c3'.repeat(20), mergeState: 'clean', canUpdateBranch: false });
    expect(whyLine(behind, own, false, undefined)).toEqual(['no permission to update']);
    expect(whyLine(clean, own, false, undefined)).toEqual([]);
  });

  it('the row’s own facts never reach the line: failing checks, a conflict and a draft say nothing here', () => {
    const repoOk = repo({ repo: 'futin/why-g' });
    expect(whyLine(pr({ number: 58, headSha: 'd4'.repeat(20), checks: 'failure' }), repoOk, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 59, headSha: 'e5'.repeat(20), mergeable: 'conflicting' }), repoOk, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 60, headSha: 'f6'.repeat(20), draft: true }), repoOk, false, undefined)).toEqual([]);
  });

  it('reads the blocks, not the repo: a draft PR on a repo with no merge method has draft on Merge and nothing on the line', () => {
    const noMethods = repo({ repo: 'futin/why-h', methods: [] });
    expect(whyLine(pr({ number: 61, headSha: '0a'.repeat(20), draft: true }), noMethods, false, undefined)).toEqual([]);
    expect(whyLine(pr({ number: 62, headSha: '1b'.repeat(20), draft: false }), noMethods, false, undefined)).toEqual(['no merge method allowed']);
  });

  it('updating… is on the line while an update is in flight, unless the row’s outcome already says it', () => {
    const behind = pr({ number: 63, headSha: '2c'.repeat(20), mergeState: 'behind', canUpdateBranch: true });
    const repoOk = repo({ repo: 'futin/why-i' });
    expect(whyLine(behind, repoOk, true, 'updating')).toEqual([]);
    expect(whyLine(behind, repoOk, true, 'ok')).toEqual(['updating…']);
    expect(whyLine(behind, repoOk, true, 'error')).toEqual(['updating…']);
    expect(whyLine(behind, repoOk, true, undefined)).toEqual(['updating…']);
    // Not updating: nothing to say, whatever the outcome kind.
    expect(whyLine(behind, repoOk, false, 'updating')).toEqual([]);
  });

  it('dropping updating… for the outcome keeps the other reasons on the line', () => {
    const behind = pr({ number: 64, headSha: '3d'.repeat(20), mergeState: 'behind', canUpdateBranch: true });
    const line = whyLine(behind, repo({ repo: 'futin/why-j', methods: [] }), true, 'updating');
    expect(line).toEqual(['no merge method allowed']);
  });
});

describe('defaultMethod', () => {
  it('is the first of squash, merge, rebase that the repo allows', () => {
    expect(defaultMethod(['rebase', 'merge'])).toBe('merge');
    expect(defaultMethod(['rebase'])).toBe('rebase');
    expect(defaultMethod(['merge', 'squash', 'rebase'])).toBe('squash');
    expect(defaultMethod([])).toBeNull();
  });
});

describe('UPDATING_MS', () => {
  it('is the 30 s the page waits before its one re-read of a marked PR', () => {
    expect(UPDATING_MS).toBe(30_000);
  });
});

describe('groupRepos', () => {
  const prAt = (number: number, updatedAt: string) => pr({ number, updatedAt, title: `PR ${number}` });

  it('puts repos with PRs first by newest update, then empty repos by name, and orders each repo newest first', () => {
    const x = repo({ repo: 'futin/x', prs: [prAt(1, '2026-10-29T10:01:00Z'), prAt(2, '2026-10-29T10:05:00Z'), prAt(3, '2026-10-29T10:03:00Z')] });
    const y = repo({ repo: 'futin/y', prs: [prAt(4, '2026-10-29T10:09:00Z')] });
    const a = repo({ repo: 'futin/a' });
    const b = repo({ repo: 'futin/b' });
    const out = groupRepos([b, x, a, y]);
    expect(out.map((r) => r.repo)).toEqual(['futin/y', 'futin/x', 'futin/a', 'futin/b']);
    expect(out[1].prs.map((p) => p.number)).toEqual([2, 3, 1]);
    // copies: the payload's own order is untouched
    expect(x.prs.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});

describe('outcomeLine', () => {
  it('says each outcome in one short line', () => {
    const line = (outcome: PrWriteResult['outcome']) => outcomeLine({ ok: true, outcome, pr: null, reread: false });
    expect(line('merged')).toBe('merged');
    expect(line('already-merged')).toBe('already merged');
    expect(line('auto-merge-enabled')).toBe('auto-merge armed');
    expect(line('auto-merge-disabled')).toBe('auto-merge off');
    expect(line('noop')).toBe('no auto-merge was armed');
    expect(line('update-requested')).toBe('updating…');
  });
});

describe('prKey and parsePrKey', () => {
  it('builds <repo>#<number>', () => {
    expect(prKey('a/x', 12)).toBe('a/x#12');
  });

  it('parses a key back into its repo and number', () => {
    expect(parsePrKey('a/x#12')).toEqual({ repo: 'a/x', number: 12 });
    expect(parsePrKey(prKey('a/x', 12))).toEqual({ repo: 'a/x', number: 12 });
  });

  it('splits at the LAST #, so a # inside the repo part stays there', () => {
    expect(parsePrKey('a#b/x#3')).toEqual({ repo: 'a#b/x', number: 3 });
  });

  it.each(['a/x', 'a/x#', '#12', 'a/x#abc', 'a/x#1.5', 'a/x#-1', 'a/x#0', ''])('%j is not a key', (key) => {
    expect(parsePrKey(key)).toBeNull();
  });
});

describe('findPr', () => {
  const one = pr({ number: 1, headSha: 'b'.repeat(40) });
  const two = pr({ number: 2, headSha: 'c'.repeat(40) });
  const ax = repo({ repo: 'a/x', prs: [one] });
  const axy = repo({ repo: 'a/xy', prs: [two] });

  it('returns the repo and the PR a key names', () => {
    expect(findPr([ax, axy], 'a/x#1')).toEqual({ repo: ax, pr: one });
  });

  it('a number listed only under another repo is no match', () => {
    expect(findPr([ax, axy], 'a/x#2')).toBeUndefined();
  });

  it('a repo that is only a prefix of the key’s, and a repo not in the read, are no match', () => {
    expect(findPr([ax, axy], 'a/xy#1')).toBeUndefined();
    expect(findPr([ax, axy], 'b/z#1')).toBeUndefined();
  });

  it('a malformed key is no match and does not throw', () => {
    expect(findPr([ax, axy], 'a/x')).toBeUndefined();
  });
});

describe('updateTransition', () => {
  const KEY = 'a/x#1';
  const SHA = 'old';
  const withHead = (headSha: string) => [repo({ repo: 'a/x', prs: [pr({ number: 1, headSha })] })];
  const prGone = [repo({ repo: 'a/x', prs: [pr({ number: 2, headSha: SHA })] })];
  const repoGone = [repo({ repo: 'b/z', prs: [pr({ number: 1, headSha: SHA })] })];

  describe('final: false, the poll', () => {
    it('a moved head drops the mark and says the update landed', () => {
      expect(updateTransition(withHead('new'), KEY, SHA, false)).toEqual({ dropMark: true, outcome: 'updated' });
    });

    it('the marked head keeps the mark and says nothing', () => {
      expect(updateTransition(withHead(SHA), KEY, SHA, false)).toEqual({ dropMark: false, outcome: null });
    });

    it('a PR the read no longer lists drops the mark alone', () => {
      expect(updateTransition(prGone, KEY, SHA, false)).toEqual({ dropMark: true, outcome: null });
    });

    it('a repo the read does not list drops the mark alone', () => {
      expect(updateTransition(repoGone, KEY, SHA, false)).toEqual({ dropMark: true, outcome: null });
    });

    it('a failed read keeps the mark and says nothing', () => {
      expect(updateTransition(null, KEY, SHA, false)).toEqual({ dropMark: false, outcome: null });
    });
  });

  describe('final: true, the timer', () => {
    it('a moved head drops the mark and says the update landed', () => {
      expect(updateTransition(withHead('new'), KEY, SHA, true)).toEqual({ dropMark: true, outcome: 'updated' });
    });

    it('the marked head drops the mark and clears the updating line', () => {
      expect(updateTransition(withHead(SHA), KEY, SHA, true)).toEqual({ dropMark: true, outcome: 'clear-updating' });
    });

    it('a PR the read no longer lists drops the mark alone', () => {
      expect(updateTransition(prGone, KEY, SHA, true)).toEqual({ dropMark: true, outcome: null });
    });

    it('a failed read drops the mark and clears the updating line', () => {
      expect(updateTransition(null, KEY, SHA, true)).toEqual({ dropMark: true, outcome: 'clear-updating' });
    });
  });
});

describe('applyUpdateOutcome', () => {
  const KEY = 'a/x#1';
  const OTHER: PrOutcome = { text: 'merged', kind: 'ok' };

  it('updated says branch updated under the key and leaves other keys alone', () => {
    const outcomes = { [KEY]: { text: 'updating…', kind: 'updating' as const }, 'a/x#2': OTHER };
    expect(applyUpdateOutcome(outcomes, KEY, 'updated')).toEqual({ [KEY]: { text: 'branch updated', kind: 'ok' }, 'a/x#2': OTHER });
  });

  it('updated on a key that already says it returns the same object', () => {
    const outcomes = applyUpdateOutcome({}, KEY, 'updated');
    expect(applyUpdateOutcome(outcomes, KEY, 'updated')).toBe(outcomes);
  });

  it('clear-updating removes a key of kind updating, and only that key', () => {
    const outcomes = { [KEY]: { text: 'updating…', kind: 'updating' as const }, 'a/x#2': OTHER };
    expect(applyUpdateOutcome(outcomes, KEY, 'clear-updating')).toEqual({ 'a/x#2': OTHER });
    // A copy: the state React still holds is never edited in place.
    expect(outcomes[KEY]).toEqual({ text: 'updating…', kind: 'updating' });
  });

  it('clear-updating leaves a finished or refused outcome that arrived meanwhile: the same object', () => {
    const finished = { [KEY]: { text: 'auto-merge armed', kind: 'ok' as const } };
    const refused = { [KEY]: { text: 'head moved', kind: 'error' as const } };
    expect(applyUpdateOutcome(finished, KEY, 'clear-updating')).toBe(finished);
    expect(applyUpdateOutcome(refused, KEY, 'clear-updating')).toBe(refused);
  });

  it('clear-updating on an absent key returns the same object', () => {
    const outcomes = { 'a/x#2': OTHER };
    expect(applyUpdateOutcome(outcomes, KEY, 'clear-updating')).toBe(outcomes);
  });

  it('null returns the same object', () => {
    const outcomes = { [KEY]: { text: 'updating…', kind: 'updating' as const } };
    expect(applyUpdateOutcome(outcomes, KEY, null)).toBe(outcomes);
  });
});

/**
 * Source guards: what they forbid would still render correctly, so behaviour cannot catch it coming back. `#${pr.number}` alone stays legal, it is display text.
 */
describe('one home for the key and for the head-moved rule', () => {
  const SRC = join(__dirname, '..', 'client', 'src');
  const GITHUB = join(SRC, 'components', 'github');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const sources = [...walk(GITHUB).filter((f) => /\.tsx?$/.test(f)), join(SRC, 'lib', 'pr-layouts.ts')];

  it('reads the files it means to', () => {
    expect(sources).toContain(join(GITHUB, 'PrCards.tsx'));
    expect(sources).toContain(join(GITHUB, 'PullRequestsView.tsx'));
  });

  it.each(sources)('%s neither builds nor parses a key by hand', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('.repo}#$');
    expect(text).not.toContain("lastIndexOf('#')");
  });

  it('PullRequestsView does not test the head itself', () => {
    expect(readFileSync(join(GITHUB, 'PullRequestsView.tsx'), 'utf8')).not.toContain('headSha !==');
  });
});

describe('mergeMain', () => {
  it('merges a mergeable PR with green checks', () => {
    expect(mergeMain(pr({ checks: 'success' }), repo())).toEqual({ mode: 'merge', block: null });
  });
  it('merges with mergeBlock\'s own reason when checks fail', () => {
    expect(mergeMain(pr({ checks: 'failure' }), repo())).toEqual({ mode: 'merge', block: 'checks failing' });
  });
  it('arms while checks are pending and the repo allows auto-merge', () => {
    expect(mergeMain(pr({ checks: 'pending' }), repo({ autoMergeAllowed: true }))).toEqual({ mode: 'arm', block: null });
  });
  it('falls back to merge when pending but auto-merge is not allowed on the repo', () => {
    expect(mergeMain(pr({ checks: 'pending' }), repo({ autoMergeAllowed: false }))).toEqual({ mode: 'merge', block: null });
  });
  it('disarms an armed PR, and keeps the sync-off reason on it', () => {
    const armed = pr({ checks: 'pending', autoMerge: { method: 'squash' } as PullRequestRow['autoMerge'] });
    expect(mergeMain(armed, repo())).toEqual({ mode: 'disarm', block: null });
    expect(mergeMain(armed, repo({ syncOff: SYNC_OFF }))).toEqual({ mode: 'disarm', block: 'sync off' });
  });
  it('a draft with pending checks cannot arm: merge, blocked as a draft', () => {
    expect(mergeMain(pr({ draft: true, checks: 'pending' }), repo())).toEqual({ mode: 'merge', block: 'draft' });
  });
});
