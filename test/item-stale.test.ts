import { isStale, leavesBoard } from '../client/src/lib/item-stale';
import rawFixture from './fixtures/orchestrator-run.json';
import type {
  BacklogItem, OrchestratorRun, OrchestratorRunsPayload, RunQueueItem, RunStage
} from '../shared/types';

/**
 * Local builder, same reasoning item-progress.test.ts gives for having its
 * own: only the three fields this predicate reads (`updated`, `created`,
 * `started`, plus `status`/`section` for the board half) actually vary per
 * case, so everything else is a fixed, plausible stand-in.
 */
function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '',
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1-a-bug.md',
  };
  return { ...base, ...over };
}

const DAY = 24 * 60 * 60 * 1000;
/** A fixed instant, so every case below reads as an exact offset from it. */
const NOW = Date.parse('2026-09-01T12:00:00Z');
const WINDOW = 30;

/** A second-precision UTC stamp `ms` before NOW — the shape `start`/`stop` write. */
const stampAgo = (ms: number): string => `${new Date(NOW - ms).toISOString().slice(0, 19)}Z`;
/** A bare `YYYY-MM-DD` `days` before NOW — the shape older files carry. */
const dateAgo = (days: number): string => new Date(NOW - days * DAY).toISOString().slice(0, 10);

/*
 * bug-11's second source. Cast for the reason every other suite reading this
 * fixture casts it: the file is plain JSON, so TS widens its string fields to
 * `string` rather than the literal unions (`RunStage` above all) the cases
 * below turn on.
 */
const runFixture = rawFixture as OrchestratorRun;
type RunPayload = OrchestratorRunsPayload['runs'][number];

/** One fresh run for `/abs/alpha` (the path `fakeItem` carries) holding
 *  exactly `bug-1` at whatever stage the case is about — the same builder
 *  test/agents-shared.test.ts uses on `runHoldsItem` itself, restated here
 *  rather than exported from there: a helper shared between two suites is a
 *  third thing to keep honest, and this one is four lines. */
function runWith(stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  const entry: RunQueueItem = { ...runFixture.queue[0], id: 'bug-1', stage };
  return { ...runFixture, project: '/abs/alpha', queue: [entry], fresh: true, pastRuns: 0, ...over };
}

/** Stale by the file's own reckoning — 90 days quiet, no `started:`, which is
 *  the exact state of any bug an orchestrator picks up out of the archive. */
const QUIET = { updated: stampAgo(90 * DAY) };

