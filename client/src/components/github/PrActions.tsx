import { useEffect, useId, useRef, useState } from 'react';

import { Chip } from '../ui/Chip';
import { Glyph, type GlyphName } from '../ui/Glyphs';
import { GlyphTile, type GlyphTileTone } from '../ui/GlyphTile';
import { Popover } from '../ui/Popover';
import { SplitChip } from '../ui/SplitChip';
import { primaryKey } from '../../lib/pr-layouts';
import { autoMergeBlock, defaultMethod, mergeBlock, mergeMain, prKey, updateBlock, whyLine, type PrOutcome } from '../../lib/prs';
import { setAutoMerge, updateBranch } from '../../lib/prs-api';
import type { PrAutoMergeRequest, PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * The one key strip every GitHub › PRs layout draws beside a pull request (.claude/DESIGN.md §8.11, "Actions and their reasons"; spec §4.8): a split Merge and
 * an icon link out to GitHub, on every PR in every layout. A person who has learned the strip on one row has learned it on all of them, so which actions a PR
 * offers is not this component's call: an action that cannot be used stays in its place, marked, and says why. The strip used to be four chips (`Merge`,
 * `Auto-merge`, `Update`, `Open ↗`); it is now one split pill, because three of those four are three ways of asking GitHub to bring the PR in, and the row was
 * paying for all of them in width.
 *
 * **The main half is `mergeMain`'s answer** (`lib/prs.ts`), the one derivation Inbox, Matrix and Cards share: `Merge` while the PR can be merged now,
 * `Auto-merge` while its checks still run and GitHub may be asked to wait, `Auto-merge on` once armed (a press disarms). It is ink only when it is the thing a
 * person most likely wants next (`primaryKey` says `merge`, nothing blocks it) and outline otherwise.
 *
 * **A blocked half is `aria-disabled`, never `disabled`.** `disabled` drops a button from the tab order and so out of a screen reader's reach, and every reason
 * here is a specific, fixable thing (`sync off`, `checks failing`). So the half keeps its focus (`SplitChip`'s `mainBlockedBy`), a click is swallowed, it is
 * drawn dashed reading `Blocked` — or the reason itself, with `blockedText`, for a layout with room to say it — and its reason is its `title` and the text of a
 * visually hidden sibling span its `aria-describedby` points at (a tooltip cannot be read on a phone or announced reliably; a child of the button would become
 * part of its name). The reasons are `lib/prs.ts`' (`mergeBlock`, `autoMergeBlock`, `updateBlock`), in their precedence order; this component only places
 * them. An armed PR on a sync-off repo is the one half whose NAME and look disagree on purpose: it is still `Auto-merge on #n`, because that is what it is,
 * and `Blocked`, because `sync off` stops a disarm like every write (parked: whether the page should let a person disarm from a repo it will not write to).
 *
 * **The chevron opens `Merge menu`, the tenth `Popover` composer**: `Merge` (asks first, then merges), `Enable auto-merge` / `Disable auto-merge` and
 * `Update branch`, each a plain button with a tile. A blocked row is `aria-disabled` and its sub-line IS the reason, pointed at by `aria-describedby`, so the
 * menu says the same thing the half does without a tooltip. The row `primaryKey` names carries an `aria-hidden` tick. Focus lands on the first enabled row when
 * the menu opens; Escape (the Popover's) and a pick both hand it back to the chevron.
 *
 * **The why-line** under the strip is `whyLine`'s: only the reasons a row does not already state elsewhere — the repo's and the token's (`sync off` once, not
 * three times), never the PR's own facts, which its chips, cells and verdict already say. `omitUpdatingReason` drops `updating…` from it for a layout that
 * prints that word in a cell of its own (Matrix's Base column), so one row does not say it twice.
 *
 * **Merge only asks.** `Merge` is the one write that cannot be taken back, so neither the half nor the row sends anything: they call `onMerge`, the page
 * records this row as the confirming one, and `PrFoot` draws the Confirm under the row — the strip does not jump under the pointer. Auto-merge and Update do
 * not ask: arming is undone by the same action, and an update-branch is GitHub merging base into head, which the next push or merge simply includes. Arming
 * uses the repo's default method, leaving `method` out of the request entirely when the repo allows none.
 *
 * **In flight.** While a write of this PR runs, `busy` sets `disabled` on both halves — momentary, with no reason worth reading — closes an open menu, and the
 * Open link stays a link. `busy` is the page's in-flight set (`PrLayoutProps.inFlight`) and nothing else: this component keeps no busy state of its own, because
 * a strip that unmounts (an Inbox filter, a Matrix collapse, a layout switch) would forget it, and an action that came back while the write still ran would send
 * a head SHA the write may already have moved. The write and its outcome are the page's too (`onWrite`), so an outcome outlives a row the re-read removed.
 */
export function PrActions({
  repo,
  pr,
  updating,
  outcome,
  busy,
  onMerge,
  onWrite,
  omitUpdatingReason = false,
  blockedText = false
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  /** The page's word that an update-branch of this PR is still landing — `updateBlock` reads it, and so does the primary. */
  updating: boolean;
  /** This PR's last outcome, for `whyLine`: an `updating` outcome already says `updating…`, so the why-line does not. */
  outcome: PrOutcome | undefined;
  /** A write of this PR is in flight (the page's `inFlight`). */
  busy: boolean;
  /** `Merge` was picked: the page makes this row the confirming one. Sends nothing. */
  onMerge: () => void;
  /** Runs one write for this PR and resolves once its outcome is recorded and the page has re-read. Never rejects. */
  onWrite: (call: () => Promise<PrWriteResult>) => Promise<void>;
  /** Leave `updating…` off the why-line, for a layout that already prints it beside the row (Matrix's Base cell). */
  omitUpdatingReason?: boolean;
  /** A blocked main half reads its reason instead of `Blocked`, for a layout that has the room. */
  blockedText?: boolean;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const primary = primaryKey(pr, repo, updating);
  const armed = pr.autoMerge !== null;
  const half = mergeMain(pr, repo);

  /* A write of this PR started (from this strip or another layout's): the menu's rows could send a head SHA the write may already have moved. */
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  /* The first enabled row takes focus when the menu opens, so a keyboard reader lands inside it and Escape (Popover's) can hand focus back to the chevron. */
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('button:not([aria-disabled="true"])')?.focus();
  }, [open]);

  const arm = (): void => {
    const target = { repo: repo.repo, number: pr.number };
    const method = defaultMethod(repo.methods);
    // Built rather than spread with `method: method ?? undefined`, so a repo that allows no method sends a request with no `method` key at all — what the
    // server's request shape says, rather than relying on the serializer to drop an `undefined`.
    const body: PrAutoMergeRequest = armed ? { ...target, enable: false } : method === null ? { ...target, enable: true } : { ...target, enable: true, method };
    void onWrite(() => setAutoMerge(body));
  };
  const update = (): void => void onWrite(() => updateBranch({ repo: repo.repo, number: pr.number, headSha: pr.headSha }));

  const base = pr.base;
  // `tone` is the mock's tile ground (`PRs.dc.html` `.tile` / `.tile.g`): Merge is the one green mark, auto-merge and Update are neutral, so the one write that cannot be taken back is the one tinted mark in the menu and the
  // two reversible ones recede.
  const rows: { id: string; glyph: GlyphName; tone: GlyphTileTone; label: string; sub: string; block: string | null; act: () => void; primary: boolean }[] = [
    {
      id: 'merge',
      glyph: 'merge',
      tone: 'green',
      label: 'Merge',
      sub: `asks first, then merges into ${base}`,
      block: mergeBlock(pr, repo),
      act: onMerge,
      primary: primary === 'merge'
    },
    armed
      ? {
          id: 'auto',
          glyph: 'clock',
          tone: 'neutral',
          label: 'Disable auto-merge',
          sub: 'GitHub stops waiting to merge',
          block: autoMergeBlock(pr, repo),
          act: arm,
          primary: false
        }
      : {
          id: 'auto',
          glyph: 'clock',
          tone: 'neutral',
          label: 'Enable auto-merge',
          sub: 'GitHub merges when checks pass',
          block: autoMergeBlock(pr, repo),
          act: arm,
          primary: false
        },
    {
      id: 'update',
      glyph: 'up',
      tone: 'neutral',
      label: 'Update branch',
      sub: `merge ${base} into ${pr.head}`,
      block: updateBlock(pr, repo, updating),
      act: update,
      primary: primary === 'update'
    }
  ];

  const mainId = `${ids}-main`;
  const word = half.mode === 'merge' ? 'Merge' : half.mode === 'arm' ? 'Auto-merge' : 'Auto-merge on';
  const reasons = whyLine(pr, repo, updating, outcome?.kind).filter((reason) => !(omitUpdatingReason && reason === 'updating…'));
  const close = (): void => setOpen(false);

  return (
    <div className="prs-keys-side" data-testid={`pr-keys-${prKey(repo.repo, pr.number)}`}>
      <div className="prs-keys">
        <span className="prs-keys-merge">
          <SplitChip
            label={`${word} #${pr.number}`}
            labelMore={`Merge options for #${pr.number}`}
            // A blocked half wears the dashed skin ALONE: `.ui-split-outline` sits after `.ui-split-dashed` in the primitives block at equal specificity, so
            // passing both drew a solid border and ink text on `Blocked` (ui-verify D4, 2026-11-05). `ink` is SplitChip's no-skin value, not a filled pill
            // here — every ink rule is `:not(.ui-split-dashed)`.
            variant={half.block === null && !(primary === 'merge' && half.mode === 'merge') ? 'outline' : 'ink'}
            dashed={half.block !== null}
            mainBlockedBy={half.block === null ? undefined : mainId}
            title={half.block ?? undefined}
            icon={<Glyph name={half.mode === 'merge' ? 'merge' : 'clock'} />}
            disabled={busy}
            onMain={half.mode === 'merge' ? onMerge : arm}
            onMore={() => setOpen((o) => !o)}
            open={open}
            moreRef={moreRef}
          >
            {half.block === null ? word : blockedText ? half.block : 'Blocked'}
          </SplitChip>
          {open && !busy && (
            <Popover label="Merge menu" width={280} anchor={moreRef} onClose={close}>
              <div ref={menuRef} className="prs-keys-rows">
                {rows.map((row) => {
                  // The primary row that is not blocked: the one the ground and the tick both mark, so they cannot drift apart.
                  const on = row.primary && row.block === null;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      // The primary row (the one the tick marks) rests on the `--strip-hi` ground — the mock's `.mi.on` — which every other row only takes on hover.
                      className={on ? 'prs-keys-row prs-keys-row-on' : 'prs-keys-row'}
                      aria-labelledby={`${ids}-${row.id}-label`}
                      aria-describedby={`${ids}-${row.id}-sub`}
                      aria-disabled={row.block === null ? undefined : 'true'}
                      onClick={() => {
                        // The other half of `aria-disabled`: a click on a control that is only labelled disabled still arrives, so this makes it inert.
                        if (row.block !== null) return;
                        close();
                        moreRef.current?.focus();
                        row.act();
                      }}
                    >
                      <GlyphTile glyph={row.glyph} tone={row.tone} size={28} />
                      <span className="prs-keys-text">
                        <span id={`${ids}-${row.id}-label`} className="prs-keys-label">
                          {row.label}
                        </span>
                        <span id={`${ids}-${row.id}-sub`} className="prs-keys-sub">
                          {row.block ?? row.sub}
                        </span>
                      </span>
                      {on && (
                        <span className="prs-keys-tick" aria-hidden="true">
                          <Glyph name="tick" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </Popover>
          )}
        </span>
        <Chip as="a" size={28} href={pr.url} aria-label={`Open #${pr.number} on GitHub`} title={`Open #${pr.number} on GitHub`}>
          <Glyph name="external" />
        </Chip>
      </div>
      {/* A sibling of the strip, not a child of the half: inside a button the reason would become part of its accessible name, and a half named `Merge #5
          checks failing` is not a half called Merge #5. Visually hidden, because the visible copy is the why-line's job and it says only what the row does not. */}
      {half.block !== null && (
        <span id={mainId} className="sr-only">
          {half.block}
        </span>
      )}
      {reasons.length > 0 && <p className="prs-why">{reasons.join(' · ')}</p>}
    </div>
  );
}
