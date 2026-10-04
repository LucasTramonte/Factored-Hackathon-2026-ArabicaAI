import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Report } from '../../shared/models/intake.model';
const report: Report = { protocol: 'P', reference_short: 'AR-AAAA-BBBB', status: 'received', kind: 'incomplete', transaction_id: null, accepted_at: '2026-10-04T12:00:00Z', closing_note: null, next_step: 'review_pending' };
describe('Customer status email', () => {
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v1', 'dismissed');
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed', 'requestUpdate', 'logout', 'actAs'], { client: signal(''), card: signal(null), roles: signal([]) });
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', roles: ['customer'], mode: 'simulated_login' });
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.reports.and.resolveTo({ items: [report, { ...report, protocol: 'Q' }], has_more: false });
    service.alert.and.resolveTo({ alert: null }); service.identities.and.resolveTo([]); service.logout.and.resolveTo(undefined); service.requestUpdate.and.resolveTo({ queued: true });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]), { provide: CustomerService, useValue: service }, { provide: CognitoService, useValue: { forget: () => undefined } }] });
  });
  afterEach(() => localStorage.removeItem('arabica.customer-tour.v1'));
  function home() {
    const fixture = TestBed.createComponent(CustomerPage); document.body.append(fixture.nativeElement); fixture.detectChanges();
    const page = fixture.componentInstance; page.identity = 'demo-ana'; void page.login(); flushMicrotasks(); fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }
  it('shows loading in all languages, queues once and retains reference and focus', fakeAsync(() => {
    const { fixture, page, el } = home(); let done!: (result: { queued: true }) => void;
    service.requestUpdate.and.returnValue(new Promise(resolve => done = resolve));
    const button = el.querySelector<HTMLButtonElement>('.update-btn')!; button.focus(); button.click(); fixture.detectChanges();
    for (const [lang, loading] of [['es', 'Solicitando correo…'], ['pt', 'Solicitando e-mail…'], ['en', 'Requesting email…']] as const) {
      page.lang.set(lang); fixture.detectChanges(); expect(button.textContent?.trim()).toBe(loading);
      expect(button.getAttribute('aria-label')).toContain('AR-AAAA-BBBB'); expect(button.getAttribute('aria-busy')).toBe('true');
    }
    button.click(); void page.requestUpdate('Q'); expect(service.requestUpdate.calls.count()).toBe(1);
    done({ queued: true }); flushMicrotasks(); fixture.detectChanges(); expect(page.updateNote()?.text).toBe(page.t().updateSent);
    expect(button.getAttribute('aria-disabled')).toBe('false'); expect(document.activeElement).toBe(button); expect(button.disabled).toBeFalse(); fixture.destroy();
  }));
  it('honors server cooldown only for its report and releases it at expiry', fakeAsync(() => {
    const { fixture, page, el } = home();
    service.requestUpdate.and.rejectWith(Object.assign(new ApiError(429), { retryAfterSeconds: 10 }));
    void page.requestUpdate('P'); flushMicrotasks(); fixture.detectChanges(); const buttons = el.querySelectorAll<HTMLButtonElement>('.update-btn');
    expect(buttons[0].getAttribute('aria-disabled')).toBe('true'); expect(buttons[1].getAttribute('aria-disabled')).toBe('false');
    buttons[0].focus(); buttons[0].click(); expect(service.requestUpdate.calls.count()).toBe(1);
    tick(9999); fixture.detectChanges(); expect(buttons[0].getAttribute('aria-disabled')).toBe('true');
    tick(1); fixture.detectChanges(); expect(buttons[0].getAttribute('aria-disabled')).toBe('false'); expect(document.activeElement).toBe(buttons[0]);
    service.requestUpdate.and.resolveTo({ queued: true }); buttons[0].click(); flushMicrotasks(); expect(service.requestUpdate.calls.count()).toBe(2); fixture.destroy();
  }));
  it('keeps reports readable and retryable after missing email, absent cooldown and network/service failure', fakeAsync(() => {
    const { fixture, page, el } = home();
    for (const status of [409, 429, 0, 503]) {
      service.requestUpdate.and.rejectWith(new ApiError(status)); void page.requestUpdate('P'); flushMicrotasks(); fixture.detectChanges();
      expect(page.updating()).toBeNull(); expect(el.querySelector('.update-btn')?.getAttribute('aria-disabled')).toBe('false'); expect(page.reports()!.items[0]).toEqual(report);
      expect(page.updateNote()?.text).toBe(status === 409 ? page.t().updateNoEmail : status === 429 ? page.t().updateRecent : (page.t() as unknown as Record<string, string>)['updateFailed']);
    }
    service.requestUpdate.and.resolveTo({ queued: true }); void page.requestUpdate('P'); flushMicrotasks(); expect(page.updateNote()?.text).toBe(page.t().updateSent); fixture.destroy();
  }));
  for (const exit of ['logout', 'act-as', 'destroy'] as const) for (const outcome of ['success', 'failure'] as const) it(`ignores late ${outcome} after ${exit} without clearing a new request`, fakeAsync(() => {
    const { fixture, page } = home(); let settle!: () => void;
    service.requestUpdate.and.returnValue(new Promise((resolve, reject) => settle = () => outcome === 'success' ? resolve({ queued: true }) : reject(new ApiError(503)))); void page.requestUpdate('P');
    if (exit === 'logout') { void page.signOut(); flushMicrotasks(); }
    else if (exit === 'destroy') fixture.destroy();
    else { service.actAs.and.resolveTo({ customer_id: 'demo-bruno', roles: ['admin'], mode: 'admin_act_as' }); page.actAsIdentities.set([{ customer_id: 'demo-bruno', display_name: 'Bruno' }]); page.actAsChoice = 'demo-bruno'; void page.actAs(); flushMicrotasks(); }
    if (exit !== 'destroy') { expect(page.updating()).toBeNull(); expect(page.updateNote()).toBeNull(); service.requestUpdate.and.returnValue(new Promise(() => undefined)); void page.requestUpdate('Q'); expect(page.updating()).toBe('Q'); }
    settle(); flushMicrotasks(); expect(page.updateNote()).toBeNull(); if (exit !== 'destroy') { expect(page.updating()).toBe('Q'); fixture.destroy(); }
  }));
});
