#!/usr/bin/env node
// Publishes the Vite dev server onto the tailnet, at the same port number it
// holds on this machine.
//
//   pnpm run tailnet          # register the serve, print the phone URL
//   pnpm run tailnet status   # what tailscaled thinks it is serving
//   pnpm run tailnet down     # unregister
//
// Why a script and not the documented one-liner docker-compose.yml used to
// point at: the port number has to agree with compose forever. compose reads
// BM_WEB_PORT out of .env, and a serve registration typed by hand stores a
// *copy* of that number inside tailscaled — outside this repo and outside git.
// Move BM_WEB_PORT the next time 5177 collides with another project (this
// machine's .env already sits on a different number than the compose default)
// and the copy keeps pointing at the old port; the phone gets a bare 502 from
// Tailscale, which reads as a Tailscale fault rather than a stale mapping.
// Here the number is read from the same file compose reads it from, so there is
// nothing to keep in sync. Ported from guide-manager's bin/tailnet.js, which
// exists for the same reason and whose ports live one variable over.
//
// Why serve at all, when a wildcard bind would already be reachable over the
// tailnet: so that compose can keep publishing on loopback. Nothing in this
// stack has auth, the API's item-body route reads every registered project's
// backlog files straight off disk, and with BM_AGENTS on the board can spawn a
// Claude Code session with write permission in another repo. A 0.0.0.0 bind
// offered all of that to every network this laptop ever joins. With the publish
// scoped to 127.0.0.1, tailscaled is the only route in and the tailnet is the
// boundary — see the BM_BIND invariant in CLAUDE.md, which this script is the
// sanctioned way around rather than an exception to.
//
// Plain HTTP is deliberate. The listener is tailnet-only (never Funnel), and
// the hop from the phone to this machine is WireGuard-encrypted end to end —
// the HTTP exists only inside that tunnel, from tailscaled to a loopback
// socket. An HTTPS serve would buy a browser-trusted certificate at the cost of
// the one property this script is for: --https accepts only 443, 8443 and
// 10000, so the tailnet port could never match the local one. The dispatch
// POSTs survive the terminating proxy either way — origin.guard.ts compares
// host and port and deliberately not the scheme, for exactly this setup.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Where the tailscale CLI lives. Linux first, because that is what this repo
// runs on; the Homebrew paths cover a Mac, and the fourth is the CLI embedded
// in the GUI app, which is what you have if Tailscale came from the App Store —
// there the binary is never on PATH, and `which tailscale` finding nothing is
// not the same as Tailscale being absent.
export const CLI_CANDIDATES = [
  '/usr/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

// The compose default, and the only port literal in this file: everything else
// reads the number from .env. `pnpm run test:skills` asserts that.
const DEFAULT_WEB_PORT = '5177'

// Reads one variable out of an .env file. Deliberately not a dotenv
// dependency: this needs a single unquoted line, and the file is also parsed by
// compose, whose interpolation rules are the ones that matter. Anything fancier
// here would be a second dialect of the same file.
export function readEnvVar(file, name) {
  if (!existsSync(file)) return undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== name) continue
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

// The port, resolved the way compose resolves it: an exported variable wins
// over the file, and the fallback is the default written into the compose
// mapping. BM_ENV_FILE exists so the suite can point this at a temp file — the
// same escape hatch backlog.mjs gives with BM_REGISTRY_FILE.
export function resolveWebPort(env = process.env) {
  const file = env.BM_ENV_FILE || join(REPO_ROOT, '.env')
  const raw = env.BM_WEB_PORT ?? readEnvVar(file, 'BM_WEB_PORT') ?? DEFAULT_WEB_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BM_WEB_PORT is not a usable port: ${JSON.stringify(raw)}`)
  }
  return port
}

// The tailnet side and the loopback side carry the same number on purpose:
// tailscaled answers this machine's tailnet address, compose publishes on
// 127.0.0.1, and the two never contend for one socket. One number per project,
// identical wherever you type it.
export const serveArgs = (port) => ['serve', '--bg', `--http=${port}`, `http://127.0.0.1:${port}`]

// Undoes the above. `off` takes the listener's port, not the target's.
export const offArgs = (port) => ['serve', `--http=${port}`, 'off']

export const findCli = (candidates = CLI_CANDIDATES) => candidates.find((path) => existsSync(path))

// Is anything actually behind the port? serve registers happily against a dead
// target and the failure surfaces on the phone as a bare 502, so it is worth
// one connect attempt and a warning here. A refused connection is the answer,
// not an error — hence the promise resolving either way.
function listening(port, timeout = 400) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (result) => {
      socket.destroy()
      resolvePromise(result)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// This machine's MagicDNS name, so the script can print the URL to type into
// the phone rather than leaving you to reconstruct it. Best-effort: MagicDNS
// can be off, in which case the tailnet IP is the honest answer, and if even
// that is unavailable the caller falls back to a placeholder.
function tailnetHost(cli) {
  const { status, stdout } = spawnSync(cli, ['status', '--json'], { encoding: 'utf8' })
  if (status !== 0) return undefined
  try {
    const self = JSON.parse(stdout).Self ?? {}
    const dns = (self.DNSName || '').replace(/\.$/, '')
    return dns || (self.TailscaleIPs ?? [])[0]
  } catch {
    return undefined
  }
}

// serve is an operator-only operation: it edits the node's configuration, so
// tailscaled refuses it from a user who is neither root nor the declared
// operator. The remedy is one command, but this script will not run it — a
// helper that silently escalates to change your machine's network config is
// worse than an error message. Print the fix, let the human decide.
//
// Three causes, because the CLI's own output does not always name the one you
// have. A logged-out node is the case worth spelling out: `tailscale serve`
// answers it with the single word `Logged out.` and nothing else, and the
// operator advice below is then the wrong fix — there is no tailnet identity
// for a serve to hang off yet, so no amount of permission helps. `up` needs
// root as well, so the two remedies are ordered: claim the operator flag once,
// then log in without sudo forever after.
function reportServeFailure(port) {
  process.stderr.write(
    [
      '',
      `tailscale refused to serve port ${port}.`,
      '',
      'If it said `Logged out.`, this node has no tailnet identity yet — check',
      'with `tailscale status`, then:',
      '  sudo tailscale set --operator=$USER   # once, so the rest needs no sudo',
      '  tailscale up                          # opens a browser login',
      '',
      'If it complained about access, this user is not the tailscaled operator:',
      '  sudo tailscale set --operator=$USER',
      '',
      'If it complained about the port, something else may already hold it on',
      'the tailnet side — `pnpm run tailnet status` lists what is registered.',
      '',
    ].join('\n'),
  )
}

// Exported for the suite alone: the remedies are the whole value of the
// failure path, and the wrong one costs a real debugging detour — this node
// answered `Logged out.` and the operator flag was not the fix.
export const serveFailureRemedies = () => [
  'tailscale status',
  'sudo tailscale set --operator=$USER',
  'tailscale up',
]

async function up(port, cli, dryRun) {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} ${serveArgs(port).join(' ')}\n`)
    return 0
  }

  if (!(await listening(port))) {
    // Not fatal: registering before the stack is up is a reasonable order to
    // work in, and the registration persists. Worth saying out loud, though,
    // because the symptom on the phone gives no hint of the cause.
    process.stdout.write(
      `warning: nothing is listening on 127.0.0.1:${port} — start the stack with \`pnpm run docker:up\`\n`,
    )
  }

  const { status } = spawnSync(cli, serveArgs(port), { stdio: 'inherit' })
  if (status !== 0) {
    reportServeFailure(port)
    return status ?? 1
  }

  const host = tailnetHost(cli) ?? '<this-machine>.<your-tailnet>.ts.net'
  process.stdout.write(`\nserving http://${host}:${port} to your tailnet\n`)
  // This machine being awake is the actual day-to-day failure mode, and no
  // amount of correct configuration survives it.
  process.stdout.write(
    'reachable from anywhere you are logged into the tailnet, while this machine is awake\n',
  )
  return 0
}

