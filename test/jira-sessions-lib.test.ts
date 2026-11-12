import type { JiraSessionState } from '../shared/jira-sessions';
import type { DashboardRow, JiraLink, JiraSessionsPayload } from '../shared/types';
import { desktopButton, desktopHref, linkedHow, openButtons, primaryIsDesktop, sessionDuration, shortSessionId, surfaceWord, ticketSessions } from '../client/src/lib/jira-sessions';

/**
 * The open buttons' pure rules (Jira sessions spec C2, C3, §7.5): when Desktop may be pressed, which surface leads, and what each button says. One case per
 * Buttons line of spec §12, plus the ties the table leaves to its row order (a Permission wait has no verb; a `desktopOwned` wait is Desktop, not Answer).
 */

function link(over: Partial<JiraLink> = {}): JiraLink {
  return {
    key: 'PAY-131',
    sessionId: 'sess-1',
    how: 'run',
    action: 'execute',
    name: 'PAY-131 execute',
    repo: '/work/pay',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'A ticket', type: 'Task', parentKey: null },
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    ...over
  };
}

const dash = (over: Partial<DashboardRow> = {}): DashboardRow => ({ id: 'sess-1', status: 'idle', surface: 'dashboard', ...over });
const local = (over: Partial<DashboardRow> = {}): DashboardRow => ({ id: 'sess-1', status: 'idle', surface: 'local', ...over });

const DASH_TITLE = 'Still running — open it in the Dashboard';
const LOCAL_TITLE = 'Still running in a terminal or the app';

const buttons = (row: DashboardRow | null, state: JiraSessionState, over: { phone?: boolean; wide?: boolean } = {}, l: JiraLink = link()) =>
  openButtons(l, row, state, { phone: false, wide: false, ...over });

describe('desktopHref', () => {
  it('is the app`s resume link, with the id encoded', () => {
    expect(desktopHref('sess-1')).toBe('claude://resume?session=sess-1');
    expect(desktopHref('a b&c')).toBe('claude://resume?session=a%20b%26c');
  });
});

