import { useRef, useState } from 'react';

import { skillCommand } from '../../lib/jira';
import type { GitlabMr, JiraSkill, ReviewHalf } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Glyph, type GlyphName } from '../ui/Glyphs';
import { Popover } from '../ui/Popover';
import { ReviewSplit } from './ReviewRow';

/**
 * ReviewMenu — `Review ▾`, the control that picks WHO reviews one MR (Jira review skills spec §4; mock `Main.dc.html`'s target row, `▶ Request review ▾`
 * and its menu; DESIGN.md §8.9.6, Delivery › the next row). `NextRow` draws it only while this machine has at least one review skill; with none the row
 * keeps today's lone `ReviewSplit` and never mounts this file, so a machine without review skills sees exactly what it saw before them.
 *
 * **Two triggers, one menu.** On a `request`/`fix` row (`ghost` false) the trigger is `ReviewSplit` with its chevron half, `More reviewers`: the left half
 * stays the bot's preset action, and the menu opens with `Built in` — the bot row, worded for this half (`Review bot — request review` / `Posts the review
 * request on !<iid>`, or `Review bot — fix findings` / `Fixes the open findings on !<iid>`) and marked `default`, because it is what the left half does —
 * then `Your review skills`. On every other OPEN-MR row (`ghost` true: `Open session`, `Run ▾`, the GitLab chip, or nothing) the trigger is the ghost
 * `Review ▾` — an outline split with one half, label `Review` and the `Chevron` mark (the chevrons guard bans a text triangle), named `Review with a skill` —
 * and its menu holds the skills ALONE: a bot dispatch without a half is refused (`jira-dispatch.service.ts`), and these rows are exactly the ones the bot
 * has no half on. Picking a reviewer per MR must not wait on the bot's state (the user's call, 2026-11-20).
 *
 * **Rows in `JiraRunMenu`'s language** (`.jira-run-*`: head, 40 px row, 28 px tile, label over a quiet sub-line, the `default` mark at the right end) so the
 * two menus a ticket carries read as one family; a skill row's sub-line is `skillCommand` (its leading slash command, or nothing) and its title the whole
 * prompt. Only `group: 'review'` skills are passed in — the caller filters, as `JiraRunMenu` filters to `run`, so neither menu can offer the other's.
 *
 * **One gate.** `blocked` is `reviewGateText`'s sentence while `reviewGate` holds (the caller computes it once for the row): the trigger is disabled in the
 * dashed skin, titled with it and pointing at the row's reason line (`whyId`), and — should the gate arrive while the menu is open — every row is disabled
 * with the same title, so a pick can never start what the trigger would now refuse. Dispatch's 409s stay the authority for what this view cannot see.
 *
 * **Escape is the stack's.** The panel is a `ui/Popover`, so it joins `useDialogEscape` while open — Escape closes the menu and nothing under it (the issue
 * modal stays), and focus returns to the trigger — and binds no key of its own. The wrapper (`.jira-review`) is the popover's positioning parent, as
 * `.jira-run` is `Run ▾`'s. A pick closes the menu first and then calls through; what opens is the launch sheet, held by `JiraView` above the modal.
 */
// 340, not `Run ▾`'s 300: the bot row carries the `default` mark beside the longest fixed label any reviewer menu has (`Review bot — request review` over
// `Posts the review request on !<5-digit iid>`), and at 300 both lines ellipsised before the iid — the one fact that says which MR the bot will touch
// (2026-11-20 ui-verify). The mock's panel is ~330 px; the phone shape ignores the width.
const MENU_WIDTH = 340;

interface MenuRow {
  id: string;
  label: string;
  sub: string;
  title: string;
  glyph: GlyphName;
  isDefault: boolean;
  pick: () => void;
}

