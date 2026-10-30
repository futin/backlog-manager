/**
 * @jest-environment jsdom
 */
import { act, render } from '@testing-library/react';

import { SettingsProvider, useSettings } from '../client/src/hooks/useSettings';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

/*
  A legacy `landing` (`board`/`archive`) is read as `github` by `clampSettings`, but that alias is read-time only (#399): an `update()` that does not name
  `landing` must carry the raw value through, or the first Settings change of a load writes `github` down as a REAL pin before the shell has settled it.
  The provider exposes the raw legacy value as `legacyLanding` until a write to `landing` ends it.
*/
const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');

let control: ReturnType<typeof useSettings>;
function Probe() {
  control = useSettings();
  return null;
}

beforeEach(() => localStorage.clear());

it('an unrelated update keeps a legacy landing; a landing write ends it', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'archive' }));
  render(
    <SettingsProvider>
      <Probe />
    </SettingsProvider>
  );
  expect(control.settings.landing).toBe('github');
  expect(control.legacyLanding).toBe('archive');

  act(() => control.update({ density: 'compact' }));
  expect(stored().landing).toBe('archive');
  expect(stored().density).toBe('compact');
  expect(control.settings.landing).toBe('github');
  expect(control.legacyLanding).toBe('archive');

  act(() => control.update({ landing: 'runs' }));
  expect(stored().landing).toBe('runs');
  expect(control.settings.landing).toBe('runs');
  expect(control.legacyLanding).toBeNull();
});

it('a current landing reads no legacy value, and outside a provider there is none', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ landing: 'files' }));
  render(
    <SettingsProvider>
      <Probe />
    </SettingsProvider>
  );
  expect(control.legacyLanding).toBeNull();

  render(<Probe />);
  expect(control.legacyLanding).toBeNull();
});
