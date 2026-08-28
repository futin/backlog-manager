import { DEFAULT_SETTINGS, FONT_SCALES, THEMES, clampSettings } from '../client/src/lib/settings';
import { EFFORTS, MODELS } from '../shared/agent';

describe('clampSettings', () => {
  it('passes a valid object through', () => {
    const s = clampSettings({
      theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects',
      dispatchDefaultModel: 'sonnet', dispatchDefaultEffort: 'high'
    });
    expect(s).toEqual({
      theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects',
      linkBase: 'http://127.0.0.1:5174',
      dispatchDefaultModel: 'sonnet', dispatchDefaultEffort: 'high'
    });
  });

  it('falls back per field, independently', () => {
    const s = clampSettings({
      theme: 'neon', density: 7, fontScale: 'big', landing: 'guides',
      dispatchDefaultModel: 'gpt', dispatchDefaultEffort: 7
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

  it('offers five themes and four font stops (UI contract)', () => {
    expect(THEMES).toHaveLength(5);
    expect(FONT_SCALES).toEqual([90, 100, 110, 120]);
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
