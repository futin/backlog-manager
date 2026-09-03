/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { RunDrawer } from '../client/src/components/board/RunDrawer';
import { RunStrip } from '../client/src/components/board/RunStrip';
import rawFixture from './fixtures/orchestrator-run.json';
import type { OrchestratorRun, RunQueueItem, RunStage } from '../shared/types';

/**
 * The time and stage-visibility layer on top of the strip and drawer: total
 * elapsed, per-item done time and duration, and the seven-dot pipeline
 * stepper. A separate file from orchestrator-strip/-drawer.test.tsx on
 * purpose — those two pin the surfaces' existing contracts and this task's
 * brief requires them to stay green with zero edits, which is a claim best
 * kept checkable by not touching them at all.
 *
 * Same fixture cast as both of those suites: the file is plain JSON, so
 * without it every string field widens to `string` instead of the literal
 * unions (RunStage most of all) these components key their behaviour on.
 */
const fixture = rawFixture as OrchestratorRun;

type Payload = OrchestratorRun & { fresh: boolean; pastRuns: number };

function runPayload(over: Partial<OrchestratorRun & { fresh: boolean; pastRuns: number }> = {}): Payload {
  // `updatedAt: ago(0)` on top of the fixture's own frozen stamp, and it is
  // load-bearing since bug-15: every ITEM-level reading in the drawer now
  // derives liveness from `status` + `updatedAt` (`runIsLive`, run-time.ts)
  // rather than trusting the payload's `fresh` flag, so a fixture claiming
  // `fresh: true` while carrying a heartbeat weeks old is a run the drawer
  // correctly reads as CRASHED — a state the server can never actually emit
  // (it computes `fresh` from this very field, moments earlier). Stating a
  // fresh heartbeat alongside the fresh flag is what keeps the live-path
  // cases below exercising the live path.
  return { ...fixture, fresh: true, updatedAt: ago(0), pastRuns: 0, ...over };
}

/**
 * A stamp `ms` before the moment the test runs.
 *
 * The strip and drawer both read `Date.now()` at render — that is what makes
 * their live readings tick on the run poll rather than freezing — so cases
 * about a live run have to be built relative to the real clock rather than
 * pinned to a fixed instant. The values below are all far enough from a rung
 * boundary that the milliseconds between building the fixture and rendering
 * it cannot move the expected string.
 */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** One queue row, shaped for the case at hand — never the whole fixture item, which buries the point. */
function queueItem(over: Partial<RunQueueItem> & { id: string; stage: RunStage }): RunQueueItem {
  return {
    title: 'a queue item',
    sessionId: null, worktree: null, branch: null, permissionMode: null,
    fixLoops: 0, stageAt: {}, verification: [], questions: [], note: null,
    ...over
  };
}

/** The state class the stepper puts on one row's dot for one stage. */
function dotState(itemId: string, stage: RunStage): string {
  const dot = screen
    .getByTestId(`run-drawer-stepper-${itemId}`)
    .querySelector(`[data-stage="${stage}"]`) as HTMLElement | null;
  if (dot === null) throw new Error(`no ${stage} dot on row ${itemId}`);
  // `stalled` joined the three original states with bug-15 — the stage a
  // stopped run died on, which is neither "here right now" nor "left behind".
  const state = ['filled', 'current', 'stalled', 'hollow']
    .find((s) => dot.classList.contains(`run-stepper-dot-${s}`));
  if (state === undefined) throw new Error(`${stage} dot on ${itemId} carries no state class`);
  return state;
}

