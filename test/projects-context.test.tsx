/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ProjectsProvider, useProjectsContext } from '../client/src/hooks/ProjectsContext';
import type { ProjectSummary } from '../shared/types';

function project(name: string, source: ProjectSummary['source']): ProjectSummary {
  return { name, path: `/abs/${name}`, source } as ProjectSummary;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}
function fail(): Response {
  return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const wrapper = ({ children }: { children: ReactNode }) => <ProjectsProvider>{children}</ProjectsProvider>;

describe('ProjectsProvider', () => {
  it('reads null data and null drawn until the first fetch resolves', async () => {
    let release: (r: Response) => void = () => {};
    global.fetch = jest.fn(() => new Promise<Response>((resolve) => (release = resolve))) as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });

    expect(result.current.data).toBeNull();
    expect(result.current.drawn).toBeNull();

    await act(async () => {
      release(ok([]));
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('derives drawn from a 200 with one github project', async () => {
    global.fetch = jest.fn(() => Promise.resolve(ok([project('gh', 'github')]))) as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });

    await waitFor(() => expect(result.current.drawn).toEqual({ files: false, github: true }));
    expect(result.current.data).toHaveLength(1);
  });

  it('stays null when the first read fails', async () => {
    const fn = jest.fn(() => Promise.resolve(fail()));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBeNull();
    expect(result.current.drawn).toBeNull();
  });

  it('keeps the last answer when a later read fails', async () => {
    const fn = jest.fn().mockResolvedValueOnce(ok([project('gh', 'github')])).mockResolvedValue(fail());
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.drawn).toEqual({ files: false, github: true });
  });

  it('re-reads once per window focus', async () => {
    const fn = jest.fn(() => Promise.resolve(ok([project('f', 'files')])));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('folds two reloads that land mid-flight into one follow-up read', async () => {
    const releases: Array<(r: Response) => void> = [];
    const fn = jest.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    global.fetch = fn as unknown as typeof fetch;
    const { result } = renderHook(() => useProjectsContext(), { wrapper });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.reload();
      result.current.reload();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      releases[0](ok([]));
    });
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    await act(async () => {
      releases[1](ok([]));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
