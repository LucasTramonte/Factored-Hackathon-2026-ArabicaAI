import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { LangService } from '../../shared/i18n/lang.service';
import { IntakeStart, Report, Transaction } from '../../shared/models/intake.model';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';

const previous: Report = { protocol: '11111111-1111-4111-8111-111111111111', reference_short: 'AR-AAAA-BBBB', kind: 'complete',
  status: 'closed', closing_note: null, next_step: 'closed_by_person', accepted_at: '2026-10-03T10:00:00.000Z', transaction_id: 'tx-old' };
const transaction: Transaction = { transaction_id: 'tx-old', merchant_name: 'Café', occurred_at: null, source_occurred_at: null, amount: '10.00', currency: 'ARS' };
const start: IntakeStart = { episode_id: '22222222-2222-4222-8222-222222222222', state: 'selection_required', language: 'es', mode: 'guided', replayed: false };

describe('Customer report again', () => {
  let page: CustomerPage;
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(async () => {
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['startIntake', 'identities', 'transactions', 'reports', 'displayed'],
      { client: signal('ana'), card: signal(null), roles: signal(['customer']) });
    service.startIntake.and.resolveTo(start);
    service.identities.and.resolveTo([]);
    service.transactions.and.resolveTo({ items: [transaction], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.reports.and.resolveTo({ items: [previous], has_more: false });
    service.displayed.and.resolveTo({});
    await TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]),
      { provide: CustomerService, useValue: service }, { provide: CognitoService, useValue: { forget: () => undefined } }] }).compileComponents();
    page = TestBed.createComponent(CustomerPage).componentInstance;
    TestBed.inject(LangService).set('es');
    page.transactions.set([transaction]);
    page.reports.set({ items: [previous], has_more: false });
  });

  it('resets an unfrozen choose or details draft before starting the linked report', async () => {
    for (const details of [false, true]) {
      page.newReport(); page.openChat('another-charge');
      page.chatStatement = 'Un borrador diferente que no debe continuar.'; page.reason.set('other'); await page.send();
      if (details) { page.cannotFind(); page.chatDetails = 'Old remembered details'; }
      page.reportAgain(previous);
      expect(page.chatStep()).toBe('describe'); expect(page.episode()).toBeNull(); expect(page.reason()).toBeNull();
      expect(page.chatDetails).toBe(''); expect(page.chatConfirmed).toBeFalse(); expect(page.choice).toBe('tx-old');
      expect(page.previousProtocol()).toBe(previous.protocol);
      expect(page.chatStatement).toContain(previous.reference_short!);
      expect(page.log()).toEqual([{ from: 'bot', key: 'chatHello' }]);
    }
  });

  it('keeps the durable link after the customer edits away the reference, and freezes it for retries', async () => {
    page.reportAgain(previous); page.pickReason('other');
    page.chatStatement = 'Todavía necesito ayuda con esta compra.';
    service.startIntake.and.rejectWith(new ApiError(503));
    await page.send();
    const frozen = page.frozen();
    expect(frozen?.path).toBe('start');
    expect(service.startIntake.calls.mostRecent().args[0].previous_protocol).toBe(previous.protocol);
    page.reportAgain({ ...previous, protocol: '33333333-3333-4333-8333-333333333333' });
    expect(page.frozen()).toBe(frozen); expect(page.previousProtocol()).toBe(previous.protocol);
    service.startIntake.and.resolveTo({ ...start, replayed: true }); await page.run();
    expect(service.startIntake.calls.allArgs()[1][0]).toEqual(service.startIntake.calls.allArgs()[0][0]);
  });

  it('clears the source on a fresh ordinary report and when the customer state resets', async () => {
    page.reportAgain(previous); page.newReport(); expect(page.previousProtocol()).toBeNull();
    page.pickReason('other'); page.chatStatement = 'Una compra distinta necesita revisión.'; await page.send();
    expect(service.startIntake.calls.mostRecent().args[0].previous_protocol).toBeUndefined();
    page.reportAgain(previous); page['reset'](); expect(page.previousProtocol()).toBeNull(); expect(page.episode()).toBeNull();
  });

  it('ignores open-source reports and busy actions, and double clicks send only one linked start', async () => {
    page.chatStatement = 'Do not lose this draft';
    page.reportAgain({ ...previous, status: 'in_review' }); expect(page.chatStatement).toBe('Do not lose this draft');
    page.busy.set(true); page.reportAgain(previous); expect(page.chatStatement).toBe('Do not lose this draft'); page.busy.set(false);
    page.reportAgain(previous); page.reportAgain(previous); expect(service.startIntake).not.toHaveBeenCalled();
    page.pickReason('other');
    let resolve!: (value: IntakeStart) => void;
    service.startIntake.and.returnValue(new Promise(r => { resolve = r; }));
    const sending = page.send(); page.reportAgain(previous); await page.send();
    expect(service.startIntake).toHaveBeenCalledTimes(1);
    expect(service.startIntake.calls.mostRecent().args[0].previous_protocol).toBe(previous.protocol);
    resolve(start); await sending;
  });

  it('keeps the link when the old charge is absent and uses the general guided entry', () => {
    page.transactions.set([]); page.reportAgain(previous);
    expect(page.general()).toBeTrue(); expect(page.choice).toBe(''); expect(page.previousProtocol()).toBe(previous.protocol);
    expect(page.log()).toEqual([{ from: 'bot', key: 'chatHelloGeneral' }]);
  });
});
