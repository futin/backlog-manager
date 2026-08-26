import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_HUES, buildProjectHues, pillClass, projectHueIndex } from '../client/src/lib/project-hue';
import { THEMES } from '../client/src/lib/settings';

describe('project hue', () => {
  it('is stable for a given name', () => {
    // The intrinsic half of the promise: a name's preference depends on
    // nothing but the name — not on time, not on what else is registered.
    expect(projectHueIndex('backlog-manager')).toBe(projectHueIndex('backlog-manager'));
    expect(projectHueIndex('guide-manager')).toBe(projectHueIndex('guide-manager'));
  });

  it('pins the preference for known names', () => {
    // Deliberately hard-coded rather than recomputed from the implementation:
    // this is the test that turns "changed the hash" into a red build. These
    // values are visible state — a user knows backlog-manager as the violet
    // one — so a "harmless" refactor of fnv1a has to be a deliberate decision.
    expect(projectHueIndex('backlog-manager')).toBe(7);
    expect(projectHueIndex('guide-manager')).toBe(2);
    expect(projectHueIndex('alpha')).toBe(4);
    expect(projectHueIndex('beta')).toBe(8);
  });

  it('stays inside the token range for anything a registry can hold', () => {
    // A registry name is a git-root basename, so it is short and ASCII in
    // practice — but the modulo has to hold for the long, the empty and the
    // non-ASCII too, because an out-of-range index is a pill with no colour at
    // all rather than a visible failure.
    const names = ['', 'a', 'x'.repeat(500), 'проект', '🙂-repo', 'A', 'a-b-c-d-e-f'];
    for (const name of names) {
      const index = projectHueIndex(name);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(PROJECT_HUES);
    }
  });

  it('spreads a handful of realistic names across more than one hue', () => {
    // Not a distribution proof — with 8 buckets and 6 names, collisions are
    // expected. This only catches the degenerate hash (every name lands on one
    // bucket), which would ship as "the colours feature does nothing".
    const names = ['backlog-manager', 'guide-manager', 'claude-agents-dashboard', 'api', 'web', 'infra'];
    const used = new Set(names.map(projectHueIndex));
    expect(used.size).toBeGreaterThan(1);
  });
});

