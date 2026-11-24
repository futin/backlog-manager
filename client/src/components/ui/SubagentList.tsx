import { useState } from 'react';

import { waitingOnSubagent } from '../../../../shared/agent';
import { useSubagents } from '../../hooks/useSubagents';
import { SUBAGENT_ORPHAN_TITLE, subagentBadge, subagentRowFacts, subagentSummary } from '../../lib/subagents';
import { Chevron } from './Chevron';
import { Pill } from './Pill';
import type { SubagentDetail } from '../../../../shared/types';

/**
 * SubagentList — one session's subagents (.claude/DESIGN.md §8.4 Runs › "Subagent list"; the same component on §8.9 Jira's session card). #611, spec
 * docs/superpowers/specs/2026-11-24-subagent-visibility-design.md, "Client".
 *
 * The open-state body: a header line (the summary, then the parent's badge when `waitingOnSubagent` says a foreground subagent holds it), a
 * `couldn't refresh — …` line when a read failed after a good one, then one row per subagent in the dashboard's order (newest first), no cap. Before the
 * first answer it is `loading subagents…`; a first failure is the route's sentence in the list's place. Every word is `lib/subagents.ts`'s, which is the
 * spec's copy table; what a state MEANS is `shared/agent.ts`'s.
 *
 * Mounting it starts `useSubagents`' 10 s poll and unmounting it stops it — which is why only `SubagentDisclosure` mounts it, and only while open.
 */
export function SubagentList({ sessionId }: { sessionId: string }) {
  const { data, error, loading } = useSubagents(sessionId);
  if (data === null) {
    return <p className="ui-subagents-note">{loading ? 'loading subagents…' : (error ?? 'loading subagents…')}</p>;
  }
  return <SubagentBody detail={data} error={error} />;
}

function SubagentBody({ detail, error }: { detail: SubagentDetail; error: string | null }) {
  // Read at render: the list re-renders on every poll's answer, so the ages move with the 10 s clock it already has and no display tick is added.
  const now = Date.now();
  const waiting = waitingOnSubagent(detail);
  const badge = subagentBadge(waiting);
  return (
    <>
      <div className="ui-subagents-head">
        <span className="ui-subagents-summary">{subagentSummary(detail, now)}</span>
        {/* A parent parked on a working subagent is a plain fact; parked on a BLOCKED one it is the blocked row's failure, in its tone. */}
        {badge !== null && <Pill tone={waiting === 'waiting-blocked' ? 'bad' : 'neutral'}>{badge}</Pill>}
      </div>
      {error !== null && <p className="ui-subagents-note bad">{`couldn’t refresh — ${error}`}</p>}
      {detail.agents.length === 0 ? (
        <p className="ui-subagents-note">no subagents</p>
      ) : (
        <ol className="ui-subagents-rows">
          {detail.agents.map((job) => {
            const f = subagentRowFacts(job, detail, now);
            return (
              <li key={job.id} className="ui-subagents-row">
                <span className="ui-subagents-state">
                  <Pill tone={f.tone}>{f.state}</Pill>
                  {f.reason !== null && <span className="ui-subagents-reason">{f.reason}</span>}
                  {f.orphan && (
                    <span className="ui-subagents-orphan" title={SUBAGENT_ORPHAN_TITLE}>
                      orphan
                    </span>
                  )}
                </span>
                <span className="ui-subagents-label" title={f.label}>
                  {f.label}
                </span>
                {f.meta !== '' && <span className="ui-subagents-meta">{f.meta}</span>}
                <span className="ui-subagents-times">
                  <span title="age">{f.age}</span>
                  {f.sinceWrite !== null && <span title="since its last transcript write">{`last write ${f.sinceWrite}`}</span>}
                </span>
                {f.lastTool !== null && (
                  <span className="ui-subagents-tool" title={f.lastTool}>
                    {f.lastTool}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/**
 * SubagentDisclosure — the `Subagents` button (same DESIGN.md subsection), collapsed by default and with no count: nothing is fetched while it is closed,
 * so a closed one has nothing to count. Open, it mounts `SubagentList` and with it the poll; closed again, it unmounts both.
 */
export function SubagentDisclosure({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-subagents">
      <button type="button" className="ui-subagents-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Chevron dir={open ? 'down' : 'right'} />
        Subagents
      </button>
      {open && (
        <div className="ui-subagents-body">
          <SubagentList sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}
