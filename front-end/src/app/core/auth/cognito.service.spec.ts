import { TestBed } from '@angular/core/testing';
import { ApiError } from '../http/api.service';
import { CognitoService } from './cognito.service';
import { cognito as config } from './cognito.config';

describe('CognitoService', () => {
  let service: CognitoService;
  let fetchSpy: jasmine.Spy;
  const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const otp = { ChallengeName: 'EMAIL_OTP', Session: 's1' };
  const statusOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e instanceof ApiError ? e.status : e);
  const sent = (i: number) => JSON.parse(fetchSpy.calls.argsFor(i)[1].body);
  const deferred = () => {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>(done => resolve = done);
    return { promise, resolve: (body: unknown) => resolve(new Response(JSON.stringify(body))) };
  };
  beforeEach(() => { service = TestBed.inject(CognitoService); fetchSpy = spyOn(globalThis, 'fetch'); });

  it('uses the chosen public client for both native OTP request and verification', async () => {
    const store = spyOn(Storage.prototype, 'setItem');
    for (const lang of ['es', 'pt', 'en'] as const) {
      fetchSpy.calls.reset();
      fetchSpy.and.returnValues(reply(200, otp), reply(200, { AuthenticationResult: { IdToken: 'id' } }));
      await service.requestCode('ana@example.com', lang);
      expect(sent(0)).toEqual({ AuthFlow: 'USER_AUTH', ClientId: config.clientIds[lang], AuthParameters: { USERNAME: 'ana@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' } });
      expect(await service.submitCode('ana@example.com', '12345678')).toBe('id');
      expect(sent(1)).toEqual({ ChallengeName: 'EMAIL_OTP', ClientId: config.clientIds[lang], Session: 's1', ChallengeResponses: { USERNAME: 'ana@example.com', EMAIL_OTP_CODE: '12345678' } });
      expect(await statusOf(service.submitCode('ana@example.com', '1'))).toBe(401);
    }
    expect(store).not.toHaveBeenCalled();
  });
  it('rejects non-OTP/missing Session and maps errors without disclosing AWS text', async () => {
    for (const data of [{ ...otp, ChallengeName: 'PASSWORD' }, { ...otp, Session: '' }]) {
      fetchSpy.and.returnValue(reply(200, data));
      expect(await statusOf(service.requestCode('ana@example.com', 'en'))).toBe(503);
    }
    for (const [type, status] of [['UserNotFoundException',401], ['NotAuthorizedException',401], ['CodeMismatchException',401], ['ExpiredCodeException',401], ['LimitExceededException',429], ['TooManyRequestsException',429], ['InvalidParameterException',503]] as const) {
      fetchSpy.and.returnValue(reply(400, { __type: type, message: 'private AWS error' }));
      expect(await statusOf(service.requestCode('ana@example.com', 'es'))).toBe(status);
    }
    fetchSpy.and.rejectWith(new TypeError('network'));
    expect(await statusOf(service.requestCode('ana@example.com', 'es'))).toBe(0);
  });
  it('keeps rotated Session on wrong codes and refuses email swapping', async () => {
    fetchSpy.and.returnValues(reply(200,otp), reply(400,{__type:'CodeMismatchException',Session:'s2'}), reply(200,{AuthenticationResult:{IdToken:'id'}}));
    await service.requestCode('ana@example.com','pt');
    expect(await statusOf(service.submitCode('other@example.com','1'))).toBe(401);
    expect(await statusOf(service.submitCode('ana@example.com','1'))).toBe(401);
    await service.submitCode('ana@example.com','2');
    expect(sent(2).Session).toBe('s2');
    expect(sent(2).ClientId).toBe(config.clientIds.pt);
  });
  it('a failed resend cannot reuse the previous challenge', async () => {
    fetchSpy.and.returnValues(reply(200,otp),reply(400,{__type:'LimitExceededException'}));
    await service.requestCode('ana@example.com','es');
    expect(await statusOf(service.requestCode('ana@example.com','en'))).toBe(429);
    expect(await statusOf(service.submitCode('ana@example.com','1'))).toBe(401);
  });
  it('late requests cannot replace a newer locale/client/Session', async () => {
    const old=deferred(); fetchSpy.and.returnValues(old.promise,reply(200,{...otp,Session:'new'}),reply(200,{AuthenticationResult:{IdToken:'id'}}));
    const first=statusOf(service.requestCode('ana@example.com','pt'));
    await service.requestCode('ana@example.com','en'); old.resolve(otp);
    expect(await first).toBe(503); await service.submitCode('ana@example.com','1');
    expect(sent(2).Session).toBe('new'); expect(sent(2).ClientId).toBe(config.clientIds.en);
  });
  it('forget invalidates pending requests and stale token responses after resend', async () => {
    const pending=deferred(); fetchSpy.and.returnValue(pending.promise);
    const first=statusOf(service.requestCode('ana@example.com','es')); service.forget(); pending.resolve(otp);
    expect(await first).toBe(503);
    const verification=deferred(); fetchSpy.and.returnValues(reply(200,otp),verification.promise,reply(200,{...otp,Session:'new'}));
    await service.requestCode('ana@example.com','es'); const old=statusOf(service.submitCode('ana@example.com','1'));
    await service.requestCode('ana@example.com','pt'); verification.resolve({AuthenticationResult:{IdToken:'old'}});
    expect(await old).toBe(503);
  });
});
