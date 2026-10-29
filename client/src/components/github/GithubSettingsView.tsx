import { GithubSyncGroup } from './GithubSyncGroup';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';

/**
 * GitHub › Settings (source-sections spec; .claude/DESIGN.md §8.6 for the card language, applied the way §8.9's Jira › Setup applies it).
 *
 * The GitHub source's own settings page: what this machine does with GitHub, under the row that shows GitHub's items, rather than on Settings › Shared
 * where a reader looking at an issue would never think to look. Settings' shape on purpose — a band with the `this machine` pill (everything here is the
 * host's: the poll and `settings/tracker-sync.json`), then cards in Settings' hand-balanced columns, folding at its 1100 px.
 *
 * One card, `Sync` (`GithubSyncGroup`): each repo's sync interval, the one control the old Trackers card carried. The rest of that card — the token, the
 * login, the rate limit and each repo's reach — is a report about what this machine has connected, so it went to Settings › Shared's Sources card instead.
 * Like every source page it draws no page switch: the rail's GitHub tree, or the Sources card's link through `App`'s `onOpenGithubPage`, opens it.
 *
 * Default export, because `App` loads it lazily like every other page: a section's chunk loads only when it is opened.
 */
export default function GithubSettingsView() {
  return (
    <div className="set">
      <Band title="Settings" sub="how often this machine asks GitHub about each repo">
        <Pill tone="neutral">this machine</Pill>
      </Band>
      <div className="set-cols">
        <div className="set-col">
          <GithubSyncGroup />
        </div>
      </div>
    </div>
  );
}
