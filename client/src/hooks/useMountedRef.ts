import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * Whether the component using this hook is still mounted — flipped false on unmount, checked before every setState a late answer would make.
 *
 * A request can be in flight the moment the component goes away, and its response would otherwise land on a hook nobody is reading any more. A plain ref
 * is cheaper than threading an AbortController through every fetcher for a cancellation that would buy nothing beyond what this already gets: the
 * request still completes either way, only what happens with its answer changes.
 *
 * The `true` has to be set in the effect BODY, not only in `useRef(true)`'s initializer — `useRef`'s initial value is computed exactly once for the
 * lifetime of the fiber, never again on a later effect run, whereas the effect body runs every time the effect (re-)fires. That distinction is invisible
 * on a plain mount, where each happens once, but StrictMode's dev-only mount → cleanup → remount sequence (client/src/main.tsx wraps <App> in
 * <StrictMode>) runs the cleanup once BEFORE the lasting mount: with only the initializer setting `true`, that first cleanup flips the ref to `false` and
 * nothing ever flips it back, so the guard reads "unmounted" for the rest of the component's real, on-screen lifetime — every answer silently skips its
 * setState, and the hook reports zero data from the very first real mount onward. Re-asserting `true` in the effect body means the remount's own run
 * re-arms it correctly.
 */
export function useMountedRef(): MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
