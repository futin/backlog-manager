import { useCallback, useState } from 'react';

import { fetchHeadlessSetting, updateHeadlessSetting } from '../lib/settings-api';
import type { HeadlessConfig, HeadlessSetting } from '../../../shared/types';
import { useFetched } from './useFetched';
import { useMountedRef } from './useMountedRef';

export interface HeadlessSettingState {
  /** `loading` until the GET answers, `failed` when it could not be read. */
  status: 'loading' | 'ok' | 'failed';
  /** The setting on screen: the newest saved answer, else the GET's; `null` until the read lands. */
  setting: HeadlessSetting | null;
  loadError: string | null;
  /** True while a POST is out. The card disables its controls meanwhile, so at most one save is ever in flight. */
  saving: boolean;
  save: (config: HeadlessConfig) => Promise<void>;
  /** The server's own refusal sentence for the last save, cleared before each new one. */
  saveError: string | null;
}

/**
 * The plugin allowlist on the API host (`~/.backlog-manager/settings/headless.json`, #625): one GET on mount, and the Settings card's save.
 *
 * Simpler than `useReviewSetting` on purpose. That hook keeps an optimistic copy and a queue because the reviewer card has six fields a person edits in quick
 * succession (bug #508); this card has a switch, a remove per chip and one add field, so it disables them while a save is out instead — one POST at a time by
 * construction, and the screen always shows the server's answer. A refusal leaves the last answer on screen and says so in `saveError`. A successful save
 * also clears an `unreadable` source, since the server only writes over a file it could read.
 */
export function useHeadlessSetting(): HeadlessSettingState {
  const fetched = useFetched(fetchHeadlessSetting, []);
  const mountedRef = useMountedRef();
  const [saved, setSaved] = useState<HeadlessSetting | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(
    async (config: HeadlessConfig) => {
      setSaving(true);
      setSaveError(null);
      try {
        const fresh = await updateHeadlessSetting(config);
        if (mountedRef.current) setSaved({ config: fresh, source: 'file' });
      } catch (e) {
        if (mountedRef.current) setSaveError(e instanceof Error ? e.message : 'failed to save the plugin list');
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [mountedRef]
  );

  const setting = saved ?? fetched.value;
  return {
    status: setting !== null ? 'ok' : fetched.status === 'failed' ? 'failed' : 'loading',
    setting,
    loadError: fetched.status === 'failed' ? (fetched.error instanceof Error ? fetched.error.message : 'could not read the plugin list') : null,
    saving,
    save,
    saveError
  };
}
