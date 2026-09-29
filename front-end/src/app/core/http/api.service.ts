import { Injectable } from '@angular/core';

const MESSAGES: Record<number, string> = {
  401: 'Session expired. Sign in again with the same identity to continue.',
  404: 'Charge not found for this session.',
  409: 'This request key was used for different content. Do not start another request; ask an agent to check the case.',
  413: 'The description is too long.',
  422: 'Check the fields and confirm the request.',
  503: 'Service unavailable. Acceptance was not confirmed. Retry the same request.'
};

/** User-facing message for an HTTP status. Server text is never shown. */
export function messageFor(status: number): string {
  return MESSAGES[status] ?? 'Request failed (HTTP ' + status + ').';
}

/** A failed API call. ``status`` is 0 when the request never got an answer. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Same-origin JSON client for the intake API. The browser handles the team gate and session cookies. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  async request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, messageFor(503));
    }
    if (!response.ok) throw new ApiError(response.status, messageFor(response.status));
    return response.json() as Promise<T>;
  }
}
