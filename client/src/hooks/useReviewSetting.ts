import { useCallback, useRef, useState } from 'react';

import { fetchReviewSetting, updateReviewSetting } from '../lib/settings-api';
import type { ReviewConfig } from '../../../shared/types';
import { useFetched } from './useFetched';
import { useMountedRef } from './useMountedRef';

export interface ReviewSettingState {
  /** `loading` until the GET answers (or while `enabled` is false), `failed` when it could not be read as a config. */
  status: 'loading' | 'ok' | 'failed';
  /** The config on screen: the newest save's while it is in flight, else the newest saved answer, else the GET's; `null` until the read lands. */
  config: ReviewConfig | null;
  /** The server answered its defaults because `review.json` exists but could not be read. Cleared by a successful save, which rewrote the file. */
  fileError: boolean;
  loadError: string | null;
  save: (config: ReviewConfig) => Promise<void>;
  /** The server's own refusal sentence for the last save, cleared before each new one. */
  saveError: string | null;
}

/**
 * The reviewer config on the API host (`~/.backlog-manager/settings/review.json`, reviewer coverage task 11): one GET on mount, and the Settings card's save.
 *
 * A one-shot `useFetched` read rather than `useRefreshing`'s mount-and-focus refetch (which `TimeZoneContext` uses): the time zone is read by every clock on
 * the board and has to follow an edit made on another device, while this is read by three surfaces that each want it ONCE — the Settings card, and the two
 * launch sheets, which seed their picker from it and must not have the seed move under a pick the person already made.
 *
 * `save` follows `TimeZoneContext`'s contract — `saveError` cleared before the await, the screen redrawn from the POST's answer (the config the server
 * wrote), and a refusal showing the server's value, which is what the error row says — with three additions the Settings card needs because it has six fields
 * where the time zone has one, so a second edit can be made while the first save is still in flight (task-11 review, Minor 1; bug #508):
 *  - The edit is shown at once, from an optimistic copy (`pending`) set BEFORE anything waits. The card builds every next config from the `config` it was
 *    handed, so without this a second edit is built from the last server answer and its POST silently drops the first edit's change.
 *  - Saves are serialized: at most one POST is in flight, and an edit made meanwhile is QUEUED, not sent. The server writes `review.json` last-write-wins by
 *    ARRIVAL order, and two POSTs in flight at once can arrive in either order, so the file could end on the older edit while the card showed the newer one
 *    (bug #508). Queued edits coalesce — the newest replaces any already queued, which loses nothing because it was built on the optimistic copy and so
 *    carries every earlier edit — and the queue is sent the moment the in-flight POST settles, whether it was answered, refused or failed. N edits during one
 *    POST cost exactly one more POST, carrying the newest config. A queued edit is still sent after the card unmounts: the person made it and saw it on screen.
 *  - Only the newest save may move the screen: each save takes a sequence number, as `useTrackers` does (#231), and an answer that is not the newest's
 *    changes nothing on screen. A superseded success is still kept as the server's value (`confirmed`, newest-wins by sequence number too), so a refused
 *    newest save falls back to what the server really holds rather than to the first read. A superseded refusal says nothing: the newer save carried its
 *    change, and that one's answer is the one that speaks.
 * A refused newest save drops the optimistic copy, so the card goes back to the server's value — the limit field's draft included, since its value moves
 * (task-11 review, Minor 2: the field and the error row must not disagree). `enabled` false is no request at all. The LaunchSheet reaches this through
 * `useReviewPick`'s latch, so its GET starts at the sheet's first execute PR finish and is not repeated by later Finish flips (#534).
 */