describe('RunStrip run elapsed', () => {
  it('reads the total elapsed of a live run at minute resolution', () => {
    render(<RunStrip run={runPayload({ startedAt: ago(38 * 60_000 + 20_000) })} onOpen={() => {}} />);
    expect(screen.getByTestId('run-strip-elapsed')).toHaveTextContent('38m');
  });

  /**
   * Absence, not empty text: an empty span still occupies the strip's flex
   * gap and reads as a field that failed to load, where nothing at all reads
   * as a strip with one fewer reading on it. The heartbeat slot beside it
   * already owns the "—" placeholder for its own unparseable case, and two
   * dashes in a row would look like one broken field.
   */
  it('renders no elapsed node at all when startedAt cannot be parsed', () => {
    render(<RunStrip run={runPayload({ startedAt: 'not-a-timestamp' })} onOpen={() => {}} />);
    expect(screen.queryByTestId('run-strip-elapsed')).not.toBeInTheDocument();
  });

  // A finished run's total must stop growing: measured startedAt → updatedAt,
  // it stays the 9 minutes it actually took however long ago that was.
  it('freezes a finished run at what it actually took, not at time since it started', () => {
    const startedAt = ago(6 * 60 * 60_000);
    const updatedAt = new Date(Date.parse(startedAt) + 552_000).toISOString();
    render(
      <RunStrip
        run={runPayload({ status: 'done', fresh: true, startedAt, updatedAt })}
        onOpen={() => {}}
      />
    );
    expect(screen.getByTestId('run-strip-elapsed')).toHaveTextContent('9m');
  });
});

describe('RunDrawer meta time', () => {
  it('reads the run start clock time and its total elapsed', () => {
    const startedAt = ago(3_840_000); // 1h 04m
    render(<RunDrawer run={runPayload({ startedAt })} onClose={() => {}} />);

    const meta = screen.getByTestId('run-drawer-time');
    expect(meta).toHaveTextContent('elapsed');
    expect(meta).toHaveTextContent('1h 04m');
    // Local clock, built from a local Date so the expectation holds in any TZ.
    const local = new Date(Date.parse(startedAt));
    const hh = `${local.getHours()}`.padStart(2, '0');
    const mm = `${local.getMinutes()}`.padStart(2, '0');
    expect(meta).toHaveTextContent(`started ${hh}:${mm}`);
  });

  // The status line's own text is asserted character for character by
  // orchestrator-drawer.test.tsx — this reading had to become a sibling span
  // rather than an extension of it, and this pins that it stayed one.
  it('leaves the status and past-runs line untouched', () => {
    render(<RunDrawer run={runPayload({ pastRuns: 5 })} onClose={() => {}} />);
    expect(screen.getByTestId('run-drawer-past').textContent).toBe(`${fixture.status} · 5 past runs`);
  });

  it('renders nothing rather than a dangling separator when neither stamp parses', () => {
    render(
      <RunDrawer
        run={runPayload({ status: 'done', fresh: false, startedAt: 'nope', updatedAt: 'nope' })}
        onClose={() => {}}
      />
    );
    expect(screen.queryByTestId('run-drawer-time')).not.toBeInTheDocument();
  });
});

