import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService } from './api.service';

describe('ApiService', () => {
  let api: ApiService;
  let fetchSpy: jasmine.Spy;
  const reply = (status: number, body: unknown = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  beforeEach(() => {
    api = TestBed.inject(ApiService);
    fetchSpy = spyOn(window, 'fetch');
  });

  it('sends same-origin JSON for POST and a bare GET otherwise', async () => {
    fetchSpy.and.returnValues(reply(200, { ok: 1 }), reply(200, { items: [] }));
    expect(await api.request<{ ok: number }>('/cases', { a: 1 })).toEqual({ ok: 1 });
    await api.request('/transactions');
    const [path, post] = fetchSpy.calls.argsFor(0);
    expect(path).toBe('/cases');
    expect(post.method).toBe('POST');
    expect(post.credentials).toBe('same-origin');
    expect(post.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(post.body).toBe('{"a":1}');
    const get = fetchSpy.calls.argsFor(1)[1];
    expect(get.method).toBe('GET');
    expect(get.body).toBeUndefined();
  });

  it('merges extra headers into the request', async () => {
    fetchSpy.and.returnValue(reply(200, {}));
    await api.request('/auth/session', {}, { Authorization: 'Bearer a.b.c' });
    expect(fetchSpy.calls.argsFor(0)[1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer a.b.c' });
  });

  it('keeps the status of every documented failure and never the server text', async () => {
    for (const status of [401, 404, 409, 413, 422, 503]) {
      fetchSpy.and.returnValue(reply(status, { detail: 'server text is not shown' }));
      try {
        await api.request('/cases', {});
        fail('expected an error');
      } catch (e) {
        expect(e instanceof ApiError).toBeTrue();
        expect((e as ApiError).status).toBe(status);
        expect((e as ApiError).message).not.toContain('server text');
      }
    }
  });

  it('flags only the open-report 409, by its detail, and keeps no server text', async () => {
    fetchSpy.and.returnValue(reply(409, { detail: 'This charge already has an open report' }));
    const e = await api.request('/intake/confirm', {}).then(() => null, (x: unknown) => x) as ApiError;
    expect(e.status).toBe(409);
    expect(e.openReport).toBeTrue();
    expect(e.message).not.toContain('open report');
  });

  it('leaves openReport false for any other 409 body, including one that is not JSON', async () => {
    for (const response of [reply(409, { detail: 'Episode is no longer open' }), reply(409, {}),
      Promise.resolve(new Response('not json', { status: 409 }))]) {
      fetchSpy.and.returnValue(response);
      const e = await api.request('/intake/confirm', {}).then(() => null, (x: unknown) => x) as ApiError;
      expect(e.status).toBe(409);
      expect(e.openReport).toBeFalse();
    }
  });

  it('keeps only finite bounded numeric Retry-After seconds', async () => {
    for (const [header, expected] of [['10', 10], ['300', 300], ['0', 0], ['301', undefined], ['-1', undefined],
      ['1.5', undefined], ['Infinity', undefined], ['NaN', undefined], ['1e2', undefined], ['', undefined], [null, undefined],
      ['Sun, 04 Oct 2026 20:30:00 GMT', undefined]] as const) {
      fetchSpy.and.resolveTo(new Response('{}', { status: 429, headers: header === null ? {} : { 'Retry-After': header } }));
      const error = await api.request('/reports/update', { protocol: 'P' }).catch(e => e) as ApiError & { retryAfterSeconds?: number };
      expect(error.retryAfterSeconds).withContext(String(header)).toBe(expected);
      expect(error.message).toBe('HTTP 429');
    }
  });

  it('a 204 resolves without reading a body', async () => {
    fetchSpy.and.returnValue(Promise.resolve(new Response(null, { status: 204 })));
    expect(await api.request('/auth/logout', {})).toBeUndefined();
  });

  it('preserves allowlisted conflict reasons without retaining server text', async () => {
    const cases = [
      ['This report is closed; messages are read-only', 'closed-thread'],
      ['This report already has 50 messages', 'full-thread'],
      ['This idempotency_key was used for another message', 'key-conflict'],
      ['untrusted detail', 'unknown']
    ];
    for (const [detail, reason] of cases) {
      fetchSpy.and.returnValue(reply(409, { detail }));
      const e = await api.request('/messages', {}).then(() => { throw new Error('expected failure'); }, (e: ApiError) => e);
      expect(e.reason).toBe(reason);
      expect(e.message).toBe('HTTP 409');
    }
    for (const body of [null, {}, { detail: 42 }]) {
      fetchSpy.and.returnValue(reply(409, body));
      const e = await api.request('/messages', {}).then(() => { throw new Error('expected failure'); }, (e: ApiError) => e);
      expect(e.reason).toBe('unknown');
    }
    fetchSpy.and.returnValue(reply(503, { detail: cases[0][0] }));
    const e = await api.request('/messages', {}).then(() => { throw new Error('expected failure'); }, (e: ApiError) => e);
    expect(e.reason).toBe('unknown');
  });

  it('treats a network failure as unconfirmed, like a 503', async () => {
    fetchSpy.and.returnValue(Promise.reject(new TypeError('Failed to fetch')));
    const e = await api.request('/cases', {}).then(() => null, (x: unknown) => x);
    expect(e instanceof ApiError && e.status).toBe(0);
  });

  it('forwards cancellation to the physical fetch and maps an aborted read to an unconfirmed error', async () => {
    const controller = new AbortController();
    fetchSpy.and.callFake((_path: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const read = api.request('/reports', undefined, {}, controller.signal).catch(e => e);
    expect(fetchSpy.calls.mostRecent().args[1].signal).toBe(controller.signal); controller.abort();
    const error = await read; expect(error instanceof ApiError).toBeTrue(); expect((error as ApiError).status).toBe(0);
  });
});
