import { useJiraContext } from '../../hooks/JiraContext';
import { useNow } from '../../hooks/useNow';
import { accessPhrase, initialsOf, sweepLine } from '../../lib/jira';
import { pollAge } from '../../lib/tracker';
import { Pill, type PillTone } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';

/**
 * Jira › Setup › Connection (spec §4.4; mock `JiraSetup.dc.html`, the banner on top) — a REPORT of the server's `.env`, nothing to set: the site, the
 * credentials and the token are the server's environment, so the banner says `restart the server to change it` rather than offering a control that could only
 * lie. It is a banner rather than a `SettingsGroup`: one row of identity, three figures and a status pill, the card above both columns.
 *
 * - **The disc** — `initialsOf(me.name)`; no avatar is served (Jira's `/myself` gives a name and an account id, and the browser never talks to Jira). `?`
 *   with `no identity` while Jira has not answered (a 401 resets it, spec §3). Never an e-mail: the payload carries none.
 * - **`<site> · <tokenKind>`** — the token as the boot probe found it (P14). Scopes are not served by anything this server reads, so none are named.
 * - **Last sweep** — `pollAge` of the newest board `polledAt` (`—` when no board was ever polled). **Every** — `15 s` while the poller is armed, `idle`
 *   otherwise. **Calls** — the last tick's `calls.sweep`, with `sweepLine`'s `rate` under it (`no 429 since start`, or `last 429 4m ago`, red inside the
 *   chip meter's own window so the banner and the chip agree).
 * - **The pill** — `Healthy` on `ok`, amber for a rate limit or an unreachable site (the connection may come back on its own), red for everything else; a
 *   failing one reads `accessPhrase`, with the server's `detail` on a red line beneath it. The ticking age is by the second, as the Boards card's is.
 */
export function JiraConnectionGroup() {
  const { data } = useJiraContext();
  const now = useNow(true, 1_000);
  const sweep = data === null ? null : sweepLine(data.armed, data.calls, now);
  const access = data === null ? null : accessPhrase(data.access);
  const tone: PillTone = data === null || data.access === 'ok' ? 'live' : data.access === 'rate-limited' || data.access === 'unreachable' ? 'warn' : 'bad';

  // The newest `polledAt` over every board: the last time ANY sweep landed.
  let newest: string | null = null;
  let newestAt = -Infinity;
  for (const b of data?.boards ?? []) {
    const at = b.polledAt === null ? NaN : Date.parse(b.polledAt);
    if (!Number.isNaN(at) && at > newestAt) {
      newest = b.polledAt;
      newestAt = at;
    }
  }
  const name = data?.me?.name ?? null;

  return (
    <Sheet as="section" className="jira-setup-banner" label="Connection">
      <div className="jira-setup-banner-row">
        <span className="jira-setup-av">{name === null ? '?' : initialsOf(name)}</span>
        <div className="jira-setup-banner-who">
          <div className="jira-setup-banner-name">{data === null ? 'Connecting…' : name === null ? 'no identity' : `Connected as ${name}`}</div>
          <div className="jira-setup-banner-sub">{data === null ? '—' : `${data.site ?? '—'} · ${data.tokenKind ?? '—'}`}</div>
          <div className="jira-setup-banner-sub">restart the server to change it</div>
        </div>
        <div className="jira-setup-figs">
          <div className="jira-setup-fig">
            <span className="jira-setup-fig-label">Last sweep</span>
            <b>{pollAge(newest, now) ?? '—'}</b>
          </div>
          <div className="jira-setup-fig">
            <span className="jira-setup-fig-label">Every</span>
            <b>{data === null ? '—' : data.armed ? '15 s' : 'idle'}</b>
          </div>
          <div className="jira-setup-fig">
            <span className="jira-setup-fig-label">Calls</span>
            <b>{data === null ? '—' : data.calls.sweep}</b>
            {sweep !== null && <span className={sweep.red ? 'jira-setup-failure' : 'jira-setup-fig-sub'}>{sweep.rate}</span>}
          </div>
        </div>
        {/* No pill before the first read: `Connecting…` already says the state, and a green Healthy would claim what nothing has checked. */}
        {data !== null && <Pill tone={tone}>{access ?? 'Healthy'}</Pill>}
      </div>
      {data?.detail && access !== null && <div className="jira-setup-failure jira-setup-banner-detail">{data.detail}</div>}
    </Sheet>
  );
}
