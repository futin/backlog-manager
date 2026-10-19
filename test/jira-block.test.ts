import { ADF_PLACEHOLDER_RE, adfToMarkdown } from '../server/src/jira/adf';
import { JIRA_BLOCK_CHILDREN_CAP, renderTicketBlock, shortDate } from '../server/src/jira/block';
import type { JiraIssue, JiraIssueDetail } from '../shared/types';

/**
 * Jira integration, spec §3 (`block.ts`): the ticket block, as the exact string a reader gets. Every case is a `toBe` on the whole text, because the block is a
 * format other code (a skill, a prompt) reads line by line — a drifted separator is a bug a substring match would wave through.
 */
const URL_131 = 'https://acme.atlassian.net/browse/PAY-131';

const issue = (over: Partial<JiraIssue> & Pick<JiraIssue, 'key'>): JiraIssue => ({
  id: '1',
  url: `https://acme.atlassian.net/browse/${over.key}`,
  summary: 'Child',
  project: { key: 'PAY', name: 'Payments' },
  type: { name: 'Sub-task', level: -1, subtask: true },
  status: { name: 'To Do', category: 'new' },
  priority: null,
  assignee: null,
  reporter: null,
  parent: null,
  subtasks: 0,
  labels: [],
  sprint: null,
  created: '2026-10-03T08:00:00.000Z',
  updated: '2026-10-04T08:00:00.000Z',
  resolved: null,
  ...over
});

const detail = (over: Partial<JiraIssueDetail> = {}): JiraIssueDetail => ({
  ...issue({
    key: 'PAY-131',
    id: '10001',
    summary: 'Refund ledger entries',
    type: { name: 'Story', level: 0, subtask: false },
    status: { name: 'In Progress', category: 'indeterminate' },
    priority: 'High',
    assignee: { accountId: '622x', name: 'Ada Lovelace' },
    reporter: 'Cho M.',
    parent: { key: 'PAY-120', summary: 'Refund flows' },
    labels: ['refunds', 'ledger'],
    sprint: 'Sprint 42',
    created: '2026-10-02T09:15:00.000Z',
    updated: '2026-10-16T11:00:00.000Z'
  }),
  description: 'Write one ledger row per refund.\n\n- partial refunds\n- full refunds',
  children: [
    issue({
      key: 'PAY-132',
      summary: 'Ledger migration',
      status: { name: 'In Progress', category: 'indeterminate' },
      assignee: { accountId: '1', name: 'Ada Lovelace' }
    }),
    issue({ key: 'PAY-133', summary: 'Ledger writer', status: { name: 'In Review', category: 'indeterminate' } })
  ],
  transitions: [],
  boards: ['b1'],
  session: null,
  ...over
});

const HEAD = [
  'PAY-131 · Refund ledger entries',
  'type: Story · status: In Progress (in progress) · priority: High',
  'project: PAY · Payments · parent: PAY-120 Refund flows · sprint: Sprint 42',
  'assignee: Ada Lovelace · reporter: Cho M. · labels: refunds, ledger',
  'created: 2026-10-02 · updated: 2026-10-16 · resolved: —',
  `url: ${URL_131}`
];

