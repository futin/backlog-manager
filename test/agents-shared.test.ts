import {
  AGENT_ACTIONS, EFFORTS, MODELS, PERMISSION_LADDER, actionLabel, clampMode, deriveAction,
  dispatchBlock, dispatchGate, isAgentAction, isItemId, modesUpTo, pickFrom, projectDispatchGate,
  runClaimBlock, runHoldsItem
} from '../shared/agent';
import rawFixture from './fixtures/orchestrator-run.json';
import { ATTENTION_RUN_STAGES, RUN_CLAIMED_STAGES } from '../shared/types';
import type {
  AgentsStatus, BacklogItem, OrchestratorRun, OrchestratorRunsPayload, RunQueueItem, RunStage
} from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0, kind: '',
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md'
  };
  return { ...base, ...over };
}

const OK: AgentsStatus = {
  enabled: true, reachable: true, remoteAnswer: true, spawnAvailable: true,
  spawnMaxPermission: 'auto', projectPaths: ['/abs/alpha']
};

describe('deriveAction', () => {
  it('sends an open idea to groom', () => {
    expect(deriveAction(fakeItem({ section: 'ideas', groomed: null }))).toBe('groom');
  });

  // Reached through the `groomed === true` fall-through rather than a branch
  // naming the section, which is exactly why it is worth an assertion: nothing
  // in deriveAction mentions refactors, so this is the only thing standing
  // between a null derivation and a refactor card offering `execute` — the one
  // action backlog-execute refuses on the section outright.
  it('sends an open refactor to groom, never to execute', () => {
    expect(deriveAction(fakeItem({ section: 'refactors', groomed: null }))).toBe('groom');
  });

  it('grooms an ungroomed bug and executes a groomed one', () => {
    expect(deriveAction(fakeItem({ groomed: false }))).toBe('groom');
    expect(deriveAction(fakeItem({ groomed: true }))).toBe('execute');
  });

  it('executes a planned task and grooms an unplanned one', () => {
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: true }))).toBe('execute');
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: false }))).toBe('groom');
  });

  it('has nothing to dispatch for a done item — history has no next step', () => {
    expect(deriveAction(fakeItem({ status: 'done', groomed: true }))).toBeNull();
    expect(deriveAction(fakeItem({ section: 'ideas', status: 'done', groomed: null }))).toBeNull();
  });

  it('captures an out-of-scope item, though its status is terminal', () => {
    // The status is what makes this case worth its own assertion: `terminal` is
    // not `open`, so the `status !== 'open'` line WOULD swallow this item — and
    // did, back when one line covered both archives. The section check running
    // first is the rule being pinned here, not just the return value.
    //
    // A rejection has a next step where a done item does not: reviving it is a
    // NEW item citing `from: oos-1`, never a move out of out-of-scope, which
    // `moveItem` refuses.
    expect(deriveAction(fakeItem({ id: 'oos-1', section: 'out-of-scope', status: 'terminal', groomed: null })))
      .toBe('capture');
  });
});

describe('the action vocabulary', () => {
  it('holds exactly the three actions', () => {
    expect(AGENT_ACTIONS).toEqual(['groom', 'execute', 'capture']);
  });

  it('accepts each of them and nothing else', () => {
    // The controller's whole body check for `action` — so a value that gets
    // past this is a value the service is asked to re-derive against.
    for (const action of AGENT_ACTIONS) expect(isAgentAction(action)).toBe(true);
    expect(isAgentAction('archive')).toBe(false);
    expect(isAgentAction('')).toBe(false);
    expect(isAgentAction(null)).toBe(false);
    expect(isAgentAction(undefined)).toBe(false);
    expect(isAgentAction(1)).toBe(false);
    expect(isAgentAction(['groom'])).toBe(false);
  });
});

