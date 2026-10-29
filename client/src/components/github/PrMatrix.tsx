import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { Dot } from '../ui/Dot';
import { Ledger } from '../ui/Ledger';
import { Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';
import { PrActions } from './PrActions';
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
import { isUpdating } from '../../lib/prs';

/**
 * GitHub › PRs, Matrix layout (.claude/DESIGN.md §8.11; spec `2026-10-29-prs-layouts-design.md`, "Matrix"): one table row per pull request, one column per
 * check, so a person scanning for "what is red" reads down a column instead of across a card. It decides nothing — the rank, the dot, every cell's text and
 * tone and every header count are `lib/pr-layouts.ts`'s, the run warning is `lib/pr-run.ts`'s, and every write is `PrActions`'s — so Matrix cannot triage a PR
 * differently from Inbox.
 *
 * **The dot is the triage; the cells are the evidence.** A cell reports its own fact whatever the row's level (`matrixCells`), so a draft with failing checks
 * sits among the Quiet rows with a red Checks cell, counted in that header. Colour is for a problem only: `.prs-cell-ok` and `-na` are ink, and the tone word
 * is always the cell's text too, so colour is never the only carrier. The header count is the number of rows whose cell in that column is bad or meh.
 *
 * **A real `<table>` inside `Ledger`'s overflow box, inside a `Sheet`** (§8.4: every table scrolls inside its own sheet). The sheet is the card the
 * dashboard's Management matrices sit on, which this layout was ported from; without it the table lay bare on the well and read as a different page from
 * its source. `Ledger` is used without `columns`, as Runs › Watchdog's feed is: a grid template would lay the columns out and the table's own semantics would
 * fight it. Matrix is wide-only (`drawableLayout`) and its title column ellipsizes, but the box stays because the evidence columns alone can still outgrow
 * a window just wide enough to offer Matrix.
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
 * **The outcome line is a row of its own beneath the PR, outside the expansion**, drawn whenever there is a line (`hasOutcomeLine`, `PrOutcomeLine`'s own
 * test): a collapsed part never hides the result of a write (spec, "What every layout carries"). The `updating…` mark is the Base cell's.
 *
 * **Can't read.** A shown repo whose last read was `rate-limited` or `error` keeps its rows — still ranked, still actionable — and gets one muted row: empty
 * dot cell, the repo in the PR column, its `detail` across the five check columns. When the only shown repos failed, that row is all the table holds, rather
 * than a `no open pull requests` that would claim a read nobody got.
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
  const updating = isUpdating(props.marks[key], pr, props.now);
  const cells = matrixCells(pr, updating);
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const age = ageText(pr.updatedAt, props.now);
  const outcome = props.outcomes[key];

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
        <td className="prs-matrix-dot">
          <Dot size={10} tone={LEVEL_DOT[r.level]} />
          <span className="sr-only">{LEVEL_LABEL[r.level]}</span>
        </td>
        <td className="prs-matrix-pr">
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
        </td>
        {MATRIX_COLUMNS.map((column) => (
          <td key={column} className="prs-matrix-cell">
            <span className={`prs-cell-${cells[column].tone}`}>{cells[column].text}</span>
          </td>
        ))}
        <td className="prs-matrix-age">{age ?? ''}</td>
      </tr>
      {hasOutcomeLine(outcome, updating) && (
        <tr className="prs-matrix-outcome">
          <td colSpan={COLUMN_COUNT}>
            <PrOutcomeLine outcome={outcome} updating={updating} />
          </td>
        </tr>
      )}
      {open && (
        <tr className="prs-matrix-expand" data-testid={`pr-expand-${key}`}>
          <td colSpan={COLUMN_COUNT}>
            <div className="prs-matrix-expand-body">
              <PrActions repo={repo} pr={pr} onWrite={(call) => props.write(key, pr.headSha, call)} variant="full" busy={props.inFlight.has(key)} />
              <a className="prs-open" href={pr.url} target="_blank" rel="noreferrer noopener">
                Open on GitHub ↗
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function PrMatrix(props: PrLayoutProps) {
  const { repos, outcomes, marks, now } = props;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const ranked = useMemo(() => rankPrs(repos), [repos]);
  const failures = transientFailures(repos);
  const counts = useMemo(() => {
    const byKey = new Map(ranked.map((r) => [r.key, isUpdating(marks[r.key], r.pr, now)]));
    return columnCounts(ranked, (key) => byKey.get(key) === true);
  }, [ranked, marks, now]);

  return (
    <div className="prs-matrix" data-testid="pr-matrix">
      <PrRepoNotes repos={repos} outcomes={outcomes} part="above" />
      {ranked.length === 0 && failures.length === 0 ? (
        <p className="prs-status">no open pull requests</p>
      ) : (
        <>
          <Sheet>
            <Ledger label="Pull requests">
              <table className="prs-matrix-table">
                <thead>
                  <tr>
                    <th scope="col" className="prs-matrix-dot">
                      <span className="sr-only">Level</span>
                    </th>
                    <th scope="col">Pull request</th>
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
                    <MatrixRow key={r.key} r={r} props={props} open={openKey === r.key} onToggle={() => setOpenKey((cur) => (cur === r.key ? null : r.key))} />
                  ))}
                  {failures.map((repo) => (
                    <tr key={repo.repo} className="prs-matrix-fail" data-testid={`pr-mfail-${repo.repo}`}>
                      <td className="prs-matrix-dot" />
                      <td className="prs-matrix-pr">{repo.repo}</td>
                      <td colSpan={MATRIX_COLUMNS.length}>{repo.detail ?? repo.access}</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
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
