import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_HEADLESS_PLUGINS, HEADLESS_PLUGINS_MAX, HEADLESS_PLUGIN_SHAPE, parseHeadlessConfig } from '../../shared/agent';
import { headlessFile } from '../../server/src/settings/headless-config.util';

/**
 * #625: `orchestrate.mjs headless-settings` reads the file `POST /api/settings/headless` writes, and a skill's tools import nothing from `shared/`, so the
 * tool holds a hand COPY of the default list, the name shape, the cap, the parser and the file path. This suite is the one thing holding the copies together:
 * a red case means the two sides disagree — change BOTH, never only the side this suite reads.
 *
 * The tool side is read by importing the module in a child `node` (jest here transpiles to CommonJS and cannot load an `.mjs` in-process); `orchestrate.mjs`
 * runs `main` only when it is the entry point, so the import executes no verb. The parser is compared by RUNNING both copies over the same cases rather than
 * by reading source, so a twin that reorders a check and answers a different `member` goes red.
 */

const TOOL = join(__dirname, '..', '..', 'skills', 'backlog-orchestrate', 'tools', 'orchestrate.mjs');

const CASES: unknown[] = [
  { enabled: true, plugins: ['backlog-manager', 'superpowers'] },
  { enabled: false, plugins: ['a', 'a', 'b@c'] },
  { enabled: 'true', plugins: [] },
  { enabled: true, plugins: 'x' },
  { enabled: true, plugins: Array.from({ length: HEADLESS_PLUGINS_MAX + 1 }, () => 'p') },
  { enabled: true, plugins: Array.from({ length: HEADLESS_PLUGINS_MAX }, (_, i) => `p${i}`) },
  { enabled: true, plugins: ['ok', 'a b'] },
  { enabled: true, plugins: ['@x'] },
  { enabled: true, plugins: ['x@'] },
  { enabled: true, plugins: [null] },
  { enabled: true, plugins: [], extra: 1 },
  { plugins: [] },
  [],
  null,
  'headless'
];

interface ToolSide {
  defaults: string[];
  shape: string;
  max: number;
  file: string;
  parsed: unknown[];
}

function toolSide(env: NodeJS.ProcessEnv): ToolSide {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(TOOL).href)});
    const cases = JSON.parse(process.argv[1]);
    console.log(JSON.stringify({
      defaults: m.HEADLESS_DEFAULT_PLUGINS,
      shape: m.HEADLESS_PLUGIN_SHAPE.source,
      max: m.HEADLESS_PLUGINS_MAX,
      file: m.headlessFile(),
      parsed: cases.map((c) => m.parseHeadlessConfigTwin(c)),
    }));`;
  const r = spawnSync('node', ['--input-type=module', '-e', script, JSON.stringify(CASES)], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`importing orchestrate.mjs failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as ToolSide;
}

describe('orchestrate.mjs headless-settings twins shared/agent.ts and the server', () => {
  const env = { ...process.env };
  delete env.BM_HEADLESS_FILE;
  const tool = toolSide(env);

  it('has the same default list', () => {
    expect(tool.defaults).toEqual([...DEFAULT_HEADLESS_PLUGINS]);
  });

  it('has the same name shape and cap', () => {
    expect(tool.shape).toBe(HEADLESS_PLUGIN_SHAPE.source);
    expect(tool.max).toBe(HEADLESS_PLUGINS_MAX);
  });

  it('answers every case the way parseHeadlessConfig does', () => {
    expect(tool.parsed).toEqual(CASES.map((c) => parseHeadlessConfig(c)));
  });

  it('reads the file the server writes, and the same override', () => {
    expect(tool.file).toBe(headlessFile({}));
    const override = '/tmp/bm-headless-twin/headless.json';
    expect(toolSide({ ...env, BM_HEADLESS_FILE: override }).file).toBe(headlessFile({ BM_HEADLESS_FILE: override }));
  });
});
