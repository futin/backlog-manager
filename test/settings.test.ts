import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SECTIONS } from '../client/src/lib/sections';
import { CONTENT_WIDTHS, DEFAULT_SETTINGS, FONT_SCALES, LIMITS, SETTINGS_SCOPES, STALE_WINDOWS, THEMES, clampSettings, stopsWith } from '../client/src/lib/settings';
import { EFFORTS, MODELS } from '../shared/agent';

describe('clampSettings', () => {
  it('passes a valid object through', () => {
    const s = clampSettings({
      theme: 'daylight',
      density: 'compact',
      fontScale: 110,
      landing: 'github',
      dispatchDefaultModel: 'sonnet',
      dispatchDefaultEffort: 'high',
      staleDays: 14,
      orchestrateDefaultMergeMode: 'branch',
      orchestrateDefaultQuestionMode: 'decide',
      executeDefaultFinish: 'pr',
      groomDefaultFinish: 'pr',
      prAutoMergeDefault: true,
      prFixDefault: true,
      settingsScope: 'shared',
      contentWidth: 'full',
      jiraDefaultAction: 's_0123abcd'
    });
    expect(s).toEqual({
      theme: 'daylight',
      density: 'compact',
      fontScale: 110,
      landing: 'github',
      linkBase: 'http://127.0.0.1:5174',
      dispatchDefaultModel: 'sonnet',
      dispatchDefaultEffort: 'high',
      staleDays: 14,
      orchestrateDefaultMergeMode: 'branch',
      orchestrateDefaultQuestionMode: 'decide',
      executeDefaultFinish: 'pr',
      groomDefaultFinish: 'pr',
      prAutoMergeDefault: true,
      prFixDefault: true,
      settingsScope: 'shared',
      contentWidth: 'full',
      jiraDefaultAction: 's_0123abcd'
    });
  });

  it('falls back per field, independently', () => {
    const s = clampSettings({
      theme: 'neon',
      density: 7,
      fontScale: 'big',
      landing: 'guides',
      dispatchDefaultModel: 'gpt',
      dispatchDefaultEffort: 7,
      staleDays: 'soon',
      orchestrateDefaultMergeMode: 'rebase',
      orchestrateDefaultQuestionMode: 'auto',
      executeDefaultFinish: 'merge'
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  // Spec §2: the clamp is pure and cannot know which skill ids exist (that is `resolveJiraAction`'s job in lib/jira.ts), so it keeps any non-empty string of
  // at most 64 characters and falls back to `execute` for everything else.
  it('keeps jiraDefaultAction a non-empty string of at most 64 characters, and falls back to execute otherwise', () => {
    expect(DEFAULT_SETTINGS.jiraDefaultAction).toBe('execute');
    expect(clampSettings({ jiraDefaultAction: '' }).jiraDefaultAction).toBe('execute');
    expect(clampSettings({ jiraDefaultAction: 42 }).jiraDefaultAction).toBe('execute');
    expect(clampSettings({ jiraDefaultAction: 'x'.repeat(65) }).jiraDefaultAction).toBe('execute');
    expect(clampSettings({ jiraDefaultAction: 'x'.repeat(64) }).jiraDefaultAction).toBe('x'.repeat(64));
    expect(clampSettings({ jiraDefaultAction: 's_0123abcd' }).jiraDefaultAction).toBe('s_0123abcd');
    expect(clampSettings({ jiraDefaultAction: 'context' }).jiraDefaultAction).toBe('context');
  });

  it('clamps fontScale into its limits', () => {
    expect(clampSettings({ fontScale: 300 }).fontScale).toBe(130);
    expect(clampSettings({ fontScale: 10 }).fontScale).toBe(80);
  });

  it('handles null and non-objects', () => {
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings('x')).toEqual(DEFAULT_SETTINGS);
  });

  /**
   * The staleness window is the one numeric setting that does NOT snap to its
   * nearest bound on the low side — see `clampDays`. Zero and negatives are
   * not "archive as aggressively as you allow", they are values nobody can
   * have meant, and honouring them literally would empty three of the four
   * Board columns with nothing on screen to explain why.
   */
  it('clamps a zero, negative or non-numeric staleness window to the default', () => {
    expect(clampSettings({ staleDays: 0 }).staleDays).toBe(DEFAULT_SETTINGS.staleDays);
    expect(clampSettings({ staleDays: -5 }).staleDays).toBe(DEFAULT_SETTINGS.staleDays);
    expect(clampSettings({ staleDays: 'soon' }).staleDays).toBe(DEFAULT_SETTINGS.staleDays);
    expect(clampSettings({}).staleDays).toBe(DEFAULT_SETTINGS.staleDays);
  });

  it('keeps a real staleness window, and clamps one past the ceiling', () => {
    expect(clampSettings({ staleDays: 7 }).staleDays).toBe(7);
    expect(clampSettings({ staleDays: 1 }).staleDays).toBe(1);
    expect(clampSettings({ staleDays: 99999 }).staleDays).toBe(LIMITS.staleDays.max);
  });

  it('offers five themes, four font stops and four staleness stops (UI contract)', () => {
    expect(THEMES).toHaveLength(5);
    expect(FONT_SCALES).toEqual([90, 100, 110, 120]);
    expect(STALE_WINDOWS).toEqual([7, 14, 30, 90]);
  });
});

describe('landing', () => {
  it('accepts every section the rail has, and `last`', () => {
    for (const landing of ['last', ...SECTIONS]) {
      expect(clampSettings({ landing }).landing).toBe(landing);
    }
  });

  /*
    `board` and `archive` were root sections until the source rows, so they sit in real installs' `Opens on` pins. A pin names a section, as
    `landing: 'jira'` does, and both legacy names name GitHub's — the page they meant is dropped here: `clampSettings` is pure and runs on every read, so it
    never writes a page store. Which source a legacy pin really settles on is the shell's call, on the projects answer.
  */
  it('legacy landing board/archive is kept', () => {
    expect(clampSettings({ landing: 'board' }).landing).toBe('github');
    expect(clampSettings({ landing: 'archive' }).landing).toBe('github');
    expect(clampSettings({ landing: 'last' }).landing).toBe('last');
    expect(clampSettings({ landing: 'runs' }).landing).toBe('runs');
    expect(clampSettings({ landing: 'nonsense' }).landing).toBe('last');
  });

  it('falls back to `last` for a section this build no longer has', () => {
    // 'projects' is what the Board tab was called before the rail grew
    // Archive, so it is sitting in real installs' settings blobs. It is not
    // aliased onto a section the way App's stored *section* is: a pin this build
    // cannot honour has an honest answer, and it is "open where I left off".
    expect(clampSettings({ landing: 'projects' }).landing).toBe('last');
    expect(clampSettings({ landing: 'archives' }).landing).toBe('last');
  });
});

describe('linkBase', () => {
  it('defaults to the dashboard on loopback', () => {
    expect(clampSettings({}).linkBase).toBe('http://127.0.0.1:5174');
  });

  it('keeps an http(s) origin and drops a trailing slash', () => {
    expect(clampSettings({ linkBase: 'https://box.ts.net:5174/' }).linkBase).toBe('https://box.ts.net:5174');
  });

  it('refuses a non-http scheme — this value becomes an href', () => {
    expect(clampSettings({ linkBase: 'javascript:alert(1)' }).linkBase).toBe('http://127.0.0.1:5174');
    expect(clampSettings({ linkBase: 'not a url' }).linkBase).toBe('http://127.0.0.1:5174');
    expect(clampSettings({ linkBase: 42 }).linkBase).toBe('http://127.0.0.1:5174');
  });
});

describe('dispatch defaults', () => {
  it('defaults both to the empty string — the CLI decides until you say otherwise', () => {
    expect(clampSettings({}).dispatchDefaultModel).toBe('');
    expect(clampSettings({}).dispatchDefaultEffort).toBe('');
  });

  it('keeps a name the launch sheet actually offers', () => {
    expect(clampSettings({ dispatchDefaultModel: 'haiku' }).dispatchDefaultModel).toBe('haiku');
    expect(clampSettings({ dispatchDefaultEffort: 'max' }).dispatchDefaultEffort).toBe('max');
  });

  it('drops a name this build has never heard of, rather than passing it on', () => {
    expect(clampSettings({ dispatchDefaultModel: 'opus-9' }).dispatchDefaultModel).toBe('');
    expect(clampSettings({ dispatchDefaultEffort: 'ludicrous' }).dispatchDefaultEffort).toBe('');
    expect(clampSettings({ dispatchDefaultModel: 42 }).dispatchDefaultModel).toBe('');
  });

  it('offers exactly the lists the launch sheet pickers are built from', () => {
    expect(MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

/**
 * `executeDefaultFinish` seeds the board's execute launch sheet's Finish select, and is clamped exactly as `orchestrateDefaultMergeMode` below is: a closed
 * two-member enum (`EXECUTE_FINISHES`), so anything a hand-edited localStorage could hold that is not a member — a mode this feature never had (`'merge'`),
 * a wrong case, a non-string — reads as the default rather than reaching the select, which would otherwise render a value none of its options carry.
 */
describe('executeDefaultFinish', () => {
  it('defaults to in-place — what every execute did before the picker existed', () => {
    expect(clampSettings({}).executeDefaultFinish).toBe('in-place');
    expect(DEFAULT_SETTINGS.executeDefaultFinish).toBe('in-place');
  });

  it('keeps pr', () => {
    expect(clampSettings({ executeDefaultFinish: 'pr' }).executeDefaultFinish).toBe('pr');
  });

  it.each([['merge'], [7], ['PR'], [null]])('clamps %p to in-place', (junk) => {
    expect(clampSettings({ executeDefaultFinish: junk }).executeDefaultFinish).toBe('in-place');
  });
});

/**
 * `groomDefaultFinish`, `prAutoMergeDefault` and `prFixDefault` seed the groom/execute launch sheets' PR options. The finish is clamped like
 * `executeDefaultFinish` (the same closed `ExecuteFinish` enum); the two flags through `pickBool`, so a hand-edited string or number reads as off rather than
 * as truthy. The clamp does NOT reconcile the pair: a stored fix-on with auto-merge-off survives, because the sheet — not the clamp — resolves it.
 */
describe('groomDefaultFinish and the PR defaults', () => {
  it('default to in-place, off and off', () => {
    expect(DEFAULT_SETTINGS.groomDefaultFinish).toBe('in-place');
    expect(DEFAULT_SETTINGS.prAutoMergeDefault).toBe(false);
    expect(DEFAULT_SETTINGS.prFixDefault).toBe(false);
    const clamped = clampSettings({});
    expect([clamped.groomDefaultFinish, clamped.prAutoMergeDefault, clamped.prFixDefault]).toEqual(['in-place', false, false]);
  });

  it('keeps pr and clamps a non-member finish to in-place', () => {
    expect(clampSettings({ groomDefaultFinish: 'pr' }).groomDefaultFinish).toBe('pr');
    expect(clampSettings({ groomDefaultFinish: 'squash' }).groomDefaultFinish).toBe('in-place');
  });

  it.each([['true'], [1], [null]])('clamps prAutoMergeDefault %p to false, and keeps true', (junk) => {
    expect(clampSettings({ prAutoMergeDefault: junk }).prAutoMergeDefault).toBe(false);
    expect(clampSettings({ prAutoMergeDefault: true }).prAutoMergeDefault).toBe(true);
  });

  it.each([['true'], [1], [null]])('clamps prFixDefault %p to false, and keeps true', (junk) => {
    expect(clampSettings({ prFixDefault: junk }).prFixDefault).toBe(false);
    expect(clampSettings({ prFixDefault: true }).prFixDefault).toBe(true);
  });

  it('leaves a stored fix-on with auto-merge-off unchanged', () => {
    const clamped = clampSettings({ prAutoMergeDefault: false, prFixDefault: true });
    expect([clamped.prAutoMergeDefault, clamped.prFixDefault]).toEqual([false, true]);
  });
});

/**
 * `orchestrateDefaultMergeMode` seeds the orchestrate sheet's merge-mode
 * picker (Task 8) the same way `dispatchDefaultModel`/`dispatchDefaultEffort`
 * seed the launch sheet's — a default you set once in Settings, not the sheet
 * remembering the last launch.
 *
 * The clamp-to-default here is the deliberate mirror image of Task 4's server
 * rule: a malformed `mergeMode` on an orchestrate request body is an HTTP 400,
 * never a clamp, because that value is an *instruction* acted on unattended —
 * silently resolving a caller's bug to `'merge'` would let it pick the
 * irreversible direction by accident. This value is a *preference* instead:
 * its worst case is the sheet opening pre-selected on the wrong option, which
 * the user sees on screen and can change before launching anything, so
 * clamping a hand-edited localStorage value back to the safe default is the
 * right failure mode rather than an error nobody watching a board would see.
 */
describe('orchestrateDefaultMergeMode', () => {
  it("defaults to merge — today's behaviour for a board that has never touched this setting", () => {
    expect(clampSettings({}).orchestrateDefaultMergeMode).toBe('merge');
  });

  it('keeps a real merge mode', () => {
    expect(clampSettings({ orchestrateDefaultMergeMode: 'branch' }).orchestrateDefaultMergeMode).toBe('branch');
  });

  it('clamps an unrecognised string to the default, rather than passing it on', () => {
    expect(clampSettings({ orchestrateDefaultMergeMode: 'nonsense' }).orchestrateDefaultMergeMode).toBe('merge');
  });

  it('clamps a non-string to the default', () => {
    expect(clampSettings({ orchestrateDefaultMergeMode: 7 }).orchestrateDefaultMergeMode).toBe('merge');
  });
});

/**
 * `orchestrateDefaultQuestionMode` seeds the orchestrate sheet's
 * question-mode picker, exactly as `orchestrateDefaultMergeMode` above seeds
 * the merge-mode one, and clamps for the identical reason: this is a
 * *preference*, not an instruction. The server's own `resolveQuestionMode`
 * 400s an unrecognised value because that one is acted on unattended and
 * ends up written verbatim into `run.json`; this one's worst case is a sheet
 * opening on the wrong pre-selection, which the person launching the run can
 * see and change.
 *
 * There is no nearest-bound behaviour to test the way `staleDays` has: the
 * union is closed, so `pickOne` falling back to the default is the whole
 * rule.
 */
describe('orchestrateDefaultQuestionMode', () => {
  it('defaults to park — what every run did before the mode existed', () => {
    expect(clampSettings({}).orchestrateDefaultQuestionMode).toBe('park');
  });

  it('keeps either real question mode', () => {
    expect(clampSettings({ orchestrateDefaultQuestionMode: 'decide' }).orchestrateDefaultQuestionMode).toBe('decide');
    expect(clampSettings({ orchestrateDefaultQuestionMode: 'park' }).orchestrateDefaultQuestionMode).toBe('park');
  });

  it('clamps an unrecognised string to the default', () => {
    expect(clampSettings({ orchestrateDefaultQuestionMode: 'auto' }).orchestrateDefaultQuestionMode).toBe('park');
  });

  it('clamps a non-string and a null to the default', () => {
    expect(clampSettings({ orchestrateDefaultQuestionMode: 42 }).orchestrateDefaultQuestionMode).toBe('park');
    expect(clampSettings({ orchestrateDefaultQuestionMode: null }).orchestrateDefaultQuestionMode).toBe('park');
  });
});

/**
 * `settingsScope` and `contentWidth` — the two keys the Settings split and the
 * fullscreen measure are built on. Grouped together because what they share is
 * the only thing worth stating twice: both are per-device, both are closed
 * two-member unions, and both have to survive a settings blob written before
 * either existed, since every install already has one.
 */
describe('settingsScope', () => {
  it('defaults to local — the page an install that has never opened Settings shows', () => {
    expect(DEFAULT_SETTINGS.settingsScope).toBe('local');
    expect(clampSettings({}).settingsScope).toBe('local');
  });

  it('keeps the shared page when it is the stored one', () => {
    expect(clampSettings({ settingsScope: 'shared' }).settingsScope).toBe('shared');
  });

  it('keeps the dashboards page when it is the stored one', () => {
    expect(clampSettings({ settingsScope: 'dashboards' }).settingsScope).toBe('dashboards');
  });

  /*
    A view position is still worth clamping: the value picks which of two card
    sets renders, so an unrecognised one would render neither and leave the
    page blank under its own band with nothing on screen saying why.
  */
  it('clamps an unrecognised value, a number and a null to local', () => {
    expect(clampSettings({ settingsScope: 'nonsense' }).settingsScope).toBe('local');
    expect(clampSettings({ settingsScope: 'bogus' }).settingsScope).toBe('local');
    expect(clampSettings({ settingsScope: 7 }).settingsScope).toBe('local');
    expect(clampSettings({ settingsScope: null }).settingsScope).toBe('local');
  });
});

describe('contentWidth', () => {
  it('defaults to fixed — the drawn measure, unchanged for every existing install', () => {
    expect(DEFAULT_SETTINGS.contentWidth).toBe('fixed');
    expect(clampSettings({}).contentWidth).toBe('fixed');
  });

  it('keeps full when it is the stored value', () => {
    expect(clampSettings({ contentWidth: 'full' }).contentWidth).toBe('full');
  });

  it('clamps an unrecognised string and a number to fixed', () => {
    expect(clampSettings({ contentWidth: 'wide' }).contentWidth).toBe('fixed');
    expect(clampSettings({ contentWidth: 1 }).contentWidth).toBe('fixed');
  });
});

/**
 * The two new keys against the rule the whole validator is built on: every
 * field falls back independently, so one bad sibling cannot discard a good
 * value beside it. Stated again here rather than left to `falls back per
 * field` above, because that case passes a blob where EVERY field is bad — it
 * would go on passing if a new key were dropped outright rather than clamped.
 */
it('keeps both new keys when a sibling is bad', () => {
  const s = clampSettings({ theme: 'chartreuse', settingsScope: 'shared', contentWidth: 'full' });
  expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
  expect(s.settingsScope).toBe('shared');
  expect(s.contentWidth).toBe('full');
});

/**
 * The member lists themselves, asserted literally.
 *
 * These are what the pickers render and what `clampSettings` validates
 * against, and a test on them is what stops a third member being added in one
 * place only — the failure that leaves a picker offering an option the
 * validator throws away on the next load.
 */
it('holds exactly three settings scopes and two content widths', () => {
  expect(SETTINGS_SCOPES).toEqual(['local', 'shared', 'dashboards']);
  expect(CONTENT_WIDTHS).toEqual(['fixed', 'full']);
});

/**
 * Daylight is the default theme and listed first (dashboard e882365). `shared/theme.css`'s `:root` block still holds Midnight, so the default is a STAMP, not a
 * palette: the pre-paint script in `client/index.html` writes `data-theme` before it reads storage, and this block pins the three things that have to agree.
 */
describe('the default theme', () => {
  it('is Daylight, and Daylight leads the picker with the other four in their old order', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('daylight');
    expect(THEMES[0].id).toBe('daylight');
    expect(THEMES.slice(1).map((t) => t.id)).toEqual(['midnight', 'graphite', 'amber', 'nightshift']);
  });

  it('falls back to Daylight for no theme or an unknown one, and keeps a stored Midnight', () => {
    expect(clampSettings({ density: 'compact' }).theme).toBe('daylight');
    expect(clampSettings({ theme: 'bogus' }).theme).toBe('daylight');
    // The stored-theme-survives half: anyone who already chose Midnight keeps it across the flip.
    expect(clampSettings({ theme: 'midnight' }).theme).toBe('midnight');
  });

  /**
   * Read as source for the same reason `content-width-style.test.ts` does: `client/index.html` is never loaded by any suite. The FIRST `dataset.theme = '<x>'`
   * must sit outside the `try` — inside it, blocked storage or a throwing `JSON.parse` would skip it and paint the `:root` palette (Midnight) instead — and `<x>`
   * must be the default, or a fresh browser paints one theme and React then re-stamps another.
   */
  it('stamps the default in index.html before the try, so a corrupt or blocked store still paints it', () => {
    const html = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const stamp = /dataset\.theme *= *'([^']*)'/.exec(script);

    expect(stamp).not.toBeNull();
    expect(stamp![1]).toBe(DEFAULT_SETTINGS.theme);
    expect(stamp!.index).toBeLessThan(script.indexOf('try {'));
  });

  /**
   * Review Focus 4's pre-paint half, by EXECUTING the inline script against a stub `document` and `localStorage` (a classic script, so `new Function` with those two
   * names as parameters runs it as the browser would). A source-order guard cannot catch a deleted `if (s.theme) r.dataset.theme = s.theme` — and deleting it
   * leaves every other test green while flashing Daylight at everyone who chose Midnight, so the assertion is on the resulting `dataset.theme`.
   */
  describe('the pre-paint script, executed', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8'))?.[1] ?? '';
    const run = (getItem: () => string | null): string | undefined => {
      const documentElement = { dataset: {} as Record<string, string>, style: { setProperty: () => undefined } };
      new Function('document', 'localStorage', script)({ documentElement }, { getItem });
      return documentElement.dataset.theme;
    };

    it('lets a stored theme override the default stamp', () => {
      expect(run(() => JSON.stringify({ theme: 'midnight' }))).toBe('midnight');
    });

    it('paints the default when nothing is stored, the blob is corrupt, or storage throws', () => {
      expect(run(() => null)).toBe('daylight');
      expect(run(() => '{not json')).toBe('daylight');
      expect(run(() => { throw new Error('blocked'); })).toBe('daylight');
    });
  });
});

/* #350 — LIMITS honours a hand-edited value between the stops, so a stop row built from the stops alone had no option for it and selected nothing. */
describe('stopsWith', () => {
  it('returns the stops unchanged when the current value is one of them', () => {
    expect(stopsWith([90, 100, 110, 120], 100)).toEqual([90, 100, 110, 120]);
  });

  it('adds an off-step value in order', () => {
    expect(stopsWith([90, 100, 110, 120], 105)).toEqual([90, 100, 105, 110, 120]);
  });

  it('adds a value past the last stop at the end', () => {
    expect(stopsWith([7, 14, 30, 90], 365)).toEqual([7, 14, 30, 90, 365]);
  });
});
