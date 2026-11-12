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
 * wrote), and a refusal showing the server's value, which is what the error row says — with two additions the Settings card needs because it has six fields
 * where the time zone has one, so a second edit can land while the first save is still in flight (task-11 review, Minor 1):
 *  - The edit is shown at once, from an optimistic copy (`pending`) set BEFORE the await. The card builds every next config from the `config` it was handed,
 *    so without this a second edit is built from the last server answer and its POST silently drops the first edit's change.
 *  - Only the newest save may move the screen: each save takes a sequence number, as `useTrackers` does (#231), and an answer that is not the newest's
 *    changes nothing on screen. A superseded success is still kept as the server's value (`confirmed`, newest-wins by sequence number too), so a refused
 *    newest save falls back to what the server really holds rather than to the first read. A superseded refusal says nothing: the newer save carried its
 *    change, and that one's answer is the one that speaks.
 * A refused newest save drops the optimistic copy, so the card goes back to the server's value — the limit field's draft included, since its value moves
 * (task-11 review, Minor 2: the field and the error row must not disagree). `enabled` false is no request at all, which is how the LaunchSheet reads it
 * only under an execute PR finish.
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

  const save = useCallback(
    async (config: ReviewConfig) => {
      const seq = ++latest.current;
      setPending(config);
      setSaveError(null);
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

function stripFileError(setting: ReviewConfig & { fileError?: true }): ReviewConfig {
  const { mode, same, big, small, smallMaxLines } = setting;
  return { mode, same, big, small, smallMaxLines };
}

/**
 * A launch sheet's reviewer pick: seeded ONCE from the saved setting the moment it lands, then the person's own. `seed` is what `reviewOverride` compares the
 * pick against, so an untouched sheet sends no `review` key. Both stay `null` until the read lands — and forever if it fails — and the sheets draw no section
 * while they are, so a pick can never be made that the request would then silently drop. The seed is never re-taken from a later read: board.md's rule for the
 * sheet's model and effort, seeded from Settings and never moved under the person.
 */
export function useReviewPick(enabled: boolean): { seed: ReviewConfig | null; pick: ReviewConfig | null; setPick: (c: ReviewConfig) => void } {
  const { config } = useReviewSetting(enabled);
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
