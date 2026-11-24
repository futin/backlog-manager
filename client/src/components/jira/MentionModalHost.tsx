import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraMentionsContext } from '../../hooks/JiraMentionsContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import type { JiraMentionsWrite } from '../../hooks/useJiraMentions';
import { useNow } from '../../hooks/useNow';
import { useSettings } from '../../hooks/useSettings';
import { dispatchReply, openDesktopJira, replyRepos, stopJira } from '../../lib/jira';
import type { JiraMention, JiraMentionIssue } from '../../../../shared/types';
import { JiraMentionModal, type MentionTicketState } from './JiraMentionModal';

/**
 * The mention modal with every read and write wired from the shell's contexts (DESIGN.md §8.9.7; Jira mentions <-> board link, Task 4) — what
 * `JiraMentionsView` used to hold inline, lifted so the board can open the same dialog from an `@ N` mark. It reuses `JiraMentionModal`, so the dialog count
 * stays ten: this is a wiring component, not a new dialog.
 *
 * The CALLER owns the stop (which ticket and mention, the position in whatever order it walks, prev/next, close); the host owns everything derived from the
 * live answer, re-read on every render and kept nowhere: the ticket's state (`open` in `data.issues`, `dismissed` in `data.dismissed`, else `gone`), the
 * freshest copy of the issue, the repo picker, the session link and each write. A poll that moves the ticket to Dismissed therefore changes the footer
 * without a remount.
 *
 * `onOpenPage(key)` is the caller's way to the ticket's full page (board link Task 6): the modal's `Open ticket page` chip closes the dialog and then calls it
 * with the shown ticket's key; `null` draws no chip.
 */
export function MentionModalHost({
  issue,
  mention,
  position,
  onPrev,
  onNext,
  onClose,
  onOpenPage
}: {
  issue: JiraMentionIssue;
  mention: JiraMention;
  position: { at: number; of: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
  onOpenPage: ((key: string) => void) | null;
}) {
  const { data, reload, dismiss, restore, discardDraft, postReply } = useJiraMentionsContext();
  const status = useJiraContext().data;
  const sessions = useJiraSessionsContext();
  const { settings } = useSettings();
  const now = useNow(true);

  const open = data?.configured ? data.issues.find((i) => i.key === issue.key) : undefined;
  const set = data?.configured ? data.dismissed.find((i) => i.key === issue.key) : undefined;
  const state: MentionTicketState = open !== undefined ? 'open' : set !== undefined ? 'dismissed' : 'gone';
  const shown = open ?? set ?? issue;
  const replySession = shown.session?.sessionId ?? null;
  const sessionLink = replySession === null ? null : (sessions.data?.links.find((l) => l.key === shown.key && l.sessionId === replySession) ?? null);
  // A call to the agents routes as the modal's write outcome: a thrown sentence is its refusal line, never swallowed. `reread` is for a dispatch or Stop the
  // dashboard accepted — both answers move, so both are re-read; a Desktop hand-over moves neither.
  const attempt = async (run: () => Promise<unknown>, reread: boolean): Promise<JiraMentionsWrite> => {
    try {
      await run();
      if (reread) {
        reload();
        void sessions.reload();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };

  return (
    <JiraMentionModal
      issue={shown}
      mention={mention}
      state={state}
      me={data?.configured ? data.me : ''}
      now={now}
      position={position}
      onPrev={onPrev}
      onNext={onNext}
      // Dismiss is the ticket's, as on the page: every mention the latest answer holds for it.
      onDismiss={() => dismiss(issue.key, shown.mentions.map((x) => x.commentId))}
      onRestore={() => restore(issue.key)}
      repos={replyRepos(shown.key.split('-')[0], status?.repos ?? {})}
      sessionLink={sessionLink}
      onDraft={(repo) => attempt(() => dispatchReply(shown.key, repo, settings), true)}
      onStop={(sessionId) => attempt(() => stopJira(shown.key, sessionId), true)}
      onDiscard={() => discardDraft(shown.key)}
      onPost={(text) => postReply(shown.key, text)}
      onHandover={(sessionId) => attempt(() => openDesktopJira(sessionId), false)}
      onOpenPage={onOpenPage === null ? null : () => onOpenPage(shown.key)}
      onClose={onClose}
    />
  );
}
