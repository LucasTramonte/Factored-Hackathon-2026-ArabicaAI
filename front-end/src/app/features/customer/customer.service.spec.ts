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
    expect(api.request.calls.allArgs()).toEqual([['/intake/start', start], ['/intake/confirm', confirm], ['/intake/handoff', handoff],
      ['/demo/session', { customer_id: 'demo-ana' }], ['/auth/session', {}, { Authorization: 'Bearer a.b.c' }], ['/auth/logout', {}], ['/reports', undefined, {}, undefined]]);
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
});
