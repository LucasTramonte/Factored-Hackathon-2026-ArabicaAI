import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { CustomerPage, formatAmount } from './customer.page';
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
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['identities', 'signIn', 'transactions', 'submitCase']);
    service.identities.and.resolveTo([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' },
      { customer_id: 'demo-bruno', display_name: 'Bruno (demo)' }]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo([tx]);
    await TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] })
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

  it('starts on the intro, moves to sign-in on start, and to the home once charges are loaded', async () => {
    expect(page.step()).toBe('intro');
    page.start();
    expect(page.step()).toBe('login');
    page.identity = 'demo-ana';
    await page.login();
    expect(page.step()).toBe('home');
    expect(page.discClass()).toBe('disc disc--home');
  });

  it('signs in and lists only what the API returns', async () => {
    await readyToSubmit();
    expect(service.signIn).toHaveBeenCalledWith('demo-ana');
    expect(page.transactions()).toEqual([tx]);
    expect(page.totals()).toEqual([{ currency: 'BRL', total: '125.50' }]);
  });

  it('stays on sign-in and shows the mapped error when sign-in fails', async () => {
    page.start();
    service.signIn.and.rejectWith(new ApiError(503, 'unavailable'));
    page.identity = 'demo-ana';
    await page.login();
    expect(page.step()).toBe('login');
    expect(page.error()).toBe('unavailable');
  });

  it('refuses to submit without selection, confirmation and a 10-character statement', async () => {
    await page.login();
    await page.submit();
    expect(service.submitCase).not.toHaveBeenCalled();
    expect(page.error()).toContain('10');
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

  it('loads the identity choices from the API instead of a hard-coded list', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    await fixture.componentInstance.ngOnInit();
    fixture.componentInstance.start();
    fixture.detectChanges();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.ar-row-name')].map(o => o.textContent?.trim());
    expect(rows).toEqual(['Ana (demo)', 'Bruno (demo)']);
    expect(fixture.componentInstance.identity).toBe('demo-ana');
  });

  it('selecting a charge opens the report; cancel clears it unless a request is pending', async () => {
    await page.login();
    page.select('demo-tx-001');
    expect(page.selectedTx()).toEqual(tx);
    page.cancel();
    expect(page.selectedTx()).toBeNull();
  });

  it('counts the statement in code points, as the server does', async () => {
    await readyToSubmit();
    page.statement = '😀😀😀😀😀';
    await page.submit();
    expect(service.submitCase).not.toHaveBeenCalled();
    expect(page.error()).toContain('10');
  });

  it('a definitive rejection unfreezes the form; the next submit uses a new key', async () => {
    await readyToSubmit();
    service.submitCase.and.returnValues(Promise.reject(new ApiError(422, 'Check the fields.')), Promise.resolve(receipt));
    await page.submit();
    expect(page.pending()).toBeNull();
    expect(page.identityLocked()).toBeFalse();
    expect(page.error()).toBe('Check the fields.');
    page.statement = 'A corrected description of the charge.';
    await page.submit();
    const [first, second] = service.submitCase.calls.allArgs().map(args => args[0]);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
    expect(second.customer_statement).toBe('A corrected description of the charge.');
  });

  it('formats totals with thin-space grouping and two decimals, never a currency symbol', () => {
    expect(formatAmount(1234567.5)).toBe('1 234 567.50');
    expect(formatAmount(89.9)).toBe('89.90');
  });
});