describe('actionLabel', () => {
  it('says only what it does — never where the item lands', () => {
    // An idea reads the same as a bug. It used to say `groom → task`; the
    // destination is the skill's business, and one button should not look like
    // two actions depending on which column it sits in.
    expect(actionLabel(fakeItem({ section: 'ideas' }), 'groom')).toBe('groom');
    expect(actionLabel(fakeItem({ section: 'tasks' }), 'groom')).toBe('groom');
    expect(actionLabel(fakeItem(), 'groom')).toBe('groom');
    expect(actionLabel(fakeItem(), 'execute')).toBe('execute');
  });

  it('labels the third action', () => {
    // Its own case rather than a fourth line above: the label used to be a
    // ternary that answered `groom` for everything that was not `execute`, so
    // a capture control read as a groom control — the button lying about what
    // it would do.
    expect(actionLabel(fakeItem({ section: 'out-of-scope' }), 'capture')).toBe('capture');
  });
});

describe('the permission ladder', () => {
  it('runs lowest to highest', () => {
    expect(PERMISSION_LADDER).toEqual(['plan', 'acceptEdits', 'auto', 'bypassPermissions']);
  });

  it('offers only the modes at or below the ceiling', () => {
    expect(modesUpTo('acceptEdits')).toEqual(['plan', 'acceptEdits']);
    expect(modesUpTo('bypassPermissions')).toEqual([...PERMISSION_LADDER]);
  });

  it('offers nothing but plan when the ceiling is unknown', () => {
    expect(modesUpTo(null)).toEqual(['plan']);
  });

  it('clamps a want above the ceiling down to it, and junk down to plan', () => {
    expect(clampMode('bypassPermissions', 'acceptEdits')).toBe('acceptEdits');
    expect(clampMode('plan', 'auto')).toBe('plan');
    expect(clampMode('nonsense', 'auto')).toBe('plan');
    expect(clampMode('auto', null)).toBe('plan');
  });
});

describe('dispatchGate', () => {
  it('enables a dispatchable item on a healthy dashboard', () => {
    expect(dispatchGate(fakeItem(), OK)).toEqual({ control: 'enabled' });
  });

  /* The four host-level conditions HIDE the control. None of them is about any
     one card — all four are true of every card at once — none is fixable from
     the board, and the .env.example and spec both promise that with BM_AGENTS
     off the board looks exactly as it did before this feature. A disabled
     button on forty cards would break that promise and tell the reader
     nothing they can act on from there. */
  it.each([
    [{ enabled: false }, /BM_AGENTS/],
    [{ reachable: false, error: 'ECONNREFUSED' }, /unreachable.*ECONNREFUSED/],
    [{ spawnAvailable: false }, /CLAUDE_BIN/],
    [{ remoteAnswer: false }, /remote answers/]
  ])('hides the control for an environment-level block (%p)', (over, matcher) => {
    const gate = dispatchGate(fakeItem(), { ...OK, ...over });
    expect(gate.control).toBe('hidden');
    expect(gate.control === 'enabled' ? '' : gate.reason).toMatch(matcher);
  });

  /* The per-item one DISABLES instead: it is about this card, it names a path,
     and it is fixable — open a session in that repo, or raise the dashboard's
     LOOKBACK_HOURS. That reason has nowhere else to be stated (Settings
     reports a count, not which projects), which is also why the button that
     carries it stays focusable. */
  it('disables the control, with the reason, for the project-visibility block', () => {
    const gate = dispatchGate(fakeItem(), { ...OK, projectPaths: ['/abs/other'] });
    expect(gate.control).toBe('disabled');
    expect(gate.control === 'enabled' ? '' : gate.reason).toContain('/abs/alpha');
  });
});

/**
 * `projectDispatchGate` (fix round 1 hoist) is `dispatchGate`'s own
 * implementation now — `dispatchGate` below is a one-line delegation to it
 * with `item.projectPath` supplied. These cases exercise it directly with a
 * bare project path, the shape its two OTHER callers actually have on hand
 * (`AgentsService.orchestrate()` and BoardView's toolbar gate, neither of
 * which has a `BacklogItem` to build). Deliberately the same four scenarios
 * `dispatchGate`'s own suite above already covers — the point of the hoist
 * is that both functions now share one code path, so proving this one
 * behaves right is what makes `dispatchGate`'s unchanged behaviour (also
 * still asserted above, untouched) a guarantee rather than a coincidence.
 */