describe('RunDrawer row times', () => {
  /**
   * The fixture's bug-14: preflight 08:40:10 through merged 08:59:55 — 19m
   * 45s of actual work, and a `pending` stamp at 08:40:03 that must NOT be
   * counted. Measured from preflight, not from dispatch: the gate check is
   * work on this item, and keeping it is what gives the two before-dispatch
   * exits a duration at all. Both halves of the reading are asserted, since
   * either could be dropped without the other noticing.
   */
  it('shows a merged row its duration and the clock time it finished', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const time = screen.getByTestId('run-drawer-time-bug-14');

    const item = fixture.queue.find((q) => q.id === 'bug-14')!;
    const merged = new Date(Date.parse(item.stageAt.merged!));
    const hh = `${merged.getHours()}`.padStart(2, '0');
    const mm = `${merged.getMinutes()}`.padStart(2, '0');

    expect(time).toHaveTextContent('19m 45s');
    expect(time).toHaveTextContent(`${hh}:${mm}`);
  });

  /**
   * The judgement this whole feature turns on, asserted on the surface a
   * person actually reads. The fixture's task-9 waited 40 minutes in the
   * queue before its own work began (pending 08:40:03, dispatched 09:20:45,
   * merged 09:31:12). Counting from the earliest `stageAt` key — which is
   * `pending` for every item, all stamped at run init — would print 51m and
   * make every merged row of a serially worked queue read as the run's own
   * duration. It has to read the ~11m it took.
   */
  it('excludes the queue wait, so a late row reports its own work and not the run', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const time = screen.getByTestId('run-drawer-time-task-9');
    expect(time).toHaveTextContent('11m 02s');
    expect(time).not.toHaveTextContent('51m');
  });

  it('reads an active row as elapsed rather than finished', () => {
    const run = runPayload({
      queue: [queueItem({
        id: 'task-14', stage: 'reviewing',
        stageAt: { pending: ago(3_000_000), dispatched: ago(300_000), reviewing: ago(120_000) }
      })]
    });
    render(<RunDrawer run={run} onClose={() => {}} />);
    expect(screen.getByTestId('run-drawer-time-task-14')).toHaveTextContent('5m 00s elapsed');
  });

  // An em dash, not "0s": nothing has been measured yet, and a zero claims a
  // measurement that was never taken.
  it('reads a pending row as an em dash', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    expect(screen.getByTestId('run-drawer-time-bug-27').textContent).toBe('—');
  });

  it('prints no time at all for the two exits where no work happened', () => {
    const run = runPayload({
      queue: [
        queueItem({ id: 'bug-22', stage: 'ungroomed', stageAt: { pending: ago(3_000_000), ungroomed: ago(2_900_000) } }),
        queueItem({ id: 'bug-30', stage: 'skipped', stageAt: { pending: ago(3_000_000), skipped: ago(2_900_000) } })
      ]
    });
    render(<RunDrawer run={run} onClose={() => {}} />);
    expect(screen.queryByTestId('run-drawer-time-bug-22')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-drawer-time-bug-30')).not.toBeInTheDocument();
  });
});

