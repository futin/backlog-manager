// Reviewer reports and verify statuses.
//
// `backlog-orchestrate` writes one `reviews/<id>-<pass>.md` per review pass
// and one `verify/<id>.status` holding the exit code of the item's proof
// commands. This module extracts what a retro cites and NOTHING it judges:
// the verdict, the pass number, and — for a `fix` verdict only — the
// Critical and Important sections verbatim. Deciding whether an Important
// finding was prose drift, a test that could not fail, or a real defect is
// the session's job (spec 3.2), and no regex here should ever try.
import fs from 'node:fs';
import path from 'node:path';

import { sidecarFiles } from './paths.mjs';

// `<id>-<pass>.md`. Anything else in the directory is not a review. `<id>`
// is a files project's `bug-21` or a tracker project's bare issue number,
// `18` — the same two shapes, for the same reason, as sessions.mjs's
// `LOG_NAME` (#223).
const REVIEW_NAME = /^((?:[a-z]+-)?\d+)-(\d+)\.md$/;

// The reviewer template puts `verdict: <word>` on its own line near the top.
// First match wins: a later occurrence is the reviewer quoting itself in
// prose, never a second verdict.
const VERDICT = /^verdict:\s*(\S+)\s*$/im;

// A section body that means "nothing here". Written as a closed list rather
// than "short body" because the excerpts are what the session labels, and a
// one-line real finding must never be swallowed by a length heuristic.
// Optional markdown emphasis because reviewers write both `None.` and
// `*None.*`.
const EMPTY_SECTION = /^[*_]*\s*(none\.?|—|-|n\/a)\s*[*_]*$/i;

// The text under a heading, up to the next heading of any level or the end
// of the file. Any heading level matches, because a reviewer that nested its
// findings under `### Critical` meant the same thing as `## Critical`.
function section(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, 'i').test(l.trim()));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s+/.test(l.trim()));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return EMPTY_SECTION.test(body) ? '' : body;
}

// Every review under one project's run state, live and archived alike
// (task-31 moves a finished run's `reviews/` beside its run file).
export function readReviews(projectDirPath, project) {
  const reviews = [];
  for (const { file, rel, name } of sidecarFiles(projectDirPath, 'reviews')) {
    const m = REVIEW_NAME.exec(name);
    if (!m) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      console.error(`skipping unreadable review: ${file}`);
      continue;
    }
    const verdictMatch = VERDICT.exec(text);
    const review = {
      // The citable key, in the shape labels.json uses (spec 3.2):
      // `<project>/reviews/<file>`. The absolute path rides beside it for
      // anyone who wants to open the thing.
      file: `${project}/${rel.split(path.sep).join('/')}`,
      abs: file,
      project,
      itemId: m[1],
      pass: Number(m[2]),
      verdict: verdictMatch ? verdictMatch[1].toLowerCase() : null
    };
    // Excerpts on a `fix` verdict alone. An approving review has nothing to
    // label, and carrying its empty sections would put rows in front of the
    // session that have no judgement to make.
    if (review.verdict === 'fix') {
      review.critical = section(text, 'Critical');
      review.important = section(text, 'Important');
    }
    reviews.push(review);
  }
  return reviews;
}

// The exit code ONE RUN recorded for an item's proof commands, or `null` when that run never got that far.
//
// Keyed by run as well as item id (#270), because item ids repeat across runs: a bug parked by one run and merged by the next leaves a
// `verify/<id>.status` in each run's sidecar directory. This used to search every `sidecarRoots` entry for the first file named after the item, so every
// run that worked the same id reported one and the same status — the live run's when it had one, else the OLDEST archive's — and a merge that proved
// itself could be reported as a failed proof inherited from an earlier attempt.
//
// `run` is the run row (`{ file, current }`) the item came from, and its sidecar directory is derived the way orchestrate.mjs's `archiveStem` mints it:
// the live run writes flat under the project directory, and an archived `runs/<stem>.json` has its sidecars in the sibling `runs/<stem>/`. Nothing else
// is searched. A run archived before task-31 has no directory of its own — its statuses were swept into whichever archive came next, beside other runs'
// — so it reads `null`, "not derivable here", which is honest where borrowing a status from a neighbouring run was not.
export function readVerifyStatus(projectDirPath, itemId, run) {
  if (!run || typeof run.file !== 'string') return null;
  const root = run.current ? projectDirPath : run.file.replace(/\.json$/, '');
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'verify', `${itemId}.status`), 'utf8');
  } catch {
    return null;
  }
  const code = Number(text.trim());
  return Number.isFinite(code) ? code : null;
}
