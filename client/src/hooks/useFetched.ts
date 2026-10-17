import { useEffect, useRef, useState, type DependencyList } from 'react';

export interface Fetched<T> {
  status: 'idle' | 'pending' | 'ok' | 'failed';
  value: T | null;
  error: unknown;
}

const IDLE: Fetched<never> = { status: 'idle', value: null, error: null };
const PENDING: Fetched<never> = { status: 'pending', value: null, error: null };

function sameDeps(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * The one-shot "fetch on a key, drop a stale answer" read (#285) — what eight call sites used to write by hand as an `alive` flag in an effect:
 * `useProjectSources`, the item modal's body, the launch sheet's plan, the Orchestrate sheet's merge-check, uncommitted flag and branch list, the run
 * detail's archived run, and the Jira issue modal's detail. Not a poller: nothing here re-asks on focus or on a clock (`useRefreshing` is that), only
 * when `deps` change.
 *
 * - `load === null` is the skip case — `idle`, no request (merge-check under branch mode, a run detail that is live-backed or remote).
 * - A change of `deps` reads `pending` with `value: null` on the very render that carries the new key, never one frame of the previous key's answer under
 *   it. That is why the stored answer is tagged with the key it was asked for, and a mismatched tag reads as `pending` at render time: resetting it with a
 *   `setState` in the effect would paint one stale frame first, because effects run after the commit has already been drawn. Whether `load` is null is
 *   part of the key, so switching from skip to a real load starts exactly one request even with `deps` unchanged.
 * - Resolve → `ok`; reject — or throw before returning a promise — → `failed` with the error and `value: null`.
 * - An answer for a superseded key, or one landing after unmount, sets nothing — the guard every site used to own, owned once here.
 *
 * `load` is read at effect time through a ref, so a caller may pass a fresh closure every render; only `deps` decide when it runs — the same idiom as
 * `useCoalescedFetch`'s task ref.
 */
export function useFetched<T>(load: (() => Promise<T>) | null, deps: DependencyList): Fetched<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  // The key's generation, bumped during render the moment `deps` (or the skip flag) differ from the last render's. Idempotent across StrictMode's double
  // render: the second pass compares equal and leaves it alone.
  const keyDeps = [...deps, load === null];
  const keyRef = useRef<{ deps: DependencyList; gen: number }>({ deps: keyDeps, gen: 0 });
  if (!sameDeps(keyRef.current.deps, keyDeps)) keyRef.current = { deps: keyDeps, gen: keyRef.current.gen + 1 };
  const gen = keyRef.current.gen;

  const [held, setHeld] = useState<{ gen: number; fetched: Fetched<T> } | null>(null);

  useEffect(() => {
    const task = loadRef.current;
    if (task === null) return;
    let current = true;
    // A load that throws synchronously (a `fetch` that does not exist, a bad argument) is a failed read like any rejection, never an exception out of
    // this effect — `useProjectSources` used to get that by starting from `Promise.resolve()`.
    let pending: Promise<T>;
    try {
      pending = task();
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (value) => {
        if (current) setHeld({ gen, fetched: { status: 'ok', value, error: null } });
      },
      (error: unknown) => {
        if (current) setHeld({ gen, fetched: { status: 'failed', value: null, error } });
      }
    );
    return () => {
      current = false;
    };
  }, [gen]);

  if (load === null) return IDLE;
  if (held === null || held.gen !== gen) return PENDING;
  return held.fetched;
}
