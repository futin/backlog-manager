import { useFetched } from './useFetched';
import type { ProjectSummary } from '../../../shared/types';

type Sources = ReadonlyMap<string, ProjectSummary['source']>;

/** One frozen empty map, so "nothing known" has a stable identity across renders. */
const EMPTY_MAP: Sources = Object.freeze(new Map<string, ProjectSummary['source']>());

/**
 * project path → its `ProjectSummary.source` (task-48), read once on mount.
 *
 * The Runs page needs one fact about a project that no run payload carries —
 * whether its items live on a tracker — to say that a local run which has not
 * claimed an issue yet cannot be seen from other machines. That is a property
 * of the committed marker, which changes on a commit rather than on a poll,
 * so one read per mount is the whole budget.
 *
 * Fails soft to an empty map: the reading this feeds is one explanatory line,
 * and a page that could not load it must not lose anything else. Plain `fetch`
 * rather than a `lib/agents` helper because this is not an agents call.
 */
export function useProjectSources(): Sources {
  // A non-OK response or a non-array body reads as nothing known, which is the empty map below.
  const { value } = useFetched(
    () =>
      fetch('/api/projects')
        .then((res) => (res.ok ? (res.json() as Promise<unknown>) : []))
        .then((body): Sources | null =>
          Array.isArray(body)
            ? new Map((body as ProjectSummary[]).filter((p) => p && typeof p.path === 'string').map((p) => [p.path, p.source]))
            : null
        ),
    []
  );
  return value ?? EMPTY_MAP;
}
