import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { Dot } from '../ui/Dot';
import { Ledger } from '../ui/Ledger';
import { Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';
import { PrActions } from './PrActions';
import { PrFoot } from './PrFoot';
import { PrOutcomeLine, hasOutcomeLine } from './PrOutcomeLine';
import { PrRepoNotes } from './PrRepoNotes';
import type { PrLayoutProps } from './pr-layout-props';
import {
  LEVEL_DOT,
  LEVEL_LABEL,
  MATRIX_COLUMNS,
  MATRIX_LABEL,
  ageText,
  columnCounts,
  matrixCells,
  rankPrs,
  transientFailures,
  type CellTone,
  type RankedPr
} from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import type { PrWriteResult } from '../../../../shared/types';

/**
 * GitHub › PRs, Matrix layout (.claude/DESIGN.md §8.11; specs `2026-10-29-prs-layouts-design.md`, "Matrix", and `2026-10-30-prs-page-fixes-design.md`,
 * "Matrix"): one table row per pull request, one column per check, so a person scanning for "what is red" reads down a column instead of across a card. It
 * decides nothing — the rank, the dot, every cell's text and tone and every header count are `lib/pr-layouts.ts`'s, the run warning is `lib/pr-run.ts`'s, and
 * every write is `PrActions`' and `PrFoot`'s — so Matrix cannot triage a PR differently from Inbox.
 *
 * **The dot is the triage; the cells are the evidence.** A cell reports its own fact whatever the row's level (`matrixCells`), so a draft with failing checks
 * sits among the Quiet rows with a red Checks cell, counted in that header. Colour is for a problem only: `.prs-cell-ok` and `-na` are ink, and the tone word
 * is always the cell's text too, so colour is never the only carrier. The header count is the number of rows whose cell in that column is bad or meh.
 *
 * **A real `<table>` in a scroll box of its own, inside `Ledger`, inside a `Sheet`** (§8.4: every table scrolls inside its own sheet). The sheet is the
 * card the dashboard's Management matrices sit on, which this layout was ported from; without it the table lay bare on the well and read as a different page
 * from its source. `Ledger` is used without `columns`, as Runs › Watchdog's feed is: a grid template would lay the columns out and the table's own semantics
 * would fight it. Matrix is drawn at every width, so the table keeps its columns' natural widths and the box (`.prs-matrix-scroll`) scrolls sideways when the
 * pane is narrower than their sum. That box is this page's, not `Ledger`'s, because it must be a size container for the pinned widths below and the DESIGN
 * guard forbids a page rule on `.ui-ledger`. The dot and PR cells are sticky at its left edge, so a person scrolling the evidence never loses which PR a
 * cell belongs to; the PR cell wraps its title inside a cap (60 % of the box) instead of squeezing the evidence off a phone.
 *
 * **One row open at a time, and the closed one is UNMOUNTED.** The open row is one key held here; opening another replaces it. The expansion is not drawn
 * `hidden` when closed: a `Confirm` joins `useDialogEscape`'s stack while it is mounted, and one left in a hidden subtree would swallow the next Escape unseen
 * ("Escape has one owner, and the topmost dialog is the only one that closes", `.claude/rules/board.md`). The price — a close forgets the strip's own busy
 * state — is paid by the page's in-flight set (`PrLayoutProps.inFlight`), which holds the keys disabled until its re-read lands. The open row is a KEY, not an
 * index, so a re-read that reorders the list leaves the expansion on its own PR.
 *
 * **Every element is keyed by `<repo>#<number>`, never by index.** Two repos can each have a `#7`, and a re-read reorders the rows; a row that remounted
 * because its position changed would drop the `Confirm` a person is reading.
 *
 * **The row toggles; what is inside it does not.** A click whose target is inside an `a`, `button`, `select` or `input` is that control's, not the row's, and
 * Enter or Space is the row's only when the row ITSELF holds focus — Enter on the `#n` link must follow the link, not also open the row. Space calls
 * `preventDefault` so the page does not scroll. The row is `tabIndex=0` with `aria-expanded`, the dashboard Git matrix's own keyboard contract.
 *
 * **The open row and its expansion are one block.** The expansion is ONE cell across every column holding the key strip with its why-line, then the foot
 * (the Confirm, then the outcome line), so a write's result lands inside the block that caused it rather than as a white row outside it. A COLLAPSED row's
 * outcome keeps a row of its own beneath it — a collapsed part never hides the result of a write. Both cells' content is pinned to the scroll box's visible
 * width, so `Merge`, `Cancel` and the outcome never sit off-screen while the table is scrolled. Collapsing a row whose Confirm is open — a second click, or
 * another row opening — closes that Confirm: the page owns it (`PrLayoutProps.confirming`), and a Confirm no row draws would still hold the Escape stack.
 *
 * **`updating…` once.** In Matrix the Base cell says it, so the `updating` outcome draws no line here, collapsed or open, and the strip leaves it off its
 * why-line (`omitUpdatingReason`); `Update` still carries it as its own reason. The mark's PRESENCE decides, never its clock, so the cell, the key and the
 * outcome agree until the page's timer has judged the re-read.
 *
 * **Can't read.** A shown repo whose last read was `rate-limited` or `error` keeps its rows — still ranked, still actionable — and its failure is one line
 * under the table, `PrRepoNotes`'. A repo is not a pull request, so it is never drawn as a row. When no shown repo has a PR and one could not be read, the
 * table, the legend and `no open pull requests` all stay away: the line is the page's whole answer.
 */

const COLUMN_COUNT = 2 + MATRIX_COLUMNS.length + 1;

/** The tones the legend names, in the order the spec lists them. Colour is for a problem; the words are the legend's. */
const LEGEND: { tone: CellTone; word: string }[] = [
  { tone: 'ok', word: 'healthy' },
  { tone: 'bad', word: 'needs you' },
  { tone: 'meh', word: 'worth a look' },
  { tone: 'live', word: 'in motion' },
  { tone: 'na', word: 'not applicable' }
];

function MatrixRow({ r, props, open, onToggle }: { r: RankedPr; props: PrLayoutProps; open: boolean; onToggle: () => void }) {
  const { pr, repo, key } = r;
  const updating = props.marks[key] !== undefined;
  const cells = matrixCells(pr, updating);
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const age = ageText(pr.updatedAt, props.now);
  // The Base cell says `updating…`; an outcome that only repeats it is not drawn here.
  const outcome = props.outcomes[key]?.kind === 'updating' ? undefined : props.outcomes[key];
  const write = (call: () => Promise<PrWriteResult>) => props.write(key, pr.headSha, call);

  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    const control = (e.target as Element).closest('a, button, select, input');
    if (control !== null && e.currentTarget.contains(control)) return;
    onToggle();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <>
      <tr className="prs-matrix-row" data-testid={`pr-mrow-${key}`} tabIndex={0} aria-expanded={open} onClick={onClick} onKeyDown={onKeyDown}>
        <td className="prs-matrix-dot prs-matrix-sticky">
          <Dot size={10} tone={LEVEL_DOT[r.level]} />
          <span className="sr-only">{LEVEL_LABEL[r.level]}</span>
        </td>
        <td className="prs-matrix-pr prs-matrix-sticky">
          <div className="prs-matrix-pr-inner">
            <div className="prs-row-title">
              <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
                #{pr.number}
              </a>
              <span className="prs-title">{pr.title}</span>
              {pr.draft && <Pill>draft</Pill>}
            </div>
            <div className="prs-meta">
              <span className="prs-branches">{`${repo.repo} · ${pr.head} → ${pr.base}`}</span>
              {warning !== null && <Pill tone="warn">{warning}</Pill>}
            </div>
          </div>
        </td>
        {MATRIX_COLUMNS.map((column) => (
          <td key={column} className="prs-matrix-cell">
            <span className={`prs-cell-${cells[column].tone}`}>{cells[column].text}</span>
          </td>
        ))}
        <td className="prs-matrix-age">{age ?? ''}</td>
      </tr>
      {!open && hasOutcomeLine(outcome, updating) && (
        <tr className="prs-matrix-outcome">
          <td colSpan={COLUMN_COUNT}>
            <div className="prs-matrix-pinned">
              <PrOutcomeLine outcome={outcome} updating={updating} />
            </div>
          </td>
        </tr>
      )}
      {open && (
        <tr className="prs-matrix-expand" data-testid={`pr-expand-${key}`}>
          <td colSpan={COLUMN_COUNT}>
            <div className="prs-matrix-pinned">
              <PrActions
                repo={repo}
                pr={pr}
                updating={updating}
                outcome={props.outcomes[key]}
                busy={props.inFlight.has(key)}
                onMerge={() => props.setConfirming(key)}
                onWrite={write}
                omitUpdatingReason
              />
              <PrFoot
                repo={repo}
                pr={pr}
                outcome={outcome}
                updating={updating}
                confirming={props.confirming === key}
                onDismiss={() => props.setConfirming(null)}
                onWrite={write}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function PrMatrix(props: PrLayoutProps) {
  const { repos, outcomes } = props;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const ranked = useMemo(() => rankPrs(repos), [repos]);
  const failures = transientFailures(repos);
  const counts = useMemo(() => columnCounts(ranked), [ranked]);
  const { confirming, setConfirming } = props;
  // Opening another row, or closing this one, unmounts the expansion; a Confirm open in it goes with it.
  const toggle = (key: string) => {
    if (openKey !== null && confirming === openKey) setConfirming(null);
    setOpenKey(openKey === key ? null : key);
  };

  return (
    <div className="prs-matrix" data-testid="pr-matrix">
      <PrRepoNotes repos={repos} outcomes={outcomes} part="above" />
      {ranked.length === 0 ? (
        failures.length === 0 && <p className="prs-status">no open pull requests</p>
      ) : (
        <>
          <Sheet>
            <Ledger label="Pull requests">
              <div className="prs-matrix-scroll">
                <table className="prs-matrix-table">
                  <thead>
                    <tr>
                      <th scope="col" className="prs-matrix-dot prs-matrix-sticky">
                        <span className="sr-only">Level</span>
                      </th>
                      <th scope="col" className="prs-matrix-pr prs-matrix-sticky">
                        Pull request
                      </th>
                      {MATRIX_COLUMNS.map((column) => (
                        <th key={column} scope="col">
                          {MATRIX_LABEL[column]}
                          {counts[column] > 0 && (
                            <>
                              {' '}
                              <span className="prs-matrix-count">{counts[column]}</span>
                            </>
                          )}
                        </th>
                      ))}
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r) => (
                      <MatrixRow key={r.key} r={r} props={props} open={openKey === r.key} onToggle={() => toggle(r.key)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Ledger>
          </Sheet>
          <p className="prs-matrix-legend" data-testid="pr-matrix-legend">
            {LEGEND.map(({ tone, word }) => (
              <span key={tone} className={`prs-cell-${tone}`}>
                {word}
              </span>
            ))}
          </p>
        </>
      )}
      <PrRepoNotes repos={repos} outcomes={outcomes} part="below" />
    </div>
  );
}
