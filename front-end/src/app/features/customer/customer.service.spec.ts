import { TestBed } from '@angular/core/testing';
import { ApiService } from '../../core/http/api.service';
import { CustomerService } from './customer.service';
import { LangService } from '../../shared/i18n/lang.service';

describe('CustomerService guided intake', () => {
  it('posts each guided body unchanged to its own route', async () => {
    const api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
    api.request.and.resolveTo({});
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    const service = TestBed.inject(CustomerService);
    const start = { customer_statement: 'No reconozco este cargo.', idempotency_key: 'k', language: 'es', mode: 'guided', reason: 'not_mine', report_type: 'unrecognized_charge' } as const;
    const confirm = { customer_confirmed: true, episode_id: 'e', idempotency_key: 'k2', transaction_id: 't' } as const;
    const handoff = { episode_id: 'e', idempotency_key: 'k3', kind: 'incomplete' } as const;
    await service.startIntake(start);
    await service.confirmIntake(confirm);
    await service.handoffIntake(handoff);
    await service.signIn('demo-ana');
    await service.signInWithToken('a.b.c');
    await service.logout();
    await service.reports();
    await service.discoverTransactions('Streaming en abril, más de 85000 ARS', 'es', 'e', 'r');
    expect(api.request.calls.allArgs()).toEqual([['/intake/start', start], ['/intake/confirm', confirm], ['/intake/handoff', handoff],
      ['/demo/session', { customer_id: 'demo-ana' }], ['/auth/session', {}, { Authorization: 'Bearer a.b.c' }], ['/auth/logout', {}], ['/reports', undefined, {}, undefined],
      ['/intake/transaction-discovery', { description: 'Streaming en abril, más de 85000 ARS', language: 'es', request_id: 'r', episode_id: 'e' }]]);
  });

  it('uses the language selected when each status email is requested', async () => {
    const api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
    api.request.and.resolveTo({ queued: true });
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    const lang = TestBed.inject(LangService), service = TestBed.inject(CustomerService);
    for (const language of ['es', 'pt', 'en'] as const) {
      lang.set(language);
      await service.requestUpdate('report-protocol');
      expect(api.request.calls.mostRecent().args).toEqual(['/reports/update', { protocol: 'report-protocol', language }]);
    }
  });

  it('sends the interface language on the charges list and posts the display acknowledgement', async () => {
    const api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
    api.request.and.resolveTo({});
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    TestBed.inject(LangService).set('pt');
    const service = TestBed.inject(CustomerService);
    await service.transactions();
    await service.displayed('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(api.request.calls.allArgs()).toEqual([['/transactions?lang=pt'],
      ['/transactions/displayed', { view_ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]]);
  });
  it('sends only current question, selected language and explicit UUID to the owned route', async () => {
    const api=jasmine.createSpyObj<ApiService>('ApiService',['request']);api.request.and.resolveTo({});TestBed.configureTestingModule({providers:[{provide:ApiService,useValue:api}]});
    await TestBed.inject(CustomerService).assist('AR-AAAA-BBBB','Current question','pt','request-uuid');
    expect(api.request.calls.mostRecent().args).toEqual(['/intake/handoff/AR-AAAA-BBBB/assist',{question:'Current question',language:'pt',request_id:'request-uuid'}]);
  });

});


describe('CustomerService transaction discovery', () => {
  for (const language of ['es', 'pt', 'en'] as const) {
    it(`posts only description and explicit ${language} language and returns the server result`, async () => {
      const api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
      const response = { status: 'none' as const, items: [], confidence: 0, missing_fields: [],
        criteria: { merchant_hint: null, date_from: null, date_to: null, currency: null, amount_operator: null, amount: null } };
      api.request.and.resolveTo(response);
      TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
      TestBed.inject(LangService).set(language === 'en' ? 'pt' : 'en');
      const result = await TestBed.inject(CustomerService).discoverTransactions('Streaming in April', language, 'episode-id', 'request-id');
      expect(api.request).toHaveBeenCalledOnceWith('/intake/transaction-discovery', { description: 'Streaming in April', language, episode_id: 'episode-id', request_id: 'request-id' });
      expect(result).toBe(response);
    });
  }

  it('propagates API rejection without retry or fallback requests', async () => {
    const api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
    const failure = new Error('unavailable'); api.request.and.rejectWith(failure);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    await expectAsync(TestBed.inject(CustomerService).discoverTransactions('Streaming in April', 'en', 'episode-id', 'request-id')).toBeRejectedWith(failure);
    expect(api.request).toHaveBeenCalledTimes(1);
  });
});
