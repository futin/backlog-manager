import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Pill } from '../ui/Pill';
import { usePullRequests } from '../../hooks/usePullRequests';
import { splitReach } from '../../lib/pr-layouts';

/**
 * GitHub › Settings' `Access` card (.claude/DESIGN.md §8.6's settings card, applied the way `GithubSyncGroup` applies it; PRs-layouts spec, "GitHub ›
 * Settings › Access") — the repos GitHub › PRs leaves out because the token cannot read their pull requests, each with the sentence GitHub gave, and what
 * to change on the token. Settings is where a person goes to fix a connection, so the PRs page's `N repos hidden` note links here rather than explaining
 * itself.
 *
 * **Drawn only when there is something to say.** It renders nothing before the first answer, with no token (then every repo is simply unread, and the Sources
 * card already says so) or when every repo reads — a card that said `0 without access` would be a report about nothing. A hidden repo comes back on its own:
 * the next read that answers `ok` takes it off this card and puts it back on the PRs page, with no button here, because there is nothing to retry from the
 * client.
 *
 * **It reads `usePullRequests`**, the PRs page's own hook, so the request, the server's 60 s cache and the payload are the same ones; this is the hook's
 * second mount. The server's PR cache still has no timer, so PRs are read only while a page that shows them is open — and this card counts as one, for the
 * same reason the PRs page does: it states a fact the read produced. Mounting Settings therefore costs at most one PR-list read per repo a minute.
 *
 * **No age on the rows.** `PrRepoView` carries `polledAt` (the last SUCCESSFUL read) and no attempt time, so a `checked … ago` would be a guess; the row is
 * the repo and its `detail`, in the `--red` text class (`.set-error`) a refusal already uses on this page. The fix note names the token's setting and the
 * variable it lives in, never a value.
 */
export function GithubAccessGroup() {
  const { data } = usePullRequests();
  if (data === null || !data.token) return null;

  const { shown, hidden } = splitReach(data.repos);
  if (hidden.length === 0) return null;

  return (
    <SettingsGroup title="Access" scope="this machine" right={<Pill tone="bad">{hidden.length} without access</Pill>}>
      <SettingsRow
        name="Not readable"
        hint="The token cannot read pull requests on these repos, so GitHub › PRs leaves them out. Each comes back on its own once it can."
      />
      {hidden.map((repo) => (
        <SettingsRow key={repo.repo} name={repo.repo} hint={<span className="set-error">{repo.detail ?? repo.access}</span>} />
      ))}
      <SettingsRow
        name="To fix it"
        hint={
          <>
            <span className="set-hint-line">
              Give the fine-grained token repository access to these repos, with <strong>Pull requests: Read and write</strong> (list, update branch,
              auto-merge) and <strong>Contents: Read and write</strong> (merge).
            </span>
            <span className="set-hint-line">
              The token is the <code>BM_GITHUB_TOKEN</code> variable in this machine&apos;s <code>.env</code>; restart the stack after changing it.
            </span>
          </>
        }
      />
      <SettingsRow name="Readable" hint={`${shown.length} ${shown.length === 1 ? 'repo' : 'repos'} readable.`} />
    </SettingsGroup>
  );
}
