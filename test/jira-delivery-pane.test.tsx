/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { DeliveryPane } from '../client/src/components/jira/DeliveryPane';
import { GitlabContext } from '../client/src/hooks/GitlabContext';
import type { GitlabMr, GitlabPayload, GitlabProjectView, GitlabStatus, JiraIssue } from '../shared/types';
import { ruleBlocks, readStyles } from './helpers/css-rule';
import { daysAgoStamp } from './helpers/dates';

/**
 * Jira Detail's Delivery pane (GitLab connection spec §7.1, mock `OptionC.dc.html`): the lead MR's head, its track with each step's word, the `Also:` line,
 * the inherited `via` mark, and the one-line no-MR and unknown sentences. Rendered under the RAW `GitlabContext` with a payload in hand, so no fetch runs and
 * the pane is read exactly as the shell's one answer would hand it over. Every MR stamp is relative to `now`, which the pane takes as a prop, so the ages
 * asserted here are fixed whatever the real clock says; the issue's own `created`/`updated` go through `daysAgoStamp` for the fixture-clock guard.
 */

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

function mr(over: Partial<GitlabMr> = {}): GitlabMr {
  const iid = over.iid ?? 412;
  return {
    project: 'development/backend/microservice',
    iid,
    title: `TIMIFY-123 | change ${iid}`,
    webUrl: `https://gitlab.example.test/development/backend/microservice/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: `timify-123-change-${iid}`,
    targetBranch: 'develop',
    createdAt: ago(120),
    updatedAt: ago(30),
    mergedAt: null,
    pipeline: 'success',
    keys: ['TIMIFY-123'],
    review: null,
    ...over
  };
}

const MICRO: GitlabProjectView = { path: 'development/backend/microservice', repo: 'microservice', polledAt: ago(5), capped: false, failed: false, repos: [] };
const PROXY: GitlabProjectView = { path: 'development/graphql/dev-api-graphql-proxy', repo: 'dev-api-graphql-proxy', polledAt: ago(3), capped: false, failed: false, repos: [] };

function status(over: Partial<GitlabStatus> = {}): GitlabStatus {
  return {
    state: 'connected',
    site: 'gitlab.example.test',
    malformedSite: false,
    user: { username: 'ada', name: 'Ada' },
    httpStatus: null,
    reason: null,
    armed: true,
    retryAt: null,
    mappedRepos: 2,
    foundHosts: [],
    problems: [],
    ...over
  };
}

function payload(mrs: GitlabMr[], jiraProjects: Record<string, GitlabProjectView[]> = { TIMIFY: [MICRO, PROXY] }, st: Partial<GitlabStatus> = {}): GitlabPayload {
  return { status: status(st), jiraProjects, mrs };
}

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  const key = over.key ?? 'TIMIFY-123';
  return {
    key,
    id: `id-${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    summary: `summary of ${key}`,
    project: { key: key.split('-')[0], name: 'Timify' },
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

function draw(data: GitlabPayload | null, of: JiraIssue = issue()) {
  return render(
    <GitlabContext.Provider value={{ data, error: null, refresh: () => Promise.resolve(data) }}>
      <DeliveryPane issue={of} now={now} />
    </GitlabContext.Provider>
  );
}

/** One track step's `<li>`, found by its label, so a word is asserted against the step it sits under and never against the pane at large. */
const step = (label: string): HTMLElement => {
  const el = screen.getByText(label, { selector: '.jira-dlv-step-label' }).closest('li');
  if (el === null) throw new Error(`no track step labelled ${label}`);
  return el;
};
const stepWord = (label: string): string | null => step(label).querySelector('.jira-dlv-step-word')?.textContent ?? null;

afterEach(cleanup);

describe('DeliveryPane', () => {
  it('draws an open MR with a passing pipeline: head, link, repo → target, polled age, and the five-step track', () => {
    const { container } = draw(payload([mr()]));
    expect(screen.getByText('Delivery')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '!412' });
    expect(link).toHaveAttribute('href', 'https://gitlab.example.test/development/backend/microservice/-/merge_requests/412');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.getByText('microservice → develop')).toBeInTheDocument();
    // The lead MR's own project's age, not the other mapped project's.
    expect(screen.getByText('polled 5m ago')).toBeInTheDocument();

    const labels = [...container.querySelectorAll('.jira-dlv-step-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Pushed', 'MR open', 'Pipeline', 'Review', 'Merged']);
    expect(stepWord('Pushed')).toBe('2h');
    expect(stepWord('MR open')).toBe('2h');
    expect(stepWord('Pipeline')).toBe('pipeline passed');
    expect(stepWord('Merged')).toBeNull();
    expect(step('Pipeline').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'green');
    expect(step('Merged').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'off');

    // The Review step is in the track now (CodeRabbit spec §5.1), off with no word for `review: null`; the CodeRabbit row is a later task's, so none yet.
    expect(stepWord('Review')).toBeNull();
    expect(step('Review').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'off');
    expect(container.textContent).not.toMatch(/CodeRabbit/);
    expect(screen.queryByText(/Also:/)).not.toBeInTheDocument();
  });

  it('a merged MR carries its merged-at age at Merged, and Pipeline has no word', () => {
    draw(payload([mr({ state: 'merged', pipeline: null, mergedAt: ago(60 * 26), updatedAt: ago(60 * 26) })]));
    expect(stepWord('Merged')).toBe('1d');
    expect(stepWord('Pipeline')).toBeNull();
    expect(stepWord('Pushed')).toBe('2h');
    expect(step('Merged').querySelector('.jira-dlv-dot')).toHaveAttribute('data-mark', 'magenta');
  });

  it('lists the other MRs on an Also: line, each with its state word and `<repo> · <age>`', () => {
    const lead = mr();
    const failing = mr({ iid: 415, pipeline: 'failed', updatedAt: ago(90) });
    const merged = mr({
      iid: 420,
      project: PROXY.path,
      webUrl: 'https://gitlab.example.test/development/graphql/dev-api-graphql-proxy/-/merge_requests/420',
      state: 'merged',
      pipeline: null,
      mergedAt: ago(60 * 50),
      updatedAt: ago(60 * 50)
    });
    draw(payload([merged, failing, lead]));
    // The lead is the newest opened MR, so the head names !412 and the others ride the Also: line.
    expect(screen.getByText('microservice → develop')).toBeInTheDocument();
    const also = screen.getByText('Also:').parentElement as HTMLElement;
    const a415 = within(also).getByRole('link', { name: '!415' });
    const a420 = within(also).getByRole('link', { name: '!420' });
    expect(a415).toHaveAttribute('href', failing.webUrl);
    expect(a420).toHaveAttribute('href', merged.webUrl);
    expect(a420).toHaveAttribute('target', '_blank');
    expect(within(also).getByText('pipeline failed')).toBeInTheDocument();
    expect(within(also).getByText('merged')).toBeInTheDocument();
    expect(within(also).getByText('microservice · 1h')).toBeInTheDocument();
    expect(within(also).getByText('dev-api-graphql-proxy · 2d')).toBeInTheDocument();
  });

  it('marks a sub-task showing its parent’s MRs with `via <PARENT-KEY>` after the link', () => {
    const sub = issue({ key: 'TIMIFY-144', type: { name: 'Sub-task', level: -1, subtask: true }, parent: { key: 'TIMIFY-100', summary: 'the story' } });
    draw(payload([mr({ keys: ['TIMIFY-100'] })]), sub);
    const link = screen.getByRole('link', { name: '!412' });
    const via = screen.getByText('via TIMIFY-100');
    expect(link.compareDocumentPosition(via) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says there is no merge request in every mapped repo, in the payload’s order', () => {
    draw(payload([]), issue({ key: 'TIMIFY-144' }));
    expect(screen.getByText('no merge request for TIMIFY-144 in microservice, dev-api-graphql-proxy in the last 30 days')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('names the one repo when only one is mapped', () => {
    draw(payload([], { TIMIFY: [MICRO] }), issue({ key: 'TIMIFY-144' }));
    expect(screen.getByText('no merge request for TIMIFY-144 in microservice in the last 30 days')).toBeInTheDocument();
  });

  it.each<[string, GitlabProjectView, string]>([
    ['never read', { ...MICRO, polledAt: null }, 'GitLab not read yet'],
    ['never read and failed', { ...MICRO, polledAt: null, failed: true }, 'GitLab could not be read — Settings › Shared › Sources'],
    ['capped', { ...MICRO, capped: true }, 'more merge requests than were read — some may be missing']
  ])('an unknown ticket (%s) reads its unknown line, not the no-MR one', (_name, v, line) => {
    draw(payload([], { TIMIFY: [v] }), issue({ key: 'TIMIFY-144' }));
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(/no merge request/)).not.toBeInTheDocument();
  });

  it('draws nothing for a ticket whose Jira project maps no GitLab project', () => {
    const { container } = draw(payload([mr()], { OTHER: [MICRO] }));
    expect(container).toBeEmptyDOMElement();
  });

  it.each<[string, GitlabPayload | null]>([
    ['no payload', null],
    ['unconfigured', payload([mr()], { TIMIFY: [MICRO] }, { state: 'unconfigured', armed: false })],
    ['not armed', payload([mr()], { TIMIFY: [MICRO] }, { armed: false })]
  ])('draws nothing while delivery is not shown (%s)', (_name, data) => {
    const { container } = draw(data);
    expect(container).toBeEmptyDOMElement();
  });
});

// jsdom paints nothing, so the track's z-order is pinned at the rule: step i+1's positioned rail comes later in the tree than step i's dot and, with no
// z-index on the dot, painted over its right half — the glyph cut and the rail showing through a hollow ring (ui-verify 2026-11-12). `isolation` keeps the
// dot's z-index local, so it never rises over the List's sticky header or a menu.
describe('delivery track paint order', () => {
  const css = readStyles();
  it('lifts the dot over the rail', () => {
    expect(ruleBlocks(css, '.jira-dlv-dot').some((b) => /(^|[;\s])z-index:\s*1\b/.test(b))).toBe(true);
  });
  it('keeps that z-index inside the track', () => {
    expect(ruleBlocks(css, '.jira-dlv-track').some((b) => /isolation:\s*isolate/.test(b))).toBe(true);
  });
});