describe('projectDispatchGate', () => {
  it('enables a visible project on a healthy dashboard', () => {
    expect(projectDispatchGate(OK, '/abs/alpha')).toEqual({ control: 'enabled' });
  });

  it.each([
    [{ enabled: false }, /BM_AGENTS/],
    [{ reachable: false, error: 'ECONNREFUSED' }, /unreachable.*ECONNREFUSED/],
    [{ spawnAvailable: false }, /CLAUDE_BIN/],
    [{ remoteAnswer: false }, /remote answers/]
  ])('hides the control for an environment-level block (%p)', (over, matcher) => {
    const gate = projectDispatchGate({ ...OK, ...over }, '/abs/alpha');
    expect(gate.control).toBe('hidden');
    expect(gate.control === 'enabled' ? '' : gate.reason).toMatch(matcher);
  });

  it('disables the control, with the reason, for the project-visibility block', () => {
    const gate = projectDispatchGate({ ...OK, projectPaths: ['/abs/other'] }, '/abs/alpha');
    expect(gate.control).toBe('disabled');
    expect(gate.control === 'enabled' ? '' : gate.reason).toContain('/abs/alpha');
  });

  // The hoist's whole point, pinned directly: dispatchGate must answer
  // IDENTICALLY to a direct call with the same status and the same path,
  // for every one of the scenarios above — not merely similarly.
  it('is exactly what dispatchGate delegates to', () => {
    const item = fakeItem();
    for (const status of [
      OK,
      { ...OK, enabled: false },
      { ...OK, reachable: false, error: 'ECONNREFUSED' },
      { ...OK, spawnAvailable: false },
      { ...OK, remoteAnswer: false },
      { ...OK, projectPaths: ['/abs/other'] }
    ]) {
      expect(dispatchGate(item, status)).toEqual(projectDispatchGate(status, item.projectPath));
    }
  });
});

describe('dispatchBlock', () => {
  it('passes a dispatchable item on a healthy dashboard', () => {
    expect(dispatchBlock(fakeItem(), OK)).toBeNull();
  });

  /* Flattens dispatchGate for the two callers that only ever refuse — the
     launch sheet's re-check and the server's — so hidden and disabled read
     the same to them. Asserted here so the two forms cannot drift into
     different wordings for the same condition. */
  it('flattens both kinds of block to their reason string', () => {
    for (const over of [{ enabled: false }, { projectPaths: ['/abs/other'] }]) {
      const status = { ...OK, ...over };
      const gate = dispatchGate(fakeItem(), status);
      expect(dispatchBlock(fakeItem(), status)).toBe(gate.control === 'enabled' ? null : gate.reason);
    }
  });

  it('reports each gate, most-fundamental first', () => {
    expect(dispatchBlock(fakeItem(), { ...OK, enabled: false })).toMatch(/BM_AGENTS/);
    expect(dispatchBlock(fakeItem(), { ...OK, reachable: false, error: 'ECONNREFUSED' }))
      .toMatch(/unreachable.*ECONNREFUSED/);
    expect(dispatchBlock(fakeItem(), { ...OK, spawnAvailable: false })).toMatch(/CLAUDE_BIN/);
    expect(dispatchBlock(fakeItem(), { ...OK, remoteAnswer: false })).toMatch(/remote answers/);
  });

  it('names the project the dashboard cannot see, and why', () => {
    const blocked = dispatchBlock(fakeItem(), { ...OK, projectPaths: ['/abs/other'] });
    expect(blocked).toContain('/abs/alpha');
    expect(blocked).toMatch(/LOOKBACK_HOURS/);
  });
});