describe('desktopButton (C2)', () => {
  it('dashboard working: disabled, with the Dashboard title', () => {
    expect(desktopButton(dash({ status: 'working' }), null, false)).toEqual({ show: true, enabled: false, via: null, title: DASH_TITLE });
  });

  it.each(['remoteQuestion', 'remotePlan', 'remoteReply'] as const)('dashboard idle but holding a %s: still disabled — a held wait is a process mid-turn', (flag) => {
    expect(desktopButton(dash({ [flag]: true }), null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
  });

  it('dashboard question (no held flag yet) is disabled: the status is not a resting one', () => {
    expect(desktopButton(dash({ status: 'question' }), null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
  });

  it('dashboard idle with a stopState: disabled', () => {
    expect(desktopButton(dash({ stopState: 'ready' }), null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
    expect(desktopButton(dash({ stopState: 'stopping' }), null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
  });

  it('dashboard idle with processLive: disabled', () => {
    expect(desktopButton(dash({ processLive: true }), null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
  });

  it('dashboard idle, clean: enabled through the guarded hand-over', () => {
    expect(desktopButton(dash(), null, false)).toEqual({ show: true, enabled: true, via: 'handover', title: null });
  });

  it('dashboard incomplete, clean: enabled through the guarded hand-over', () => {
    expect(desktopButton(dash({ status: 'incomplete' }), null, false)).toEqual({ show: true, enabled: true, via: 'handover', title: null });
  });

  it('dashboard incomplete with a stopState or processLive: disabled', () => {
    expect(desktopButton(dash({ status: 'incomplete', stopState: 'ready' }), null, false).enabled).toBe(false);
    expect(desktopButton(dash({ status: 'incomplete', processLive: true }), null, false).enabled).toBe(false);
  });

  it('desktopOwned: enabled as the plain href whatever the status — the app already owns it', () => {
    for (const status of ['working', 'question', 'idle']) {
      expect(desktopButton(dash({ desktopOwned: true, status }), null, false)).toEqual({ show: true, enabled: true, via: 'href', title: null });
    }
  });

  it('a row with an unknown status or no surface is judged as a dashboard session, and an unknown status is not resting', () => {
    expect(desktopButton({ id: 's', status: 'unknown' }, null, false)).toMatchObject({ enabled: false, title: DASH_TITLE });
    expect(desktopButton({ id: 's', status: 'idle' }, null, false)).toMatchObject({ enabled: true, via: 'handover' });
  });

  it.each(['working', 'question'])('local %s: disabled, with the terminal-or-app title', (status) => {
    expect(desktopButton(local({ status }), null, false)).toEqual({ show: true, enabled: false, via: null, title: LOCAL_TITLE });
  });

  it('local idle and incomplete: enabled as the plain href', () => {
    expect(desktopButton(local(), null, false)).toEqual({ show: true, enabled: true, via: 'href', title: null });
    expect(desktopButton(local({ status: 'incomplete' }), null, false)).toEqual({ show: true, enabled: true, via: 'href', title: null });
  });

  it('a local row is judged by its status alone: stopState and processLive do not matter to it', () => {
    expect(desktopButton(local({ processLive: true }), null, false).enabled).toBe(true);
  });

  it('a phone hides the button whatever the row says', () => {
    expect(desktopButton(dash(), null, true)).toEqual({ show: false, enabled: false, via: null, title: null });
    expect(desktopButton(local({ status: 'working' }), null, true)).toEqual({ show: false, enabled: false, via: null, title: null });
    expect(desktopButton(dash({ desktopOwned: true }), null, true).show).toBe(false);
  });
});

describe('appOwned: a local row Run ▾ launched in Desktop', () => {
  it.each(['working', 'question', 'idle', 'incomplete'])('local %s launched in Desktop: enabled as the href, like desktopOwned', (status) => {
    expect(desktopButton(local({ status }), 'desktop', false)).toEqual({ show: true, enabled: true, via: 'href', title: null });
    expect(primaryIsDesktop(local({ status }), 'desktop')).toBe(true);
  });

  it('a local row launched from the dashboard or never launched here keeps the stricter terminal-or-app reading', () => {
    expect(desktopButton(local({ status: 'working' }), 'dashboard', false)).toMatchObject({ enabled: false, title: LOCAL_TITLE });
    expect(desktopButton(local({ status: 'working' }), null, false)).toMatchObject({ enabled: false, title: LOCAL_TITLE });
  });

  // A session started in the desktop app and found by its branch (or linked by hand) carries no launch. The dashboard flags a `local` row the app lists
  // `desktopOwned`, so it reads as Desktop on its own — the Where line, the primary and an enabled Open in Desktop mid-turn.
  it.each(['working', 'question', 'idle', 'incomplete'])('a local %s row the app lists (desktopOwned) is Desktop with no launch', (status) => {
    const row = local({ status, desktopOwned: true });
    expect(desktopButton(row, null, false)).toEqual({ show: true, enabled: true, via: 'href', title: null });
    expect(primaryIsDesktop(row, null)).toBe(true);
    expect(surfaceWord(link({ how: 'branch', surface: null }), row)).toBe('Desktop');
  });

  it('the row outranks the launch: a dashboard row is judged by the dashboard rules whatever Run ▾ launched', () => {
    expect(desktopButton(dash({ status: 'working' }), 'desktop', false)).toMatchObject({ enabled: false, title: DASH_TITLE });
    expect(primaryIsDesktop(dash(), 'desktop')).toBe(false);
  });

  it('a phone still hides it', () => {
    expect(desktopButton(local({ status: 'working' }), 'desktop', true).show).toBe(false);
  });

  it('a permission wait in an app-launched session leads with Open in Desktop, Dashboard second', () => {
    expect(buttons(local({ status: 'question', permissionWait: true }), 'permission', { wide: true }, link({ surface: 'desktop' }))).toEqual({
      primary: { label: 'Open in Desktop', target: 'desktop' },
      secondary: { label: 'Open in Dashboard', target: 'dashboard' }
    });
  });

  it('its Where reads Desktop', () => {
    expect(surfaceWord(link({ surface: 'desktop' }), local({ status: 'working' }))).toBe('Desktop');
    expect(surfaceWord(link({ surface: null }), local({ status: 'working' }))).toBe('Terminal or app');
  });
});

describe('primaryIsDesktop (C3)', () => {
  it('desktopOwned leads with Desktop', () => {
    expect(primaryIsDesktop(dash({ desktopOwned: true, status: 'working' }), null)).toBe(true);
  });

  it('local idle leads with Desktop; local working or question promotes Dashboard', () => {
    expect(primaryIsDesktop(local(), null)).toBe(true);
    expect(primaryIsDesktop(local({ status: 'working' }), null)).toBe(false);
    expect(primaryIsDesktop(local({ status: 'question' }), null)).toBe(false);
  });

  it('a plain dashboard session leads with Dashboard even when its Desktop is enabled', () => {
    expect(desktopButton(dash(), null, false).enabled).toBe(true);
    expect(primaryIsDesktop(dash(), null)).toBe(false);
  });
});

describe('openButtons (§7.5)', () => {
  it('dashboard, not desktopOwned: answer, plan and reply each give their own primary, Desktop as the secondary', () => {
    expect(buttons(dash({ status: 'question' }), 'answer')).toEqual({
      primary: { label: 'Answer in Dashboard', target: 'dashboard' },
      secondary: { label: 'Desktop', target: 'desktop' }
    });
    expect(buttons(dash({ status: 'question', remotePlan: true }), 'plan').primary.label).toBe('Review plan in Dashboard');
    expect(buttons(dash({ status: 'question', remoteReply: true }), 'reply').primary.label).toBe('Reply in Dashboard');
  });

  it('a Permission wait gets no verb', () => {
    expect(buttons(dash({ status: 'question', permissionWait: true }), 'permission').primary).toEqual({ label: 'Open in Dashboard', target: 'dashboard' });
  });

  it('dashboard working, quiet and lost: Open in Dashboard, with Desktop (disabled by desktopButton, label kept) beside it', () => {
    for (const state of ['working', 'quiet', 'lost'] as const) {
      expect(buttons(dash({ status: 'working' }), state)).toEqual({
        primary: { label: 'Open in Dashboard', target: 'dashboard' },
        secondary: { label: 'Desktop', target: 'desktop' }
      });
    }
  });

  it('a desktopOwned session in a question is Open in Desktop, not Answer in Dashboard', () => {
    expect(buttons(dash({ status: 'question', desktopOwned: true }), 'answer')).toEqual({
      primary: { label: 'Open in Desktop', target: 'desktop' },
      secondary: { label: 'Dashboard', target: 'dashboard' }
    });
  });

  it('local working: Desktop is disabled, so Dashboard is promoted — with no verb, a local wait can be answered only where it runs', () => {
    expect(buttons(local({ status: 'working' }), 'working').primary).toEqual({ label: 'Open in Dashboard', target: 'dashboard' });
    expect(buttons(local({ status: 'question' }), 'answer').primary).toEqual({ label: 'Open in Dashboard', target: 'dashboard' });
    expect(buttons(local({ status: 'question', remotePlan: true }), 'plan').primary.label).toBe('Open in Dashboard');
    expect(buttons(local({ status: 'question' }), 'answer').secondary).toEqual({ label: 'Desktop', target: 'desktop' });
  });

  it('local idle: Open in Desktop leads, Dashboard follows', () => {
    expect(buttons(local(), 'quiet')).toEqual({
      primary: { label: 'Open in Desktop', target: 'desktop' },
      secondary: { label: 'Dashboard', target: 'dashboard' }
    });
  });

  it('wide spells the secondary out, in both directions', () => {
    expect(buttons(local(), 'quiet', { wide: true }).secondary?.label).toBe('Open in Dashboard');
    expect(buttons(dash({ status: 'working' }), 'working', { wide: true }).secondary?.label).toBe('Open in Desktop');
  });

  it('a phone has no Desktop: Dashboard leads and nothing follows, even for a session whose surface is Desktop', () => {
    expect(buttons(local(), 'quiet', { phone: true })).toEqual({ primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: null });
    expect(buttons(dash({ desktopOwned: true }), 'working', { phone: true })).toEqual({
      primary: { label: 'Open in Dashboard', target: 'dashboard' },
      secondary: null
    });
    expect(buttons(dash({ status: 'question' }), 'answer', { phone: true })).toEqual({
      primary: { label: 'Answer in Dashboard', target: 'dashboard' },
      secondary: null
    });
  });

  it('a live link with no row can say only Open in Dashboard', () => {
    expect(buttons(null, 'quiet')).toEqual({ primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: null });
    expect(buttons(null, 'starting', {}, link({ sessionId: null }))).toEqual({ primary: { label: 'Open in Dashboard', target: 'dashboard' }, secondary: null });
  });

  describe('ended', () => {
    const ended = (surface: JiraLink['surface']) => link({ surface, endedAt: new Date().toISOString(), endReason: 'idle' });

    it('is Reopen alone, whatever the row would have said', () => {
      expect(buttons(dash({ status: 'question' }), 'ended', {}, ended('dashboard'))).toEqual({ primary: { label: 'Reopen', target: 'dashboard' }, secondary: null });
    });

    it('with no row, the link`s own surface picks the target: dashboard → Dashboard, desktop → Desktop, none → Desktop', () => {
      expect(buttons(null, 'ended', {}, ended('dashboard')).primary).toEqual({ label: 'Reopen', target: 'dashboard' });
      expect(buttons(null, 'ended', {}, ended('desktop')).primary).toEqual({ label: 'Reopen', target: 'desktop' });
      expect(buttons(null, 'ended', {}, ended(null)).primary).toEqual({ label: 'Reopen', target: 'desktop' });
    });

    it('on a phone Desktop is hidden, so Reopen targets Dashboard', () => {
      expect(buttons(null, 'ended', { phone: true }, ended('desktop'))).toEqual({ primary: { label: 'Reopen', target: 'dashboard' }, secondary: null });
    });
  });
});

describe('Detail’s pure readings (Jira sessions spec §7.3)', () => {
  const entry = (over: Partial<JiraLink> = {}): JiraSessionsPayload['links'][number] => ({ ...link(over), state: 'working', row: null, stateSince: new Date().toISOString() });
  const at = (m: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0) + m * 60_000).toISOString();

  it('ticketSessions keeps one key’s links, live newest-started first and ended newest-ended first, and tolerates no payload', () => {
    const payload: JiraSessionsPayload = {
      links: [
        entry({ sessionId: 'a', startedAt: at(0) }),
        entry({ sessionId: 'b', startedAt: at(30) }),
        entry({ sessionId: 'c', key: 'PAY-2', startedAt: at(60) }),
        entry({ sessionId: 'd', startedAt: at(0), endedAt: at(10) }),
        entry({ sessionId: 'e', startedAt: at(0), endedAt: at(20) })
      ],
      reachable: true,
      rowsAt: null
    };
    const { live, ended } = ticketSessions('PAY-131', payload);
    expect(live.map((l) => l.sessionId)).toEqual(['b', 'a']);
    expect(ended.map((l) => l.sessionId)).toEqual(['e', 'd']);
    expect(ticketSessions('PAY-131', null)).toEqual({ live: [], ended: [] });
  });

  it('shortSessionId keeps the first and last four of a long id and a short one whole', () => {
    expect(shortSessionId('0123456789abcdef')).toBe('0123…cdef');
    expect(shortSessionId('abc')).toBe('abc');
    expect(shortSessionId('123456789')).toBe('123456789');
  });

  it('sessionDuration is the span start → end, `<1m` under a minute, and null while live', () => {
    expect(sessionDuration({ startedAt: at(0), endedAt: at(135) })).toBe('2h');
    expect(sessionDuration({ startedAt: at(0), endedAt: at(0) })).toBe('<1m');
    expect(sessionDuration({ startedAt: at(0), endedAt: null })).toBeNull();
  });

  it('linkedHow and surfaceWord say how and where, the row’s word beating the link’s own surface', () => {
    expect(linkedHow('run')).toBe('started by Run');
    expect(linkedHow('branch')).toBe('found by its branch');
    expect(linkedHow('manual')).toBe('linked by hand');
    const row = (over: Partial<DashboardRow>): DashboardRow => ({ id: 's', status: 'busy', ...over });
    expect(surfaceWord(link({ surface: 'dashboard' }), row({ desktopOwned: true }))).toBe('Desktop');
    expect(surfaceWord(link({ surface: 'dashboard' }), row({ surface: 'local' }))).toBe('Terminal or app');
    expect(surfaceWord(link({ surface: 'desktop' }), row({ surface: 'dashboard' }))).toBe('Dashboard');
    expect(surfaceWord(link({ surface: 'dashboard' }), row({ surface: 'cloud' }))).toBe('Cloud');
    expect(surfaceWord(link({ surface: 'desktop' }), null)).toBe('Desktop');
    expect(surfaceWord(link({ surface: null }), null)).toBeNull();
  });
});
