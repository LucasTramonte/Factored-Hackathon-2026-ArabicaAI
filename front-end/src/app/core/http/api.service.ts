import { Injectable } from '@angular/core';

/**
 * A failed API call. ``status`` is 0 when the request never got an answer. Only the status is
 * meaningful; the UI maps it to text (``errorText``) and server text is never kept or shown.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message = `HTTP ${status}`) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Same-origin JSON client for the intake API. The browser handles the team gate and session cookies. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  /** ``headers`` are merged over the defaults (e.g. ``Authorization`` for the sign-in token). */
  async request<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0);
    }
    if (!response.ok) throw new ApiError(response.status);
    return response.json() as Promise<T>;
  }
}
