import type { ReactNode } from 'react';

import { MentionOpenContext } from '../../client/src/components/jira/MentionOpenContext';
import { JiraMentionsContext } from '../../client/src/hooks/JiraMentionsContext';
import type { JiraMentionsState } from '../../client/src/hooks/useJiraMentions';
import type { JiraMention, JiraMentionIssue, JiraMentionsConfigured } from '../../shared/types';
import { daysAgoStamp } from './dates';

/* A stubbed mentions payload and an opener spy for the suites that draw the board's `@ N` mark (Jira mentions <-> board link, Task 5). */

export function mention(id: string, name: string, excerpt: string, key: string, days: number): JiraMention {
  return {
    commentId: id,
    author: { accountId: `acc-${name}`, name },
    created: daysAgoStamp(days),
    excerpt,
    url: `https://acme.atlassian.net/browse/${key}?focusedCommentId=${id}`
  };
}

export const mentionIssue = (key: string, mentions: JiraMention[]): JiraMentionIssue => ({
  key,
  summary: `Summary of ${key}`,
  type: 'Bug',
  status: { name: 'In Progress', category: 'indeterminate' },
  boards: [],
  draft: null,
  session: null,
  mentions
});

export function mentionsPayload(over: Partial<JiraMentionsConfigured> = {}): JiraMentionsConfigured {
  return {
    configured: true,
    polledAt: daysAgoStamp(0.001),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: 'Andreja',
    issues: [],
    dismissed: [],
    ...over
  } as JiraMentionsConfigured;
}

const ok = () => Promise.resolve({ ok: true } as const);
export function mentionsState(data: JiraMentionsConfigured | null): JiraMentionsState {
  return {
    data,
    loading: false,
    error: null,
    reload: () => {},
    sweep: () => Promise.resolve(),
    checking: false,
    dismiss: ok,
    restore: ok,
    discardDraft: ok,
    postReply: ok
  } as JiraMentionsState;
}

/** The mentions context over `data` and an opener spy, around `children`. */
export function MentionWrap({ data, open, children }: { data: JiraMentionsConfigured | null; open: (key: string) => void; children: ReactNode }) {
  return (
    <JiraMentionsContext.Provider value={mentionsState(data)}>
      <MentionOpenContext.Provider value={open}>{children}</MentionOpenContext.Provider>
    </JiraMentionsContext.Provider>
  );
}
