import { readDeepLink, withoutDeepLink } from '../client/src/lib/deep-link';

/*
  The one URL this app reads: `?section=<section>` opens that section over the landing preference and the stored one, and `&runs=history|watchdog` picks
  the Runs page with it. Lookout's Orchestrator tile opens `/?section=runs&runs=history`. Anything it does not recognise is ignored rather than clamped, so
  a bad link opens the app the way a plain load would.
*/
describe('readDeepLink', () => {
  it('reads a section and the Runs page', () => {
    expect(readDeepLink('?section=runs&runs=history')).toEqual({ section: 'runs', runsMode: 'runs' });
    expect(readDeepLink('?section=runs&runs=watchdog')).toEqual({ section: 'runs', runsMode: 'watchdog' });
  });

  it('reads a section alone', () => {
    expect(readDeepLink('?section=archive')).toEqual({ section: 'archive', runsMode: null });
    expect(readDeepLink('?section=runs')).toEqual({ section: 'runs', runsMode: null });
  });

  it('is empty without a search, or with an unknown section', () => {
    expect(readDeepLink('')).toEqual({ section: null, runsMode: null });
    expect(readDeepLink('?section=projects')).toEqual({ section: null, runsMode: null });
    expect(readDeepLink('?other=1')).toEqual({ section: null, runsMode: null });
  });

  it('takes a Runs page only with the Runs section, and never the internal name of History', () => {
    expect(readDeepLink('?runs=watchdog')).toEqual({ section: null, runsMode: null });
    expect(readDeepLink('?section=board&runs=watchdog')).toEqual({ section: 'board', runsMode: null });
    expect(readDeepLink('?section=runs&runs=runs')).toEqual({ section: 'runs', runsMode: null });
  });
});

describe('withoutDeepLink', () => {
  it('drops the two parameters and keeps everything else', () => {
    expect(withoutDeepLink('/', '?section=runs&runs=history', '')).toBe('/');
    expect(withoutDeepLink('/', '?a=1&section=runs&runs=history', '#x')).toBe('/?a=1#x');
  });
});
