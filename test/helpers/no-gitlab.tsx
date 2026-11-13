import type { ReactNode } from 'react';

import { GitlabContext } from '../../client/src/hooks/GitlabContext';

/**
 * A GitLab answer that has not arrived, handed in through the raw context so a suite that mounts `SettingsView` (whose Sources card reads
 * `useGitlabContext`, which throws outside a provider) needs no fetch stub for `/api/gitlab` and counts no extra request.
 */
const PENDING = { data: null, error: null, refresh: () => Promise.resolve(null) };

export function NoGitlab({ children }: { children: ReactNode }) {
  return <GitlabContext.Provider value={PENDING}>{children}</GitlabContext.Provider>;
}
