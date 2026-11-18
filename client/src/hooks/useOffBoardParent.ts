import { useCallback, useEffect, useRef, useState } from 'react';

import { askParent } from '../lib/jira-parent';
import type { JiraIssue } from '../../../shared/types';
import { useMountedRef } from './useMountedRef';

/** The off-board lane headers' one read: which key is out, and the one failure to show. */
export interface OffBoardRead {
  /** The key whose read is in flight — its summary button is disabled until it settles. */
  reading: string | null;
  /** The newest failed read — its sentence draws under that header only. */
  failed: { key: string; message: string } | null;
  ask(key: string): void;
}

/**
 * Click-to-read for an off-board parent's lane header (parent-lanes spec §3.2; .claude/DESIGN.md §8.9.1). Drawing a header requests nothing; a click on its
 * summary asks `askParent(key)` — the shared in-flight read, so a click that lands while Detail's own read of the key is out joins it — and opens Detail on
 * the answer.
 *
 * **Only the newest ask may act, and only on a lane still drawn.** Two headers clicked in turn race: the first read resolving last must not open Detail
 * over the second, so a settled read acts only while its key is still the newest ask. A refresh that takes the lane away (its cards moved, the filter
 * dropped it) leaves an answer nobody is looking at, so `drawn` — the off-board lane keys on screen NOW, read through a ref at landing time, not at click
 * time — must still hold the key; otherwise the answer is dropped, success and failure alike.
 *
 * **Never `useParentRead`, `retainParent` or `releaseParent`.** Those keep a copy of a parent for as long as a surface holds its key, and a page that drew
 * every off-board header through them would pin a stale copy of each for the whole page. This hook holds nothing once the read settles; the failure is the
 * same sentence `useParentRead` shows — `fetchJiraDetail`'s message, carried by the rejection.
 */
export function useOffBoardParent(onOpen: (issue: JiraIssue) => void, drawn: ReadonlySet<string>): OffBoardRead {
  const [reading, setReading] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const newest = useRef<number>(0);
  const drawnRef = useRef(drawn);
  const openRef = useRef(onOpen);
  const mounted = useMountedRef();
  useEffect(() => {
    drawnRef.current = drawn;
    openRef.current = onOpen;
  });

  const ask = useCallback(
    (key: string): void => {
      const seq = ++newest.current;
      setFailed(null);
      setReading(key);
      const settle = (act: () => void): void => {
        if (!mounted.current || seq !== newest.current) return;
        setReading(null);
        if (drawnRef.current.has(key)) act();
      };
      askParent(key).then(
        (issue) => settle(() => openRef.current(issue)),
        (err: unknown) => settle(() => setFailed({ key, message: err instanceof Error ? err.message : String(err) }))
      );
    },
    [mounted]
  );

  return { reading, failed, ask };
}