export function ReviewMenu({
  mr,
  half,
  skills,
  blocked,
  whyId,
  onBot,
  onSkill,
  ghost
}: {
  /** This row's MR: its iid words the bot row, and every pick acts on it. */
  mr: GitlabMr;
  /** The bot's half on this row, or `null` where it has none (a ghost). */
  half: ReviewHalf | null;
  /** The review skills, in the stored (menu) order. */
  skills: readonly JiraSkill[];
  /** `reviewGateText`'s sentence while the gate holds, else `null`. */
  blocked: string | null;
  /** The row's reason line, which a blocked trigger points at. */
  whyId: string;
  /** The bot row's action — the split's left half. Absent on a ghost. */
  onBot?: () => void;
  onSkill: (id: string) => void;
  /** Draw the ghost `Review ▾` (skills only) rather than the split with its chevron. */
  ghost: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const toggle = (): void => setOpen((o) => !o);
  const choose = (act: () => void): void => {
    setOpen(false);
    act();
  };

  const bot: MenuRow | null =
    ghost || half === null || onBot === undefined
      ? null
      : {
          id: 'bot',
          label: half === 'fix' ? 'Review bot — fix findings' : 'Review bot — request review',
          sub: half === 'fix' ? `Fixes the open findings on !${mr.iid}` : `Posts the review request on !${mr.iid}`,
          title: half === 'fix' ? 'Review bot — fix findings' : 'Review bot — request review',
          glyph: 'play',
          isDefault: true,
          pick: () => choose(onBot)
        };
  const rows: MenuRow[] = skills.map((k) => ({
    id: k.id,
    label: k.name,
    sub: skillCommand(k.prompt) ?? '',
    title: k.prompt,
    glyph: 'sparkle',
    isDefault: false,
    pick: () => choose(() => onSkill(k.id))
  }));

  const row = (r: MenuRow) => (
    <button
      key={r.id}
      type="button"
      className={r.isDefault ? 'jira-run-opt jira-run-opt-default' : 'jira-run-opt'}
      title={blocked ?? r.title}
      disabled={blocked !== null}
      onClick={() => {
        if (blocked === null) r.pick();
      }}
    >
      <span className="jira-run-tile" aria-hidden="true">
        <Glyph name={r.glyph} />
      </span>
      <span className="jira-run-text">
        <span className="jira-run-label">{r.label}</span>
        {r.sub !== '' && (
          <span className="jira-run-sub" aria-hidden="true">
            {r.sub}
          </span>
        )}
      </span>
      {r.isDefault && (
        <span className="jira-run-mark" aria-hidden="true">
          <Glyph name="tick" size={14} />
          default
        </span>
      )}
    </button>
  );

  const split = bot !== null && half !== null && onBot !== undefined;
  return (
    <span className="jira-review">
      {split ? (
        <ReviewSplit
          label={half === 'fix' ? 'Fix review' : 'Request review'}
          blocked={blocked}
          whyId={whyId}
          onClick={onBot}
          more={{ open, onToggle: toggle, anchor }}
        />
      ) : (
        // The ghost: `Chip`'s outline look on the split family (`.ui-split-outline`), so its blocked state is the split's own dashed skin and the two triggers
        // a row can carry are drawn from one primitive's states.
        <span className={blocked === null ? 'ui-split ui-split-28 ui-split-outline' : 'ui-split ui-split-28 ui-split-dashed'} title={blocked ?? undefined}>
          <button
            type="button"
            ref={anchor}
            className="ui-split-main"
            aria-label="Review with a skill"
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={blocked !== null}
            title={blocked ?? undefined}
            aria-describedby={blocked === null ? undefined : whyId}
            onClick={toggle}
          >
            Review
            <Chevron dir={open ? 'up' : 'down'} />
          </button>
        </span>
      )}
      {open && (
        <Popover label="Review menu" width={MENU_WIDTH} anchor={anchor} onClose={() => setOpen(false)}>
          {bot !== null && (
            <>
              <div className="jira-run-head">Built in</div>
              {row(bot)}
            </>
          )}
          <div className="jira-run-head">Your review skills</div>
          {rows.map(row)}
        </Popover>
      )}
    </span>
  );
}
