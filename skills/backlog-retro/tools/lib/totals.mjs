// The fold: rows -> the headline numbers a report and a delta are built on.
//
// Every number here comes from the sweep's own rows and nothing is a
// literal — that is a global constraint of this task, and it is what makes
// a record comparable to the one before it. Where a measure cannot be
// derived the answer is `null`, never `0`: "no fix loops ran" and "nobody
// recorded whether a fix loop ran" are different facts, and a report that
// prints `0` for the second is lying with a straight face.
import fs from 'node:fs';
import path from 'node:path';

// An item that reached one of these ended the pipeline successfully.
// `branched` is here for the same reason CLAUDE.md's own invariant puts it
// in RECONCILE_TERMINAL_STAGES: `merged` is no longer the only success exit,
// and a retro that counted merges alone would report every branch-mode run
// as having achieved nothing.
const SUCCESS_STAGES = new Set(['merged', 'branched']);

// The two dispatch slots that are rework. `execute` is the work; a `retry`
// is the runner going again after a crash and a `fix` is the reviewer
// sending it back, and both cost money the item was not supposed to need.
const REWORK_KINDS = new Set(['fix', 'retry']);

// ONE convention for a median, used everywhere one appears: the mean of the
// two middle values on an even-length list, so two 30-minute items and two
// 60-minute ones report 45 rather than an arbitrary one of them.
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

