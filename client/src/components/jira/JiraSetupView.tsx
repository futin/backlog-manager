import type { JiraPage } from '../../lib/jira-page';

/**
 * Jira › Setup (Jira phase 2, spec §6.4; DESIGN.md §8.9.3) — a PLACEHOLDER until Task 10 replaces this file with the real page.
 *
 * It exists now so `JiraView` (Task 7) can import the page at its final path and name, and so the shell suite can stub it the way `nav.test.tsx` stubs
 * `SettingsView`. It must not ship past Task 10, which overwrites it.
 */
export function JiraSetupView(_props: { onOpenJiraPage: (p: JiraPage) => void }) {
  return <div className="board-empty">Jira setup — not built yet</div>;
}
