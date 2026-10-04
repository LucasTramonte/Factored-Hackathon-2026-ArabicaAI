import { Injectable } from '@angular/core';

/** Allowlisted conflict reasons; unknown server details are discarded. */
export type ConflictReason = 'open-report' | 'closed-thread' | 'full-thread' | 'key-conflict' | 'unknown';

function conflictReason(detail: unknown): ConflictReason {
  switch (detail) {
    case 'This charge already has an open report': return 'open-report';
    case 'This report is closed; messages are read-only': return 'closed-thread';
    case 'This report already has 50 messages': return 'full-thread';
    case 'This idempotency_key was used for another message': return 'key-conflict';
    default: return 'unknown';
  }
}

/**
 * A failed API call. ``status`` is 0 when the request never got an answer. The UI maps the status to text
 * (``errorText``) and server text is never kept or shown. ``reason`` identifies known 409 conflicts;
 * ``openReport`` preserves the existing charge-report conflict flag.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message = `HTTP ${status}`, readonly openReport = false, readonly reason: ConflictReason = 'unknown') {
    super(message);
    this.name = 'ApiError';
  }
}

/** Same-origin JSON client for the intake API. The browser handles the session cookies. */
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
    if (!response.ok) {
      const reason = response.status === 409
        ? conflictReason((await response.json().catch(() => null))?.detail) : 'unknown';
      throw new ApiError(response.status, undefined, reason === 'open-report', reason);
    }
    return response.json() as Promise<T>;
  }
}