describe('RunDrawer stage stepper', () => {
  it('fills what an active row visited, rings where it is, and leaves what is ahead hollow', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    // The fixture's task-14: dispatched, inspecting, now reviewing.
    expect(dotState('task-14', 'dispatched')).toBe('filled');
    expect(dotState('task-14', 'inspecting')).toBe('filled');
    expect(dotState('task-14', 'reviewing')).toBe('current');
    expect(dotState('task-14', 'fixing')).toBe('hollow');
    expect(dotState('task-14', 'verifying')).toBe('hollow');
    expect(dotState('task-14', 'merging')).toBe('hollow');
    expect(dotState('task-14', 'merged')).toBe('hollow');
  });

  it('captions an active row with the stage it is in and how long it has been there', () => {
    const run = runPayload({
      queue: [queueItem({
        id: 'task-14', stage: 'reviewing',
        stageAt: { dispatched: ago(300_000), reviewing: ago(120_000) }
      })]
    });
    render(<RunDrawer run={run} onClose={() => {}} />);
    const note = screen.getByTestId('run-drawer-stage-note-task-14');
    expect(note).toHaveTextContent('now reviewing');
    expect(note).toHaveTextContent('2m 00s in stage');
  });

  /**
   * The fixture's task-16 merged with no `fixing` key at all — it never
   * needed a fix loop. That dot must stay hollow with filled dots on both
   * sides of it: "went through clean" is the single most useful thing that
   * row says, and a stepper that filled everything behind the current
   * position would erase it.
   */
  it('leaves a stage that was never needed hollow between filled neighbours', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    expect(dotState('task-16', 'reviewing')).toBe('filled');
    expect(dotState('task-16', 'fixing')).toBe('hollow');
    expect(dotState('task-16', 'verifying')).toBe('filled');
    expect(dotState('task-16', 'merging')).toBe('filled');
    // Terminal: the last dot reads like the six before it, never as "current".
    expect(dotState('task-16', 'merged')).toBe('filled');
  });

  it('leaves every dot hollow on a pending row', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const dots = screen.getByTestId('run-drawer-stepper-bug-27').querySelectorAll('[data-stage]');
    expect(dots).toHaveLength(7);
    for (const dot of Array.from(dots)) {
      expect(dot).toHaveClass('run-stepper-dot-hollow');
    }
  });

  /**
   * Hover is mouse-only, so the `title` alone would leave the dots
   * unidentifiable to a keyboard or screen-reader user. The `aria-label`
   * carries the same text, and `role="img"` is what makes it reach the
   * accessibility tree at all — on a bare span the label sits on the
   * `generic` role, which prohibits naming, and is silently dropped.
   */
  it('names every dot for hover and for assistive tech alike', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const stepper = screen.getByTestId('run-drawer-stepper-task-14');

    const reviewing = stepper.querySelector('[data-stage="reviewing"]') as HTMLElement;
    expect(reviewing).toHaveAttribute('role', 'img');
    expect(reviewing.getAttribute('title')).toContain('reviewing');
    expect(reviewing.getAttribute('aria-label')).toBe(reviewing.getAttribute('title'));

    // A visited dot appends its arrival time; the fixture's task-14 reached
    // inspecting at 09:35:12.
    const item = fixture.queue.find((q) => q.id === 'task-14')!;
    const arrival = new Date(Date.parse(item.stageAt.inspecting!));
    const hh = `${arrival.getHours()}`.padStart(2, '0');
    const mm = `${arrival.getMinutes()}`.padStart(2, '0');
    const inspecting = stepper.querySelector('[data-stage="inspecting"]') as HTMLElement;
    expect(inspecting.getAttribute('title')).toBe(`inspecting · ${hh}:${mm}`);

    // A never-entered dot still names its stage — with no time appended,
    // since there is none to append.
    const fixing = stepper.querySelector('[data-stage="fixing"]') as HTMLElement;
    expect(fixing.getAttribute('title')).toBe('fixing');
    expect(fixing.getAttribute('aria-label')).toBe('fixing');
  });

  /**
   * The one row that gets no stepper: an `ungroomed` item never entered the
   * pipeline, so seven hollow dots would draw a progress track for something
   * with no progress to make. A `pending` row keeps its empty track, because
   * that one is a promise it will enter.
   */
  it('renders no stepper for an ungroomed row, and does render one for a pending row', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    expect(screen.queryByTestId('run-drawer-stepper-bug-22')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-drawer-stepper-bug-27')).toBeInTheDocument();
  });

  // The existing suite reads the row's chip with
  // `.querySelector('.board-card-stage')` and asserts its exact class list —
  // a stepper dot borrowing that class would silently break the tone tests.
  it('keeps the stepper out of the stage chip class namespace the tone tests key on', () => {
    render(<RunDrawer run={runPayload()} onClose={() => {}} />);
    const row = screen.getByTestId('run-drawer-item-task-14');
    expect(within(row).getAllByRole('img')).toHaveLength(7);
    expect(row.querySelectorAll('.board-card-stage')).toHaveLength(1);
  });
});

/**
 * bug-15 on the drawer: an aborted (or failed, or crashed-`running`) run's
 * in-flight item must stop presenting as work in progress. Three surfaces on
 * one row, all keyed on the same missing fork, all asserted here — the row's
 * time reading, the stepper dot, and the "now <stage>" caption.
 *
 * The fixture's task-14 is the in-flight row (`reviewing`); every stamp on it
 * is built relative to `updatedAt` so the frozen readings are exact numbers
 * rather than "whatever the wall clock said".
 */
