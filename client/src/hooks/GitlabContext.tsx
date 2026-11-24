import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { GitlabPayload } from '../../../shared/types';
import { useAnsweredAt } from './useAnsweredAt';
import { useGitlab } from './useGitlab';

export interface GitlabContextValue {
  data: GitlabPayload | null;
  error: string | null;
  refresh: () => Promise<GitlabPayload | null>;
  /** When `data` last landed (`useAnsweredAt`, #588) — Settings › Shared's `Last read` foot. Optional: a hand-built value may leave it out. */
  answeredAt?: number | null;
}

/** Exported raw so a test can render a consumer under a provided value without a fetch; app code reads `useGitlabContext`. */
export const GitlabContext = createContext<GitlabContextValue | null>(null);

/**
 * The shell's one read of `GET /api/gitlab`: the Sources row, the Jira ticket MR rows and the MR badges read one answer on one clock. Unlike
 * `PullRequestsProvider` it has no enable gate — GitLab's status is always read, because the Sources row has to say "not configured" — so the hook is
 * mounted directly and there is no reader component.
 */
export function GitlabProvider({ children }: { children: ReactNode }) {
  const { data, error, refresh } = useGitlab();
  const answeredAt = useAnsweredAt(data);
  const value = useMemo<GitlabContextValue>(() => ({ data, error, refresh, answeredAt }), [data, error, refresh, answeredAt]);
  return <GitlabContext.Provider value={value}>{children}</GitlabContext.Provider>;
}

/** Throws outside the provider: a bare render must fail loudly rather than draw "GitLab is not configured" from a missing answer. */
export function useGitlabContext(): GitlabContextValue {
  const value = useContext(GitlabContext);
  if (value === null) throw new Error('useGitlabContext must be used inside <GitlabProvider>');
  return value;
}
