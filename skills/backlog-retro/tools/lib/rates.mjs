// Per-token rates, fitted rather than hard-coded.
//
// Dollar figures exist only where the CLI wrote a `total_cost_usd`. The
// driver's spend does not: a live Claude Code session leaves a transcript
// full of token counts and no cost at all. So the tool learns the machine's
// own prices from the sessions that DID report one and applies them to the
// ones that did not.
//
// Fitted, not tabulated, because a table goes stale the day pricing moves
// or the account changes tier, and it would go stale silently. The fit
// tracks whatever the CLI actually billed on this machine this month, and
// it ships with `maxResidualUsd` so a reader can see how well it did. The
// 2026-09-06 hand fit had a residual of $8.83 on the single session that
// crossed the long-context tier — a tier this model does not represent, and
// says so in `caveats` rather than pretending to.
//
// Everything priced this way is marked `estimated: true` in JSON and `est.`
// in text, every time it is printed (spec 3.6).

// The regressors, in a FIXED order. Every matrix index below depends on it,
// so it is stated once here and never re-spelled.
export const RATE_KEYS = ['cacheRead', 'cacheCreation', 'output', 'input']

// Four unknowns want more than four observations before anybody puts a
// dollar sign on the answer. Eight is the floor the spec names: enough that
// the system is comfortably over-determined, low enough that a machine with
// a couple of runs on it still gets a fit.
const MIN_SESSIONS = 8

// Solve `A x = b` by Gaussian elimination with partial pivoting. Returns
// null for a singular system rather than a vector of NaNs and Infinities —
// which is what "eight sessions with identical token mixes" produces, and
// it must read as "no fit", not as a rate of Infinity dollars per token.
function solve(A, b) {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / m[col][col]
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n]
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k]
    x[row] = sum / m[row][row]
  }
  return x.every((v) => Number.isFinite(v)) ? x : null
}

// Ordinary least squares over the measured sessions, through the origin —
// there is no intercept because a session that used no tokens cost nothing,
// and fitting a constant would let the model buy accuracy with a fixed fee
// nobody was ever charged.
export function fitRates(sessions) {
  const rows = []
  for (const s of sessions) {
    const r = s.result
    if (!r || !Number.isFinite(r.costUsd) || r.costUsd <= 0) continue
    const x = RATE_KEYS.map((k) => (Number.isFinite(r[k]) ? r[k] : 0))
    rows.push({ x, y: r.costUsd })
  }
  if (rows.length < MIN_SESSIONS) return null

  const n = RATE_KEYS.length
  const A = Array.from({ length: n }, () => new Array(n).fill(0))
  const b = new Array(n).fill(0)
  for (const { x, y } of rows) {
    for (let i = 0; i < n; i += 1) {
      b[i] += x[i] * y
      for (let j = 0; j < n; j += 1) A[i][j] += x[i] * x[j]
    }
  }
  const solution = solve(A, b)
  if (solution === null) return null

  const rates = {}
  RATE_KEYS.forEach((key, i) => { rates[key] = solution[i] })
  // The residual is shipped rather than checked against a threshold: a
  // large one does not make the fit unusable, it makes it a fit a reader
  // should know the size of before quoting a figure derived from it.
  rates.maxResidualUsd = Math.max(...rows.map(({ x, y }) => Math.abs(
    x.reduce((acc, v, i) => acc + v * solution[i], 0) - y,
  )))
  rates.sessions = rows.length
  return rates
}

// Tokens times rates. A missing count contributes nothing rather than
// throwing, because a transcript from a future CLI that renames a field
// should leave a small hole in an estimate, not kill the sweep.
export function priceTokens(tokens, rates) {
  if (!rates) return null
  return RATE_KEYS.reduce(
    (acc, key) => acc + (Number.isFinite(tokens?.[key]) ? tokens[key] : 0) * rates[key],
    0,
  )
}