function down(port, cli, dryRun) {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} ${offArgs(port).join(' ')}\n`)
    return 0
  }
  const { status } = spawnSync(cli, offArgs(port), { stdio: 'inherit' })
  if (status !== 0) reportServeFailure(port)
  return status ?? 1
}

async function status(port, cli, dryRun) {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} serve status\n`)
    return 0
  }
  spawnSync(cli, ['serve', 'status'], { stdio: 'inherit' })
  const alive = await listening(port)
  process.stdout.write(`\n127.0.0.1:${port}: ${alive ? 'listening' : 'nothing there'}\n`)
  return 0
}

const COMMANDS = { up, down, status }

export async function main(argv) {
  // A bare `--` is dropped, not treated as the command: `pnpm run tailnet --
  // --dry-run` is how pnpm forwards flags, and the separator arrives here as
  // its own argv entry.
  const args = argv.filter((arg) => arg !== '--dry-run' && arg !== '--')
  const dryRun = argv.includes('--dry-run')
  const command = args[0] ?? 'up'

  if (!Object.hasOwn(COMMANDS, command)) {
    process.stderr.write(`unknown command: ${command}\nusage: tailnet [up|down|status] [--dry-run]\n`)
    return 2
  }

  let port
  try {
    port = resolveWebPort()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  // Resolved after the port so that --dry-run works on a machine without
  // Tailscale at all: the command it would run is a fact about this repo's
  // configuration, not about what happens to be installed.
  const cli = findCli()
  if (!cli && !dryRun) {
    process.stderr.write(
      `tailscale CLI not found. Looked in:\n${CLI_CANDIDATES.map((p) => `  ${p}`).join('\n')}\n`,
    )
    return 2
  }

  return COMMANDS[command](port, cli, dryRun)
}

// Guarded so the test file can import the helpers without reconfiguring
// anything as a side effect — same guard sync-plugin.mjs uses.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
