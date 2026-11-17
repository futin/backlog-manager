#!/usr/bin/env node
// pr-resolve's CLI: `parse` names the target's paths, `lock take|release` guards one resolve per PR, `outcome` writes the record the board reads. Exit 0 ok,
// 2 usage, 3 lock refused; one JSON line on stdout. The merge itself is the skill's job, not this tool's — it never writes git beyond cleaning up the trees a
// recovered lock left behind.
//
// Self-contained: imports only its own lib (see pr-resolve-lib.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths, parseTarget, prResolveHome, releaseLock, takeLock, writeOutcome } from './pr-resolve-lib.mjs';

const USAGE = [
  'usage: pr-resolve.mjs parse <owner/repo#N> [--reclaim <id>]',
  '       pr-resolve.mjs lock take <owner/repo#N> [--reclaim <id>] | lock release <owner/repo#N>',
  '       pr-resolve.mjs outcome <owner/repo#N> --outcome pushed|stopped|up-to-date --reason <text> --from <sha> [--head <sha>]',
].join('\n');

class Usage extends Error {}

const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');

const sessionId = () => process.env.CLAUDE_CODE_SESSION_ID || null;

// Splits `args` into positionals and `--flag value` pairs; a flag with no value is a usage error.
function parseArgs(args, flags) {
  const positional = [];
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!flags.includes(name)) throw new Usage(`unknown flag ${a}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Usage(`${a} needs a value`);
    values[name] = value;
    i++;
  }
  return { positional, values };
}

function target(arg) {
  const t = parseTarget(arg);
  if (!t) throw new Usage(`not owner/repo#N: ${arg}`);
  return t;
}

// Removes the trees a killed resolve left, so the successor starts clean. Errors are reported, never fatal: a tree that is already gone is the common case.
function cleanup(p) {
  const messages = [];
  for (const tree of [p.tree, p.baseTree]) {
    if (!fs.existsSync(tree)) continue;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', tree], { stdio: 'pipe' });
    } catch (e) {
      messages.push(String(e.stderr || e.message).trim());
    }
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { stdio: 'pipe' });
  } catch (e) {
    messages.push(String(e.stderr || e.message).trim());
  }
  return messages;
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const home = prResolveHome();
  if (cmd === 'parse') {
    const { positional, values } = parseArgs(rest, ['reclaim']);
    if (positional.length !== 1) throw new Usage('parse needs one target');
    const t = target(positional[0]);
    out({ repo: t.repo, number: t.number, reclaim: values.reclaim ?? null, ...paths(process.cwd(), home, t) });
    return 0;
  }
  if (cmd === 'lock') {
    const [sub, ...more] = rest;
    if (sub === 'take') {
      const { positional, values } = parseArgs(more, ['reclaim']);
      if (positional.length !== 1) throw new Usage('lock take needs one target');
      const t = target(positional[0]);
      const p = paths(process.cwd(), home, t);
      const r = takeLock(p.lockFile, { sessionId: sessionId(), now: Date.now(), reclaim: values.reclaim ?? null });
      if (!r.taken) {
        out({ taken: false, reason: `another resolve of #${t.number} is running` });
        return 3;
      }
      out(r.recovered ? { ...r, cleanup: cleanup(p) } : r);
      return 0;
    }
    if (sub === 'release') {
      const { positional } = parseArgs(more, []);
      if (positional.length !== 1) throw new Usage('lock release needs one target');
      out({ released: releaseLock(paths(process.cwd(), home, target(positional[0])).lockFile, sessionId()) });
      return 0;
    }
    throw new Usage('lock needs take or release');
  }
  if (cmd === 'outcome') {
    const { positional, values } = parseArgs(rest, ['outcome', 'reason', 'from', 'head']);
    if (positional.length !== 1) throw new Usage('outcome needs one target');
    const t = target(positional[0]);
    if (!['pushed', 'stopped', 'up-to-date'].includes(values.outcome)) throw new Usage('--outcome must be pushed, stopped or up-to-date');
    if (values.reason === undefined) throw new Usage('--reason is required');
    if (values.from === undefined) throw new Usage('--from is required');
    let headSha = values.head;
    if (values.outcome === 'pushed') {
      if (headSha === undefined) throw new Usage('--head is required for pushed');
    } else if (headSha === undefined) {
      headSha = values.from;
    } else if (headSha !== values.from) {
      throw new Usage(`--head must equal --from for ${values.outcome}`);
    }
    const { outcomeFile } = paths(process.cwd(), home, t);
    writeOutcome(outcomeFile, { sessionId: sessionId(), outcome: values.outcome, reason: values.reason, fromSha: values.from, headSha, now: Date.now() });
    out({ written: outcomeFile });
    return 0;
  }
  throw new Usage('unknown subcommand');
}

function main(argv) {
  try {
    return run(argv);
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
}

function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// `process.exitCode`, NOT `process.exit()`: a pipe write is asynchronous and `process.exit()` never drains it. Nothing here holds a live handle.
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
