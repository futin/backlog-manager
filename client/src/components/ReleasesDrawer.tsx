import type { Release, ReleasesResponse } from '../../../shared/types';
import { TYPE_LABEL, chipLabel, displayTitle, formatReleaseDate } from '../lib/releases';
import { renderMarkdown } from '../lib/markdown';
import { Drawer } from './ui/Drawer';

/**
 * The What's new drawer (.claude/DESIGN.md §8.10, docs/subsystems/releases.md): every release this checkout carries, newest first, behind the rail's
 * version chip. The order is the route's — `GET /api/releases` already sorts — and nothing here re-sorts it.
 *
 * Rendered by `AppShell`, never inside the rail: the phone menu is a transformed ancestor, and a transformed ancestor turns a `position: fixed` panel into
 * one positioned inside it (the dashboard's reason, measured there).
 */

function Entry({ r }: { r: Release }) {
  // The baseline is where numbering starts, not something that shipped: a divider with its words in the gap, no badge, no title — but its date, as every
  // entry has, so the list says when versioning began.
  if (r.type === 'baseline') {
    return (
      <div className="releases-entry" data-testid={`release-${r.version}`}>
        <div className="releases-base">
          <span>Versioning starts here · v{r.version}</span>
          <span className="releases-date">{formatReleaseDate(r.date)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="releases-entry" data-testid={`release-${r.version}`}>
      <div className="releases-row">
        <span className="releases-ver">v{r.version}</span>
        <span className={`releases-badge releases-badge-${r.type}`}>{TYPE_LABEL[r.type]}</span>
        {r.breaking && <span className="releases-badge releases-badge-breaking">Breaking</span>}
        <span className="releases-date">{formatReleaseDate(r.date)}</span>
      </div>
      <div className="releases-title">{displayTitle(r.title)}</div>
      {/* `renderMarkdown` is the sanitising renderer the item modal uses: raw HTML is dropped and every link is hand-built with its href escaped, so the
          notes — a PR body's `## What's new` section, written by whoever opened the PR — are safe to set as HTML. */}
      {r.notes !== '' && <div className="releases-notes" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.notes) }} />}
      {r.url && r.pr !== undefined && (
        <a className="releases-pr" href={r.url} target="_blank" rel="noreferrer noopener">
          PR #{r.pr}
        </a>
      )}
    </div>
  );
}

export function ReleasesDrawer({ data, onClose }: { data: ReleasesResponse; onClose: () => void }) {
  return (
    <Drawer label="What's new" onClose={onClose}>
      <div className="releases-head">
        <h2 className="releases-head-t">What's new</h2>
        {data.current && <span className="releases-head-s">running {chipLabel(data.current)}</span>}
      </div>
      <div className="releases-list">
        {data.releases.map((r) => (
          <Entry key={r.version} r={r} />
        ))}
      </div>
    </Drawer>
  );
}
