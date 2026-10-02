import { Injectable } from '@angular/core';
import { ApiError } from '../http/api.service';
import { cognito } from './cognito.config';

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

  /** Ask Cognito to email a code. Only an EMAIL_OTP challenge is accepted; the pool's password factor is never used. */
  async requestCode(email: string): Promise<void> {
    this.session = '';
    const r = await this.call('InitiateAuth', { AuthFlow: 'USER_AUTH', ClientId: cognito.clientId,
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' } });
    if (r.ChallengeName !== 'EMAIL_OTP' || !this.session) {
      this.session = '';
      throw new ApiError(503);
    }
  }

  /** Answer the challenge; resolves the ID token and forgets the Session. A wrong code keeps the newest Session for another try. */
  async submitCode(email: string, code: string): Promise<string> {
    const r = await this.call('RespondToAuthChallenge', { ChallengeName: 'EMAIL_OTP', ClientId: cognito.clientId, Session: this.session,
      ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code } });
    const token = r.AuthenticationResult?.IdToken;
    if (!token) throw new ApiError(503);
    this.session = '';
    return token;
  }

  /** Drop the pending challenge ("use another email"). */
  forget(): void {
    this.session = '';
  }

  private async call(target: string, body: unknown): Promise<CognitoReply> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` }, body: JSON.stringify(body) });
    } catch {
      throw new ApiError(0);
    }
    const data: CognitoReply = await response.json().catch(() => ({}));
    if (typeof data.Session === 'string' && data.Session) this.session = data.Session;
    if (!response.ok) throw new ApiError(STATUS[String(data.__type ?? '').split('#').pop()!] ?? 503);
    return data;
  }
}
