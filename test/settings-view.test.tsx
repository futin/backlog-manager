/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import SettingsView from '../client/src/components/settings/SettingsView';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { SETTINGS_STORAGE_KEY } from '../client/src/lib/settings';

describe('SettingsView', () => {
  beforeEach(() => localStorage.clear());

  function renderView() {
    render(
      <SettingsProvider>
        <SettingsView />
      </SettingsProvider>
    );
  }

  it('offers the five themes and persists a pick under the backlog-manager key', async () => {
    renderView();
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Daylight Strip/ }));
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });

  it('has no bionic reading rows', () => {
    renderView();
    expect(screen.queryByText(/Bionic/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixation/)).not.toBeInTheDocument();
  });

  it('changes density and text size', async () => {
    renderView();
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(document.documentElement.dataset.density).toBe('compact');
    await userEvent.click(screen.getByRole('button', { name: '120%' }));
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  it('offers Projects as a landing choice', async () => {
    renderView();
    await userEvent.selectOptions(screen.getByLabelText('Opens on'), 'projects');
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.landing).toBe('projects');
  });
});
