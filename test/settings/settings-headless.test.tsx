/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { HeadlessPluginsGroup } from '../../client/src/components/settings/HeadlessPluginsGroup';
import { defaultHeadlessConfig } from '../../shared/agent';
import type { HeadlessConfig, HeadlessSetting } from '../../shared/types';

/**
 * #625 — Settings › Shared's `Orchestrator plugins` card, rendered bare. It reads and writes `/api/settings/headless` through `useHeadlessSetting`; the
 * server half (validation, the 409 over an unreadable file) is `test/settings/headless-config.test.ts`, and the tool that reads the file at each launch is
 * `skills/backlog-orchestrate/tools/orchestrate-headless.test.mjs`.
 */

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `GET /api/settings/headless` answers `get`; its POST answers `post(body)`, by default echoing the body, as the server does for a valid config. */
function stubFetch(opts: { get: HeadlessSetting; post?: (body: HeadlessConfig) => { status: number; body: unknown } }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/settings/headless')) {
      if (init?.method === 'POST') {
        const answer = (opts.post ?? ((b) => ({ status: 200, body: b })))(JSON.parse(String(init.body ?? '{}')));
        return respond(answer.status, answer.body);
      }
      return respond(200, opts.get);
    }
    return respond(404, { error: 'not stubbed' });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const posts = (fn: jest.Mock) =>
  fn.mock.calls.filter(([url, init]) => String(url).endsWith('/api/settings/headless') && (init as RequestInit)?.method === 'POST');
const postedBody = (fn: jest.Mock, i: number): unknown => JSON.parse(String((posts(fn)[i][1] as RequestInit).body));

const DEFAULT: HeadlessSetting = { config: defaultHeadlessConfig(), source: 'default' };
const realFetch = global.fetch;

describe('HeadlessPluginsGroup', () => {
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  it('draws the default list with backlog-manager locked and the switch on', async () => {
    stubFetch({ get: DEFAULT });
    render(<HeadlessPluginsGroup />);
    expect(await screen.findByRole('switch', { name: 'Trim plugins in orchestrator sessions' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /backlog-manager · locked/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove backlog-manager' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove superpowers' })).toBeEnabled();
    expect(screen.getByText(/@builtin plugins are never switched off/)).toBeInTheDocument();
  });

  it('adding caveman then removing superpowers saves each change, the second as backlog-manager plus caveman', async () => {
    const fn = stubFetch({ get: DEFAULT });
    const user = userEvent.setup();
    render(<HeadlessPluginsGroup />);
    await user.type(await screen.findByRole('textbox', { name: 'Plugin name' }), 'caveman');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posts(fn)).toHaveLength(1));
    expect(postedBody(fn, 0)).toEqual({ enabled: true, plugins: ['backlog-manager', 'superpowers', 'caveman'] });
    expect(screen.getByRole('textbox', { name: 'Plugin name' })).toHaveValue('');

    await user.click(await screen.findByRole('button', { name: 'Remove superpowers' }));
    await waitFor(() => expect(posts(fn)).toHaveLength(2));
    expect(postedBody(fn, 1)).toEqual({ enabled: true, plugins: ['backlog-manager', 'caveman'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove superpowers' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Remove caveman' })).toBeInTheDocument();
  });

  it('an invalid name shows the inline error, marks the field and posts nothing', async () => {
    const fn = stubFetch({ get: DEFAULT });
    const user = userEvent.setup();
    render(<HeadlessPluginsGroup />);
    const field = await screen.findByRole('textbox', { name: 'Plugin name' });
    await user.type(field, 'not a name');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('is not a plugin name');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(posts(fn)).toHaveLength(0);
  });

  it('switching off saves enabled false with the list unchanged', async () => {
    const fn = stubFetch({ get: DEFAULT });
    const user = userEvent.setup();
    render(<HeadlessPluginsGroup />);
    await user.click(await screen.findByRole('switch', { name: 'Trim plugins in orchestrator sessions' }));
    await waitFor(() => expect(posts(fn)).toHaveLength(1));
    expect(postedBody(fn, 0)).toEqual({ enabled: false, plugins: ['backlog-manager', 'superpowers'] });
  });

  it('an unreadable file disables every control and names the file', async () => {
    stubFetch({ get: { config: defaultHeadlessConfig(), source: 'unreadable' } });
    render(<HeadlessPluginsGroup />);
    expect(await screen.findByRole('switch', { name: 'Trim plugins in orchestrator sessions' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove superpowers' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Plugin name' })).toBeDisabled();
    expect(screen.getByText(/headless\.json/)).toBeInTheDocument();
  });

  it('a refused save says so and leaves the server value on screen', async () => {
    stubFetch({ get: DEFAULT, post: () => ({ status: 409, body: { error: 'headless.json exists but is not a valid headless config' } }) });
    const user = userEvent.setup();
    render(<HeadlessPluginsGroup />);
    await user.click(await screen.findByRole('button', { name: 'Remove superpowers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved — headless.json exists but is not a valid headless config');
    expect(screen.getByRole('button', { name: 'Remove superpowers' })).toBeInTheDocument();
  });
});
