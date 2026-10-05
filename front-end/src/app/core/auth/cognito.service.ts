import { Injectable } from '@angular/core';
import { ApiError } from '../http/api.service';
import { cognito } from './cognito.config';
import { Lang } from '../../shared/i18n/lang.service';

/** The fields read from a Cognito JSON reply (success or error). */
interface CognitoReply {
  ChallengeName?: string;
  Session?: string;
  AuthenticationResult?: { IdToken?: string };
  __type?: string;
}

const ENDPOINT = `https://cognito-idp.${cognito.region}.amazonaws.com/`;
/** Cognito error types → the status the UI maps to text; anything else is 503. One status for a wrong code or unknown user: no enumeration. */
const STATUS: Record<string, number> = { UserNotFoundException: 401, NotAuthorizedException: 401, CodeMismatchException: 401,
  ExpiredCodeException: 401, LimitExceededException: 429, TooManyRequestsException: 429 };

/**
 * Passwordless email one-time-code sign-in against the Cognito JSON API, from the browser. Only the ID token
 * leaves this service; the challenge Session lives in memory only and no token is ever stored.
 */
@Injectable({ providedIn: 'root' })
export class CognitoService {
  private session = '';
  private email = '';
  private clientId = '';
  private attempt = 0;

  /** Snapshot the language's public client; only the newest request can keep a challenge Session. */
  async requestCode(email: string, locale: Lang): Promise<void> {
    const attempt = ++this.attempt;
    this.session = '';
    this.email = '';
    this.clientId = '';
    const lang = ['es', 'pt', 'en'].includes(locale) ? locale : 'es';
    const clientId = cognito.clientIds[lang];
    const selected = await this.call('InitiateAuth', { AuthFlow: 'USER_AUTH', ClientId: clientId,
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' } });
    if (attempt !== this.attempt || selected.ChallengeName !== 'EMAIL_OTP' || !selected.Session) throw new ApiError(503);
    this.session = selected.Session;
    this.email = email;
    this.clientId = clientId;
  }

  /** Answer the native code challenge; stale responses cannot return a token or change a newer attempt's Session. */
  async submitCode(email: string, code: string): Promise<string> {
    if (!this.session || this.email !== email) throw new ApiError(401);
    const attempt = ++this.attempt;
    const r = await this.call('RespondToAuthChallenge', { ChallengeName: 'EMAIL_OTP', ClientId: this.clientId, Session: this.session,
      ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code } }, reply => {
        if (attempt === this.attempt && typeof reply.Session === 'string' && reply.Session) this.session = reply.Session;
      });
    if (attempt !== this.attempt) throw new ApiError(503);
    const token = r.AuthenticationResult?.IdToken;
    if (!token) throw new ApiError(503);
    this.forget();
    return token;
  }

  /** Drop the pending challenge and invalidate in-flight replies ("use another email"). */
  forget(): void {
    ++this.attempt;
    this.session = '';
    this.email = '';
    this.clientId = '';
  }

  private async call(target: string, body: unknown, onReply?: (reply: CognitoReply) => void): Promise<CognitoReply> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` }, body: JSON.stringify(body) });
    } catch {
      throw new ApiError(0);
    }
    const data: CognitoReply = await response.json().catch(() => ({}));
    onReply?.(data);
    if (!response.ok) throw new ApiError(STATUS[String(data.__type ?? '').split('#').pop()!] ?? 503);
    return data;
  }
}
