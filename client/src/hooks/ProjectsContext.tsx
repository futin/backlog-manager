import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { ProjectSummary } from '../../../shared/types';
import { drawnSources, type DrawnSources } from '../lib/sources';
import { useMountedRef } from './useMountedRef';
import { useRefreshing } from './useRefreshing';

/**
 * The shell's one answer to "which projects are registered, and from which sources" (source-sections spec) — read once above `AppShell` so the rail can
 * draw a Files and a GitHub row only for a source that owns a project, and the shell can settle a section whose row has just vanished. Same posture as
 * `TrackersContext` and `JiraContext`: one instance, handed to every reader, because two instances would be two clocks that could hold two answers.
 *
 * `data` and `drawn` are `null` while unknown — nothing has answered yet, or every read so far failed — and a reader must treat `null` as "do not
 * decide", never as "no projects": drawing no rows, or settling away from a section, on an absent answer would move a person off the page they are on
 * because of a hiccup. After a first success a later failure keeps the last answer, the `useJira` rule: a transient 500 must not make the rail lose rows.
 *
 * Built on `useRefreshing` with no `armed` and no timer: the registry is a fact of this MACHINE, not of this tab, and changes only when someone runs
 * `backlog.mjs register` somewhere else. Mount plus window focus is exactly when a person comes back to look, which is the cadence `useBoard` and
 * `TimeZoneProvider` already use for the same reason. `reload` is the layer's own trigger, so reloads that land mid-flight fold into one follow-up.
 * `useProjectSources` (Runs) stays as it is: it reads a different fact (path → source) once per mount and is not the shell's answer.
 *
 * The default value — no provider mounted — is the unknown state with a no-op `reload`, so a component rendered bare draws what it drew before; it never
 * fetches, only the provider does.
 */
export interface ProjectsState {
  data: ProjectSummary[] | null;
  drawn: DrawnSources | null;
  reload: () => void;
}

const UNKNOWN: ProjectsState = { data: null, drawn: null, reload: () => {} };

export const ProjectsContext = createContext<ProjectsState>(UNKNOWN);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ProjectSummary[] | null>(null);
  const mountedRef = useMountedRef();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      // A non-array body is a failed read, not an empty registry: only an array may replace the last answer.
      if (Array.isArray(body) && mountedRef.current) setData(body as ProjectSummary[]);
    } catch {
      // The last good answer stays — see the header.
    }
  }, [mountedRef]);
  const trigger = useRefreshing(load);
  const reload = useCallback(() => {
    void trigger();
  }, [trigger]);

  const value = useMemo<ProjectsState>(() => ({ data, drawn: data ? drawnSources(data) : null, reload }), [data, reload]);
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjectsContext(): ProjectsState {
  return useContext(ProjectsContext);
}
