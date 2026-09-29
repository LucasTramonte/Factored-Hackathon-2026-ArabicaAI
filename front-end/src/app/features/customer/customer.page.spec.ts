import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/http/api.service';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { Receipt, Transaction } from '../../shared/models/intake.model';

describe('CustomerPage', () => {
  let service: jasmine.SpyObj<CustomerService>;
  let page: CustomerPage;
  const tx: Transaction = { transaction_id: 'demo-tx-001', merchant_name: 'Mercado', occurred_at: null,
    source_occurred_at: '2026-02-26T13:21:51', amount: '125.50', currency: 'BRL' };
  const receipt: Receipt = { protocol: '11111111-2222-4333-8444-555555555555', transaction_id: 'demo-tx-001', status: 'accepted',
    accepted_at: '2026-09-29T12:00:00Z', replayed: false, scope: 'synthetic_demo_only', next_step: 'Await review' };

  beforeEach(async () => {
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'submitCase']);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo([tx]);
    await TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }] })
      .compileComponents();
    page = TestBed.createComponent(CustomerPage).componentInstance;
  });

  async function readyToSubmit() {
    page.identity = 'demo-ana';
    await page.login();
    page.selected = 'demo-tx-001';
    page.statement = '  I do not recognize this charge.  ';
    page.confirmed = true;
  }

  it('signs in and lists only what the API returns', async () => {
    await readyToSubmit();
    expect(service.signIn).toHaveBeenCalledWith('demo-ana');
    expect(page.transactions()).toEqual([tx]);
  });

  it('refuses to submit without selection, confirmation and a 10-character statement', async () => {
    await page.login();
    await page.submit();
    expect(service.submitCase).not.toHaveBeenCalled();
    expect(page.error()).toContain('confirm');
  });

  it('freezes the payload and reuses the same key on retry, even if the form changes', async () => {
    await readyToSubmit();
    service.submitCase.and.returnValues(Promise.reject(new ApiError(503, 'unavailable')), Promise.resolve(receipt));
    await page.submit();
    expect(page.receipt()).toBeNull();
    expect(page.pending()).not.toBeNull();
    page.statement = 'Edited after the failure, must not be sent.';
    page.selected = 'other';
    await page.submit();
    const [first, second] = service.submitCase.calls.allArgs().map(args => args[0]);
    expect(second).toEqual(first);
    expect(first.customer_statement).toBe('I do not recognize this charge.');
    expect(first.customer_confirmed).toBeTrue();
    expect(first.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.receipt()).toEqual(receipt);
    expect(page.pending()).toBeNull();
  });

  it('keeps the same identity while a request is pending, even if another is selected', async () => {
    await readyToSubmit();
    service.submitCase.and.rejectWith(new ApiError(401, 'expired'));
    await page.submit();
    expect(page.identityLocked()).toBeTrue();
    page.identity = 'demo-bruno';
    await page.login();
    expect(service.signIn.calls.mostRecent().args[0]).toBe('demo-ana');
  });

  it('does not submit twice while busy or after a receipt', async () => {
    await readyToSubmit();
    service.submitCase.and.resolveTo(receipt);
    await Promise.all([page.submit(), page.submit()]);
    await page.submit();
    expect(service.submitCase).toHaveBeenCalledTimes(1);
  });
});
