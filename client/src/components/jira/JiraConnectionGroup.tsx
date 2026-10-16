import { useJiraContext } from '../../hooks/JiraContext';
import { useNow } from '../../hooks/useNow';
import { accessPhrase, sweepLine } from '../../lib/jira';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';

/**
 * Jira › Setup › Connection (Jira phase 2, spec §6.4; DESIGN.md §8.9.3, and §8.6 for the card language) — a REPORT of the server's `.env`, read-only rows off
 * `GET /api/jira` and nothing to set: the site, the credentials and the token are the server's environment, so the last line says `restart the server to
 * change it` rather than offering a control that could only lie.
 *
 * - **Site** — `site`, as the server holds it.
 * - **Signed in as** — `me.name`, Jira's answer to `/myself`, or `no identity` while it has not answered (a 401 resets it, spec §3). Never an e-mail: the
 *   payload carries none, and this card would not draw one if it did. When `access` is not `ok` the row also says so in red, with the server's `detail`
 *   after it — the spec's "the Connection row red" for a rejected credential, a rate limit or an unreachable site.
 * - **Token** — `classic` or `scoped`, as the boot probe found it (P14). The hint names the three scopes a scoped token needs and does not claim to have
 *   checked them: nothing here can — Jira reports scopes nowhere this server reads.
 * - **Last sweep** — `sweepLine`: `every 15 s` while the poller is armed, `idle` otherwise, `· N calls`, then `· last 429 <age> ago` (red while inside
 *   `JIRA_429_RED_MS`, the chip meter's own window) or `· no 429 since start`. Its age ticks by the second, as the Boards card's does.
 */
export function JiraConnectionGroup() {
  const { data } = useJiraContext();
  const now = useNow(true, 1_000);
  const sweep = data === null ? null : sweepLine(data.armed, data.calls, now);
  const access = data === null ? null : accessPhrase(data.access);

  return (
    <SettingsGroup title="Connection" scope="this machine · a report of the server's .env, nothing here is editable">
      <SettingsRow name="Site" hint="BM_JIRA_SITE">
        <span className="jira-setup-value">{data?.site ?? '—'}</span>
      </SettingsRow>
      <SettingsRow
        name="Signed in as"
        hint={
          access === null ? (
            'the name is Jira’s answer to /myself'
          ) : (
            <>
              <span className="jira-setup-failure">{access}</span>
              {data?.detail ? ` · ${data.detail}` : ''}
            </>
          )
        }
      >
        <span className="jira-setup-value">{data === null ? '—' : (data.me?.name ?? 'no identity')}</span>
      </SettingsRow>
      <SettingsRow name="Token" hint="a scoped token needs read:jira-work, write:jira-work and read:jira-user — the server does not check them">
        <span className="jira-setup-value">{data?.tokenKind ?? '—'}</span>
      </SettingsRow>
      <SettingsRow
        name="Last sweep"
        hint={
          sweep === null ? undefined : (
            <>
              {sweep.lead}
              {' · '}
              <span className={sweep.red ? 'jira-setup-failure' : undefined}>{sweep.rate}</span>
            </>
          )
        }
      />
      <div className="set-row">
        <span className="set-hint">restart the server to change it</span>
      </div>
    </SettingsGroup>
  );
}
