import { useCallback, useState } from 'react';

import { fetchReviewSetting, updateReviewSetting } from '../lib/settings-api';
import type { ReviewConfig } from '../../../shared/types';
import { useFetched } from './useFetched';
import { useMountedRef } from './useMountedRef';

export interface ReviewSettingState {
  /** `loading` until the GET answers (or while `enabled` is false), `failed` when it could not be read as a config. */
  status: 'loading' | 'ok' | 'failed';
  /** The config on screen: the last saved answer when there is one, else the GET's; `null` until the read lands. */
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
 * `save` follows `TimeZoneContext`'s contract: `saveError` cleared before the await, the screen redrawn from the POST's answer (the config the server
 * wrote), and a refusal leaving the shown value alone — it is still the server's, which is what the error row says. `enabled` false is no request at all,
 * which is how the LaunchSheet reads it only under an execute PR finish.
 */
export function useReviewSetting(enabled = true): ReviewSettingState {
  const fetched = useFetched(enabled ? fetchReviewSetting : null, []);
  const mountedRef = useMountedRef();
  const [saved, setSaved] = useState<ReviewConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(
    async (config: ReviewConfig) => {
      setSaveError(null);
      try {
        const fresh = await updateReviewSetting(config);
        if (mountedRef.current) setSaved(fresh);
      } catch (e) {
        if (mountedRef.current) setSaveError(e instanceof Error ? e.message : 'failed to save the reviewer');
      }
    },
    [mountedRef]
  );

  const read = fetched.value;
  const config: ReviewConfig | null = saved ?? (read === null ? null : stripFileError(read));
  const status = fetched.status === 'ok' ? 'ok' : fetched.status === 'failed' ? 'failed' : 'loading';
  return {
    status: saved !== null ? 'ok' : status,
    config,
    fileError: saved === null && read?.fileError === true,
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
