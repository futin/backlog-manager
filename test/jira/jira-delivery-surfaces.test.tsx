/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ReactNode } from 'react';

import { JiraAgentDeck } from '../../client/src/components/jira/JiraAgentDeck';
import { JiraCard } from '../../client/src/components/jira/JiraCard';
import { JiraIssueList } from '../../client/src/components/jira/JiraIssueList';
import { GitlabContext } from '../../client/src/hooks/GitlabContext';
import { JiraContext } from '../../client/src/hooks/JiraContext';
import { JiraSessionsContext } from '../../client/src/hooks/JiraSessionsContext';
import { SettingsProvider } from '../../client/src/hooks/useSettings';
import { cardFold, foldBoard } from '../../client/src/lib/jira';
import type { DeckEntry } from '../../client/src/lib/jira-deck';
import type { GitlabMr, GitlabPayload, GitlabProjectView, GitlabStatus, JiraBoard, JiraIssue, JiraStatusPayload } from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/**
 * The board's delivery surfaces (GitLab connection spec §7.2 and §7.3; mocks `Cards.dc.html` and `List.dc.html`): the MR chip in a shelf card's marker row and
 * on a deck card, and the List's Delivery column. Each component is rendered alone under the RAW contexts the shell would fill — `GitlabContext` with a
 * payload in hand, so no fetch runs — and every word asserted is `lib/delivery.ts`'s, whose own cases live in `delivery-lib.test.ts`: what this suite owns is
 * WHERE each surface draws it, and that a surface draws nothing it should not. The band's GitLab line is in `jira-board.test.tsx`'s band block.
 *
 * MR stamps are relative to the real clock (the ages are never asserted here); the issues' `created`/`updated` go through `daysAgoStamp` for the fixture-clock
 * guard.
 */

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

function mr(over: Partial<GitlabMr> = {}): GitlabMr {
  const iid = over.iid ?? 412;
  return {
    project: 'development/backend/microservice',
    iid,
    title: `change ${iid}`,
    webUrl: `https://gitlab.example.test/development/backend/microservice/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: `change-${iid}`,
    targetBranch: 'develop',
    createdAt: ago(120),
    updatedAt: ago(30),
    mergedAt: null,
    pipeline: 'success',
    keys: ['TIMIFY-123'],
    ...over
  };
}

const MICRO: GitlabProjectView = { path: 'development/backend/microservice', repo: 'microservice', polledAt: ago(5), capped: false, failed: false };

function gitlabStatus(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'connected',
    site: 'gitlab.example.test',
    malformedSite: false,
    user: { username: 'ada', name: 'Ada' },
    httpStatus: null,
    reason: null,
    armed: true,
    retryAt: null,
    mappedRepos: 1,
    foundHosts: [],
    problems: [],
    ...over
  };
}

function payload(mrs: GitlabMr[], jiraProjects: Record<string, GitlabProjectView[]> = { TIMIFY: [MICRO] }, st: Partial<GitlabStatus> = {}): GitlabPayload {
  return { status: gitlabStatus(st), jiraProjects, mrs };
}

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    id: `id-${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `summary of ${key}`,
    project: { key: key.split('-')[0], name: key.split('-')[0] },
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: null,
    assignee: null,
    reporter: null,
    parent: null,
    subtasks: 0,
    labels: [],
    sprint: null,
    created: daysAgoStamp(10),
    updated: daysAgoStamp(1),
    resolved: null,
    ...over
  };
}

const sub = (key: string, parent: string, over: Partial<JiraIssue> = {}): JiraIssue =>
  issue(key, { type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: parent, summary: `summary of ${parent}` }, ...over });
const done = { status: { name: 'Done', category: 'done' as const } };

function jiraStatus(): JiraStatusPayload {
  return {
    configured: true,
    configUnreadable: null,
    site: 'acme.atlassian.net',
    me: null,
    tokenKind: 'classic',
    access: 'ok',
    detail: null,
    boards: [],
    repos: { TIMIFY: ['/r/timify'], PAY: ['/r/pay'] },
    repoDefaults: {},
    projects: [],
    skills: [],
    calls: { sweep: 0, last429At: null },
    live: {},
    armed: true,
    home: '/home/ada'
  };
}

function shell(data: GitlabPayload | null, children: ReactNode) {
  return render(
    <SettingsProvider>
      <JiraContext.Provider value={{ data: jiraStatus(), loading: false, error: false, reload: jest.fn() }}>
        <JiraSessionsContext.Provider value={{ data: null, reload: jest.fn(() => Promise.resolve()) }}>
          <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>{children}</GitlabContext.Provider>
        </JiraSessionsContext.Provider>
      </JiraContext.Provider>
    </SettingsProvider>
  );
}

