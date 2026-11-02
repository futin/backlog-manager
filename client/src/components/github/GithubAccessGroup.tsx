import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Pill } from '../ui/Pill';
import { usePullRequests } from '../../hooks/usePullRequests';
import { splitReach } from '../../lib/pr-layouts';

/**
 * GitHub › Settings' `Access` card (.claude/DESIGN.md §8.6's settings card, applied the way `GithubSyncGroup` applies it; PRs-layouts spec, "GitHub ›
 * Settings › Access") — the repos GitHub › PRs leaves out because the token cannot read their pull requests, each with the sentence GitHub gave, then the
 * repos it DOES read but whose check runs and commit statuses it may not (`PrRepoView.checksDetail`), and what to change on the token. Settings is where a
 * person goes to fix a connection, so the PRs page's `N repos hidden` note links here rather than explaining itself.
 *
 * **Two lists, two pills, one fix note.** `Not readable` (a `bad` pill, `N without access`) is the repo the page hides; `Checks not readable` (a `warn` pill,
 * `N without checks`) is a repo the page draws with every PR's checks `unknown` — a fine-grained token without `Checks` and `Commit statuses` reads a private
 * repo's PRs in full and is refused that one field, which until 2026-11-02 the server took for a refusal of the repo. Warn and not bad because the PRs are
 * there and the merge still works; a row, because a person reading `checks unknown` on every card needs to find the sentence and the permission in one place.
 * The fix note names all four permissions once, since one token setting serves both lists.
 *
 * **Drawn only when there is something to say.** It renders nothing before the first answer, with no token (then every repo is simply unread, and the Sources
 * card already says so) or when every repo reads in full — a card that said `0 without access` would be a report about nothing. A listed repo comes back on
 * its own: the next read that answers `ok`, or delivers every rollup, takes it off this card, with no button here, because there is nothing to retry from the
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
  // Drawn repos whose checks the token may not read. Disjoint from `hidden` by construction — `checksDetail` is set by a read that answered `ok` — so a repo
  // is on one list or the other, never both.
  const unreadChecks = shown.filter((repo) => repo.checksDetail !== null);
  if (hidden.length === 0 && unreadChecks.length === 0) return null;

  return (
    <SettingsGroup
      title="Access"
      scope="this machine"
      right={
        <>
          {hidden.length > 0 && <Pill tone="bad">{hidden.length} without access</Pill>}
          {unreadChecks.length > 0 && <Pill tone="warn">{unreadChecks.length} without checks</Pill>}
        </>
      }
    >
      {hidden.length > 0 && (
        <SettingsRow
          name="Not readable"
          hint="The token cannot read pull requests on these repos, so GitHub › PRs leaves them out. Each comes back on its own once it can."
        />
      )}
      {hidden.map((repo) => (
        <SettingsRow key={`access:${repo.repo}`} name={repo.repo} hint={<span className="set-error">{repo.detail ?? repo.access}</span>} />
      ))}
      {unreadChecks.length > 0 && (
        <SettingsRow
          name="Checks not readable"
          hint="The token reads these repos' pull requests but not their check runs or commit statuses, so every PR there shows checks unknown. Each clears on its own once it can."
        />
      )}
      {unreadChecks.map((repo) => (
        <SettingsRow key={`checks:${repo.repo}`} name={repo.repo} hint={<span className="set-error">{repo.checksDetail}</span>} />
      ))}
      <SettingsRow
        name="To fix it"
        hint={
          <>
            <span className="set-hint-line">
              Give the fine-grained token repository access to these repos, with <strong>Pull requests: Read and write</strong> (list, update branch,
              auto-merge), <strong>Contents: Read and write</strong> (merge), <strong>Checks: Read-only</strong> and{' '}
              <strong>Commit statuses: Read-only</strong> (the checks of a private repo&apos;s PRs).
            </span>
            <span className="set-hint-line">
              A permission or repository-access change on github.com applies to the same token with no restart. Only a new token value goes in{' '}
              <code>BM_GITHUB_TOKEN</code> in this machine&apos;s <code>.env</code>, and that needs the stack recreated.
            </span>
          </>
        }
      />
      <SettingsRow name="Readable" hint={`${shown.length} ${shown.length === 1 ? 'repo' : 'repos'} readable.`} />
    </SettingsGroup>
  );
}
