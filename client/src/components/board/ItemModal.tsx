import { useEffect, useState } from 'react';

import { elapsedSince, formatSeconds } from '../../lib/item-age';
import { isInProgress, isLiveWork } from '../../lib/item-progress';
import { renderMarkdown } from '../../lib/markdown';
import { claimReading } from '../../lib/tracker';
import type { ProjectHues } from '../../lib/project-hue';
import { Dot } from '../ui/Dot';
import { Fact } from '../ui/Fact';
import { Modal } from '../ui/Modal';
import { ClaimRelease } from './ClaimRelease';
import { DispatchButton } from './DispatchButton';
import type { AgentsStatus, BacklogItem } from '../../../../shared/types';

/**
 * Integers with thousands separators, pinned to `en-US` rather than the
 * viewer's locale — `run-stats.ts`'s `formatUsd` states the reason this board
 * keeps making the same choice: two people looking at the same item should
 * read the same string, and a locale-driven `toLocaleString` gives one of them
 * `1.234.567`.
 */
function groupDigits(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * ItemModal — the item's detail, and the ONE modal this app draws
 * (.claude/DESIGN.md §8.7, the design spec's §6.1 and §12.3).
 *
 * It composes `Modal`, which owns the scrim, the exit, the Escape key and the
 * 700 px shape; this file owns what goes in the two slots. It never edits an
 * item — every write to an item file belongs to the skills. The one write it
 * can start is a TRACKER claim's release (#225, `ClaimRelease`), through the
 * server's guarded abort route, never a file.
 *
 * It was `ItemDrawer`, a panel pinned to the right edge, until task-40. The
 * facts it drew as one run-on meta line are a facts COLUMN now, one labelled
 * row each, which is what 290 px of column buys over 480 px of panel: the same
 * readings, none dropped, and each one findable without parsing a sentence.
 * Three of the facts §6.1 lists — `section`, `updated`/`last commit`, and the
 * token counters — were in `BacklogItem` all along and were the casualties of
 * that one-line shape; they are drawn here rather than left out, which is why
 * this is not quite a like-for-like move.
 *
 * The body is fetched on open rather than carried in the index: the index is
 * refetched on every window focus, and shipping every body every time would
 * make that refresh pay for content nobody is looking at.
 */
export function ItemModal({
  item,
  hues,
  onClose,
  agents,
  onDispatch,
  runBlock,
  reverify,
  trackerLine,
  onReleased
}: {
  item: BacklogItem;
  hues: ProjectHues;
  onClose: () => void;
  /** null until the status probe answers; absent when the board is rendered
   *  without dispatch at all (older tests, and any future read-only view). */
  agents?: AgentsStatus | null;
  onDispatch?: () => void;
  /**
   * Why an orchestrator run forbids dispatching this item, or null/undefined
   * when none does — passed straight through to `DispatchButton`, and looked
   * up by BoardView from the same run payload the card's own copy of this
   * prop comes from. Both render sites need it: they render two independent
   * buttons for one item, and a modal chip that stayed live while the card
   * tab went dead is half of the bug this exists to fix.
   */
  runBlock?: string | null;
  /** Re-ask the dashboard status, resolving to the fresh answer — passed
   *  straight through to `DispatchButton` (bug-13). Both render sites need
   *  it for the same reason they both need `runBlock`: the modal's chip and
   *  the card tab are two independent buttons for one item, and a chip that
   *  stayed unrecoverably disabled while the tab could clear itself would be
   *  the same contradiction on two surfaces. */
  reverify?: () => Promise<AgentsStatus>;
  /**
   * `futin/x · polled 12 s ago` for an item whose project is a connected
   * tracker, or null/undefined for every files item (task-45, spec §5.5).
   *
   * Drawn beside the body because of what the body IS here: an issue body out
   * of the poller's in-memory cache, at most one poll interval old. There is
   * no per-open fetch to GitHub — that is the whole reason the cache exists —
   * so the honest thing is to say how old the cached copy is rather than to
   * imply it was just read.
   *
   * Handed in already derived, like `runBlock` beside it and for the same
   * reason: the line needs the clock and the project list, and this modal owns
   * neither.
   */
  trackerLine?: string | null;
  /** #225 — the board's re-read after the claim control released this item's claim. Its presence is also what draws the control at all, so a render
   *  site with no payload to re-read (a test, a future read-only view) offers no write. */
  onReleased?: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /* The shared predicate, not a local copy of its two conditions — see
     item-progress.ts for why it is two and not one. This modal and the card
     render the same claim about the same item side by side, so the day the
     rule grows a third condition (a stamp past some age no longer counting as
     live, say) they have to grow it together or the board will contradict
     itself about one item on two surfaces at once.
     Read once per render rather than twice inside the JSX below, where the
     null-check and the value would each call it. No injected clock, unlike the
     card: the modal is opened, read and closed, so a reading that aged in place
     while it sat open would be motion for its own sake.
     That third condition arrived with #227: a tracker claim whose heartbeat is
     past `CLAIM_STALE_MS` is not live work, so `isLiveWork` rather than
     `isInProgress`, and the stale claim gets a fact of its own below. */
  const at = Date.now();
  const inProgress = isLiveWork(item, at);
  const elapsed = inProgress ? elapsedSince(item.started, at) : null;
  const staleHolder = isInProgress(item) && claimReading(item, at) === 'stale' ? item.holder : undefined;
  const staleAge = staleHolder === undefined ? null : elapsedSince(staleHolder.heartbeat, at);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setFailed(false);
    fetch(`/api/items/body?path=${encodeURIComponent(item.path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((text) => {
        if (alive) setBody(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  /* `renderMarkdown` (`lib/markdown.ts`) is the sanitising renderer: the HTML goes in via dangerouslySetInnerHTML below, and that is safe because the
     renderer drops raw HTML outright and hand-builds every link/image tag with its href/src escaped — see its header. */
  const html = body === null ? '' : renderMarkdown(body);

  const facts = (
    <div className="item-facts">
      {/* The project reads as a dot plus its name (§6.1) rather than as the
          filled pill the card used to draw here: a pill is a status
          micro-label, and the project is an identity. The hue is the same
          assignment the card's dot takes, from the one helper, so a card and
          the modal it opens can never disagree about a colour. */}
      <div className="item-facts-proj">
        <Dot hue={hues.hueFor(item.project)} size={10} />
        <span className="item-facts-proj-name">{item.project}</span>
      </div>
      <dl className="item-facts-list">
        <Fact label="id">{item.id}</Fact>
        <Fact label="section">{item.section}</Fact>
        {item.created !== '' && <Fact label="created">{item.created}</Fact>}
        {/* Verbatim, all three of them, and never collapsed into `lastTouched`'s
            one answer: that derivation exists to decide Board versus Archive,
            and this column is the surface someone reconciling a card against
            the bytes on disk comes to. Which rung won is their question to ask;
            printing only the winner would answer it for them, wrongly, on any
            item whose `updated` is silent because a groom edited the file
            without `start`. */}
        {item.updated !== '' && <Fact label="updated">{item.updated}</Fact>}
        {item.lastCommit !== '' && <Fact label="last commit">{item.lastCommit}</Fact>}
        {/* `null` is a reading, not a missing value: an idea, a refactor and an
            out-of-scope item have no groomed state at all (CLAUDE.md —
            "grooming is not a state they have"), so the row is absent rather
            than saying `no`, which would be a claim about them that is false. */}
        {item.groomed !== null && <Fact label="groomed">{item.groomed ? 'yes' : 'no'}</Fact>}
        {item.tags.length > 0 && <Fact label="tags">{item.tags.join(', ')}</Fact>}
        {/* Both halves, because they answer different questions — the elapsed
            is what a person reads, the parenthetical is the exact bytes on
            disk, which is what anyone reconciling a card against the file
            actually needs. The reading drops out on a value that cannot be aged
            (a hand-edited file), leaving the stored value alone rather than
            printing NaN. Gated on `isInProgress` the same way the card is, so
            an archived item reads as done rather than as still being worked. */}
        {inProgress && <Fact label="in progress">{elapsed === null ? `(since ${item.started})` : `${elapsed} (since ${item.started})`}</Fact>}
        {/* #227: in place of `in progress` when the claim has gone quiet. Aged off the HEARTBEAT, not `started` — how long nobody has been on it is
            the reading that decides whether to release it — with the stamp and, when the claim recorded one, the machine it was taken on. */}
        {staleHolder !== undefined && (
          <Fact label="stale claim">
            {`${staleAge === null ? 'no heartbeat' : `no heartbeat ${staleAge}`} (since ${staleHolder.heartbeat})${
              staleHolder.host === undefined || staleHolder.host === '' ? '' : ` · ${staleHolder.host}`
            }`}
          </Fact>
        )}
        {item.status === 'done' && <Fact label="status">done</Fact>}
        {/* Accumulated time and tokens, unlike the in-progress row above, are
            NOT gated on `inProgress` or `item.status`: they are history, not a
            live reading, and `move` never rewrites an item's content, so a done
            item's billed seconds are exactly as true after archiving as before.
            Each counter renders independently — an item can carry any subset —
            and a zero is silent rather than printing `0s`, since `0` is also
            what an item that was never groomed or executed carries (see
            BacklogItem.groomElapsed/groomTokens in shared/types.ts): there is
            nothing true to say about it. */}
        {item.groomElapsed > 0 && <Fact label="groomed for">{formatSeconds(item.groomElapsed)}</Fact>}
        {item.executeElapsed > 0 && <Fact label="worked for">{formatSeconds(item.executeElapsed)}</Fact>}
        {item.groomTokens > 0 && <Fact label="groom tokens">{groupDigits(item.groomTokens)}</Fact>}
        {item.executeTokens > 0 && <Fact label="execute tokens">{groupDigits(item.executeTokens)}</Fact>}
        <Fact label="file">
          <span className="item-facts-path">{item.path}</span>
        </Fact>
      </dl>
      {onDispatch && (
        <div className="item-facts-dispatch">
          <DispatchButton item={item} status={agents ?? null} onDispatch={onDispatch} runBlock={runBlock} reverify={reverify} />
        </div>
      )}
      {onReleased && <ClaimRelease item={item} onReleased={onReleased} />}
    </div>
  );

  return (
    <Modal label={item.title} facts={facts} onClose={onClose}>
      <h2 className="item-body-title">{item.title}</h2>
      {/* Between the title and the body, so it reads as a statement about what
          follows rather than as one more fact in the left column. */}
      {trackerLine && <p className="item-body-tracker">{trackerLine}</p>}
      <div className="item-body">
        {failed ? (
          <div className="drawer-empty">item file unavailable</div>
        ) : body === null ? (
          <div className="drawer-empty">loading…</div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </Modal>
  );
}
