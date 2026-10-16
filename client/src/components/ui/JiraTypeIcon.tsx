import type { JiraIssue } from '../../../../shared/types';

/**
 * JiraTypeIcon — a Jira issue's type glyph (.claude/DESIGN.md §8.9.1; grouped-board spec §6).
 *
 * Moved here from `JiraCard`, where it was private, because the issue modal's Children tree draws it on every row too, and a look two surfaces draw has
 * one home in `components/ui/` (CLAUDE.md) — two copies of this table would drift the first time a team's type needed a glyph.
 *
 * By what the type IS rather than what a team named it: a sub-task by Jira's own flag, an epic (or anything above it) by hierarchy level, then a bug and a
 * story by name — the two standard names every Jira site ships — and every other type the plain task square. The mocks' glyphs, as 14 px outline strokes
 * in `--ink3`; `aria-hidden`, because the type name is the wrapper's title and a screen reader gets it from the column and the modal.
 */
export function JiraTypeIcon({ type }: { type: JiraIssue['type'] }) {
  const name = type.name.toLowerCase();
  const path = type.subtask
    ? 'M5 4v10h12M13 10l4 4-4 4'
    : type.level >= 1
      ? 'M13 2 3 14h7l-1 8 10-12h-7z'
      : name === 'bug'
        ? 'M12 7a6 6 0 1 1 0 12a6 6 0 1 1 0-12M12 7V4M8 9 5 7M16 9l3-2M7 14H4M20 14h-3M8 18l-3 2M16 18l3 2'
        : name === 'story'
          ? 'M6 3h12v18l-6-4-6 4z'
          : 'M5 5h14v14H5zM9 12l2 2 4-4';
  return (
    <svg className="ui-type-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
