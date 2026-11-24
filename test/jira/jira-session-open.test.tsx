/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useRef, useState } from 'react';

import { JiraSessionCard } from '../../client/src/components/jira/JiraSessionCard';
import { SessionOpen } from '../../client/src/components/jira/SessionOpen';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { DESKTOP_BUSY_DASHBOARD_TITLE, type OpenButtons } from '../../client/src/lib/jira-sessions';
import type { JiraSessionState } from '../../shared/jira-sessions';
import type { DashboardRow, JiraSessionsPayload } from '../../shared/types';

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

/*
  #478: the split and the plain path draw ONE confirmation (`StopConfirm`), and `SessionOpen.tsx` no longer imports back from `JiraSessionCard.tsx` — `OpenChip`
  moved here, so the dependency runs one way.
*/
describe('SessionOpen cleanup (#478)', () => {
  const STOP_SENTENCE = 'Stop this session? It ends mid-work; its edits stay where it left them.';
  const confirmFacts = (): { text: string; buttons: string[] } => {
    const box = screen.getByTestId('jira-stop-confirm');
    return { text: box.textContent ?? '', buttons: within(box).getAllByRole('button').map((b) => b.textContent ?? '') };
  };

  it('both Stop paths draw the same confirmation', async () => {
    const split = mount({ onStop: jest.fn() });
    await userEvent.click(more());
    await userEvent.click(within(menu()).getByRole('button', { name: 'Stop session' }));
    const fromSplit = confirmFacts();
    split.unmount();

    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      mount({ buttons: { primary: { label: 'Open in Desktop', target: 'desktop' }, secondary: null }, onStop: jest.fn() });
      expect(document.querySelector('.ui-split')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
      const fromPlain = confirmFacts();
      expect(fromPlain).toEqual(fromSplit);
    } finally {
      window.matchMedia = original;
    }
    expect(fromSplit.text).toContain(STOP_SENTENCE);
    expect(fromSplit.buttons).toEqual(expect.arrayContaining(['Stop session', 'Keep running']));
  });

  it('has no import cycle: SessionOpen.tsx imports nothing from JiraSessionCard, and OpenChip is defined there alone', () => {
    const dir = join(__dirname, '../../client/src/components/jira');
    const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
    const sessionOpen = read('SessionOpen.tsx');
    expect(sessionOpen).not.toMatch(/from '\.\/JiraSessionCard'/);
    expect(sessionOpen).toMatch(/export function OpenChip\(/);
    expect(read('JiraSessionCard.tsx')).not.toMatch(/function OpenChip\(/);
    expect(read('JiraCard.tsx')).toMatch(/import \{ OpenChip, SessionOpen \} from '\.\/SessionOpen'/);
    // One Confirm in the file, inside StopConfirm: the two copies cannot drift apart again.
    expect(sessionOpen.match(/<Confirm\b/g)).toHaveLength(1);
    expect(sessionOpen.match(/jira-stop-confirm/g)).toHaveLength(1);
  });
});

/*
  #611: the card carries the same `Subagents` disclosure as a run's item row, under its facts — only while the dashboard has agents on, which is the same
  `agentsOn` the card already takes for its Stop row. Closed, it fetches nothing, so no fetch stub is needed to see whether it is drawn.
*/
describe('JiraSessionCard — subagents (#611)', () => {
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  function card(agentsOn: boolean) {
    const link: JiraSessionsPayload['links'][number] = {
      key: 'PAY-131',
      sessionId: 's1',
      how: 'run',
      action: 'context',
      name: 'jira PAY-131',
      repo: '/Users/ada/pay',
      branch: null,
      surface: 'dashboard',
      model: null,
      effort: null,
      snapshot: { summary: 'Refund partial captures', type: 'Story', parentKey: null },
      startedAt: ago(3_600_000),
      endedAt: null,
      endReason: null,
      quietSince: null,
      reattachedAt: null,
      state: 'working',
      row: null,
      stateSince: ago(3_600_000)
    };
    return render(
      <SettingsProvider>
        <JiraSessionCard link={link} now={Date.now()} busy={false} onUnlink={() => {}} onStop={() => {}} agentsOn={agentsOn} />
      </SettingsProvider>
    );
  }

  it('5. draws the Subagents button while agents are on, and none while they are off', () => {
    const on = card(true);
    expect(within(screen.getByRole('article')).getByRole('button', { name: 'Subagents' })).toBeInTheDocument();
    on.unmount();
    card(false);
    expect(screen.queryByRole('button', { name: 'Subagents' })).toBeNull();
  });
});
