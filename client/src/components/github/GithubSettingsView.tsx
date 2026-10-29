import { TrackersGroup } from '../settings/TrackersGroup';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';

/**
 * GitHub › Settings (source-sections spec; .claude/DESIGN.md §8.6 for the card language, applied the way §8.9's Jira › Setup applies it).
 *
 * The GitHub source's own settings page: what this machine does with GitHub, under the row that shows GitHub's items, rather than on Settings › Shared
 * where a reader looking at an issue would never think to look. Settings' shape on purpose — a band with the `this machine` pill (everything here is the
 * host's: the token, the poll and `settings/tracker-sync.json`), then cards in Settings' hand-balanced columns, folding at its 1100 px.
 *
 * Until the page's own sync card lands (plan Task 6), it holds the existing `TrackersGroup`, unchanged — still mounted on Settings › Shared as well, so
 * nothing moves away from where a reader already finds it before its replacement is here. Like every source page it draws no page switch: the rail's
 * GitHub tree is the only thing that opens it.
 *
 * Default export, because `App` loads it lazily like every other page: a section's chunk loads only when it is opened.
 */
export default function GithubSettingsView() {
  return (
    <div className="set">
      <Band title="Settings" sub="how this machine follows GitHub · the token, the poll and each repo's sync interval">
        <Pill tone="neutral">this machine</Pill>
      </Band>
      <div className="set-cols">
        <div className="set-col">
          <TrackersGroup />
        </div>
      </div>
    </div>
  );
}