export function useReviewSetting(enabled = true): ReviewSettingState {
  const fetched = useFetched(enabled ? fetchReviewSetting : null, []);
  const mountedRef = useMountedRef();
  // The last config the server answered a save with, and the sequence number of the save it answered — the newest answer wins, whatever order they land in.
  const [confirmed, setConfirmed] = useState<ReviewConfig | null>(null);
  const confirmedSeq = useRef(0);
  // The optimistic copy: the newest save's config while it is in flight, `null` once that save has settled either way.
  const [pending, setPending] = useState<ReviewConfig | null>(null);
  const latest = useRef(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The one POST in flight and the edit queued behind it (bug #508). Refs, not state: queuing an edit must not render, and the next `save` reads the flag
  // synchronously. `queued` is ONE slot — a newer edit overwrites it — and its `done` settles every `save` call that was coalesced into it.
  const inFlight = useRef(false);
  const queued = useRef<QueuedSave | null>(null);

  // One POST and its answer. Never throws: a refusal or a network failure is handled here, so the drain loop below always goes on to the queued save.
  const post = useCallback(
    async (config: ReviewConfig, seq: number) => {
      try {
        const fresh = await updateReviewSetting(config);
        if (!mountedRef.current) return;
        if (seq > confirmedSeq.current) {
          confirmedSeq.current = seq;
          setConfirmed(fresh);
        }
        if (seq === latest.current) setPending(null);
      } catch (e) {
        if (!mountedRef.current || seq !== latest.current) return;
        setPending(null);
        setSaveError(e instanceof Error ? e.message : 'failed to save the reviewer');
      }
    },
    [mountedRef]
  );

  const save = useCallback(
    (config: ReviewConfig): Promise<void> => {
      const seq = ++latest.current;
      setPending(config);
      setSaveError(null);
      if (inFlight.current) {
        if (queued.current === null) queued.current = queuedSave(config, seq);
        else Object.assign(queued.current, { config, seq });
        return queued.current.done;
      }
      const first = queuedSave(config, seq);
      inFlight.current = true;
      void (async () => {
        let next: QueuedSave | null = first;
        while (next !== null) {
          await post(next.config, next.seq);
          next.resolve();
          next = queued.current;
          queued.current = null;
        }
        inFlight.current = false;
      })();
      return first.done;
    },
    [post]
  );

  const read = fetched.value;
  const config: ReviewConfig | null = pending ?? confirmed ?? (read === null ? null : stripFileError(read));
  const status = fetched.status === 'ok' ? 'ok' : fetched.status === 'failed' ? 'failed' : 'loading';
  return {
    status: pending !== null || confirmed !== null ? 'ok' : status,
    config,
    fileError: confirmed === null && read?.fileError === true,
    loadError: fetched.status === 'failed' ? (fetched.error instanceof Error ? fetched.error.message : 'could not read the reviewer') : null,
    save,
    saveError
  };
}

/** A save waiting for the POST in flight to settle; `done` resolves once the POST carrying its config has settled. */
interface QueuedSave {
  config: ReviewConfig;
  seq: number;
  done: Promise<void>;
  resolve: () => void;
}

function queuedSave(config: ReviewConfig, seq: number): QueuedSave {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return { config, seq, done, resolve };
}

function stripFileError(setting: ReviewConfig & { fileError?: true }): ReviewConfig {
  const { mode, same, big, small, smallMaxLines } = setting;
  return { mode, same, big, small, smallMaxLines };
}

/**
 * A launch sheet's reviewer pick: seeded ONCE from the saved setting the moment it lands, then the person's own. `seed` is what `reviewOverride` compares the
 * pick against, so an untouched sheet sends no `review` key. Both stay `null` until the read lands — and forever if it fails — and the sheets draw no section
 * while they are, so a pick can never be made that the request would then silently drop. The seed is never re-taken from a later read: board.md's rule for the
 * sheet's model and effort, seeded from Settings and never moved under the person.
 *
 * `enabled` means "start reading once this is first true", not "read while true" (#534). The hook latches it: the first render it is true sets `asked`, which
 * never goes back, and `asked` — not `enabled` — is what reaches `useReviewSetting`. So the `useFetched` key changes exactly once, and a sheet makes at most
 * ONE GET for its whole life, however often the execute sheet's Finish flips between PR and In place; a sheet is mounted per open, so that is one GET per open.
 * Gating the loader on `enabled` re-issued the GET on every flip back to PR and threw the answer away, since the seed was already taken; gating it on
 * `seed === null` instead would still re-issue it when a flip beat the first answer. Two consequences, both intended — do not "fix" either back:
 *  - A GET still in flight when `enabled` drops is kept: it lands and seeds the pick while the caller draws nothing, and the next time `enabled` is true the
 *    section is drawn already seeded, with no loading frame.
 *  - A failed GET is not retried by toggling `enabled`. The pick stays `null` forever on a failure, as said above; before the latch a flip away and back
 *    re-read by accident. Callers gate what they draw and send on their own condition (the LaunchSheet on `reviewerOffered`), never on this hook.
 */
export function useReviewPick(enabled: boolean): { seed: ReviewConfig | null; pick: ReviewConfig | null; setPick: (c: ReviewConfig) => void } {
  const [asked, setAsked] = useState(enabled);
  // Set during render, like the seed below, so the first frame with `enabled` true already starts the read — no extra commit waiting on an effect.
  if (enabled && !asked) setAsked(true);
  const { config } = useReviewSetting(asked);
  const [seed, setSeed] = useState<ReviewConfig | null>(null);
  const [pick, setPick] = useState<ReviewConfig | null>(null);
  // Adjusted during render rather than in an effect (React's "storing information from previous renders"), so the first frame that has a config already
  // draws the section seeded — no flash of an empty section, and no render that sends a launch with a seed but no pick.
  if (seed === null && config !== null) {
    setSeed(config);
    setPick(config);
  }
  return { seed, pick, setPick };
}
