// backlog-review's CLI. Later subcommands (`scope`, `merge`) slot into COMMANDS; today it resolves the reviewer config the other subcommands and the
// skill read. Exit codes match orchestrate.mjs, which has no exit 2: 0 success, 1 bad arguments or an unknown subcommand.
//
// Self-contained by the same rule every skill's tools are: it imports nothing from another skill's `tools/`, from `server/` or from `shared/`. The reviewer
// config's validator and defaults are therefore a TWIN of `DEFAULT_REVIEW_CONFIG` / `parseReviewConfig` in `shared/agent.ts`; a change to one is a change to
// the other.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: review.mjs config [--review-mode same|split] [--review-config <json>] [--review-model|--review-effort ...]';

// Closed lists. `null` (unset) means "the agent's own default" and is accepted everywhere a pair member is.
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SMALL_MAX_LINES_MIN = 1;
const SMALL_MAX_LINES_MAX = 10000;

// Twin of `DEFAULT_REVIEW_CONFIG` in `shared/agent.ts`. A function, not a constant, so no caller can mutate the shared defaults.
function defaultConfig() {
  return {
    mode: 'split',
    same: { model: null, effort: null },
    big: { model: null, effort: null },
    small: { model: 'sonnet', effort: null },
    smallMaxLines: 300,
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Twin of `parseReviewConfig` in `shared/agent.ts`. Returns the normalised config (all five keys, in a fixed order, extras dropped) or throws an Error
// whose message says what is wrong; the caller decides whether that is a warning (a file) or an exit 1 (an argument).
function validateConfig(value) {
  if (!isObject(value)) throw new Error('not an object');
  if (value.mode !== 'same' && value.mode !== 'split') throw new Error('mode must be "same" or "split"');
  const pair = (name) => {
    const p = value[name];
    if (!isObject(p)) throw new Error(`${name} must be an object with model and effort`);
    if (p.model !== null && !MODELS.includes(p.model)) throw new Error(`${name}.model must be null or one of ${MODELS.join(', ')}`);
    if (p.effort !== null && !EFFORTS.includes(p.effort)) throw new Error(`${name}.effort must be null or one of ${EFFORTS.join(', ')}`);
    return { model: p.model, effort: p.effort };
  };
  const n = value.smallMaxLines;
  if (!Number.isInteger(n) || n < SMALL_MAX_LINES_MIN || n > SMALL_MAX_LINES_MAX) {
    throw new Error(`smallMaxLines must be an integer ${SMALL_MAX_LINES_MIN}-${SMALL_MAX_LINES_MAX}`);
  }
  return { mode: value.mode, same: pair('same'), big: pair('big'), small: pair('small'), smallMaxLines: n };
}

// One flag per config member. `mode` says which reviewer mode the flag belongs to; `set` writes the already-validated value into the config.
const FLAGS = {
  '--review-model': { mode: 'same', kind: 'model', set: (c, v) => (c.same.model = v) },
  '--review-effort': { mode: 'same', kind: 'effort', set: (c, v) => (c.same.effort = v) },
  '--review-big-model': { mode: 'split', kind: 'model', set: (c, v) => (c.big.model = v) },
  '--review-big-effort': { mode: 'split', kind: 'effort', set: (c, v) => (c.big.effort = v) },
  '--review-small-model': { mode: 'split', kind: 'model', set: (c, v) => (c.small.model = v) },
  '--review-small-effort': { mode: 'split', kind: 'effort', set: (c, v) => (c.small.effort = v) },
  '--review-small-max-lines': { mode: 'split', kind: 'lines', set: (c, v) => (c.smallMaxLines = v) },
};

// `default` is how a flag says "unset": the agent's own model or effort.
function flagValue(flag, kind, raw) {
  if (kind === 'lines') {
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < SMALL_MAX_LINES_MIN || n > SMALL_MAX_LINES_MAX) {
      throw new Error(`${flag} must be an integer ${SMALL_MAX_LINES_MIN}-${SMALL_MAX_LINES_MAX}, got "${raw}"`);
    }
    return n;
  }
  if (raw === 'default') return null;
  const list = kind === 'model' ? MODELS : EFFORTS;
  if (!list.includes(raw)) throw new Error(`${flag} must be default or one of ${list.join(', ')}, got "${raw}"`);
  return raw;
}

// Parses `--flag value` and `--flag=value`; anything else is an error naming it. Returns { flags: Map, reviewConfigJson }.
function parseArgs(args) {
  const flags = new Map();
  let reviewConfigJson;
  for (let i = 0; i < args.length; i++) {
    let name = args[i];
    let value;
    const eq = name.indexOf('=');
    if (name.startsWith('--') && eq > 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name !== '--review-mode' && name !== '--review-config' && !FLAGS[name]) throw new Error(`unknown argument: ${name}`);
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
    }
    if (name === '--review-config') reviewConfigJson = value;
    else flags.set(name, value);
  }
  return { flags, reviewConfigJson };
}

