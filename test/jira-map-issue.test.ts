import { JIRA_DONE_WINDOW_DAYS, JIRA_ISSUE_FIELDS, categoryOf, mapJiraIssue, pickSprintField, type MapContext } from '../server/src/jira/map-issue';
import { makeRawIssue } from './helpers/jira';

/**
 * Jira integration, spec §3 (`map-issue.ts`, the Done window) and §4 (the shapes), with §14 P3/P4/P5 as the authority on what Jira sends. Every date is derived
 * from the fixed `NOW` by arithmetic, so no fixture is a literal that ages.
 */
const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ctx: MapContext = { site: 'acme.atlassian.net', sprintField: 'customfield_10020', now: NOW };

const map = (fields: Record<string, unknown> = {}, over: Partial<MapContext> = {}, key = 'PAY-131') =>
  mapJiraIssue(makeRawIssue({ key, fields }), { ...ctx, ...over });

describe('mapJiraIssue — a full issue', () => {
  it('maps every field of §4', () => {
    const created = ago(5 * DAY);
    const updated = ago(1 * DAY);
    const raw = {
      key: 'PAY-131',
      id: '10001',
      fields: {
        summary: 'Refund a partial payment',
        issuetype: { name: 'Story', hierarchyLevel: 0, subtask: false },
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        priority: { name: 'High' },
        assignee: { accountId: '622x', displayName: 'Ada Lovelace' },
        reporter: { displayName: 'Cho M.' },
        parent: { key: 'PAY-120', fields: { summary: 'Refund flows' } },
        subtasks: [{}, {}],
        labels: ['refunds', 'ledger'],
        customfield_10020: [{ id: 3, name: 'Sprint 42', state: 'active' }],
        created,
        updated,
        resolutiondate: null,
        project: { key: 'PAY', name: 'Payments' }
      }
    };
    expect(mapJiraIssue(raw, ctx)).toEqual({
      key: 'PAY-131',
      id: '10001',
      url: 'https://acme.atlassian.net/browse/PAY-131',
      summary: 'Refund a partial payment',
      project: { key: 'PAY', name: 'Payments' },
      type: { name: 'Story', level: 0, subtask: false },
      status: { name: 'In Progress', category: 'indeterminate' },
      priority: 'High',
      assignee: { accountId: '622x', name: 'Ada Lovelace' },
      reporter: 'Cho M.',
      parent: { key: 'PAY-120', summary: 'Refund flows' },
      subtasks: 2,
      labels: ['refunds', 'ledger'],
      sprint: 'Sprint 42',
      created,
      updated,
      resolved: null
    });
  });
});

describe('JIRA_ISSUE_FIELDS', () => {
  it('is exactly the sweep field list of §4', () => {
    expect(JIRA_ISSUE_FIELDS).toEqual([
      'summary',
      'issuetype',
      'status',
      'priority',
      'assignee',
      'reporter',
      'parent',
      'subtasks',
      'labels',
      'created',
      'updated',
      'resolutiondate',
      'project'
    ]);
  });

  it('names a 14-day window', () => {
    expect(JIRA_DONE_WINDOW_DAYS).toBe(14);
  });
});

describe('categoryOf (P5)', () => {
  it.each(['new', 'indeterminate', 'done'] as const)('%s maps to itself', (key) => {
    expect(categoryOf(key)).toBe(key);
  });

  it.each(['undefined', undefined, 'weird', null, 3, ''])('%j maps to new', (key) => {
    expect(categoryOf(key)).toBe('new');
  });
});

describe('mapJiraIssue — type level (P3)', () => {
  it('derives -1 for a subtask whose type carries no hierarchyLevel', () => {
    expect(map({ issuetype: { name: 'Sub-task', subtask: true } })?.type).toEqual({ name: 'Sub-task', level: -1, subtask: true });
  });

  it('derives 0 for a non-subtask whose type carries none', () => {
    expect(map({ issuetype: { name: 'Task', subtask: false } })?.type).toEqual({ name: 'Task', level: 0, subtask: false });
  });

  it('keeps a hierarchyLevel it is given, whatever the type is called', () => {
    expect(map({ issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false } })?.type.level).toBe(1);
    expect(map({ issuetype: { name: 'Project', hierarchyLevel: -1, subtask: true } })?.type.level).toBe(-1);
  });
});

describe('mapJiraIssue — absent and null fields', () => {
  it.each(['parent', 'assignee', 'priority', 'reporter'] as const)('%s null → null', (field) => {
    const issue = map({ [field]: null });
    expect(issue?.[field]).toBeNull();
  });

  it('absent → null for the same four', () => {
    const raw = makeRawIssue({ key: 'PAY-131' });
    for (const f of ['parent', 'assignee', 'priority', 'reporter']) delete raw.fields[f];
    const issue = mapJiraIssue(raw, ctx);
    expect([issue?.parent, issue?.assignee, issue?.priority, issue?.reporter]).toEqual([null, null, null, null]);
  });

  it('labels absent → [] and subtasks absent → 0', () => {
    const raw = makeRawIssue({ key: 'PAY-131' });
    delete raw.fields.labels;
    delete raw.fields.subtasks;
    const issue = mapJiraIssue(raw, ctx);
    expect(issue?.labels).toEqual([]);
    expect(issue?.subtasks).toBe(0);
  });

  it('project absent → the key prefix for both key and name', () => {
    const raw = makeRawIssue({ key: 'PAY-131' });
    delete raw.fields.project;
    expect(mapJiraIssue(raw, ctx)?.project).toEqual({ key: 'PAY', name: 'PAY' });
  });

  it('a parent without a summary keeps its key and an empty summary', () => {
    expect(map({ parent: { key: 'PAY-120' } })?.parent).toEqual({ key: 'PAY-120', summary: '' });
  });
});

