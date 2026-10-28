import { errorOf, postJson } from '../client/src/lib/http';

// #376 moved these two out of `components/jira/JiraBoardSheet.tsx` and made `errorOf` the one reader of a refusal's sentence, with one rule change: an
// empty `error` string falls through to the fallback, as `failureOf` already did, instead of rendering an empty alert.
describe('errorOf', () => {
  it('reads a non-empty error sentence', () => {
    expect(errorOf({ error: 'refused' }, 'fallback')).toBe('refused');
  });

  it.each([
    ['an empty error string', { error: '' }],
    ['a non-string error', { error: 3 }],
    ['an object without error', {}],
    ['null', null],
    ['a string body', 'text'],
    ['undefined', undefined]
  ])('falls back on %s', (_label, body) => {
    expect(errorOf(body, 'fallback')).toBe('fallback');
  });
});

describe('postJson', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const answer = (status: number, json: () => Promise<unknown>): jest.Mock =>
    (global.fetch = jest.fn().mockResolvedValue({ ok: status < 300, status, json })) as jest.Mock;

  it('sends a JSON POST: method, content type and the stringified body', async () => {
    const f = answer(200, () => Promise.resolve({}));
    await postJson('/api/x', { a: 1 });
    expect(f).toHaveBeenCalledWith('/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
  });

  it('resolves a refusal with its parsed body rather than rejecting', async () => {
    answer(400, () => Promise.resolve({ error: 'x' }));
    await expect(postJson('/api/x', {})).resolves.toEqual({ ok: false, status: 400, body: { error: 'x' } });
  });

  it('resolves a non-JSON answer with body null', async () => {
    answer(502, () => Promise.reject(new SyntaxError('Unexpected token <')));
    await expect(postJson('/api/x', {})).resolves.toEqual({ ok: false, status: 502, body: null });
  });
});