describe('isStale', () => {
  it('is false one second inside the window and true one second outside it', () => {
    const inside = fakeItem({ updated: stampAgo(WINDOW * DAY - 1000) });
    const outside = fakeItem({ updated: stampAgo(WINDOW * DAY + 1000) });
    expect(isStale(inside, WINDOW, NOW, [])).toBe(false);
    expect(isStale(outside, WINDOW, NOW, [])).toBe(true);
  });

  it('treats an age of exactly the window as inside it', () => {
    expect(isStale(fakeItem({ updated: stampAgo(WINDOW * DAY) }), WINDOW, NOW, [])).toBe(false);
  });

  it('falls back to created when there is no updated stamp', () => {
    expect(isStale(fakeItem({ created: dateAgo(90) }), WINDOW, NOW, [])).toBe(true);
    expect(isStale(fakeItem({ created: dateAgo(3) }), WINDOW, NOW, [])).toBe(false);
  });

  it('reads updated, not created, when both are present', () => {
    const item = fakeItem({ created: dateAgo(900), updated: stampAgo(2 * DAY) });
    expect(isStale(item, WINDOW, NOW, [])).toBe(false);
  });

  it('treats an item with neither stamp as fresh', () => {
    expect(isStale(fakeItem({}), WINDOW, NOW, [])).toBe(false);
  });

  it('treats an unparseable stamp as fresh', () => {
    expect(isStale(fakeItem({ updated: 'whenever' }), WINDOW, NOW, [])).toBe(false);
    expect(isStale(fakeItem({ created: 'whenever' }), WINDOW, NOW, [])).toBe(false);
  });

  it('ages a bare YYYY-MM-DD in whole days', () => {
    // Exactly `WINDOW` whole days old, plus the twelve hours since UTC
    // midnight. The ms age is past the window; the day-level age is not, and
    // the day-level answer is the one a bare date can actually support.
    expect(isStale(fakeItem({ updated: dateAgo(WINDOW) }), WINDOW, NOW, [])).toBe(false);
    expect(isStale(fakeItem({ updated: dateAgo(WINDOW + 1) }), WINDOW, NOW, [])).toBe(true);
  });

  it('is false for an in-progress item however old its stamp', () => {
    const item = fakeItem({ updated: stampAgo(900 * DAY), started: stampAgo(2 * 60 * 1000) });
    expect(isStale(item, WINDOW, NOW, [])).toBe(false);
  });

  it('is false for a done item, and for a rejected one', () => {
    const old = { updated: stampAgo(900 * DAY) };
    expect(isStale(fakeItem({ ...old, status: 'done' }), WINDOW, NOW, [])).toBe(false);
    expect(isStale(fakeItem({ ...old, status: 'terminal', section: 'out-of-scope' }), WINDOW, NOW, []))
      .toBe(false);
  });

  /*
   * The middle rung. `updated` has one writer while the item file has several
   * editors, so a groomed item can carry a months-old `created` and nothing
   * else — which is how a bug groomed five days earlier left the Board.
   */
  it('reads lastCommit when there is no updated stamp', () => {
    const groomed = fakeItem({ created: dateAgo(35), lastCommit: stampAgo(5 * DAY) });
    expect(isStale(groomed, WINDOW, NOW, [])).toBe(false);
    expect(leavesBoard(groomed, WINDOW, NOW, [])).toBe(false);
  });

  it('is stale when created and lastCommit are both outside the window', () => {
    const item = fakeItem({ created: dateAgo(35), lastCommit: stampAgo(35 * DAY) });
    expect(isStale(item, WINDOW, NOW, [])).toBe(true);
  });

  it('reads updated, not lastCommit, when both are present', () => {
    const item = fakeItem({ updated: stampAgo(2 * DAY), lastCommit: stampAgo(200 * DAY) });
    expect(isStale(item, WINDOW, NOW, [])).toBe(false);
  });

  it('reads lastCommit, not created, when both are present', () => {
    const item = fakeItem({ created: dateAgo(3), lastCommit: stampAgo(200 * DAY) });
    expect(isStale(item, WINDOW, NOW, [])).toBe(true);
  });

  it('treats an unparseable lastCommit as fresh rather than reaching created', () => {
    // Precedence is on presence, not validity: a broken file stays on the
    // Board where someone will notice it.
    const item = fakeItem({ created: dateAgo(90), lastCommit: 'whenever' });
    expect(isStale(item, WINDOW, NOW, [])).toBe(false);
  });

  it('ages a lastCommit carrying a UTC offset exactly', () => {
    // `%cI` writes the committer's offset, not `Z` — the only rung whose stamp
    // does, and it must neither read as a bare date nor parse to NaN.
    const outside = new Date(NOW - (WINDOW * DAY + 3600_000)).toISOString().replace('Z', '+00:00');
    const inside = new Date(NOW - (WINDOW * DAY - 3600_000)).toISOString().replace('Z', '+00:00');
    expect(isStale(fakeItem({ lastCommit: outside }), WINDOW, NOW, [])).toBe(true);
    expect(isStale(fakeItem({ lastCommit: inside }), WINDOW, NOW, [])).toBe(false);
  });

  it('is false for a future stamp', () => {
    expect(isStale(fakeItem({ updated: stampAgo(-5 * DAY) }), WINDOW, NOW, [])).toBe(false);
  });
});

