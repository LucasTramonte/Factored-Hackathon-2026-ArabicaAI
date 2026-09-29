import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService, messageFor } from './api.service';

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

  it('maps every documented status to a message and keeps the status', async () => {
    for (const status of [401, 404, 409, 413, 422, 503]) {
      fetchSpy.and.returnValue(reply(status, { detail: 'server text is not shown' }));
      try {
        await api.request('/cases', {});
        fail('expected an error');
      } catch (e) {
        expect(e instanceof ApiError).toBeTrue();
        expect((e as ApiError).status).toBe(status);
        expect((e as ApiError).message).toBe(messageFor(status));
        expect((e as ApiError).message).not.toContain('server text');
      }
    }
  });

  it('treats a network failure as unconfirmed, like a 503', async () => {
    fetchSpy.and.returnValue(Promise.reject(new TypeError('Failed to fetch')));
    await expectAsync(api.request('/cases', {})).toBeRejectedWith(new ApiError(0, messageFor(503)));
  });
});