/** Registry rows in registration order; createdAt is what the sort reads. */
function registry(...names: string[]) {
  return names.map((name, i) => ({
    name,
    path: `/abs/${name}`,
    createdAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`
  }));
}

describe('buildProjectHues', () => {
  it('gives each project its preferred hue when nothing has taken it', () => {
    const hues = buildProjectHues(registry('backlog-manager', 'ixray'));
    expect(hues.classFor('backlog-manager')).toBe(pillClass(projectHueIndex('backlog-manager')));
    expect(hues.classFor('ixray')).toBe(pillClass(projectHueIndex('ixray')));
  });

  it('probes past a collision instead of doubling up', () => {
    // The case that forced the design: on the first real registry this ran
    // against, these two names hash to the same preference. Asserting the
    // shared preference first means this test still describes a collision if
    // the palette size ever changes and the two happen to separate on their
    // own.
    expect(projectHueIndex('guide-manager')).toBe(projectHueIndex('claude-agents-dashboard'));
    const hues = buildProjectHues(registry('guide-manager', 'claude-agents-dashboard'));
    expect(hues.classFor('guide-manager')).not.toBe(hues.classFor('claude-agents-dashboard'));
    // The earlier registration is the one that keeps its preference.
    expect(hues.classFor('guide-manager')).toBe(pillClass(projectHueIndex('guide-manager')));
  });

  it('leaves every existing project where it was when a new one registers', () => {
    // Static means static: registering a project must never repaint the board.
    // The registry only ever grows (registerProject upserts, never removes),
    // so this is the only churn that has to be safe — and it is safe precisely
    // because the sort is by createdAt and the newcomer is always last.
    const before = buildProjectHues(registry('guide-manager', 'claude-agents-dashboard', 'ixray'));
    const after = buildProjectHues(
      registry('guide-manager', 'claude-agents-dashboard', 'ixray', 'finance-manager')
    );
    for (const name of ['guide-manager', 'claude-agents-dashboard', 'ixray']) {
      expect(after.classFor(name)).toBe(before.classFor(name));
    }
  });

  it('orders by createdAt, not by the array it was handed', () => {
    // A registry.json reordered by hand (or an API that stopped preserving
    // order) must not repaint anything, because createdAt is the field that
    // actually records first registration.
    const rows = registry('guide-manager', 'claude-agents-dashboard');
    const forwards = buildProjectHues(rows);
    const backwards = buildProjectHues([...rows].reverse());
    expect(backwards.classFor('guide-manager')).toBe(forwards.classFor('guide-manager'));
    expect(backwards.classFor('claude-agents-dashboard'))
      .toBe(forwards.classFor('claude-agents-dashboard'));
  });

  it('uses every hue before repeating one', () => {
    const names = Array.from({ length: PROJECT_HUES }, (_, i) => `project-${i}`);
    const hues = buildProjectHues(registry(...names));
    expect(new Set(names.map((n) => hues.classFor(n))).size).toBe(PROJECT_HUES);
  });

  it('falls back to the raw preference once the palette is full', () => {
    // A registry larger than the palette has to share somewhere. Sharing on
    // the newcomer's OWN colour is the least surprising place to do it — the
    // alternative is a hue picked by whatever the probe happened to land on.
    const names = Array.from({ length: PROJECT_HUES }, (_, i) => `project-${i}`);
    const hues = buildProjectHues(registry(...names, 'one-too-many'));
    expect(hues.classFor('one-too-many')).toBe(pillClass(projectHueIndex('one-too-many')));
  });

  it('gives two checkouts of one repo the same hue', () => {
    // They share a name, and the pill can only show the name — two colours
    // under one label would read as a rendering bug.
    const hues = buildProjectHues([
      { name: 'alpha', path: '/one/alpha', createdAt: '2026-08-10T00:00:00.000Z' },
      { name: 'alpha', path: '/two/alpha', createdAt: '2026-08-11T00:00:00.000Z' }
    ]);
    expect(hues.classFor('alpha')).toBe(pillClass(projectHueIndex('alpha')));
  });

  it('falls back to the preference for a project it was never told about', () => {
    // The window where /api/items has answered and /api/projects has not: a
    // card still needs a colour, and the preference is the right one.
    const hues = buildProjectHues([]);
    expect(hues.classFor('ixray')).toBe(pillClass(projectHueIndex('ixray')));
  });
});

describe('shared/theme.css', () => {
  const css = readFileSync(join(__dirname, '..', 'shared', 'theme.css'), 'utf8');

  it.each(THEMES.map((t) => t.id))('defines every --proj-N token for %s', (theme) => {
    // An undefined custom property makes `color: var(--proj-3)` invalid at
    // computed-value time, so the pill silently falls back to inherited ink
    // instead of erroring — exactly the kind of miss that survives review and
    // ships. This is the guard for adding a sixth theme (or a ninth hue) and
    // updating only half of what that takes.
    const selector = theme === 'midnight' ? ':root,[data-theme="midnight"]' : `[data-theme="${theme}"]`;
    // Every block for this theme, concatenated: midnight and the four others
    // each own two (palette, then project hues), and the tokens may sit in
    // either one.
    const blocks = [...css.matchAll(/([^}]*?)\{([^}]*)\}/g)]
      .filter(([, head]) => head.trim().endsWith(selector) || head.trim() === selector)
      .map(([, , body]) => body)
      .join('');
    expect(blocks).not.toBe('');
    for (let n = 1; n <= PROJECT_HUES; n += 1) {
      expect(blocks).toContain(`--proj-${n}:`);
    }
  });
});
