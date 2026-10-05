import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { Transaction } from '../../shared/models/intake.model';

const KEY = 'arabica.customer-tour.v2';
const tx: Transaction = { transaction_id: 'tour-charge', merchant_name: 'Café', amount: '10', currency: 'BRL', occurred_at: null, source_occurred_at: null };
describe('Customer tour eligibility and preference', () => {
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.removeItem(KEY);
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed'],
      { client: signal(''), card: signal(null), roles: signal([]) });
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', roles: ['customer'] } as never);
    service.transactions.and.resolveTo({ items: [tx], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.reports.and.resolveTo({ items: [], has_more: false }); service.alert.and.resolveTo({ alert: null }); service.identities.and.resolveTo([]);
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]), { provide: CustomerService, useValue: service },
      { provide: CognitoService, useValue: { forget: () => undefined } }] });
  });
  afterEach(() => localStorage.removeItem(KEY));
  async function home() {
    const fixture = TestBed.createComponent(CustomerPage); document.body.append(fixture.nativeElement);
    fixture.autoDetectChanges(); const page = fixture.componentInstance; page.identity = 'demo-ana'; await page.login(); await fixture.whenStable();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }
  it('offers once after initial reads, highlights a real row and persists skip across identity changes', async () => {
    const { fixture, page, el } = await home();
    expect(page.tour()).toBe('welcome'); expect(el.querySelector('dialog:modal')).not.toBeNull();
    expect(page.tourSteps()[1].targetId).toBe('tour-report-charge');
    page.endTour(); expect(localStorage.getItem(KEY)).toBe('dismissed');
    Object.assign(service, { actAs: jasmine.createSpy('actAs').and.resolveTo({ customer_id: 'demo-bruno', roles: ['admin'] }) });
    page.actAsIdentities.set([{ customer_id: 'demo-bruno', display_name: 'Bruno' }]); page.actAsChoice = 'demo-bruno';
    await page.actAs(); await fixture.whenStable(); expect(page.tour()).toBeNull();
    page.startTour(); expect(page.tour()).toBe('steps'); fixture.destroy();
  });
  for (const preference of ['dismissed', 'complete']) it(`keeps ${preference} preference and allows replay/completion`, async () => {
    localStorage.setItem(KEY, preference); const { fixture, page } = await home(); expect(page.tour()).toBeNull();
    page.startTour(); expect(page.tour()).toBe('steps'); page.endTour(true); expect(localStorage.getItem(KEY)).toBe('complete'); fixture.destroy();
  });
  it('waits for all initial reads before offering and does not obscure a late bank alert', async () => {
    let answer!: (value: { alert: Transaction | null }) => void;
    service.alert.and.returnValue(new Promise(resolve => answer = resolve));
    const fixture = TestBed.createComponent(CustomerPage); document.body.append(fixture.nativeElement); fixture.autoDetectChanges();
    const page = fixture.componentInstance; page.identity = 'demo-ana'; const signingIn = page.login();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); fixture.detectChanges();
    expect(page.tour()).toBeNull();
    await signingIn; expect(page.step()).toBe('home'); expect(page.busy()).toBeFalse();
    answer({ alert: tx }); await fixture.whenStable(); expect(page.tour()).toBeNull(); expect(page.alert()).toBe(tx); fixture.destroy();
  });
  it('defers an urgent bank alert to Help, without answering it', async () => {
    service.alert.and.resolveTo({ alert: tx }); const { fixture, page } = await home();
    expect(page.tour()).toBeNull(); expect(page.alert()).toBe(tx); page.startTour(); expect(page.tour()).toBe('steps'); expect(page.alert()).toBe(tx); fixture.destroy();
  });
  it('uses the Help problem entry without charges and still offers when optional alert read fails', async () => {
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null }); service.alert.and.rejectWith(new Error('offline'));
    const { fixture, page } = await home(); expect(page.tour()).toBe('welcome'); expect(page.tourSteps()[1].targetId).toBe('report-entry');
    expect(page.tourSteps()[1].body).toBe(page.t().tourMissing); fixture.destroy();
  });
  it('storage denial never blocks entry and suppresses repeated offers in the page session', async () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('denied'); spyOn(Storage.prototype, 'setItem').and.throwError('denied');
    const { fixture, page } = await home(); expect(page.tour()).toBe('welcome'); page.endTour(); page['reset'](); page.step.set('home'); page['offerTour'](); expect(page.tour()).toBeNull();
    page.startTour(); expect(page.tour()).toBe('steps'); fixture.destroy();
  });
});
