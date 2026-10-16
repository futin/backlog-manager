import type { JiraPage } from '../../lib/jira-page';

/**
 * Jira › Board (Jira phase 2, spec §6.2; DESIGN.md §8.9.1) — a PLACEHOLDER until Task 8 replaces this file with the real page.
 *
 * It exists now so `JiraView` (Task 7) can import the page at its final path and name, and so the shell suite can stub it the way `nav.test.tsx` stubs
 * `BoardView`. It must not ship past Task 10: the plan's Task 8 overwrites it.
 */
export function JiraBoardView(_props: { onOpenJiraPage: (p: JiraPage) => void }) {
  return <div className="board-empty">Jira board — not built yet</div>;
}