describe('renderTicketBlock', () => {
  it('renders the full fixture: facts, description, subtasks, a final newline', () => {
    expect(renderTicketBlock(detail())).toBe(
      [
        ...HEAD,
        '',
        'Write one ledger row per refund.',
        '',
        '- partial refunds',
        '- full refunds',
        '',
        'Subtasks (2):',
        '- PAY-132 Ledger migration · In Progress · Ada Lovelace',
        '- PAY-133 Ledger writer · In Review · —',
        ''
      ].join('\n')
    );
  });

  it('puts a dash in the place of every absent fact, labels included', () => {
    const base = detail();
    const bare = detail({
      priority: null,
      parent: null,
      sprint: null,
      assignee: null,
      reporter: null,
      resolved: null,
      labels: [],
      children: [],
      description: 'Body.'
    });
    expect(renderTicketBlock(bare)).toBe(
      [
        'PAY-131 · Refund ledger entries',
        'type: Story · status: In Progress (in progress) · priority: —',
        'project: PAY · Payments · parent: — · sprint: —',
        'assignee: — · reporter: — · labels: —',
        'created: 2026-10-02 · updated: 2026-10-16 · resolved: —',
        `url: ${base.url}`,
        '',
        'Body.',
        ''
      ].join('\n')
    );
  });

  it('names the status category in words: to do, in progress, done', () => {
    const line = (category: 'new' | 'indeterminate' | 'done') => renderTicketBlock(detail({ status: { name: 'X', category }, children: [] })).split('\n')[1];
    expect(line('new')).toBe('type: Story · status: X (to do) · priority: High');
    expect(line('indeterminate')).toBe('type: Story · status: X (in progress) · priority: High');
    expect(line('done')).toBe('type: Story · status: X (done) · priority: High');
  });

  it('renders a resolved instant as a date', () => {
    const text = renderTicketBlock(detail({ resolved: '2026-10-15T23:59:00.000Z', children: [] }));
    expect(text.split('\n')[4]).toBe('created: 2026-10-02 · updated: 2026-10-16 · resolved: 2026-10-15');
  });

  it('renders (no description) for an empty description, and never the string null', () => {
    const expected = [...HEAD, '', '(no description)', ''].join('\n');
    expect(renderTicketBlock(detail({ description: '', children: [] }))).toBe(expected);
    // A Jira description of `null` maps to '' upstream (Review Focus 5); a value that still arrives as null or whitespace must land on the same line.
    expect(renderTicketBlock(detail({ description: null as unknown as string, children: [] }))).toBe(expected);
    expect(renderTicketBlock(detail({ description: ' \n ', children: [] }))).toBe(expected);
    expect(renderTicketBlock(detail({ description: null as unknown as string, children: [] }))).not.toContain('null');
  });

  it('has no Subtasks section and no trailing blank line when there are no children', () => {
    const text = renderTicketBlock(detail({ children: [] }));
    expect(text).toBe([...HEAD, '', 'Write one ledger row per refund.', '', '- partial refunds', '- full refunds', ''].join('\n'));
    expect(text).not.toContain('Subtasks');
    expect(text.endsWith('\n\n')).toBe(false);
  });

  describe('the children cap', () => {
    const kids = (n: number) => Array.from({ length: n }, (_, i) => issue({ key: `PAY-${200 + i}`, summary: `Child ${i}` }));

    it('lists the first 30 and then +1 more for 31', () => {
      expect(JIRA_BLOCK_CHILDREN_CAP).toBe(30);
      const lines = renderTicketBlock(detail({ children: kids(31), description: 'D' })).split('\n');
      const at = lines.indexOf('Subtasks (31):');
      expect(at).toBeGreaterThan(0);
      expect(lines.slice(at + 1)).toEqual([...kids(30).map((c, i) => `- PAY-${200 + i} Child ${i} · To Do · —`), '+1 more', '']);
    });

    it('lists exactly 30 with no +N more', () => {
      const text = renderTicketBlock(detail({ children: kids(30), description: 'D' }));
      expect(text).toContain('Subtasks (30):');
      expect(text).not.toContain('more');
      expect(text.split('\n').filter((l) => l.startsWith('- PAY-'))).toHaveLength(30);
    });
  });

  describe('the description option', () => {
    it("'omitted' drops the description and every note about it, and keeps the facts and the subtasks", () => {
      const withPlaceholder = detail({ description: 'Layout.\n[table omitted]' });
      const text = renderTicketBlock(withPlaceholder, { description: 'omitted' });
      expect(text).toBe(
        [...HEAD, '', 'Subtasks (2):', '- PAY-132 Ledger migration · In Progress · Ada Lovelace', '- PAY-133 Ledger writer · In Review · —', ''].join('\n')
      );
      expect(text).not.toContain('(no description)');
      expect(text).not.toContain('omitted');
      expect(renderTicketBlock(detail({ description: '', children: [] }), { description: 'omitted' })).toBe([...HEAD, ''].join('\n'));
    });

    it("'as-is' and no option are the same bytes", () => {
      expect(renderTicketBlock(detail(), { description: 'as-is' })).toBe(renderTicketBlock(detail()));
    });

    it('{ fence } wraps a description between two fence lines and leaves the rest alone', () => {
      const text = renderTicketBlock(detail({ children: [] }), { description: { fence: '````' } });
      expect(text).toBe([...HEAD, '', '````', 'Write one ledger row per refund.', '', '- partial refunds', '- full refunds', '````', ''].join('\n'));
    });

    it('{ fence } leaves the empty-description line unfenced, and puts the omitted-content note after the closing fence', () => {
      expect(renderTicketBlock(detail({ description: ' ', children: [] }), { description: { fence: '```' } })).toBe(
        [...HEAD, '', '(no description)', ''].join('\n')
      );
      const note = `(something was omitted — open in Jira: ${URL_131})`;
      expect(renderTicketBlock(detail({ description: '[table omitted]', children: [] }), { description: { fence: '```' } })).toBe(
        [...HEAD, '', '```', '[table omitted]', '```', note, ''].join('\n')
      );
    });
  });

  describe('the omitted-content note', () => {
    const note = `(something was omitted — open in Jira: ${URL_131})`;

    it('follows a description that holds a placeholder', () => {
      const description = 'Layout below.\n\n[table omitted]';
      expect(ADF_PLACEHOLDER_RE.test(description)).toBe(true);
      expect(renderTicketBlock(detail({ description, children: [] }))).toBe([...HEAD, '', 'Layout below.', '', '[table omitted]', note, ''].join('\n'));
    });

    it('is raised by a placeholder inside a list item (P7: the pattern matches anywhere in a line)', () => {
      const description = '- first\n- [attachment: spec.pdf]\n- last';
      expect(renderTicketBlock(detail({ description, children: [] }))).toBe(
        [...HEAD, '', '- first', '- [attachment: spec.pdf]', '- last', note, ''].join('\n')
      );
    });

    it('is raised by what adfToMarkdown really writes for a table in a list', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'table', content: [] }] }] }]
      };
      const { markdown } = adfToMarkdown(adf);
      expect(renderTicketBlock(detail({ description: markdown, children: [] }))).toContain(note);
    });

    it('is absent when the description has none, and for a literal the converter escaped', () => {
      expect(renderTicketBlock(detail())).not.toContain('something was omitted');
      expect(renderTicketBlock(detail({ description: 'a person typed \\[table omitted\\]', children: [] }))).not.toContain('something was omitted');
    });

    it('is not raised for an empty description', () => {
      expect(renderTicketBlock(detail({ description: '', children: [] }))).not.toContain('something was omitted');
    });

    it('is raised on every call, whatever the regex has seen before (a non-global pattern keeps no lastIndex)', () => {
      const d = detail({ description: '[panel omitted]', children: [] });
      expect(renderTicketBlock(d)).toBe(renderTicketBlock(d));
      expect(renderTicketBlock(d)).toContain('something was omitted');
    });
  });
});

describe('shortDate', () => {
  it('is the UTC calendar day of the instant, whatever offset the string carries', () => {
    expect(shortDate('2026-10-02T09:15:00.000Z')).toBe('2026-10-02');
    expect(shortDate('2026-10-02T23:30:00.000-0500')).toBe('2026-10-03');
    expect(shortDate('2026-10-03T00:30:00.000+0200')).toBe('2026-10-02');
  });

  it('is independent of the process time zone', () => {
    const before = process.env.TZ;
    try {
      for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
        process.env.TZ = tz;
        expect(shortDate('2026-10-02T02:00:00.000Z')).toBe('2026-10-02');
        expect(shortDate('2026-10-02T23:00:00.000Z')).toBe('2026-10-02');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('hands back what it cannot read rather than throwing', () => {
    expect(shortDate('not a date')).toBe('not a date');
    expect(shortDate('')).toBe('');
  });
});