describe('RunDrawer rows of a run that stopped', () => {
  /** An aborted run whose task-14 reached `reviewing` 7m 24s before the run's last heartbeat. */
  function abortedPayload(): Payload {
    const stopped = ago(24 * 60 * 60 * 1000); // aborted a day ago
    const stoppedAt = Date.parse(stopped);
    const iso = (before: number): string => new Date(stoppedAt - before).toISOString();
    return runPayload({
      status: 'aborted',
      fresh: false,
      startedAt: iso(900_000),
      updatedAt: stopped,
      queue: [queueItem({
        id: 'task-14',
        stage: 'reviewing',
        stageAt: { pending: iso(900_000), dispatched: iso(504_000), reviewing: iso(444_000) }
      })]
    });
  }

  // dispatched → the run's last heartbeat = 504_000ms, 8m 24s. Not the ~24h
  // `now − dispatched` this row printed before the fix, and identical on
  // every re-render since nothing in the reading touches the wall clock.
  it('freezes an in-flight row at the run\'s last heartbeat instead of counting to now', () => {
    render(<RunDrawer run={abortedPayload()} onClose={() => {}} />);
    const time = screen.getByTestId('run-drawer-time-task-14');
    expect(time).toHaveTextContent('8m 24s elapsed');
    expect(time).not.toHaveTextContent('h ');
  });

  // The dot the item died on: amber and static, never the cyan pulsing ring
  // that is this app's one "happening right now" signal.
  it('marks the stage it died on stalled rather than current', () => {
    render(<RunDrawer run={abortedPayload()} onClose={() => {}} />);
    expect(dotState('task-14', 'reviewing')).toBe('stalled');
    expect(dotState('task-14', 'dispatched')).toBe('filled');
    expect(dotState('task-14', 'fixing')).toBe('hollow');
  });

  // The bluntest of the four surfaces: `now reviewing · 32h 05m in stage` is
  // prose asserting, in the word "now", that something is happening to an
  // item nothing is touching. There is no honest wording for a stopped run —
  // the row's status chip and its stalled dot already say where it stopped —
  // so the caption renders nothing at all.
  it('drops the "now <stage>" caption entirely', () => {
    render(<RunDrawer run={abortedPayload()} onClose={() => {}} />);
    expect(screen.queryByTestId('run-drawer-stage-note-task-14')).not.toBeInTheDocument();
  });

  // Same three readings, same fix, for the case `status` alone cannot spot: a
  // killed orchestrator leaves `run.json` at `status: "running"` forever
  // ("one run per project, checked twice"), and `fresh` is the only thing
  // that ever said otherwise. Deriving from `updatedAt` covers it without a
  // second rule.
  it('treats a crashed running run exactly as a stopped one', () => {
    const crashed = { ...abortedPayload(), status: 'running' as const };
    render(<RunDrawer run={crashed} onClose={() => {}} />);
    expect(screen.getByTestId('run-drawer-time-task-14')).toHaveTextContent('8m 24s elapsed');
    expect(dotState('task-14', 'reviewing')).toBe('stalled');
    expect(screen.queryByTestId('run-drawer-stage-note-task-14')).not.toBeInTheDocument();
  });

  // A stopped run whose own heartbeat will not parse can prove no instant at
  // all, so there is nothing to measure an in-flight row against: the reading
  // goes away rather than falling back to the wall clock. The dot still
  // stalls — the item IS at that stage, that much is not in doubt.
  it('prints no time at all for an in-flight row when the run has no readable heartbeat', () => {
    const unreadable = runPayload({
      status: 'failed',
      fresh: false,
      updatedAt: 'nope',
      queue: [queueItem({
        id: 'task-14',
        stage: 'reviewing',
        stageAt: { pending: ago(900_000), dispatched: ago(504_000), reviewing: ago(444_000) }
      })]
    });
    render(<RunDrawer run={unreadable} onClose={() => {}} />);
    expect(screen.queryByTestId('run-drawer-time-task-14')).not.toBeInTheDocument();
    expect(dotState('task-14', 'reviewing')).toBe('stalled');
  });
});
