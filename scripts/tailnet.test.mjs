import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { offArgs, readEnvVar, resolveWebPort, serveArgs, serveFailureRemedies } from './tailnet.mjs'

// scripts/tailnet.mjs publishes the Vite dev server onto the tailnet, and the
// whole reason it exists rather than a hand-typed `tailscale serve` is that the
// port number must live in exactly one place. compose reads BM_WEB_PORT from
// .env; so does this script; nothing else knows the number. A literal typed
// into either side is the drift this suite exists to prevent — and the failure
// it produces is a 502 from Tailscale on the phone, which reads as a Tailscale
// problem rather than a config one, so it is worth catching here.
//
// Two halves. The pure helpers are imported and called directly. The command
// dispatch is driven as a CLI, because that is where the exit codes and the
// argv parsing live, and `--dry-run` prints the command instead of running it —
// a test that reconfigured this machine's network to prove a string would be a
// worse test than no test.
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'tailnet.mjs')

// The script's own environment, minus anything the ambient shell may have set.
// BM_WEB_PORT leaking in from the developer's own env would make the fallback
// cases pass or fail depending on whose machine ran them — and on this machine
// .env holds a non-default port, so that is not a hypothetical.
function run(args, env = {}) {
  const clean = { ...process.env }
  delete clean.BM_WEB_PORT
  delete clean.BM_ENV_FILE
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...clean, ...env } })
}

// An .env holding just the lines a case cares about.
function envFile(body) {
  const file = join(mkdtempSync(join(tmpdir(), 'bm-tailnet-')), '.env')
  writeFileSync(file, body)
  return file
}

test('serves the port BM_WEB_PORT names, from the tailnet to loopback', () => {
  const { status, stdout } = run(['up', '--dry-run'], { BM_WEB_PORT: '5187' })

  assert.equal(status, 0)
  // The listen port and the target port are deliberately the same number on
  // two different addresses: tailscaled answers the tailnet address and
  // forwards to the loopback socket compose publishes. That symmetry is the
  // feature — one number per project, the same wherever you type it.
  assert.match(stdout, /serve --bg --http=5187 http:\/\/127\.0\.0\.1:5187/)
})

test('reads the port out of .env when the variable is not exported', () => {
  // How this actually runs: compose resolves ${BM_WEB_PORT} from .env, and
  // nobody exports it into their shell first. A script that only read the
  // environment would silently serve the default while the stack listened
  // somewhere else.
  const file = envFile('# comment\nBM_WEB_PORT=5199\nPORT=4322\n')
  const { status, stdout } = run(['up', '--dry-run'], { BM_ENV_FILE: file })

  assert.equal(status, 0)
  assert.match(stdout, /--http=5199 http:\/\/127\.0\.0\.1:5199/)
})

test('prefers an exported variable over the file, as compose does', () => {
  const file = envFile('BM_WEB_PORT=5199\n')
  const { stdout } = run(['up', '--dry-run'], { BM_ENV_FILE: file, BM_WEB_PORT: '5187' })

  assert.match(stdout, /--http=5187 http:\/\/127\.0\.0\.1:5187/)
})

test('falls back to the same default compose does', () => {
  const { status, stdout } = run(['up', '--dry-run'], { BM_ENV_FILE: envFile('') })

  assert.equal(status, 0)
  assert.match(stdout, /--http=5177 http:\/\/127\.0\.0\.1:5177/)
})

test('tears down the same port it brought up', () => {
  const { status, stdout } = run(['down', '--dry-run'], { BM_WEB_PORT: '5187' })

  assert.equal(status, 0)
  assert.match(stdout, /serve --http=5187 off/)
})

test('refuses a port that is not a port', () => {
  // A typo'd .env would otherwise reach the tailscale CLI as an argument and
  // fail there, with an error about flags rather than about the port.
  for (const bad of ['not-a-number', '0', '70000', '-1']) {
    const { status, stderr } = run(['up', '--dry-run'], { BM_WEB_PORT: bad })
    assert.notEqual(status, 0)
    assert.match(stderr, /port/i)
  }
})

test('rejects an unknown subcommand instead of guessing', () => {
  const { status, stderr } = run(['sideways'], { BM_WEB_PORT: '5187' })

  assert.notEqual(status, 0)
  assert.match(stderr, /sideways/)
})

test('defaults to up, so `pnpm run tailnet` with no argument publishes', () => {
  const { status, stdout } = run(['--dry-run'], { BM_WEB_PORT: '5187' })

  assert.equal(status, 0)
  assert.match(stdout, /serve --bg --http=5187/)
})

test('drops the bare -- pnpm forwards, rather than reading it as the command', () => {
  // `pnpm run tailnet -- --dry-run` is how a flag reaches the script through
  // pnpm, and the separator arrives as its own argv entry. Reading it as the
  // subcommand made the documented invocation exit 2.
  const { status, stdout } = run(['--', '--dry-run'], { BM_WEB_PORT: '5187' })

  assert.equal(status, 0)
  assert.match(stdout, /serve --bg --http=5187/)
})

test('readEnvVar ignores comments, blank lines and other keys', () => {
  const file = envFile('\n# BM_WEB_PORT=1111\nBM_API_PORT=4322\nBM_WEB_PORT="5199"\n')

  assert.equal(readEnvVar(file, 'BM_WEB_PORT'), '5199')
  assert.equal(readEnvVar(file, 'BM_MISSING'), undefined)
  // A file that is not there is not an error: .env is gitignored and a fresh
  // clone has none, which is precisely when the compose default has to apply.
  assert.equal(readEnvVar(join(tmpdir(), 'bm-tailnet-absent', '.env'), 'BM_WEB_PORT'), undefined)
})

test('resolveWebPort returns a number, and the args builders agree on it', () => {
  const port = resolveWebPort({ BM_WEB_PORT: '5187', BM_ENV_FILE: envFile('') })

  assert.equal(port, 5187)
  // Both sides of the registration, and its undo, read the one number: `off`
  // takes the listener's port, so a mismatch here would leave a serve up that
  // `pnpm run tailnet down` could never remove.
  assert.deepEqual(serveArgs(port), ['serve', '--bg', '--http=5187', 'http://127.0.0.1:5187'])
  assert.deepEqual(offArgs(port), ['serve', '--http=5187', 'off'])
})

test('names the logged-out cause, not just the operator one', () => {
  // The failure this actually hit on a fresh WSL node: `tailscale serve`
  // printed the single word `Logged out.`, and a message offering only
  // `--operator` sends you after a permission problem you do not have. Both
  // remedies have to be present, and `status` is what tells the two apart.
  const source = readFileSync(CLI, 'utf8')

  assert.match(source, /Logged out\./)
  for (const remedy of serveFailureRemedies()) {
    assert.ok(source.includes(remedy), `failure message lost its ${remedy} remedy`)
  }
})

test('hardcodes no port of its own', () => {
  // The one invariant worth asserting against the source text: any literal
  // port in here is a second place the number lives.
  const source = readFileSync(CLI, 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')

  // 5177 appears exactly once, as DEFAULT_WEB_PORT — the compose default.
  assert.equal(code.match(/\b5177\b/g).length, 1)
  // And the number this machine's own .env happens to hold is not in here at
  // all: a developer's local port is never the script's business.
  assert.equal(code.match(/\b5187\b/), null)
  // Nor is the API port: this script publishes the web port and only that one.
  assert.equal(code.match(/\b4322\b/), null)
})
