import { useEffect, useRef, useState } from 'react';

import { useNarrow } from '../../hooks/useNarrow';
import { useSettings } from '../../hooks/useSettings';
import { openTarget, type OpenButton, type OpenButtons, type SessionLink } from '../../lib/jira-sessions';
import { needsYou, type JiraSessionState } from '../../../../shared/jira-sessions';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Popover } from '../ui/Popover';
import { SplitChip } from '../ui/SplitChip';
import { OpenChip } from './JiraSessionCard';

/**
 * SessionOpen — a session's Open control (spec §4.5; `JiraLaunch.dc.html`'s deck card): one split pill whose main half is the primary Open and whose chevron
 * opens `Session actions`, the ninth `Popover` composer. It draws on the deck card and in Detail's session card, so the two cannot disagree about what a
 * session's rows are.
 *
 * **Rows are exactly what the control would otherwise have drawn as separate chips**: the secondary Open (when `openTarget` shows it — a disabled Desktop is an
 * `aria-disabled` row carrying C2's own title, so the reason survives the move into a menu), `Unlink` and `Stop session`. The caller passes `onUnlink` /
 * `onStop` only where the card offers them (Unlink: a `branch` link; Stop: a row with `stopState`, agents on), so this component decides nothing about WHETHER
 * to offer a write. With no rows there is nothing for a chevron to open and the control is today's single `OpenChip`.
 *
 * **Both Open forms read `openTarget`**, the same function `OpenChip` reads, so C2's Desktop rule (hidden on a phone, disabled while a hand-over could fork a
 * live transcript, the guarded `jira-open-desktop` POST for a dashboard session at rest) is decided in one place whichever shape draws it.
 *
 * **Stop swaps the split for `Confirm`** in place, as `StopSession` did for its chip: the question replaces the control, the safe answer holds the focus, the
 * menu closes first. The POST itself is the parent's.
 *
 * The main half is ink while a person is wanted (`needsYou`) and outline otherwise, so the one pill that asks for you is the only dark one on the card.
 */
export function SessionOpen({
  issueKey,
  sessionId,
  row,
  launch,
  state,
  buttons,
  onHandover,
  onUnlink,
  onStop,
  busy = false
}: {
  issueKey: string;
  sessionId: string;
  row: SessionLink['row'];
  launch: SessionLink['surface'];
  state: JiraSessionState;
  buttons: OpenButtons;
  onHandover: (sessionId: string) => void;
  onUnlink?: (sessionId: string) => void;
  onStop?: (sessionId: string) => void;
  busy?: boolean;
}) {
  const { settings } = useSettings();
  const phone = useNarrow();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const plan = (b: OpenButton) => openTarget(b, sessionId, row, launch, phone, settings.linkBase);
  const primary = plan(buttons.primary);
  const secondary = buttons.secondary === null ? null : plan(buttons.secondary);
  const hasRows = secondary !== null || onUnlink !== undefined || onStop !== undefined;

  /* The first enabled row takes focus when the menu opens, so a keyboard reader lands inside it and Escape (Popover's) can hand focus back to the chevron. */
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('a, button:not([aria-disabled="true"])')?.focus();
  }, [open]);

  if (primary === null && !hasRows) return null;
  if (primary === null) return <PlainActions sessionId={sessionId} busy={busy} onUnlink={onUnlink} onStop={onStop} />;
  if (!hasRows) return <OpenChip button={buttons.primary} sessionId={sessionId} row={row} launch={launch} primary onHandover={onHandover} />;

  if (asking)
    return (
      <Confirm
        label="confirm stop"
        testId="jira-stop-confirm"
        acceptLabel="Stop session"
        dismissLabel="Keep running"
        onDismiss={() => setAsking(false)}
        onAccept={() => {
          setAsking(false);
          onStop?.(sessionId);
        }}
      >
        Stop this session? It ends mid-work; its edits stay where it left them.
      </Confirm>
    );

  const close = (): void => setOpen(false);
  return (
    <span className="jira-open">
      <SplitChip
        label={buttons.primary.label}
        labelMore={`More for ${issueKey}`}
        variant={needsYou(state) ? 'ink' : 'outline'}
        href={primary.kind === 'href' ? primary.href : undefined}
        onMain={primary.kind === 'handover' ? () => onHandover(sessionId) : undefined}
        disabled={busy || primary.kind === 'disabled'}
        title={primary.kind === 'disabled' ? (primary.title ?? undefined) : undefined}
        onMore={() => setOpen((o) => !o)}
        open={open}
        moreRef={moreRef}
      >
        {buttons.primary.label}
      </SplitChip>
      {open && (
        <Popover label="Session actions" width={220} anchor={moreRef} onClose={close}>
          <div ref={menuRef} className="jira-open-rows">
            {secondary !== null && buttons.secondary !== null && secondary.kind === 'href' && (
              <a className="jira-open-row" href={secondary.href} target="_blank" rel="noreferrer" onClick={close}>
                {buttons.secondary.label}
              </a>
            )}
            {secondary !== null && buttons.secondary !== null && secondary.kind === 'handover' && (
              <button
                type="button"
                className="jira-open-row"
                onClick={() => {
                  close();
                  onHandover(sessionId);
                }}
              >
                {buttons.secondary.label}
              </button>
            )}
            {secondary !== null && buttons.secondary !== null && secondary.kind === 'disabled' && (
              <button type="button" className="jira-open-row" aria-disabled="true" title={secondary.title ?? undefined}>
                {buttons.secondary.label}
              </button>
            )}
            {onUnlink !== undefined && (
              <button
                type="button"
                className="jira-open-row"
                title="drop this link — the session itself is not touched"
                onClick={() => {
                  close();
                  onUnlink(sessionId);
                }}
              >
                Unlink
              </button>
            )}
            {onStop !== undefined && (
              <button
                type="button"
                className="jira-open-row jira-open-danger"
                title="end this session"
                onClick={() => {
                  close();
                  setAsking(true);
                }}
              >
                Stop session
              </button>
            )}
          </div>
        </Popover>
      )}
    </span>
  );
}

/**
 * No Open is shown (a phone's Desktop-only answer, say) but Unlink or Stop still is: today's plain controls, no split — a split with no main half would be a
 * chevron over nothing. Stop keeps its `Confirm` in place of the chip.
 */
function PlainActions({ sessionId, busy, onUnlink, onStop }: { sessionId: string; busy: boolean; onUnlink?: (id: string) => void; onStop?: (id: string) => void }) {
  const [asking, setAsking] = useState(false);
  if (asking)
    return (
      <Confirm
        label="confirm stop"
        testId="jira-stop-confirm"
        acceptLabel="Stop session"
        dismissLabel="Keep running"
        onDismiss={() => setAsking(false)}
        onAccept={() => {
          setAsking(false);
          onStop?.(sessionId);
        }}
      >
        Stop this session? It ends mid-work; its edits stay where it left them.
      </Confirm>
    );
  return (
    <>
      {onUnlink !== undefined && (
        <Chip size={28} variant="flat" disabled={busy} title="drop this link — the session itself is not touched" onClick={() => onUnlink(sessionId)}>
          Unlink
        </Chip>
      )}
      {onStop !== undefined && (
        <Chip size={28} variant="danger" disabled={busy} title="end this session" onClick={() => setAsking(true)}>
          Stop session
        </Chip>
      )}
    </>
  );
}
