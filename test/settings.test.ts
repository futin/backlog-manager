import { DEFAULT_SETTINGS, FONT_SCALES, THEMES, clampSettings } from '../client/src/lib/settings';

describe('clampSettings', () => {
  it('passes a valid object through', () => {
    const s = clampSettings({ theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects' });
    expect(s).toEqual({
      theme: 'daylight', density: 'compact', fontScale: 110, landing: 'projects',
      linkBase: 'http://127.0.0.1:5174'
    });
  });

  it('falls back per field, independently', () => {
    const s = clampSettings({ theme: 'neon', density: 7, fontScale: 'big', landing: 'guides' });
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
