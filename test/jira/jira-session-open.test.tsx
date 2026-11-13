/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { useRef, useState } from 'react';

import { SessionOpen } from '../../client/src/components/jira/SessionOpen';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { DESKTOP_BUSY_DASHBOARD_TITLE, type OpenButtons } from '../../client/src/lib/jira-sessions';
import type { JiraSessionState } from '../../shared/jira-sessions';
import type { DashboardRow } from '../../shared/types';

/*
  SessionOpen — the split Open (spec §4.5), the ninth Popover composer. Rendered straight, with `buttons` handed in as `openButtons` would answer, so each
  case names the one thing it is about: when the menu exists, which half is ink, what a row does, and where focus goes.
*/

const BOTH: OpenButtons = { primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: { label: 'Desktop', target: 'desktop' } };
const ALONE: OpenButtons = { primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: null };
/** Resting and unsignalled: C2 lets the dashboard hand it over, so Desktop is an enabled press, not a link. */
const RESTING: DashboardRow = { id: 's1', status: 'idle', surface: 'dashboard' };
/** A process that is still live: C2 disables Desktop with its title. */
const LIVE: DashboardRow = { id: 's1', status: 'busy', surface: 'dashboard', processLive: true };

function mount(over: Partial<Parameters<typeof SessionOpen>[0]> = {}, state: JiraSessionState = 'working') {
  const props = {
    issueKey: 'PAY-1',
    sessionId: 's1',
    row: RESTING,
    launch: 'dashboard' as const,
    state,
    buttons: BOTH,
    onHandover: jest.fn(),
    ...over
  };
  return { props, ...render(<SettingsProvider><SessionOpen {...props} /></SettingsProvider>) };
}
/**
 * The card around the control, as `JiraSessionCard` draws it: an `article` that can take focus, handed down as `cardRef`, and the parent's Stop that turns
 * `busy` on — which is what disables the chevron, and so what made an accepted Stop drop the focus to the page (#475).
 */
function InCard(props: Omit<Parameters<typeof SessionOpen>[0], 'busy' | 'onStop' | 'cardRef'> & { onStop: (id: string) => void }) {
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <article ref={card} tabIndex={-1} aria-label="Session s1">
      <SessionOpen
        {...props}
        cardRef={card}
        busy={busy}
        onStop={(id) => {
          setBusy(true);
          props.onStop(id);
        }}
      />
    </article>
  );
}
function mountInCard(buttons: OpenButtons = BOTH) {
  const onStop = jest.fn();
  const props = { issueKey: 'PAY-1', sessionId: 's1', row: RESTING, launch: 'dashboard' as const, state: 'working' as const, buttons, onHandover: jest.fn(), onStop };
  return { onStop, ...render(<SettingsProvider><InCard {...props} /></SettingsProvider>) };
}
const more = (): HTMLElement => screen.getByRole('button', { name: 'More for PAY-1' });
const menu = (): HTMLElement => screen.getByRole('dialog', { name: 'Session actions' });

