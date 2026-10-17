import { useCallback, useRef, useState } from 'react';

import { useMountedRef } from './useMountedRef';

/**
 * What a site does with a settled call. Both optional: a site with nothing to do on failure but show the message passes no `onError` at all.
 *
 * `onError` returning exactly `true` means "handled — render nothing". That is for the one refusal that is really the outcome the click wanted: a resume
 * refused because the run is already alive (`RUN_IN_PROGRESS_CODE`) means the run came back under this very click, so `RunControls` takes the success path
 * rather than printing an error for something that just fixed itself. Returning anything else leaves the message rendered, which is what
 * `OrchestrateSheet` wants from the same code: it closes on it AND sets the message, as it always has — so `onError` runs whether or not it returns `true`,
 * and runs BEFORE the error is set.
 */
export interface ActionHandlers<T> {
  onSuccess?: (value: T) => void;
  onError?: (err: unknown) => boolean | void;
}

export interface Action {
  busy: boolean;
  error: string | null;
  run: <T>(call: () => Promise<T>, on?: ActionHandlers<T>) => void;
  clearError: () => void;
}

/** The message a rendered error shows for a rejection: an `Error`'s own text (an `ApiError` carries the server's), anything else through `String`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * useAction — the one home of a click-fired mutation's plumbing (#286): the in-flight guard, the rendered `busy` flag, the rendered `error` string and the
 * `Error`-to-message mapping. `RunControls`, `LaunchSheet`, `OrchestrateSheet` and `ClaimRelease` each wrote all four by hand, and only `RunControls` had
 * the guard (bug-19) — so a double-click on launch, start or a claim release's accept could send the same POST twice. The guard lives here so a site
 * cannot forget it; each site keeps only its own success and refusal branches.
 *
 * `run` takes a thunk per call rather than a function bound when the hook is created, because `RunControls` fires pause, cancel, resume and stop through
 * ONE guard and ONE error slot. A hook per mutation would give it a guard per mutation, and a pause and a resume could then overlap — which is exactly what
 * bug-19's layer 1 forbids.
 *
 * Unmount: `OrchestrateSheet` closes itself from `onSuccess`, so the component is routinely gone by the time the settle path runs. Every setState here is
 * skipped once `useMountedRef` reads false; the ref is cleared regardless (harmless, and it keeps the guard honest if StrictMode reuses the fiber). The
 * handlers are called after unmount too — `onChanged`, `refresh` and `onReleased` are the caller's business, and every site called them regardless before.
 *
 * `run` and `clearError` are stable across renders (no deps: the handlers are read per call), so a site may hand them to memoised children.
 */
export function useAction(): Action {
  /**
   * bug-19's layer 1, in two halves — and they are two on purpose.
   *
   * `busyRef` is the GUARD. It has to be a ref rather than the state below because `setBusy(true)` does not change the value `busy` holds in this render's
   * closure: two clicks dispatched before React re-renders both read `false` and both fire. A state-backed check only catches a second click that arrives
   * after a repaint — which is most of them, and is the shape bug-19's own occurrence had (three clicks inside ten seconds), but it is not the guarantee the
   * invariant states. A ref is assigned and read in the same synchronous turn, so "the only layer that can catch a second click before the first answer
   * lands" is true of every second click rather than of the slow ones. Measured: with the ref removed, two clicks in one tick send two POSTs.
   *
   * `busy` is the RENDERING. A ref does not re-render, and a control has to swap itself for its in-flight word (`Resuming…`, `launching…`, `starting…`)
   * while the request is out — `RunControls`' host's own `resuming` mark cannot do it, being set from `onChanged`, i.e. after the request settles.
   */
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMountedRef();

  const run = useCallback(<T>(call: () => Promise<T>, on: ActionHandlers<T> = {}): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    call()
      .then(
        (value) => on.onSuccess?.(value),
        (err: unknown) => {
          if (on.onError?.(err) === true) return;
          if (mounted.current) setError(errorMessage(err));
        }
      )
      // Both halves cleared on BOTH settle paths — a spawn that threw started no session, and the server's own lock is likewise cleared there.
      .finally(() => {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      });
  }, []);

  const clearError = useCallback((): void => setError(null), []);

  return { busy, error, run, clearError };
}