function reviewFilePath(env = process.env) {
  return env.BM_REVIEW_FILE || path.join(os.homedir(), '.backlog-manager', 'settings', 'review.json');
}

// Reads `file`; a missing file is silent defaults, an unparseable or invalid one is ONE warning and defaults — a hand-edited file must never stop a review.
function readFileConfig(file, warn) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultConfig();
    warn(`review.json unreadable (${file}): ${error.message} — using the defaults`);
    return defaultConfig();
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (error) {
    warn(`review.json invalid (${file}): ${error.message} — using the defaults`);
    return defaultConfig();
  }
}

// `--review-config` JSON and flags are mutually exclusive; either one beats the file, which beats the defaults. Argument errors throw (exit 1); a bad
// FILE only warns. `file` is the review.json path.
export function resolveConfig({ flags = new Map(), reviewConfigJson, file, warn = () => {} }) {
  if (reviewConfigJson !== undefined && flags.size > 0) {
    throw new Error(`--review-config and ${[...flags.keys()].join(', ')} are mutually exclusive`);
  }
  if (reviewConfigJson !== undefined) {
    try {
      return validateConfig(JSON.parse(reviewConfigJson));
    } catch (error) {
      throw new Error(`--review-config is invalid: ${error.message}`);
    }
  }
  if (flags.size === 0) return readFileConfig(file, warn);
  const mode = flags.get('--review-mode');
  if (mode === undefined) throw new Error(`${[...flags.keys()][0]} requires --review-mode`);
  if (mode !== 'same' && mode !== 'split') throw new Error(`--review-mode must be same or split, got "${mode}"`);
  const config = defaultConfig();
  config.mode = mode;
  for (const [flag, raw] of flags) {
    if (flag === '--review-mode') continue;
    const spec = FLAGS[flag];
    if (spec.mode !== mode) throw new Error(`${flag} belongs to --review-mode ${spec.mode}, not ${mode}`);
    spec.set(config, flagValue(flag, spec.kind, raw));
  }
  return config;
}

function configCommand(args) {
  const { flags, reviewConfigJson } = parseArgs(args);
  const config = resolveConfig({ flags, reviewConfigJson, file: reviewFilePath(), warn: (line) => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify(config)}\n`);
  return 0;
}

// Subcommand table: a later task adds a row, never a branch in `main`.
const COMMANDS = { config: configCommand };

export function main(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n${USAGE}\n`);
    return 1;
  }
  try {
    return handler(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Twin of `isMain` in `skills/backlog/tools/backlog.mjs`, which carries the reasoning; `scripts/run-as-main.test.mjs` pins every copy.
function isMain(url) {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// `process.exitCode`, NOT `process.exit()`: writing to a pipe is asynchronous and `process.exit()` never drains it, so a large payload would be cut.
// retro.mjs's entry guard carries the full record. Nothing here holds a live handle, so returning from `main` lets the process end on its own.
if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