describe('SessionOpen', () => {
  it('with no rows to offer is today\'s single Open, and has no chevron', () => {
    mount({ buttons: ALONE });
    expect(screen.getByRole('link', { name: 'Open in Dashboard' })).toHaveAttribute('href', expect.stringContaining('session=s1'));
    expect(screen.queryByRole('button', { name: 'More for PAY-1' })).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('with only a secondary draws the split, whose menu holds that secondary', async () => {
    const { props } = mount();
    expect(screen.getByRole('group')).toHaveClass('ui-split');
    expect(screen.getByRole('link', { name: 'Open in Dashboard' })).toHaveAttribute('target', '_blank');
    await userEvent.click(more());
    // A resting dashboard session: Desktop is a handover press.
    await userEvent.click(within(menu()).getByRole('button', { name: 'Desktop' }));
    expect(props.onHandover).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('dialog', { name: 'Session actions' })).toBeNull();
  });

  it('is ink when a person is wanted and outline when the session is just working', () => {
    const waiting = mount({}, 'plan');
    expect(screen.getByRole('group')).not.toHaveClass('ui-split-outline');
    waiting.unmount();
    mount({}, 'working');
    expect(screen.getByRole('group')).toHaveClass('ui-split-outline');
  });

  it('a lone Open (no menu behind it) is ink only while a person is wanted, never because it is alone', () => {
    const lone = mount({ buttons: ALONE }, 'working');
    expect(screen.getByRole('link', { name: 'Open in Dashboard' })).toHaveClass('ui-chip-outline');
    lone.unmount();
    mount({ buttons: ALONE }, 'plan');
    expect(screen.getByRole('link', { name: 'Open in Dashboard' })).toHaveClass('ui-chip-ink');
  });

  it('Unlink calls onUnlink once with the session id, and closes the menu', async () => {
    const onUnlink = jest.fn();
    mount({ buttons: ALONE, onUnlink });
    await userEvent.click(more());
    await userEvent.click(within(menu()).getByRole('button', { name: 'Unlink' }));
    expect(onUnlink.mock.calls).toEqual([['s1']]);
    expect(screen.queryByRole('dialog', { name: 'Session actions' })).toBeNull();
  });

  it('Stop session swaps the split for the confirmation; Stop there calls onStop once, Keep running restores the split', async () => {
    const onStop = jest.fn();
    mount({ onStop });
    await userEvent.click(more());
    await userEvent.click(within(menu()).getByRole('button', { name: 'Stop session' }));
    expect(screen.getByTestId('jira-stop-confirm')).toBeInTheDocument();
    expect(document.querySelector('.ui-split')).toBeNull();
    await userEvent.click(screen.getByTestId('jira-stop-confirm-dismiss'));
    expect(screen.queryByTestId('jira-stop-confirm')).toBeNull();
    expect(document.querySelector('.ui-split')).not.toBeNull();
    expect(more()).toHaveFocus();
    expect(onStop).not.toHaveBeenCalled();

    await userEvent.click(more());
    await userEvent.click(within(menu()).getByRole('button', { name: 'Stop session' }));
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
    expect(onStop.mock.calls).toEqual([['s1']]);
  });

  it('an accepted Stop leaves the chevron disabled and puts the focus on the card, not the page (#475)', async () => {
    const { onStop } = mountInCard();
    await userEvent.click(more());
    await userEvent.click(within(menu()).getByRole('button', { name: 'Stop session' }));
    await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
    expect(onStop.mock.calls).toEqual([['s1']]);
    expect(more()).toBeDisabled();
    expect(screen.getByRole('article', { name: 'Session s1' })).toHaveFocus();
  });

  it('focuses the first enabled row on open, and Escape closes the menu and focuses the chevron', async () => {
    mount({ row: LIVE, onUnlink: jest.fn() });
    await userEvent.click(more());
    // The Desktop row is disabled for a live process, so the first ENABLED row is Unlink.
    expect(within(menu()).getByRole('button', { name: 'Unlink' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Session actions' })).toBeNull();
    expect(more()).toHaveFocus();
  });

  it('draws a disabled Desktop secondary as an aria-disabled row carrying C2\'s title', async () => {
    const { props } = mount({ row: LIVE });
    await userEvent.click(more());
    const row = within(menu()).getByRole('button', { name: 'Desktop' });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAttribute('title', DESKTOP_BUSY_DASHBOARD_TITLE);
    await userEvent.click(row);
    expect(props.onHandover).not.toHaveBeenCalled();
  });

  it('busy disables both halves', () => {
    mount({ busy: true });
    expect(more()).toBeDisabled();
    expect(within(screen.getByRole('group')).getByRole('button', { name: 'Open in Dashboard' })).toBeDisabled();
  });

  describe('with no Open to show (a phone answers Desktop-only as nothing)', () => {
    const DESKTOP_ONLY: OpenButtons = { primary: { label: 'Open in Desktop', target: 'desktop' }, secondary: null };
    const original = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = original;
    });

    it('still offers Unlink as a plain chip, with no split', async () => {
      const onUnlink = jest.fn();
      mount({ buttons: DESKTOP_ONLY, onUnlink });
      expect(document.querySelector('.ui-split')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
      expect(onUnlink.mock.calls).toEqual([['s1']]);
    });

    it('still offers Stop behind its Confirm, and renders nothing with no rows either', async () => {
      const onStop = jest.fn();
      const first = mount({ buttons: DESKTOP_ONLY, onStop });
      await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
      await userEvent.click(within(screen.getByTestId('jira-stop-confirm')).getByRole('button', { name: 'Stop session' }));
      expect(onStop.mock.calls).toEqual([['s1']]);
      first.unmount();
      expect(mount({ buttons: DESKTOP_ONLY }).container).toBeEmptyDOMElement();
    });

    it('an accepted Stop puts the focus on the card, since the Stop chip it replaced is disabled by then (#475)', async () => {
      const { onStop } = mountInCard(DESKTOP_ONLY);
      await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
      await userEvent.click(screen.getByTestId('jira-stop-confirm-accept'));
      expect(onStop.mock.calls).toEqual([['s1']]);
      expect(screen.getByRole('button', { name: 'Stop session' })).toBeDisabled();
      expect(screen.getByRole('article', { name: 'Session s1' })).toHaveFocus();
    });
  });
});
