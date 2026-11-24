import { useCallback, useState } from 'react';

import { fetchSubagents } from '../lib/subagents';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';
import type { SubagentDetail } from '../../../shared/types';

/**
 * How long after one subagents read settles the next is asked. Ten seconds is fast enough that a subagent crossing the 5-minute `quiet` line shows within
 * one poll of it, and the read is cheap on the dashboard's side (incremental) — but it only ever runs while a person holds a `Subagents` disclosure open.
 */
export const SUBAGENTS_POLL_MS = 10_000;

export interface SubagentsState {
  /** The last good answer, kept across a failed refresh; `null` until the first lands. */
  data: SubagentDetail | null;
  /** The newest failure's sentence, cleared by the next good answer. Beside a non-null `data` it is a failed REFRESH, drawn under the header. */
  error: string | null;
  /** True until the first read settles, either way. */
  loading: boolean;
}

/**
 * One session's subagents (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md, "Client"). Called only by `SubagentList`, which mounts
 * only while its disclosure is open — so the mount IS the arming, `armed` is constant `true` (`useMachines`' and `useGitlab`'s shape), and closing the
 * disclosure unmounts the hook, which clears the timer: a closed disclosure fetches nothing. One instance per open disclosure, no cap.
 *
 * It enters through `useRefreshing` (mount + window focus + the coalesced timer), never a `setInterval`, so a focus that lands mid-flight folds into one
 * follow-up. A failed read keeps the last good `data` (as `useJiraSessions` does) but, unlike that hook, says so: `error` is set, and the list draws
 * `couldn't refresh — <error>` under the header, because a frozen list of `working` rows would otherwise read as live. State is set only while mounted.
 */
export function useSubagents(sessionId: string): SubagentsState {
  const [state, setState] = useState<SubagentsState>({ data: null, error: null, loading: true });
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const data = await fetchSubagents(sessionId);
      if (mountedRef.current) setState({ data, error: null, loading: false });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setState((prev) => ({ data: prev.data, error, loading: false }));
    }
  }, [sessionId, mountedRef]);

  useRefreshing(load, { armed: true, intervalMs: SUBAGENTS_POLL_MS });
  return state;
}
