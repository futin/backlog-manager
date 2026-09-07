// `--text`: the same facts as `--json`, laid out for a person.
//
// Every number here is read off the sweep object; nothing is recomputed and
// nothing is a literal, so the text and the JSON can never disagree about
// what this machine did. If a figure needs a different derivation, it
// belongs in totals.mjs and both renderers get it.
//
// The one presentational rule that is really a correctness rule: an
// ESTIMATED dollar figure carries the suffix `est.` every single time it is
// printed, and a measured one never does (spec 3.6). A reader who cannot
// tell the fitted third of the bill from the billed two thirds is being
// misled by the report, not by the pipeline.

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return '—'
  return `${Math.round((numerator / denominator) * 100)}%`
}

function num(value, suffix = '') {
  return Number.isFinite(value) ? `${value}${suffix}` : '—'
}

function row(label, value) {
  return `  ${label.padEnd(22)}${value}`
}

function tallyText(counts) {
  const entries = Object.entries(counts ?? {})
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k} ${v}`).join(', ')
}

function headline(sweep) {
  const t = sweep.totals
  const lines = ['HEADLINE']
  lines.push(row('runs', `${t.runs.total} (${tallyText(t.runs.byStatus)})`))
  // "merged 2 of 3" is the sentence the whole retro exists to move.
  lines.push(row('items', `${t.items.total} queued, ${t.items.dispatched} dispatched, merged ${t.merged} of ${t.items.total}`))
  lines.push(row('sessions', `${sweep.sessions.length} (${tallyText(t.sessions.byKind)}); killed ${t.sessions.killed}`))
  lines.push(row('measured spend', money(t.costUsd.measured)))
  lines.push(row(
    'driver spend',
    t.costUsd.driverEstimated === null
      ? 'not priced — no rate fit'
      : `${money(t.costUsd.driverEstimated)} est.`,
  ))
  lines.push(row(
    'all-in spend',
    t.costUsd.allIn === null ? 'not priced — no rate fit' : `${money(t.costUsd.allIn)} est.`,
  ))
  lines.push(row(
    'per merged item',
    t.costPerMerged.measured === null
      ? '—'
      : `${money(t.costPerMerged.measured)} measured`
        + (t.costPerMerged.allIn === null ? '' : `, ${money(t.costPerMerged.allIn)} est. all-in`),
  ))
  lines.push(row(
    'fix loops',
    `${t.fixLoops.itemsAffected} item(s) of ${t.items.dispatched} dispatched (${pct(t.fixLoops.itemsAffected, t.items.dispatched)}), `
    + `${t.fixLoops.count} loop(s), ${money(t.fixLoops.costUsd)}, ${num(t.fixLoops.minutes)} min`,
  ))
  lines.push(row(
    'median item wall',
    `${num(t.itemWallMin.median, ' min')} (p90 ${num(t.itemWallMin.p90, ' min')}; `
    + `${num(t.itemWallMin.withoutFix)} without a fix loop, ${num(t.itemWallMin.withFix)} with)`,
  ))
  // Printed beside pipeline time and never inside it — queue wait is not
  // work, and a report that folded it in would blame the runner for the
  // hours an item spent waiting to be picked up.
  lines.push(row('queue wait', `median ${num(t.queueWaitMin.median, ' min')}, p90 ${num(t.queueWaitMin.p90, ' min')} (not pipeline time)`))
  return lines
}

function stageTable(sweep) {
  const stages = Object.entries(sweep.totals.stageMinutes).sort((a, b) => b[1] - a[1])
  const total = stages.reduce((a, [, m]) => a + m, 0)
  const lines = ['', 'WHERE THE TIME WENT (queue wait excluded)']
  if (stages.length === 0) return [...lines, 'none recorded']
  // Rows start at column zero on purpose: they are a table, and a reader
  // grepping for a stage name should find the line about it.
  lines.push(`${'stage'.padEnd(14)}${'minutes'.padStart(10)}${'share'.padStart(8)}`)
  for (const [stage, minutes] of stages) {
    lines.push(`${stage.padEnd(14)}${String(minutes).padStart(10)}${pct(minutes, total).padStart(8)}`)
  }
  return lines
}

function outcomes(sweep) {
  const lines = ['', 'OUTCOMES']
  const byStage = Object.entries(sweep.totals.items.byStage).sort((a, b) => b[1] - a[1])
  if (byStage.length === 0) lines.push('none')
  for (const [stage, count] of byStage) lines.push(`${stage.padEnd(14)}${String(count).padStart(6)}`)
  const v = sweep.totals.verdicts
  lines.push('')
  lines.push(row('review verdicts', `approve ${v.approve}, fix ${v.fix}`))
  for (const [pass, counts] of Object.entries(v.byPass)) {
    lines.push(row(`  pass ${pass}`, `approve ${counts.approve}, fix ${counts.fix}`))
  }
  return lines
}

function caveats(sweep) {
  const lines = ['', 'CAVEATS']
  if (sweep.caveats.length === 0) return [...lines, 'none']
  for (const c of sweep.caveats) lines.push(`- [${c.kind}] ${c.detail}`)
  return lines
}

function delta(entry) {
  if (!entry || entry.delta === null) return 'not comparable'
  const sign = entry.delta > 0 ? '+' : ''
  return `${entry.then} -> ${entry.now} (${sign}${entry.delta})`
}

function previousBlock(sweep) {
  const lines = ['', 'SINCE THE PREVIOUS RECORD']
  if (!sweep.previous) {
    // The literal phrase the skill's report reuses, so a first retro reads
    // the same in both places.
    return [...lines, 'first record — no previous sweep']
  }
  lines.push(row('recorded', sweep.previous.generatedAt ?? '—'))
  for (const [key, entry] of Object.entries(sweep.previous.deltas)) {
    lines.push(row(key, delta(entry)))
  }
  if (sweep.previous.labelRates) {
    lines.push(row('labels then', Object.entries(sweep.previous.labelRates).map(([k, v]) => `${k} ${pct(v, 1)}`).join(', ')))
  }
  const open = sweep.previous.candidates.filter((c) => c.status === 'filed')
  lines.push(row('candidates filed', open.length === 0 ? 'none' : open.map((c) => c.filedAs ?? c.title).join(', ')))
  return lines
}

export function renderText(sweep) {
  const lines = [
    `retro sweep — ${sweep.generatedAt}`,
    `run state: ${sweep.home}${sweep.scope ? ` (scoped to ${sweep.scope})` : ''}`,
    `projects:  ${sweep.projects.length === 0 ? 'none' : sweep.projects.map((p) => p.name ?? p.path).join(', ')}`,
    '',
    ...headline(sweep),
    ...stageTable(sweep),
    ...outcomes(sweep),
    ...caveats(sweep),
    ...previousBlock(sweep),
    '',
  ]
  return lines.join('\n')
}