const BOARD: JiraBoard = { id: 'b1', name: 'Timify', roots: [], queries: [], interval: '5m' };

/** One shelf card for `top`, folded over `board` (the whole board's issues) as the Board page folds it. */
function drawCard(top: JiraIssue, data: GitlabPayload | null, board: JiraIssue[] = [top]) {
  const fold = foldBoard(board);
  return shell(
    data,
    <JiraCard issue={top} board={BOARD} me={null} now={now} fold={cardFold(top.key, fold)} matches={[]} ended={[]} trees={[]} onOpen={jest.fn()} onRun={jest.fn()} />
  );
}

const markers = (): HTMLElement => screen.getByTestId('marker-row');
const chips = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.jira-mr-chip'));

afterEach(cleanup);

describe('the shelf card’s MR chip', () => {
  it('draws the lead MR in the marker row, before Run ▾', () => {
    drawCard(issue('TIMIFY-123'), payload([mr({ iid: 415, pipeline: 'failed' })]));
    const chip = within(markers()).getByText('!415 · ✕ pipeline failed');
    expect(chip).toHaveAttribute('data-tone', 'red');
    expect(chip).not.toHaveAttribute('title');
    const run = within(markers()).getAllByRole('button')[0];
    // DOCUMENT_POSITION_FOLLOWING: Run ▾ comes after the chip, so the chip ellipsises before Run gives any width.
    expect(chip.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('adds the amber `not merged` chip to a done ticket whose own lead MR is open', () => {
    drawCard(issue('TIMIFY-123', done), payload([mr({ iid: 401 })]));
    expect(within(markers()).getByText('!401 · ✓ pipeline')).toBeInTheDocument();
    expect(within(markers()).getByText('not merged')).toHaveAttribute('data-tone', 'amber');
  });

  it('marks an inherited MR `via <PARENT-KEY>` and never raises `not merged` for it', () => {
    drawCard(sub('TIMIFY-131', 'TIMIFY-100', done), payload([mr({ iid: 401, keys: ['TIMIFY-100'] })]));
    expect(within(markers()).getByText('!401 · ✓ pipeline')).toHaveAttribute('title', 'via TIMIFY-100');
    expect(screen.queryByText('not merged')).toBeNull();
  });

  it('draws nothing for a known ticket with no MR — no chip, and no `no MR` text', () => {
    drawCard(issue('TIMIFY-123'), payload([mr({ keys: ['TIMIFY-999'] })]));
    expect(chips()).toEqual([]);
    expect(screen.queryByText(/no MR/)).toBeNull();
  });

  it('draws nothing on a folded top whose child has an MR and the top none — the card is the top’s own', () => {
    const top = issue('TIMIFY-100');
    const child = sub('TIMIFY-131', 'TIMIFY-100');
    drawCard(top, payload([mr({ iid: 415, keys: ['TIMIFY-131'] })]), [top, child]);
    expect(chips()).toEqual([]);
  });

  it('draws nothing while GitLab is unconfigured, and nothing for a project that maps no GitLab project', () => {
    drawCard(issue('TIMIFY-123'), payload([mr()], {}, { state: 'unconfigured', armed: false }));
    expect(chips()).toEqual([]);
    cleanup();
    drawCard(issue('PAY-120'), payload([mr({ keys: ['PAY-120'] })]));
    expect(chips()).toEqual([]);
  });
});

describe('the deck card’s MR chip', () => {
  it('reads the session’s own ticket — a folded child’s MR, not its top’s', () => {
    const top = issue('TIMIFY-100');
    const child = sub('TIMIFY-131', 'TIMIFY-100');
    const entry: DeckEntry = {
      id: 'TIMIFY-131',
      state: 'starting',
      group: 'other',
      issue: child,
      top,
      link: null,
      starting: { name: 'timify-131', sessionId: null, startedAt: ago(1), repo: '/r/timify', starting: true },
      startedAt: ago(1),
      since: ago(1)
    };
    shell(
      payload([mr({ iid: 401, keys: ['TIMIFY-100'] }), mr({ iid: 415, keys: ['TIMIFY-131'] })]),
      <JiraAgentDeck entries={[entry]} now={now} onOpenIssue={jest.fn()} />
    );
    const card = screen.getByRole('article', { name: 'Session on TIMIFY-131' });
    expect(within(card).getByText('!415 · ✓ pipeline')).toBeInTheDocument();
    expect(within(card).queryByText(/!401/)).toBeNull();
  });
});

describe('the List’s Delivery column', () => {
  function drawList(tops: JiraIssue[], data: GitlabPayload | null) {
    return shell(
      data,
      <JiraIssueList tops={tops} fold={foldBoard(tops)} sessions={new Map()} now={now} filtered={false} onOpenIssue={jest.fn()} onRun={jest.fn()} />
    );
  }
  const headers = (): string[] => screen.getAllByRole('columnheader').map((h) => h.textContent || h.getAttribute('aria-label') || '');
  /** The Delivery cell of `key`'s row, found by the column's index in the head — so a cell is never read from the wrong column. */
  const cell = (key: string): HTMLElement => {
    const at = headers().indexOf('Delivery');
    const row = document.querySelector(`tr[data-key="${key}"]`);
    if (at < 0 || row === null) throw new Error(`no Delivery cell for ${key}`);
    return row.querySelectorAll<HTMLElement>('td')[at];
  };

  it('puts Delivery after Status, between it and Priority', () => {
    drawList([issue('TIMIFY-123')], payload([mr()]));
    expect(headers()).toEqual(['Session', 'Key', 'Summary', 'Type', 'Status', 'Delivery', 'Priority', 'Assignee', 'Sprint', 'Updated', 'Run']);
  });

  it('draws the lead MR as a link out, its word, and `+N MR` for the others', () => {
    drawList([issue('TIMIFY-123')], payload([mr({ iid: 412 }), mr({ iid: 420, updatedAt: ago(300) })]));
    const c = cell('TIMIFY-123');
    const link = within(c).getByRole('link', { name: '!412' });
    expect(link).toHaveAttribute('href', 'https://gitlab.example.test/development/backend/microservice/-/merge_requests/412');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(within(c).getByText('pipeline passed')).toHaveAttribute('data-tone', 'green');
    expect(within(c).getByText('+1 MR')).toBeInTheDocument();
    expect(c.querySelector('.jira-dlv-track')).not.toBeNull();
  });

  it('adds `not merged` after the word on a done row whose own lead MR is open', () => {
    drawList([issue('TIMIFY-123', done)], payload([mr()]));
    const c = cell('TIMIFY-123');
    const word = within(c).getByText('pipeline passed');
    const chip = within(c).getByText('not merged');
    expect(word.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads `no MR` for a known ticket, `—` for an unknown one, and nothing for a project GitLab does not map', () => {
    const unread: GitlabProjectView = { ...MICRO, path: 'development/other', repo: 'other', polledAt: null };
    drawList(
      [issue('TIMIFY-123'), issue('OPS-7'), issue('PAY-120')],
      payload([mr({ keys: ['TIMIFY-999'] })], { TIMIFY: [MICRO], OPS: [unread] })
    );
    expect(cell('TIMIFY-123').textContent).toBe('no MR');
    expect(cell('OPS-7').textContent).toBe('—');
    expect(cell('PAY-120').textContent).toBe('');
  });

  it('draws no Delivery column while GitLab is unconfigured', () => {
    drawList([issue('TIMIFY-123')], payload([], {}, { state: 'unconfigured', armed: false }));
    expect(headers()).toEqual(['Session', 'Key', 'Summary', 'Type', 'Status', 'Priority', 'Assignee', 'Sprint', 'Updated', 'Run']);
    expect(document.querySelector('[data-delivery]')).toBeNull();
  });

  it('keeps every row and column on a rejected, still-armed GitLab whose projects were never read, each mapped cell `—`', () => {
    const tops = [issue('TIMIFY-123'), issue('TIMIFY-124'), issue('PAY-120')];
    drawList(tops, payload([], { TIMIFY: [{ ...MICRO, polledAt: null, failed: true }] }, { state: 'rejected', httpStatus: 401, user: null }));
    expect(headers()).toContain('Delivery');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(cell('TIMIFY-123').textContent).toBe('—');
    expect(cell('TIMIFY-124').textContent).toBe('—');
    expect(cell('PAY-120').textContent).toBe('');
  });
});

// jsdom never applies the stylesheet, so the band line's own-line rule is pinned in source: `Band` puts `sub` in one `<p>`, and without a block box the
// GitLab span runs on from `JiraBandSub`'s span ("…polled 4s agoGitLab: …") instead of sitting on the second line spec §7.2 draws.
describe('the band’s GitLab line', () => {
  it('is a block box, so it sits on its own line under the Jira sub-line', () => {
    const css = readFileSync(join(__dirname, '../../client/src/styles.css'), 'utf8');
    expect(css).toMatch(/^\.jira-band-gitlab\s*\{[^}]*display:\s*block/m);
  });
});
