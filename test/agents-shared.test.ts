import {
  EFFORTS, MODELS, PERMISSION_LADDER, actionLabel, clampMode, deriveAction, dispatchBlock,
  dispatchGate, modesUpTo, pickFrom
} from '../shared/agent';
import type { AgentsStatus, BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1', title: 'a bug', created: '2026-08-20', started: '', tags: [],
    updated: '', phase: '', groomElapsed: 0, executeElapsed: 0,
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

  it('grooms an ungroomed bug and executes a groomed one', () => {
    expect(deriveAction(fakeItem({ groomed: false }))).toBe('groom');
    expect(deriveAction(fakeItem({ groomed: true }))).toBe('execute');
  });

  it('executes a planned task and grooms an unplanned one', () => {
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: true }))).toBe('execute');
    expect(deriveAction(fakeItem({ section: 'tasks', groomed: false }))).toBe('groom');
  });

  it('has nothing to dispatch for an archived item or an out-of-scope one', () => {
    expect(deriveAction(fakeItem({ status: 'done', groomed: true }))).toBeNull();
    expect(deriveAction(fakeItem({ section: 'out-of-scope', status: 'terminal', groomed: null })))
      .toBeNull();
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
