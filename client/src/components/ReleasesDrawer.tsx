import { ReleasesDrawer as KitReleasesDrawer } from 'ui-kit';

import type { ReleasesResponse } from '../../../shared/types';
import { useDialogEscape } from '../hooks/useDialogEscape';
import { useNarrow } from '../hooks/useNarrow';
import { renderMarkdown } from '../lib/markdown';

/**
 * The What's new drawer (.claude/DESIGN.md §8.10, docs/subsystems/releases.md): every release this checkout carries, newest first, behind the rail's
 * version chip. The drawer itself — the scrim, the panel, the ✕ and every entry's markup — is ui-kit's (`ReleasesDrawer`, spec D15/D16 in futin/release-kit
 * `docs/superpowers/specs/2026-10-18-shared-releases-ui-design.md`); this wrapper is the three things that stay this app's.
 *
 * Escape: `useDialogEscape(onClose)` here and `closeOnEscape={false}` on ui-kit's drawer, so the key keeps one owner and the drawer stays the sixth entry on
 * the stack. Left at ui-kit's default, the drawer would bind a `keydown` listener of its own beside the stack's, and one press would close it AND the item
 * modal it opened over — bug-23's exact defect, which `test/dialog-escape.test.tsx` pins.
 *
 * The phone shape: `narrow` is `useNarrow()`, the 700 px reading every overlay here uses — ui-kit's CSS has no media queries, so the host decides.
 *
 * Notes: `renderMarkdown` is the sanitising renderer the item modal uses (raw HTML dropped, every link hand-built with its href escaped), so the notes — a PR
 * body's `## What's new` section, written by whoever opened the PR — are safe to set as HTML. ui-kit's own escape-first default is not used: notes render
 * here exactly as they did before the move (spec D14).
 *
 * Rendered by `AppShell`, never inside the rail: the phone menu is a transformed ancestor, and a transformed ancestor turns a `position: fixed` panel into
 * one positioned inside it (the dashboard's reason, measured there).
 */
export function ReleasesDrawer({ data, onClose }: { data: ReleasesResponse; onClose: () => void }) {
  const narrow = useNarrow();
  useDialogEscape(onClose);

  return (
    <KitReleasesDrawer
      data={data}
      onClose={onClose}
      closeOnEscape={false}
      narrow={narrow}
      renderNotes={(notes) => <div dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }} />}
    />
  );
}