describe('MODELS / EFFORTS', () => {
  /* Mirrors of the dashboard's server/lib/spawn.ts arrays of the same names.
     There is no cross-repo drift test: the sibling checkout is not guaranteed
     to exist here, and PERMISSION_LADDER above is already duplicated on the
     same terms. What keeps this honest is the fail-soft rule below — a value
     this copy has never heard of is dropped, so drift costs a missing flag,
     never a wrong one. */
  it('offers the four model names the dashboard accepts', () => {
    expect(MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('offers the five effort levels, lowest first', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('pickFrom', () => {
  it('keeps a value the list knows', () => {
    expect(pickFrom('sonnet', MODELS)).toBe('sonnet');
    expect(pickFrom('xhigh', EFFORTS)).toBe('xhigh');
  });

  /* Dropped, not rejected — the same rule the dashboard's own parseSpawnRequest
     applies to these two fields. There is no ladder to clamp along, so the only
     safe reading of a name we do not know is "send no flag and let the CLI
     default stand". A 400 here would also make this app the thing that breaks
     when the dashboard learns a fifth model. */
  it('drops a value the list does not know', () => {
    expect(pickFrom('gpt', MODELS)).toBeUndefined();
    expect(pickFrom('ludicrous', EFFORTS)).toBeUndefined();
  });

  it('drops the empty string, which is what "default" submits', () => {
    expect(pickFrom('', MODELS)).toBeUndefined();
  });

  it('drops a non-string', () => {
    expect(pickFrom(undefined, MODELS)).toBeUndefined();
    expect(pickFrom(7, EFFORTS)).toBeUndefined();
    expect(pickFrom(['sonnet'], MODELS)).toBeUndefined();
  });
});

describe('isItemId', () => {
  /* The shape backlog.mjs's own ID_SHAPE has always enforced, restated on
     this side for the one caller that needs it before any file is touched:
     POST /api/agents/orchestrate composes a shell-visible prompt out of these
     strings, so a value that is not an id must never reach the composition
     step at all. */
  it('accepts every section prefix the store mints', () => {
    expect(isItemId('bug-1')).toBe(true);
    expect(isItemId('idea-2')).toBe(true);
    expect(isItemId('task-12')).toBe(true);
    expect(isItemId('ref-3')).toBe(true);
    expect(isItemId('oos-4')).toBe(true);
  });

  it('rejects a bare prefix, a bare number, and an empty string', () => {
    expect(isItemId('')).toBe(false);
    expect(isItemId('task')).toBe(false);
    expect(isItemId('task-')).toBe(false);
    expect(isItemId('-1')).toBe(false);
    expect(isItemId('12')).toBe(false);
  });

  it('rejects anything with case, a filename, or inner whitespace', () => {
    expect(isItemId('Task-1')).toBe(false);
    expect(isItemId('task-1.md')).toBe(false);
    expect(isItemId('task 1')).toBe(false);
    expect(isItemId('task-1-a-title')).toBe(false);
  });

  /* The reason this predicate exists rather than a membership check alone.
     Membership is the real boundary and runs second (AgentsService.orchestrate),
     but these are the values that must not survive even long enough to be
     looked up. `\n` matters on its own: the prompt is one line, and an id
     carrying a newline would split it. */
  it('rejects traversal, shell metacharacters and newlines', () => {
    expect(isItemId('../task-1')).toBe(false);
    expect(isItemId('../../etc/passwd')).toBe(false);
    expect(isItemId('task-1; rm -rf /')).toBe(false);
    expect(isItemId('task-1;ls')).toBe(false);
    expect(isItemId('task-1\n')).toBe(false);
    expect(isItemId('task-1 --resume')).toBe(false);
  });

  /* Anchored, so a valid id embedded in a longer string is not "a valid id".
     A regex without ^ and $ passes every one of the cases above — including
     the two padded ones, which is exactly how a `--ids` list built by naive
     string joining would smuggle an argument through.

     `xtask-1` is deliberately NOT here: it is a well-formed id whose prefix
     names no section, and this predicate's contract is "could this be an id",
     not "does it exist". The membership scan is what refuses it, and it is
     the only check that can — see isItemId's own comment. */
  it('is anchored at both ends', () => {
    expect(isItemId('task-1x')).toBe(false);
    expect(isItemId(' task-1')).toBe(false);
    expect(isItemId('task-1 ')).toBe(false);
    expect(isItemId('a'.repeat(500))).toBe(false);
  });

  /* Well-formed but absurd. Refused on length rather than shape, so the
     directory scan behind this predicate is never handed something that
     cannot possibly name a file. */
  it('rejects an id longer than any store can mint', () => {
    expect(isItemId(`task-${'9'.repeat(500)}`)).toBe(false);
    expect(isItemId('task-1234567890')).toBe(true);
  });

  it('rejects a non-string', () => {
    expect(isItemId(undefined)).toBe(false);
    expect(isItemId(7)).toBe(false);
    expect(isItemId(['task-1'])).toBe(false);
    expect(isItemId(null)).toBe(false);
  });
});

/*
 * The fourth kind of dispatch block: an item an orchestrator run has already
 * claimed. Cast for the same reason every other suite that reads this fixture
 * casts it — the file is plain JSON, so TS widens its string fields to
 * `string` rather than the narrower literal unions (`RunStage` above all,
 * which is the entire vocabulary these cases turn on).
 */
const runFixture = rawFixture as OrchestratorRun;

type RunPayload = OrchestratorRunsPayload['runs'][number];

/** One fresh run for `/abs/alpha` (the path `fakeItem` carries) holding
 *  exactly one queue entry, at whatever stage the case is about. Built off
 *  the contract fixture rather than a hand-rolled queue item so the shape
 *  stays the real one, with only the two fields each case varies replaced. */
function runWith(stage: RunStage, over: Partial<RunPayload> = {}): RunPayload {
  const entry: RunQueueItem = { ...runFixture.queue[0], id: 'bug-1', stage };
  return { ...runFixture, project: '/abs/alpha', queue: [entry], fresh: true, pastRuns: 0, ...over };
}

/*
 * The six stages a run has FINISHED with an item at. Written out here rather
 * than derived as "everything RUN_CLAIMED_STAGES omits", because deriving it
 * from the thing under test is how a partition test proves nothing: if
 * RUN_CLAIMED_STAGES lost a member, a derived complement would gain it and
 * both halves would still agree.
 */
const TERMINAL_STAGES: readonly RunStage[] = [
  'merged', 'failed', 'skipped', 'needs-answers', 'ungroomed', 'parked'
];

/*
 * The four stages a run has truly EXITED an item at — the complement of
 * `runHoldsItem`'s answer rather than of `runClaimBlock`'s, and the reason
 * the two lists above and below this comment both have to exist. A parked or
 * needs-answers item is terminal to DISPATCH (nobody is going to move it but
 * a human, which is what parking is for) and not terminal to the ITEM: the
 * run still holds the worktree and is waiting, so bug-11's question — "is
 * this item live work" — answers yes where `runClaimBlock`'s answers no.
 *
 * Written out by hand for the reason TERMINAL_STAGES above is: derived from
 * the constants under test, a partition test proves nothing, because a
 * constant that loses a member hands it straight to the derived complement
 * and both halves still agree.
 */
const EXITED_STAGES: readonly RunStage[] = ['merged', 'failed', 'skipped', 'ungroomed'];

describe('runClaimBlock', () => {
  it('names the stage for every stage a run still owns the item at', () => {
    for (const stage of RUN_CLAIMED_STAGES) {
      const reason = runClaimBlock(fakeItem(), [runWith(stage)]);
      expect(reason).not.toBeNull();
      // The stage itself, not a generic "a run has this": which stage it is
      // tells the reader whether to wait a moment or go look at the run.
      expect(reason).toContain(stage);
    }
  });

  /* The half that keeps this from being a blanket "any run mentioning this
     item blocks it". A run that merged, failed, skipped, parked or bounced an
     item is DONE with it, and a human picking it up by hand is the intended
     next move — `parked` most of all, since a park exists precisely to hand
     the item back to a person. */
  it('allows dispatch once the run has left the item at a terminal stage', () => {
    for (const stage of TERMINAL_STAGES) {
      expect(runClaimBlock(fakeItem(), [runWith(stage)])).toBeNull();
    }
  });

  /* Staleness is the same rule every other run-derived surface already
     applies (RunStrip renders nothing, BoardView's badge map is built from
     fresh runs only). A crashed run may well still hold a worktree, but that
     is what `--resume`/`--abort` are for: cards dead until someone runs one
     of those is a worse failure than the one this block exists to prevent. */
  it('allows dispatch when the only run holding the item has gone stale', () => {
    expect(runClaimBlock(fakeItem(), [runWith('reviewing', { fresh: false })])).toBeNull();
  });

  /* Ids are only sequential within one project's own store, so two checkouts
     can both hold `bug-1` — matching on id alone would block a card in a
     project no run is touching at all. */
  it('ignores a run for a different project holding the same id', () => {
    expect(runClaimBlock(fakeItem(), [runWith('reviewing', { project: '/abs/other' })])).toBeNull();
  });

  it('allows dispatch when the right project\'s fresh run does not mention this item', () => {
    expect(runClaimBlock(fakeItem({ id: 'task-99' }), [runWith('reviewing')])).toBeNull();
  });

  it('allows dispatch when there are no runs at all', () => {
    expect(runClaimBlock(fakeItem(), [])).toBeNull();
  });

  /* The test that fails the day a new `RunStage` member is added and left
     unclassified. `Record<RunStage, ...>` is what does the work: TS refuses
     the object literal below if it omits a member, so the compiler forces
     the new stage into this file, and the two assertions then force it into
     one of the two lists rather than into neither. */
  it('partitions every RunStage member into exactly one of claimed or terminal', () => {
    const everyStage: Record<RunStage, true> = {
      pending: true, preflight: true, dispatched: true, inspecting: true, reviewing: true,
      fixing: true, verifying: true, merging: true, merged: true, failed: true,
      skipped: true, 'needs-answers': true, ungroomed: true, parked: true
    };
    const all = Object.keys(everyStage) as RunStage[];

    expect([...RUN_CLAIMED_STAGES, ...TERMINAL_STAGES].sort()).toEqual([...all].sort());
    expect(RUN_CLAIMED_STAGES.filter((s) => TERMINAL_STAGES.includes(s))).toEqual([]);

    /* The SECOND partition of the same fourteen members, the one bug-11
       added: live (a run still holds the item, whether working it or blocked
       on a person) versus exited. It shares the `Record<RunStage, true>`
       literal above deliberately — one object the compiler forces a new
       member into, and two independent classifications it then has to be
       given, so a stage cannot be filed as claimed-or-terminal and left out
       of live-or-exited. */
    const live = [...RUN_CLAIMED_STAGES, ...ATTENTION_RUN_STAGES];
    expect([...live, ...EXITED_STAGES].sort()).toEqual([...all].sort());
    expect(live.filter((s) => EXITED_STAGES.includes(s))).toEqual([]);
  });
});

/*
 * bug-11: the same lookup asked the other question — "is this item live work",
 * which is what keeps a stale open bug an orchestrator is working on the Board
 * instead of in Archive. Every case here is the `runClaimBlock` case above it
 * read against the wider stage set, plus the two attention stages, which are
 * the whole reason this is a second function rather than a second caller.
 */
describe('runHoldsItem', () => {
  it('holds the item at every stage a run still owns it', () => {
    for (const stage of RUN_CLAIMED_STAGES) {
      expect(runHoldsItem(fakeItem(), [runWith(stage)])).toBe(true);
    }
  });

  /* The half that differs from `runClaimBlock`, and the reason bug-11's fix
     could not simply reuse it: a parked or needs-answers run has STOPPED and
     is waiting for a person. Dispatch is allowed (that is what parking hands
     back), but the item is the last card that should leave the surface the
     person is being asked to look at. */
  it('holds the item at both stages a run is blocked on a person at', () => {
    for (const stage of ATTENTION_RUN_STAGES) {
      expect(runHoldsItem(fakeItem(), [runWith(stage)])).toBe(true);
    }
  });

  it('releases the item at the four stages a run has exited it at', () => {
    for (const stage of EXITED_STAGES) {
      expect(runHoldsItem(fakeItem(), [runWith(stage)])).toBe(false);
    }
  });

  /* The three lines the two functions share, asserted here as well as on
     `runClaimBlock` — the extracted helper is what makes them one
     implementation, and these are the cases that would notice if it stopped
     being. */
  it('releases the item when the only run holding it has gone stale', () => {
    expect(runHoldsItem(fakeItem(), [runWith('reviewing', { fresh: false })])).toBe(false);
  });

  it('ignores a run for a different project holding the same id', () => {
    expect(runHoldsItem(fakeItem(), [runWith('reviewing', { project: '/abs/other' })])).toBe(false);
  });

  it('releases an item the right project\'s fresh run does not mention', () => {
    expect(runHoldsItem(fakeItem({ id: 'task-99' }), [runWith('reviewing')])).toBe(false);
  });

  it('releases the item when there are no runs at all', () => {
    expect(runHoldsItem(fakeItem(), [])).toBe(false);
  });
});