// ONE convention for a p90: the NEAREST-RANK value, at index
// ceil(0.9 * n) - 1. Nearest rank rather than interpolation because every
// figure it reports is then a real observation somebody can go and look at
// — "the 90th percentile item took 61 minutes" names an item.
export function p90(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function tally(values) {
  const out = {};
  for (const v of values) {
    if (v === null || v === undefined) continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

// preflight -> terminal stamp, in minutes: how long the item took from the
// runner picking it up to the run being done with it. `null` for an item
// that never reached a success stamp, which is why a parked item pulls the
// median neither up nor down — it has no wall time, not a wall time of zero.
export function itemWallMin(item) {
  const start = Date.parse(item.stageAt?.preflight ?? '');
  if (!Number.isFinite(start)) return null;
  for (const stage of SUCCESS_STAGES) {
    const end = Date.parse(item.stageAt?.[stage] ?? '');
    if (Number.isFinite(end)) return round2((end - start) / 60000);
  }
  return null;
}

// Where a session or review file is stored: its key with the last two
// segments (`logs/<file>` or `reviews/<file>`) cut off, so `<project>` for
// the live run and `<project>/runs/<stem>` for an archived one. Reviews
// carry no run id, and this is the one thing a review and the sessions it
// judged are guaranteed to share — `init` moves a run's logs and reviews
// together, into the same directory (task-31).
function storageRoot(key) {
  return typeof key === 'string' ? key.split('/').slice(0, -2).join('/') : null;
}

// Execute first, then retries, then fix loops in loop order: the order the
// runner dispatches them in, which is what "an earlier session" means below.
const KIND_ORDER = { execute: 0, retry: 1, fix: 2 };

// #226: every fix loop classified as RESUMED (it kept a session id some
// earlier session of the same item already had — `claude --resume` keeps
// the id it was handed) or FRESH (a session id nothing before it had, which
// is what a new `claude -p` is given). No new field records the mode: the
// ids alone derive it, and a run from before #226 therefore reads as all
// resumed, which is what it was. A fix session with no id is in neither —
// unknown is not a mode.
//
// Each loop is credited with the review that judged its work, pass `loop +
// 1` of the same item in the same storage location, so the two modes can be
// compared on what came of them and not only on what they cost. A loop
// with no such review (the run ended, or the review was never written)
// still counts in `loops` and in neither verdict.
function fixLoopsByMode(sessions, reviews) {
  const groups = new Map();
  const groupOf = (project, itemId, root) => {
    const key = JSON.stringify([project, itemId, root]);
    if (!groups.has(key)) groups.set(key, { sessions: [], reviews: new Map() });
    return groups.get(key);
  };
  for (const s of sessions) {
    if (s.itemId === null || s.itemId === undefined || !(s.kind in KIND_ORDER)) continue;
    groupOf(s.project, s.itemId, storageRoot(s.key)).sessions.push(s);
  }
  for (const r of reviews) {
    groupOf(r.project, r.itemId, storageRoot(r.file)).reviews.set(r.pass, r.verdict);
  }

  const modes = { resumed: [], fresh: [] };
  for (const group of groups.values()) {
    const ordered = [...group.sessions].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.loop ?? 0) - (b.loop ?? 0));
    const seen = new Set();
    for (const s of ordered) {
      const id = typeof s.sessionId === 'string' && s.sessionId !== '' ? s.sessionId : null;
      if (s.kind === 'fix' && id !== null) {
        const verdict = Number.isFinite(s.loop) ? group.reviews.get(s.loop + 1) : undefined;
        modes[seen.has(id) ? 'resumed' : 'fresh'].push({ session: s, verdict });
      }
      if (id !== null) seen.add(id);
    }
  }

  const fold = (loops) => ({
    loops: loops.length,
    costUsd: round2(loops.filter((l) => Number.isFinite(l.session.result?.costUsd)).reduce((a, l) => a + l.session.result.costUsd, 0)),
    peakMedian: median(loops.map((l) => l.session.context?.peak)),
    nextPass: {
      approve: loops.filter((l) => l.verdict === 'approve').length,
      fix: loops.filter((l) => l.verdict === 'fix').length
    }
  });
  return { resumed: fold(modes.resumed), fresh: fold(modes.fresh) };
}

export function computeTotals(sweep) {
  const { runs, items, sessions, reviews, drivers } = sweep;

  const measured = sessions
    .map((s) => s.result?.costUsd)
    .filter((c) => Number.isFinite(c))
    .reduce((a, b) => a + b, 0);

  // The driver's spend is estimated from fitted rates, never measured — the
  // orchestrating session is a live Claude Code session and nothing writes
  // a `result` event for it. `null` rather than 0 when there is no fit:
  // an unpriced driver is unknown spend, not free spend.
  const driverEstimates = drivers.map((d) => d.estimatedCostUsd).filter((c) => Number.isFinite(c));
  const driverEstimated = drivers.some((d) => d.driver !== null) && driverEstimates.length > 0 ? round2(driverEstimates.reduce((a, b) => a + b, 0)) : null;
  const allIn = driverEstimated === null ? null : round2(measured + driverEstimated);

  const merged = items.filter((i) => SUCCESS_STAGES.has(i.stage)).length;

  const stageMinutes = {};
  for (const item of items) {
    for (const [stage, minutes] of Object.entries(item.stages)) {
      stageMinutes[stage] = round2((stageMinutes[stage] ?? 0) + minutes);
    }
  }

  const queueWaits = items.map((i) => i.queueWaitMin).filter((v) => Number.isFinite(v));

  const withFixLoop = items.filter((i) => i.fixLoops > 0);
  const fixLoops = {
    count: items.reduce((a, i) => a + i.fixLoops, 0),
    itemsAffected: withFixLoop.length,
    costUsd: round2(sessions.filter((s) => REWORK_KINDS.has(s.kind) && Number.isFinite(s.result?.costUsd)).reduce((a, s) => a + s.result.costUsd, 0)),
    minutes: round2(items.reduce((a, i) => a + (i.stages.fixing ?? 0), 0)),
    byMode: fixLoopsByMode(sessions, reviews)
  };

  // Verdicts by pass, because "reviews that came back `fix`" and "items that
  // needed a second pass" are different questions and the second one is the
  // one a fix-loop budget is spent on. Every pass seen gets both keys, so a
  // pass with no `fix` reads `fix: 0` rather than going missing.
  const byPass = {};
  for (const review of reviews) {
    if (review.verdict !== 'approve' && review.verdict !== 'fix') continue;
    if (!byPass[review.pass]) byPass[review.pass] = { approve: 0, fix: 0 };
    byPass[review.pass][review.verdict] += 1;
  }
  const verdicts = {
    approve: reviews.filter((r) => r.verdict === 'approve').length,
    fix: reviews.filter((r) => r.verdict === 'fix').length,
    byPass
  };

  // Context by project over EXECUTE sessions only. A resumed fix loop starts
  // from a context that is already grown, so folding its floor in would
  // report a number nobody ever paid at turn one — and the floor is exactly
  // the figure worth acting on, being the standing toll on every turn. A
  // fresh fix loop (#226) is a different job with a different prompt, and
  // its peak is reported per mode in `fixLoops.byMode` instead.
  const byProject = {};
  for (const project of sweep.projects) {
    const own = sessions.filter((s) => s.project === project.path && s.kind === 'execute' && s.context);
    byProject[project.path] = {
      floorMedian: median(own.map((s) => s.context.floor)),
      peakMedian: median(own.map((s) => s.context.peak))
    };
  }

  // Every failing verification entry, with the file/test/error lines already
  // extracted — the rows a report cites when it says the pipeline's own
  // proof step is where the time went.
  const firstVerifyFailures = [];
  for (const item of items) {
    for (const entry of item.verification) {
      if (entry.ok || !entry.failures) continue;
      firstVerifyFailures.push({
        project: item.project,
        itemId: item.id,
        cmd: entry.cmd,
        tests: entry.failures.tests,
        errors: entry.failures.errors
      });
    }
  }

  const walls = items.map(itemWallMin).filter((v) => Number.isFinite(v));
  const wallsWithFix = items
    .filter((i) => i.fixLoops > 0)
    .map(itemWallMin)
    .filter((v) => Number.isFinite(v));
  const wallsWithoutFix = items
    .filter((i) => i.fixLoops === 0)
    .map(itemWallMin)
    .filter((v) => Number.isFinite(v));

  return {
    runs: { total: runs.length, byStatus: tally(runs.map((r) => r.status)) },
    items: {
      total: items.length,
      byStage: tally(items.map((i) => i.stage)),
      // "Reached the runner", which is the denominator a fix-loop RATE has
      // to use: an item that was queued and never dispatched had no chance
      // to need a fix loop, and counting it would flatter every rate.
      dispatched: items.filter((i) => i.stageAt?.dispatched !== undefined).length
    },
    sessions: {
      byKind: tally(sessions.map((s) => s.kind)),
      byTerminated: tally(sessions.map((s) => s.result?.terminated ?? null)),
      killed: sessions.filter((s) => s.result === null).length
    },
    costUsd: { measured: round2(measured), driverEstimated, allIn },
    merged,
    costPerMerged: {
      measured: merged === 0 ? null : round2(measured / merged),
      allIn: merged === 0 || allIn === null ? null : round2(allIn / merged)
    },
    stageMinutes,
    queueWaitMin: {
      total: round2(queueWaits.reduce((a, b) => a + b, 0)),
      median: median(queueWaits),
      p90: p90(queueWaits)
    },
    fixLoops,
    verdicts,
    context: { byProject },
    firstVerifyFailures,
    itemWallMin: {
      median: median(walls),
      p90: p90(walls),
      withFix: median(wallsWithFix),
      withoutFix: median(wallsWithoutFix)
    }
  };
}

// --- the previous record, and the deltas against it ----------------------

// The four labels a session may assign to a fix-verdict review (spec 1).
// A CLOSED set, and `record` refuses anything outside it, so a typo can
// never become a fifth category the next sweep dutifully counts.
export const LABELS = ['drift', 'red-proof', 'defect', 'other'];

// The newest record in the retro home.
//
// Stems are filesystem-safe ISO stamps (`record`, Task 7), so LEXICAL order
// is time order — no parsing, and no way for a record's name and its
// content to disagree about when it was taken. An absent directory is
// `null`, not an error: the first sweep on a machine has no previous.
export function newestRecord(home) {
  let entries;
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) return null;
  const file = path.join(home, files.at(-1));
  try {
    return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return round2(numerator / denominator);
}

// The eleven measures a retro is actually judged on. Each is a function of a
// `totals` object, so "then" and "now" are computed by the SAME expression
// — a delta between two differently-derived numbers would be noise.
const MEASURES = {
  runs: (t) => t?.runs?.total ?? null,
  items: (t) => t?.items?.total ?? null,
  merged: (t) => t?.merged ?? null,
  costMeasured: (t) => t?.costUsd?.measured ?? null,
  costPerMergedMeasured: (t) => t?.costPerMerged?.measured ?? null,
  // Rework as a share of what actually reached the runner, not of the whole
  // queue — see `items.dispatched`.
  fixLoopRate: (t) => ratio(t?.fixLoops?.itemsAffected, t?.items?.dispatched),
  // FIRST-pass fix verdicts only: a second pass exists precisely because
  // the first came back `fix`, so counting every pass would fold the
  // consequence into the cause.
  fixVerdictRate: (t) => {
    const first = t?.verdicts?.byPass?.[1];
    if (!first) return null;
    return ratio(first.fix, first.approve + first.fix);
  },
  // How many fix loops ran in each mode (#226). A record written before
  // the split has no `byMode`, which reads as `null` — not comparable —
  // rather than as "no loops", which would report every loop since as new.
  fixLoopsResumed: (t) => t?.fixLoops?.byMode?.resumed?.loops ?? null,
  fixLoopsFresh: (t) => t?.fixLoops?.byMode?.fresh?.loops ?? null,
  itemWallMedianMin: (t) => t?.itemWallMin?.median ?? null,
  queueWaitMedianMin: (t) => t?.queueWaitMin?.median ?? null
};

export function computePrevious(sweep, newest) {
  if (!newest || !newest.record) return null;
  const thenTotals = newest.record.sweep?.totals ?? null;
  const nowTotals = sweep.totals;

  const deltas = {};
  for (const [key, of] of Object.entries(MEASURES)) {
    const then = of(thenTotals);
    const now = of(nowTotals);
    // A delta needs both sides. `null` here means "not comparable", which
    // is a different statement from "did not move" and must never be
    // rendered as an improvement.
    const delta = Number.isFinite(then) && Number.isFinite(now) ? round2(now - then) : null;
    deltas[key] = { then, now, delta };
  }

  // What the previous session's judgments came to, as shares. `null` when
  // the record carries no labels: a retro that labelled nothing did not
  // find "0% drift".
  const values = Object.values(newest.record.labels?.reviews ?? {});
  let labelRates = null;
  if (values.length > 0) {
    labelRates = {};
    for (const label of LABELS) {
      labelRates[label] = round2(values.filter((v) => v === label).length / values.length);
    }
  }

  return {
    generatedAt: newest.record.sweep?.generatedAt ?? null,
    file: newest.file,
    deltas,
    labelRates,
    // Verbatim, so the next session can skip a candidate already declined
    // and check on one already filed (spec 3.4) without re-reading the
    // record itself.
    candidates: newest.record.labels?.candidates ?? []
  };
}
