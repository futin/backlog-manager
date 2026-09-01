import { SECTIONS } from '../client/src/components/SideRail';
import {
  DEFAULT_SETTINGS, FONT_SCALES, LIMITS, STALE_WINDOWS, THEMES, clampSettings
} from '../client/src/lib/settings';
import { EFFORTS, MODELS } from '../shared/agent';

describe('clampSettings', () => {
  it('passes a valid object through', () => {
    const s = clampSettings({
      theme: 'daylight', density: 'compact', fontScale: 110, landing: 'board',
      dispatchDefaultModel: 'sonnet', dispatchDefaultEffort: 'high', staleDays: 14
    });
    expect(s).toEqual({
      theme: 'daylight', density: 'compact', fontScale: 110, landing: 'board',
      linkBase: 'http://127.0.0.1:5174',
      dispatchDefaultModel: 'sonnet', dispatchDefaultEffort: 'high', staleDays: 14
    });
  });

  it('falls back per field, independently', () => {
    const s = clampSettings({
      theme: 'neon', density: 7, fontScale: 'big', landing: 'guides',
      dispatchDefaultModel: 'gpt', dispatchDefaultEffort: 7, staleDays: 'soon'
    });
    expect(s).toEqual(DEFAULT_SETTINGS);
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

  it('falls back to `last` for a section this build no longer has', () => {
    // 'projects' is what the Board tab was called before the rail grew
    // Archive, so it is sitting in real installs' settings blobs. It is not
    // aliased onto 'board' the way App's stored *section* is: a pin this build
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
    expect(clampSettings({ linkBase: 'https://box.ts.net:5174/' }).linkBase)
      .toBe('https://box.ts.net:5174');
  });

  it('refuses a non-http scheme — this value becomes an href', () => {
    expect(clampSettings({ linkBase: 'javascript:alert(1)' }).linkBase)
      .toBe('http://127.0.0.1:5174');
    expect(clampSettings({ linkBase: 'not a url' }).linkBase)
      .toBe('http://127.0.0.1:5174');
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
