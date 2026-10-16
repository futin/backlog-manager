/**
 * @jest-environment jsdom
 */
import {
  LAST_SEEN_KEY,
  TYPE_LABEL,
  chipLabel,
  compareVersions,
  displayTitle,
  dotState,
  formatReleaseDate,
  isVersion,
  readLastSeen,
  writeLastSeen
} from '../client/src/lib/releases';

// jsdom because the storage helpers read the real `localStorage`; everything else here is pure.

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

describe('compareVersions', () => {
  it('orders each part numerically, so 0.10.0 is above 0.9.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
  });
});

describe('isVersion', () => {
  it('accepts a bare X.Y.Z and nothing else', () => {
    expect(isVersion('0.2.0')).toBe(true);
    expect(isVersion('v0.2.0')).toBe(false);
    expect(isVersion('0.2')).toBe(false);
    expect(isVersion('garbage')).toBe(false);
    expect(isVersion(null)).toBe(false);
    expect(isVersion(3)).toBe(false);
  });
});

describe('chipLabel', () => {
  it('is the version on the tag, and +N commits past it', () => {
    expect(chipLabel({ version: '0.2.0', ahead: 0 })).toBe('v0.2.0');
    expect(chipLabel({ version: '0.2.0', ahead: 3 })).toBe('v0.2.0+3');
  });
});

describe('displayTitle', () => {
  it('drops the type(scope)!: prefix the badge already says, and leaves a title without one alone', () => {
    expect(displayTitle('feat(releases)!: version chip')).toBe('version chip');
    expect(displayTitle('fix: x')).toBe('x');
    expect(displayTitle('Baseline — versioning starts here')).toBe('Baseline — versioning starts here');
  });
});

describe('formatReleaseDate', () => {
  it('is day, short month and year, and shows an unparseable date as it came', () => {
    // Midday UTC, so the viewer's timezone cannot move it to another day.
    expect(formatReleaseDate('2026-10-16T12:00:00+00:00')).toBe('16 Oct 2026');
    expect(formatReleaseDate('soon')).toBe('soon');
  });
});

describe('TYPE_LABEL', () => {
  it('names the three releasing types', () => {
    expect(TYPE_LABEL).toEqual({ feat: 'Feature', fix: 'Fix', perf: 'Performance' });
  });
});

describe('dotState', () => {
  it('seeds the newest on a first visit, and on junk, with no dot', () => {
    expect(dotState('0.2.0', null, false)).toEqual({ dot: false, seed: '0.2.0' });
    expect(dotState('0.2.0', 'garbage', false)).toEqual({ dot: false, seed: '0.2.0' });
  });

  it('dots only when the newest is above the stored version', () => {
    expect(dotState('0.2.0', '0.1.0', false)).toEqual({ dot: true, seed: null });
    expect(dotState('0.2.0', '0.2.0', false)).toEqual({ dot: false, seed: null });
    expect(dotState('0.2.0', '0.3.0', false)).toEqual({ dot: false, seed: null });
  });

  it('has nothing to say with no releases', () => {
    expect(dotState(null, '0.1.0', false)).toEqual({ dot: false, seed: null });
    expect(dotState(null, '0.1.0', true)).toEqual({ dot: false, seed: null });
  });

  it('with the drawer open, never dots and marks the newest seen when it is above the stored one or nothing valid is stored', () => {
    expect(dotState('0.2.1', '0.1.0', true)).toEqual({ dot: false, seed: '0.2.1' });
    expect(dotState('0.2.1', null, true)).toEqual({ dot: false, seed: '0.2.1' });
    expect(dotState('0.2.1', 'v0.1.0', true)).toEqual({ dot: false, seed: '0.2.1' });
    expect(dotState('0.2.1', '0.2.1', true)).toEqual({ dot: false, seed: null });
  });

  it('with the drawer open on an older checkout, keeps the higher stored version rather than writing a lower one', () => {
    // Switching to a checkout behind the one last opened must not re-flag the releases between the two once the newer checkout is back.
    expect(dotState('0.2.0', '0.3.0', true)).toEqual({ dot: false, seed: null });
  });
});

describe('readLastSeen / writeLastSeen', () => {
  it('round-trips through localStorage under the board key', () => {
    writeLastSeen('0.2.1');
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBe('0.2.1');
    expect(LAST_SEEN_KEY).toBe('backlog-manager.releases-last-seen');
    expect(readLastSeen()).toBe('0.2.1');
  });

  it('reads a throwing storage as null', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLastSeen()).toBeNull();
  });

  it('swallows a throwing write', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeLastSeen('0.2.1')).not.toThrow();
  });
});