describe('mapJiraIssue — the sprint', () => {
  const sprint = (value: unknown, over: Partial<MapContext> = {}) => map({ customfield_10020: value }, over)?.sprint;

  it('picks the active sprint over a closed and a future one', () => {
    expect(
      sprint([
        { id: 1, state: 'closed', name: 'S1' },
        { id: 3, state: 'active', name: 'S3' },
        { id: 2, state: 'future', name: 'S2' }
      ])
    ).toBe('S3');
  });

  it('with no active one, picks the last by id, not by position', () => {
    expect(
      sprint([
        { id: 2, state: 'future', name: 'S2' },
        { id: 1, state: 'closed', name: 'S1' }
      ])
    ).toBe('S2');
  });

  it('is null for an empty array, a null sprint field, a string, and no discovered field', () => {
    expect(sprint([])).toBeNull();
    expect(sprint(null)).toBeNull();
    expect(sprint('Sprint 42')).toBeNull();
    expect(sprint([{ id: 3, state: 'active', name: 'S3' }], { sprintField: null })).toBeNull();
  });
});

describe('pickSprintField (P4)', () => {
  const GH = 'com.pyxis.greenhopper.jira:gh-sprint';

  it('picks the gh-sprint field and ignores one that merely looks like it', () => {
    expect(
      pickSprintField([
        { id: 'customfield_10014', name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
        { id: 'customfield_10020', name: 'Sprint', schema: { custom: GH } }
      ])
    ).toBe('customfield_10020');
  });

  it('with two, prefers the one named Sprint', () => {
    expect(
      pickSprintField([
        { id: 'customfield_10020', name: 'Old sprint', schema: { custom: GH } },
        { id: 'customfield_10099', name: 'Sprint', schema: { custom: GH } }
      ])
    ).toBe('customfield_10099');
  });

  it('with two and none named Sprint, takes the lowest numeric id — not the lowest as text', () => {
    expect(
      pickSprintField([
        { id: 'customfield_10099', name: 'A', schema: { custom: GH } },
        { id: 'customfield_10020', name: 'B', schema: { custom: GH } }
      ])
    ).toBe('customfield_10020');
    expect(
      pickSprintField([
        { id: 'customfield_9', name: 'A', schema: { custom: GH } },
        { id: 'customfield_10', name: 'B', schema: { custom: GH } }
      ])
    ).toBe('customfield_9');
  });

  it('is null when there is none, and for an empty list', () => {
    expect(pickSprintField([{ id: 'summary', name: 'Summary' }])).toBeNull();
    expect(pickSprintField([])).toBeNull();
  });
});

describe('mapJiraIssue — the Done window (§3)', () => {
  const done = { status: { name: 'Done', statusCategory: { key: 'done' } } };

  it('drops a done issue resolved 15 days ago', () => {
    expect(map({ ...done, resolutiondate: ago(15 * DAY) })).toBeNull();
  });

  it('keeps one resolved 13 days ago, with `resolved` the instant Jira sent', () => {
    const at = ago(13 * DAY);
    expect(map({ ...done, resolutiondate: at })?.resolved).toBe(at);
  });

  it('keeps one resolved exactly 14 days ago and drops one a second older', () => {
    expect(map({ ...done, resolutiondate: ago(14 * DAY) })).not.toBeNull();
    expect(map({ ...done, resolutiondate: ago(14 * DAY + 1000) })).toBeNull();
  });

  it('with no resolution date, falls back to `updated`', () => {
    expect(map({ ...done, resolutiondate: null, updated: ago(15 * DAY) })).toBeNull();
    expect(map({ ...done, resolutiondate: null, updated: ago(1 * DAY) })).not.toBeNull();
  });

  it('reads Jira’s own timestamp shape (a zone offset without a colon)', () => {
    const jiraStamp = (ms: number) => new Date(NOW - ms).toISOString().replace(/\.\d{3}Z$/, '.000+0000');
    expect(map({ ...done, resolutiondate: jiraStamp(13 * DAY) })).not.toBeNull();
    expect(map({ ...done, resolutiondate: jiraStamp(15 * DAY) })).toBeNull();
  });

  it('never drops a live issue for a stale resolution', () => {
    expect(map({ resolutiondate: ago(40 * DAY) })).not.toBeNull();
  });

  it('keeps everything when `now` is null — the search route needs any issue', () => {
    expect(map({ ...done, resolutiondate: ago(400 * DAY) }, { now: null })).not.toBeNull();
  });
});

describe('mapJiraIssue — not an issue', () => {
  it.each([
    ['no key', { id: '1', fields: {} }],
    ['no fields', { id: '1', key: 'PAY-1' }],
    ['null', null],
    ['a string', 'PAY-1'],
    ['a number', 7],
    ['an array', []],
    ['undefined', undefined]
  ])('%s → null', (_name, raw) => {
    expect(mapJiraIssue(raw, ctx)).toBeNull();
  });
});