describe('leavesBoard', () => {
  const stale = { updated: stampAgo(90 * DAY) };

  it('evicts a stale refactor, idea and bug', () => {
    for (const section of ['refactors', 'ideas', 'bugs'] as const) {
      expect(leavesBoard(fakeItem({ ...stale, section }), WINDOW, NOW, [])).toBe(true);
    }
  });

  it('never evicts a task, however stale', () => {
    expect(leavesBoard(fakeItem({ ...stale, id: 'task-1', section: 'tasks' }), WINDOW, NOW, []))
      .toBe(false);
  });

  it('never evicts a fresh item', () => {
    expect(leavesBoard(fakeItem({ updated: stampAgo(2 * DAY), section: 'ideas' }), WINDOW, NOW, []))
      .toBe(false);
  });

  it('never evicts an in-progress item with a stale stamp', () => {
    const item = fakeItem({ ...stale, section: 'ideas', started: stampAgo(60 * 1000) });
    expect(leavesBoard(item, WINDOW, NOW, [])).toBe(false);
  });
});

/*
 * bug-11. The file cannot know an orchestrator is working an item: the run
 * stamps `started:`/`phase:` on its own worktree's copy, so the copy the
 * registry points at — the one both surfaces render — stays silent for the
 * whole run. These are the cases that prove the predicate now reads the run
 * payload as a second source for the very rule it already had.
 */
describe('isStale against the run payload', () => {
  /* The four stages the bug was actually filed about, in one loop: two the
     run is working the item at, two it has STOPPED at and is waiting for a
     person. The second pair matters more, not less — an item asking a human a
     question is the last card that should leave the human's surface. */
  it('is false when a fresh run holds the item, working it or blocked on a person', () => {
    for (const stage of ['dispatched', 'pending', 'parked', 'needs-answers'] as RunStage[]) {
      expect(isStale(fakeItem(QUIET), WINDOW, NOW, [runWith(stage)])).toBe(false);
    }
  });

  /* The other half, and the half that keeps this from being "any run
     mentioning the item exempts it forever": once the run has exited the
     item, nobody is on it and the date arithmetic is telling the truth again.
     A merged item is in `done/` and stale to nobody anyway; the other three
     are genuinely back to being neglected open work. */
  it('is still stale at the four stages a run has exited the item at', () => {
    for (const stage of ['merged', 'failed', 'skipped', 'ungroomed'] as RunStage[]) {
      expect(isStale(fakeItem({ ...QUIET, status: 'open' }), WINDOW, NOW, [runWith(stage)]))
        .toBe(true);
    }
  });

  it('is still stale when the run holding the item has gone stale', () => {
    expect(isStale(fakeItem(QUIET), WINDOW, NOW, [runWith('dispatched', { fresh: false })]))
      .toBe(true);
  });

  // Ids are only sequential within one project's store, so two checkouts can
  // both hold `bug-1`; matching on id alone would exempt an item no run is
  // touching at all.
  it('is still stale when the run holding the id belongs to another project', () => {
    expect(isStale(fakeItem(QUIET), WINDOW, NOW, [runWith('dispatched', { project: '/abs/other' })]))
      .toBe(true);
  });
});

describe('leavesBoard against the run payload', () => {
  /* The assertion that actually closes the bug: the same three sections that
     leave the Board when quiet stay on it while a run holds them. Read from
     Archive's side this is the same statement — the card is gone from there. */
  it('keeps a stale refactor, idea and bug a fresh run holds', () => {
    for (const section of ['refactors', 'ideas', 'bugs'] as const) {
      const item = fakeItem({ ...QUIET, section });
      expect(leavesBoard(item, WINDOW, NOW, [runWith('dispatched')])).toBe(false);
    }
  });

  it('still evicts them once that run has merged the item', () => {
    for (const section of ['refactors', 'ideas', 'bugs'] as const) {
      expect(leavesBoard(fakeItem({ ...QUIET, section }), WINDOW, NOW, [runWith('merged')]))
        .toBe(true);
    }
  });

  /* The task exemption is unchanged and unconditional: a stale task never
     leaves the Board, run or no run, and `isStale` still answers true for it
     so the card keeps its `stale` marker. */
  it('never evicts a stale task, with or without a run holding it', () => {
    const task = fakeItem({ ...QUIET, id: 'task-1', section: 'tasks' });
    expect(leavesBoard(task, WINDOW, NOW, [])).toBe(false);
    expect(leavesBoard(task, WINDOW, NOW, [runWith('dispatched')])).toBe(false);
  });
});
