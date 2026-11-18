import { JIRA_REPLY_MAX_CHARS } from '../../../../shared/types';
import { chipMentions, replyMarkdown } from '../../lib/jira-mentions';
import { renderMarkdown } from '../../lib/markdown';
import { Chip } from '../ui/Chip';
import { Modal } from '../ui/Modal';

/**
 * The reply editor (DESIGN.md §8.9.7; spec `docs/superpowers/specs/2026-11-18-jira-reply-markdown-design.md`, "Draft box and Reply editor"): the mention
 * modal's draft box opened large, Write beside Preview, so a long Markdown reply can be read the way Jira will show it before it posts.
 *
 * It owns NO reply state. The text, the "newer draft" offer, the busy flag and the refusal all belong to `DraftReply` (and its parent), which renders this as
 * its own child: what is typed here is what the box shows, closing keeps it, and the editor disappears whenever the box does — posted, discarded, or replaced
 * by a Redraft run. That is also how a successful Post closes it: the post unmounts the box, and the box takes the editor with it.
 *
 * `Modal`'s split shape with an even split (`lead` false), `over` so it stacks above the mention modal it opens from, and a `foot` band carrying the
 * counter and the two actions, so Post reply stays in view however long either column scrolls. Post reply's enablement is exactly the box's — blank text,
 * past the server's cap, or a write already out — and a refusal shows here, in the foot, because the mention modal's own alert line is behind this scrim.
 *
 * The preview goes through `replyMarkdown`, which mirrors `replyDoc`'s mention placement, and renders with `breaks: true`, which mirrors its single-newline
 * `hardBreak` — so what is previewed is what posts. Only the addressee is chipped: the thread's author list is the thread's business, and the preview only
 * needs its one lead mention tinted.
 */
export function JiraReplyEditor({
  issueKey,
  to,
  text,
  onText,
  busy,
  newer,
  onUseNewer,
  error,
  onPost,
  onClose
}: {
  issueKey: string;
  to: string | null;
  text: string;
  onText: (text: string) => void;
  busy: boolean;
  newer: boolean;
  onUseNewer: () => void;
  error: string | null;
  onPost: (text: string) => void;
  onClose: () => void;
}) {
  const blank = text.trim() === '';
  const over = text.length > JIRA_REPLY_MAX_CHARS;
  const html = blank ? null : chipMentions(renderMarkdown(replyMarkdown(to, text), { breaks: true }), to === null ? [] : [to]);

  const head = (
    <div className="jira-editor-head">
      <h2 className="jira-editor-title">{`Reply to ${issueKey}`}</h2>
      {to !== null && <div className="jira-editor-to">{`To @${to}`}</div>}
    </div>
  );

  const write = (
    <div className="jira-editor-col">
      <div className="jira-detail-lbl">Write</div>
      {newer && (
        <div className="jira-reply-note">
          <span>A newer draft arrived · </span>
          <button type="button" className="jira-mention-more" onClick={onUseNewer}>
            Use it
          </button>
        </div>
      )}
      <textarea className="jira-editor-text" aria-label={`Edit reply to ${to ?? issueKey}`} value={text} onChange={(e) => onText(e.target.value)} />
    </div>
  );

  const foot = (
    <>
      {error !== null && (
        <p className="jira-modal-error jira-editor-error" role="alert">
          {error}
        </p>
      )}
      <span className="jira-reply-count jira-editor-count" data-over={over ? '' : undefined}>{`${text.length} / ${JIRA_REPLY_MAX_CHARS}`}</span>
      <Chip size={28} onClick={onClose}>
        Close
      </Chip>
      <Chip size={28} variant="ink" disabled={busy || blank || over} onClick={() => onPost(text)}>
        Post reply
      </Chip>
    </>
  );

  return (
    <Modal label={`Reply editor for ${issueKey}`} head={head} facts={write} foot={foot} over onClose={onClose}>
      <div className="jira-editor-col">
        <div className="jira-detail-lbl">Preview</div>
        <div className="jira-mention-thread jira-editor-preview">
          {html === null ? (
            <div className="jira-editor-empty">Nothing to preview yet.</div>
          ) : (
            <div className="item-body jira-mention-txt" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </Modal>
  );
}
