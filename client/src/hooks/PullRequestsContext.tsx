import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { hasTracker } from '../lib/tracker';
import type { PullRequestsPayload } from '../../../shared/types';
import { useTrackersContext } from './TrackersContext';
import { usePullRequests } from './usePullRequests';

export interface PullRequestsContextValue {
  data: PullRequestsPayload | null;
  error: string | null;
  refresh: () => Promise<PullRequestsPayload | null>;
  /** Whether the shell is reading PRs at all: a GitHub project is registered. `false` means `data` and `error` are `null` because nothing was asked. */
  enabled: boolean;
}

const PullRequestsContext = createContext<PullRequestsContextValue | null>(null);

type Read = Pick<PullRequestsContextValue, 'data' | 'error' | 'refresh'>;

const DISABLED: PullRequestsContextValue = { data: null, error: null, refresh: () => Promise.resolve(null), enabled: false };

/** The one mounted `usePullRequests()`: it renders nothing and reports its answer up, so toggling `enabled` never remounts the tree under the provider. */
function PullRequestsReader({ onRead }: { onRead: (read: Read) => void }) {
  const read = usePullRequests();
  useEffect(() => onRead(read), [onRead, read.data, read.error, read.refresh]); // eslint-disable-line react-hooks/exhaustive-deps -- `read` is these three parts
  return null;
}

/**
 * The shell's one read of `GET /api/prs` (spec §4.9a): the rail counts PRs that need you on every page, so the read can no longer belong to the two pages
 * that draw PRs. It is on while a GitHub project is registered (`hasTracker`) — the PRs page's own no-token message keeps working, because a registered
 * project with no token still answers `{ token: false }` — and nothing mounts, so nothing is requested, while there is none. The server's PR cache stays on
 * demand with no timer of its own: this reader's 60 s poll is what arms it, and it is armed only while a GitHub project exists. GitHub › PRs and Settings'
 * `Access` card read this answer instead of each running a poll, so there is one request a minute however many readers there are.
 */
export function PullRequestsProvider({ children }: { children: ReactNode }) {
  const { data: trackers } = useTrackersContext();
  const enabled = trackers !== null && hasTracker(trackers.projects);
  const [read, setRead] = useState<Read | null>(null);
  const value = useMemo<PullRequestsContextValue>(() => (enabled && read !== null ? { ...read, enabled } : { ...DISABLED, enabled }), [enabled, read]);
  return (
    <PullRequestsContext.Provider value={value}>
      {enabled && <PullRequestsReader onRead={setRead} />}
      {children}
    </PullRequestsContext.Provider>
  );
}

/** Throws outside the provider: a bare render must fail loudly rather than draw an empty PR list that looks like "no PRs". */
export function usePullRequestsContext(): PullRequestsContextValue {
  const value = useContext(PullRequestsContext);
  if (value === null) throw new Error('usePullRequestsContext must be used inside <PullRequestsProvider>');
  return value;
}
