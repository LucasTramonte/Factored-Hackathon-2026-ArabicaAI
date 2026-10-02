import { TestBed } from '@angular/core/testing';
import { ApiError } from '../http/api.service';
import { CognitoService } from './cognito.service';

describe('CognitoService', () => {
  let cognito: CognitoService;
  let fetchSpy: jasmine.Spy;
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/x-amz-json-1.1' } }));
  const sent = (i: number) => {
    const [url, init] = fetchSpy.calls.argsFor(i);
    return { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
  };
  const statusOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e instanceof ApiError ? e.status : e);

  beforeEach(() => {
    cognito = TestBed.inject(CognitoService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  it('requests an email code with the exact InitiateAuth call and answers it with the kept Session', async () => {
    fetchSpy.and.returnValues(reply(200, { ChallengeName: 'EMAIL_OTP', Session: 's1', ChallengeParameters: {} }),
      reply(200, { AuthenticationResult: { IdToken: 'id.token.x', AccessToken: 'a', RefreshToken: 'r', ExpiresIn: 3600 } }));
    await cognito.requestCode('ana@example.com');
    expect(sent(0)).toEqual({ url: 'https://cognito-idp.us-east-2.amazonaws.com/', method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: { AuthFlow: 'USER_AUTH', ClientId: '5ak5cbjgdddso1c3h3i2aha7sn', AuthParameters: { USERNAME: 'ana@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' } } });
    expect(await cognito.submitCode('ana@example.com', '12345678')).toBe('id.token.x');
    expect(sent(1).headers['X-Amz-Target']).toBe('AWSCognitoIdentityProviderService.RespondToAuthChallenge');
    expect(sent(1).body).toEqual({ ChallengeName: 'EMAIL_OTP', ClientId: '5ak5cbjgdddso1c3h3i2aha7sn', Session: 's1',
      ChallengeResponses: { USERNAME: 'ana@example.com', EMAIL_OTP_CODE: '12345678' } });
  });

  it('rejects any challenge other than EMAIL_OTP', async () => {
    fetchSpy.and.returnValue(reply(200, { ChallengeName: 'PASSWORD', Session: 's1' }));
    expect(await statusOf(cognito.requestCode('ana@example.com'))).toBe(503);
  });

  it('maps each Cognito error type to a status, never to AWS text', async () => {
    const table: [string, number][] = [['UserNotFoundException', 401], ['NotAuthorizedException', 401], ['CodeMismatchException', 401],
      ['ExpiredCodeException', 401], ['LimitExceededException', 429], ['TooManyRequestsException', 429], ['InvalidParameterException', 503]];
    for (const [type, status] of table) {
      fetchSpy.and.returnValue(reply(400, { __type: type, message: 'aws text' }));
      expect(await statusOf(cognito.requestCode('ana@example.com'))).withContext(type).toBe(status);
    }
  });

  it('treats a network failure as status 0', async () => {
    fetchSpy.and.returnValue(Promise.reject(new TypeError('Failed to fetch')));
    expect(await statusOf(cognito.requestCode('ana@example.com'))).toBe(0);
  });

  it('keeps the newest Session after a wrong code', async () => {
    fetchSpy.and.returnValues(reply(200, { ChallengeName: 'EMAIL_OTP', Session: 's1' }),
      reply(400, { __type: 'CodeMismatchException', Session: 's2' }), reply(400, { __type: 'CodeMismatchException' }),
      reply(200, { AuthenticationResult: { IdToken: 'id' } }));
    await cognito.requestCode('ana@example.com');
    expect(await statusOf(cognito.submitCode('ana@example.com', '1'))).toBe(401);
    expect(await statusOf(cognito.submitCode('ana@example.com', '2'))).toBe(401);
    await cognito.submitCode('ana@example.com', '3');
    expect([1, 2, 3].map(i => sent(i).body.Session)).toEqual(['s1', 's2', 's2']);
  });

  it('writes nothing to web storage', async () => {
    const write = spyOn(Storage.prototype, 'setItem'); // localStorage and sessionStorage share it
    fetchSpy.and.returnValues(reply(200, { ChallengeName: 'EMAIL_OTP', Session: 's1' }), reply(200, { AuthenticationResult: { IdToken: 'id' } }));
    await cognito.requestCode('ana@example.com');
    await cognito.submitCode('ana@example.com', '12345678');
    expect(write).not.toHaveBeenCalled();
  });
});
