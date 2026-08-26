import { useEffect, useState } from 'react';
import { marked } from 'marked';

import type { BacklogItem, Section } from '../../../../shared/types';

const PILL: Record<Section, { cls: string; label: string }> = {
  bugs: { cls: 'pill-bug', label: 'bug' },
  ideas: { cls: 'pill-idea', label: 'idea' },
  tasks: { cls: 'pill-task', label: 'task' },
  'out-of-scope': { cls: 'pill-oos', label: 'oos' }
};

/**
 * The right-hand detail drawer. Read-only on purpose — every write to an item
 * belongs to the skills, so the drawer renders and never edits.
 *
 * The body is fetched on open rather than carried in the index: the index is
 * refetched on every window focus, and shipping every body every time would
 * make that refresh pay for content nobody is looking at.
 */
export function ItemDrawer({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setFailed(false);
    fetch(`/api/items/body?path=${encodeURIComponent(item.path)}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((text) => {
        if (alive) setBody(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* marked is synchronous unless handed async extensions — none here. The
     HTML goes in via dangerouslySetInnerHTML, which is fine for exactly one
     reason: these are the user's own local Markdown files, served through the
     registry allowlist. Nothing here renders content from another origin. */
  const html = body === null ? '' : (marked.parse(body, { async: false }) as string);

  return (
    <>
      <div className="drawer-backdrop" data-testid="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={item.title}>
        <div className="drawer-head">
          <span className={`pill ${PILL[item.section].cls}`}>{PILL[item.section].label}</span>
          <span className="drawer-title">{item.title}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>
        <div className="drawer-meta">
          <span>
            {item.id} · {item.project} · {item.created}
            {item.status === 'done' ? ' · done' : ''}
            {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
          </span>
          <span className="drawer-path">{item.path}</span>
        </div>
        <div className="drawer-body">
          {failed ? (
            <div className="drawer-empty">item file unavailable</div>
          ) : body === null ? (
            <div className="drawer-empty">loading…</div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </aside>
    </>
  );
}
