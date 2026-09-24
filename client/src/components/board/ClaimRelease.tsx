import { useState } from 'react';

import { abortClaim } from '../../lib/agents';
import { claimControl } from '../../lib/tracker';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import type { BacklogItem } from '../../../../shared/types';

/** Enough of a session id to tell two apart in one sentence; the whole id is on the claim comment. */
function shortSession(session: string): string {
  return session.length > 8 ? session.slice(0, 8) : session;
}

/**
 * ClaimRelease — the item modal's **Stop & release** / **Release claim** (#225), drawn under the facts column's dispatch control (.claude/DESIGN.md §8.7:
 * the confirmation is `ui/Confirm`, inline in place of the chip, never a second overlay).
 *
 * A board-dispatched groom or execute session releases its tracker claim only by running its own closing `stop`, so a session stopped from the dashboard,
 * or dead, left the item reading as in progress on every machine until the claim went stale. This is the board's way to let go of it. Which of the two
 * labels is drawn, and whether either is, is `claimControl`'s (`lib/tracker.ts`) — nothing for a files item, a run-held claim or a claim that is not live.
 *
 * Both are confirm-gated, because both end somebody's claim on work in flight. The Release claim confirm says the one thing the server cannot see for it:
 * a board-dispatched session waiting on a reply has no process between turns, so it reads as stopped to the dashboard too. The server re-checks every
 * condition at click time and its refusal is printed verbatim — it is the only side that can see the dispatch record and the dashboard.
 *
 * `onReleased` lets the board re-read its payload; the chip is replaced by a `claim released` note meanwhile, because the item this modal holds is the
 * snapshot it was opened with and would otherwise still offer the control.
 */
export function ClaimRelease({ item, onReleased }: { item: BacklogItem; onReleased?: () => void }) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (stage === 'done') {
    return (
      <p className="item-claim-note" data-testid="claim-released">
        claim released
      </p>
    );
  }
  const control = claimControl(item, Date.now());
  if (control === null || item.holder === undefined) return null;

  const session = shortSession(item.holder.session);
  const label = control === 'stop-release' ? 'Stop & release' : 'Release claim';

  const accept = (): void => {
    setStage('busy');
    setError(null);
    abortClaim(item.projectPath, item.id)
      .then(() => {
        setStage('done');
        onReleased?.();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStage('idle');
      });
  };

  return (
    <div className="item-facts-claim">
      {stage === 'confirm' ? (
        <Confirm
          label={`confirm ${label.toLowerCase()}`}
          testId="claim-release-confirm"
          acceptLabel={label}
          dismissLabel="Keep claim"
          onDismiss={() => setStage('idle')}
          onAccept={accept}
        >
          {control === 'stop-release'
            ? `Stop session ${session} and release its claim on ${item.id}? The session ends mid-work; its edits stay where it left them.`
            : `Release session ${session}'s claim on ${item.id}? Only if that session has ended — a board-dispatched session waiting on a reply also looks stopped.`}
        </Confirm>
      ) : (
        <Chip
          size={28}
          data-testid="claim-release"
          title={control === 'stop-release' ? 'the board started this session — stop it, then release its claim' : 'release a claim whose session has ended'}
          disabled={stage === 'busy'}
          onClick={() => setStage('confirm')}
        >
          {label}
        </Chip>
      )}
      {error !== null && (
        <span className="run-controls-error" data-testid="claim-release-error">
          {error}
        </span>
      )}
    </div>
  );
}
