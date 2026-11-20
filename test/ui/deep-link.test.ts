import { readDeepLink, withoutDeepLink } from '../../client/src/lib/deep-link';

/*
  The one URL this app reads: `?section=<section>` opens that section over the landing preference and the stored one, and `&runs=history|watchdog` picks
  the Runs page with it. Lookout's Orchestrator tile opens `/?section=runs&runs=history`. Anything it does not recognise is ignored rather than clamped, so
  a bad link opens the app the way a plain load would.
*/
describe('readDeepLink', () => {
  it('reads a section and the Runs page', () => {
    expect(readDeepLink('?section=runs&runs=history')).toEqual({ section: 'runs', runsMode: 'runs', settingsScope: null, ticket: null });
    expect(readDeepLink('?section=runs&runs=watchdog')).toEqual({ section: 'runs', runsMode: 'watchdog', settingsScope: null, ticket: null });
  });

  it('reads a section alone', () => {
    expect(readDeepLink('?section=github')).toEqual({ section: 'github', runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=runs')).toEqual({ section: 'runs', runsMode: null, settingsScope: null, ticket: null });
  });

  it('is empty without a search, or with an unknown section', () => {
    expect(readDeepLink('')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=projects')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    // The root sections the source rows replaced: an old link opens the app the way a plain load does (source-sections spec).
    expect(readDeepLink('?section=board')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=archive')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?other=1')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
  });

  it('takes a Runs page only with the Runs section, and never the internal name of History', () => {
    expect(readDeepLink('?runs=watchdog')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=files&runs=watchdog')).toEqual({ section: 'files', runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=runs&runs=runs')).toEqual({ section: 'runs', runsMode: null, settingsScope: null, ticket: null });
  });
});

describe('the Settings page', () => {
  it('reads a scope beside the Settings section', () => {
    expect(readDeepLink('?section=settings&settings=shared')).toEqual({ section: 'settings', runsMode: null, settingsScope: 'shared', ticket: null });
    expect(readDeepLink('?section=settings&settings=local')).toEqual({ section: 'settings', runsMode: null, settingsScope: 'local', ticket: null });
    expect(readDeepLink('?section=settings&settings=dashboards')).toEqual({ section: 'settings', runsMode: null, settingsScope: 'dashboards', ticket: null });
  });

  it('ignores `machines`, a name the page never had, and a Dashboards scope beside no Settings section', () => {
    expect(readDeepLink('?section=settings&settings=machines')).toEqual({ section: 'settings', runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?settings=dashboards')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=files&settings=dashboards')).toEqual({ section: 'files', runsMode: null, settingsScope: null, ticket: null });
  });

  it('ignores a scope beside any other section, or beside none', () => {
    expect(readDeepLink('?section=runs&settings=shared')).toEqual({ section: 'runs', runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?settings=shared')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
  });

  it('ignores an unknown scope, and an inherited object key', () => {
    expect(readDeepLink('?section=settings&settings=bogus')).toEqual({ section: 'settings', runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=settings&settings=constructor')).toEqual({ section: 'settings', runsMode: null, settingsScope: null, ticket: null });
  });
});

describe('withoutDeepLink', () => {
  it('drops the Settings scope with the others', () => {
    expect(withoutDeepLink('/', '?section=settings&settings=shared', '')).toBe('/');
  });

  it('drops the parameters and keeps everything else', () => {
    expect(withoutDeepLink('/', '?section=runs&runs=history', '')).toBe('/');
    expect(withoutDeepLink('/', '?a=1&section=runs&runs=history', '#x')).toBe('/?a=1#x');
  });
});

describe('the Jira ticket pair', () => {
  it('reads a key only beside the Jira section', () => {
    expect(readDeepLink('?section=jira&ticket=PAY-12').ticket).toBe('PAY-12');
    expect(readDeepLink('?ticket=PAY-12')).toEqual({ section: null, runsMode: null, settingsScope: null, ticket: null });
    expect(readDeepLink('?section=runs&ticket=PAY-12').ticket).toBeNull();
  });

  it('ignores a malformed key', () => {
    expect(readDeepLink('?section=jira&ticket=pay-12').ticket).toBeNull();
    expect(readDeepLink('?section=jira&ticket=PAY-').ticket).toBeNull();
  });

  it('is stripped by withoutDeepLink', () => {
    expect(withoutDeepLink('/', '?ticket=PAY-12&x=1', '#h')).toBe('/?x=1#h');
  });
});
