import { useReviewSetting } from '../../hooks/useReviewSetting';
import { SettingsGroup } from '../ui/SettingsRow';
import { ReviewerFields } from './ReviewerFields';

/**
 * The reviewer config's Settings card (reviewer coverage task 11, spec §7; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup` of `SettingsRow`s, the
 * composition `TimeZoneGroup` and `TickGroup` make). Which model and effort review a change, once per group or split by group size.
 *
 * On the SHARED page with the `this machine` pill: the value is `~/.backlog-manager/settings/review.json` on the API host, which `backlog-execute`'s and
 * `backlog-orchestrate`'s review read when no `--review-*` flag overrides it — so it is one setting per machine, not per browser.
 *
 * Saves on every change, `TimeZoneGroup`'s pattern (`useReviewSetting.save`): the edit shows at once and the POST's answer redraws the card, a refusal puts the
 * server's value back and says so in the shared `role="alert"` wording. `config` is the hook's optimistic copy, so an edit made while an earlier save is still
 * in flight is built on that earlier edit and its POST carries both; only the newest save's answer moves the card. A `fileError` answer means the file exists but could not be read and the pickers show the defaults; the
 * hint says that saving replaces it, which is what any save does. A failed read draws one `Unavailable` row, `WatchdogGroup`'s shape — no pickers over a
 * value that does not exist.
 */
export function ReviewerGroup() {
  const { status, config, fileError, loadError, save, saveError } = useReviewSetting();
  return (
    <SettingsGroup title="Reviewer" pill="this machine">
      {fileError && (
        <div className="set-row">
          <span className="set-hint">review.json could not be read — showing defaults. Saving replaces it.</span>
        </div>
      )}
      {config !== null ? (
        <ReviewerFields value={config} onChange={(next) => void save(next)} />
      ) : (
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">{status === 'failed' ? 'Unavailable' : 'Loading'}</span>
            {status === 'failed' && (
              <span className="set-hint">
                Could not read the reviewer{loadError ? ` — ${loadError}` : ''}. This group will fill in once the API answers{' '}
                <code>GET /api/settings/review</code> again.
              </span>
            )}
          </div>
        </div>
      )}
      {saveError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">Not saved — {saveError}. The value shown is the one still on the server.</span>
        </div>
      )}
    </SettingsGroup>
  );
}
