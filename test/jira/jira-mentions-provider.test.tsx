/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import fs from 'node:fs';
import path from 'node:path';

import { JiraMentionsProvider, useJiraMentionsContext, useMentionIndex } from '../../client/src/hooks/JiraMentionsContext';
import type { JiraMentionIssue, JiraMentionsPayload } from '../../shared/types';

/*
  The shell's one mentions poll (Jira mentions <-> board link, Task 2): the provider is the hook's only caller, the context's default is "nothing known" and
  never fetches, and `useMentionIndex` is the key -> ticket map the board's markers read, empty unless a stamped, configured payload says otherwise.
*/

const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const issue = (key: string, n: number): JiraMentionIssue => ({
  key,
  summary: `${key} summary`,
  type: 'Bug',
  status: { name: 'In Progress', category: 'indeterminate' },
  boards: [],
  draft: null,
  session: null,
  mentions: Array.from({ length: n }, (_, i) => ({
    commentId: `${key}-${i}`,
    author: { accountId: 'a', name: 'Ada' },
    created: iso(60_000 * (i + 1)),
    excerpt: 'hi',
    url: `https://x/browse/${key}`
  }))
});
function payload(over: Partial<Extract<JiraMentionsPayload, { configured: true }>> = {}): JiraMentionsPayload {
  return {
    configured: true,
    polledAt: iso(10_000),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: 'Ada',
    issues: [issue('PAY-1', 2), issue('PAY-2', 1)],
    dismissed: [issue('PAY-3', 1)],
    ...over
  };
}
const res = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

let fetchMock: jest.Mock;
let seen: ReturnType<typeof useJiraMentionsContext>[];
let index: ReturnType<typeof useMentionIndex>;
let answer: JiraMentionsPayload;

function Consumer({ i }: { i: number }) {
  seen[i] = useJiraMentionsContext();
  index = useMentionIndex();
  return <span data-testid={`c${i}`}>{seen[i].data === null ? 'none' : 'data'}</span>;
}
const tree = (enabled: boolean) => (
  <JiraMentionsProvider enabled={enabled}>
    <Consumer i={0} />
    <Consumer i={1} />
  </JiraMentionsProvider>
);
const mentionGets = (): number => fetchMock.mock.calls.filter(([u, init]) => u === '/api/jira/mentions' && init === undefined).length;
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  seen = [];
  answer = payload();
  fetchMock = jest.fn(() => res(answer));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('JiraMentionsProvider', () => {
  it('reads once for two consumers, who hold the same data object', async () => {
    render(tree(true));
    await flush();
    expect(mentionGets()).toBe(1);
    expect(seen[0].data).not.toBeNull();
    expect(seen[0].data).toBe(seen[1].data);
  });

  it('enabled: false reads nothing and the consumers see no data', async () => {
    render(tree(false));
    await flush();
    expect(mentionGets()).toBe(0);
    expect(seen[0].data).toBeNull();
    expect(seen[1].data).toBeNull();
  });

  it('true -> false -> true reads twice in all and keeps the first payload while off', async () => {
    const view = render(tree(true));
    await flush();
    const first = seen[0].data;
    expect(first).not.toBeNull();
    view.rerender(tree(false));
    await flush();
    expect(mentionGets()).toBe(1);
    expect(seen[0].data).toBe(first);
    view.rerender(tree(true));
    await flush();
    expect(mentionGets()).toBe(2);
  });

  it('a consumer with no provider reads nothing and its writes resolve not-ok', async () => {
    function Bare() {
      seen[0] = useJiraMentionsContext();
      return null;
    }
    render(<Bare />);
    await flush();
    expect(mentionGets()).toBe(0);
    expect(seen[0].data).toBeNull();
    expect(seen[0].loading).toBe(false);
    expect(seen[0].checking).toBe(false);
    await expect(seen[0].dismiss('PAY-1', ['1'])).resolves.toEqual({ ok: false, message: 'mentions unavailable' });
  });
});

describe('useMentionIndex', () => {
  it('maps the waiting tickets by key and leaves the dismissed ones out', async () => {
    render(tree(true));
    await flush();
    expect([...index.keys()].sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(index.get('PAY-1')!.mentions.length).toBe(2);
  });

  it('is empty while the cache has never been stamped', async () => {
    answer = payload({ polledAt: null });
    render(tree(true));
    await flush();
    expect(index.size).toBe(0);
  });

  it('is empty when Jira is unconfigured', async () => {
    answer = { configured: false, detail: null };
    render(tree(true));
    await flush();
    expect(index.size).toBe(0);
  });
});

describe('source guard', () => {
  it('useJiraMentions( is called in exactly one file, the provider', () => {
    const root = path.join(__dirname, '../../client/src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('useJiraMentions(')) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits.filter((h) => h !== path.join('hooks', 'useJiraMentions.ts'))).toEqual([path.join('hooks', 'JiraMentionsContext.tsx')]);
  });
});
