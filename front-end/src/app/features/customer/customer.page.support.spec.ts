import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Report, MessageThread } from '../../shared/models/intake.model';

const report: Report = { protocol: 'P', reference_short: 'AR-AAAA-BBBB', status: 'received', kind: 'incomplete', transaction_id: null,
  accepted_at: '2026-10-04T12:00:00Z', closing_note: null, next_step: 'review_pending' };
const customerMessage = { message_id: 'customer-1', author: 'customer' as const, body: 'Synthetic merchant details', created_at: '2026-10-04T12:01:00Z' };
const humanMessage = { message_id: 'agent-1', author: 'agent' as const, body: 'Please check your receipt.', created_at: '2026-10-04T12:02:00Z' };

describe('Customer report support', () => {
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v1', 'dismissed');
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed', 'messages', 'postMessage', 'logout', 'requestUpdate'],
      { client: signal(''), card: signal(null), roles: signal([]) });
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', roles: ['customer'], mode: 'simulated_login' });
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.reports.and.resolveTo({ items: [report], has_more: false }); service.alert.and.resolveTo({ alert: null }); service.identities.and.resolveTo([]);
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] }); service.logout.and.resolveTo(undefined);
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]), { provide: CustomerService, useValue: service },
      { provide: CognitoService, useValue: { forget: () => undefined } }] });
  });
  afterEach(() => localStorage.removeItem('arabica.customer-tour.v1'));
  function home() {
    const fixture = TestBed.createComponent(CustomerPage); document.body.append(fixture.nativeElement); fixture.detectChanges();
    const page = fixture.componentInstance; page.lang.set('en'); page.identity = 'demo-ana'; void page.login(); flushMicrotasks(); fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }
  // Access via a shape keeps the red test compiling before the production action exists.
  function check(page: CustomerPage, protocol = 'P'): Promise<void> {
    return (page as CustomerPage & { checkReportStatus(protocol: string): Promise<void> }).checkReportStatus(protocol);
  }

  it('shows one report progress header with an explicitly human thread', fakeAsync(() => {
    const { fixture, page, el } = home(); void page.toggleMessages('P'); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelectorAll('.report-progress').length).toBe(1);
    expect(el.querySelector('app-message-thread h3')?.textContent).toBe('Messages with the review team');
    fixture.destroy();
  }));

  it('shows saved acknowledgement only after success and waiting from persisted order, including reload', fakeAsync(() => {
    const { fixture, page, el } = home(); page.lang.set('en'); void page.toggleMessages('P'); flushMicrotasks(); fixture.detectChanges();
    let saved!: (value: typeof customerMessage) => void;
    service.postMessage.and.returnValue(new Promise(resolve => saved = resolve));
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [customerMessage] });
    void page.sendMessage(customerMessage.body); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('.message-saved')).toBeNull(); expect(el.querySelector('.messages-waiting')).toBeNull();
    saved(customerMessage); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('.message-saved')?.textContent).toContain('Message saved');
    expect(el.querySelector('.messages-waiting')?.textContent).toContain('Waiting for the review team');
    fixture.destroy();
    const reloaded = home(); reloaded.page.lang.set('en'); void reloaded.page.toggleMessages('P'); flushMicrotasks(); reloaded.fixture.detectChanges();
    expect(reloaded.el.querySelector('.messages-waiting')?.textContent).toContain('Waiting for the review team');
    expect(reloaded.el.querySelector('.message-saved')).toBeNull(); reloaded.fixture.destroy();
  }));

  it('keeps an unsaved draft and offers retry without acknowledging persistence', fakeAsync(() => {
    const { fixture, page, el } = home(); page.lang.set('en'); void page.toggleMessages('P'); flushMicrotasks(); fixture.detectChanges();
    flushMicrotasks(); fixture.detectChanges();
    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = 'Unsent synthetic details'; area.dispatchEvent(new Event('input')); flushMicrotasks();
    service.postMessage.and.rejectWith(new ApiError(503)); el.querySelector<HTMLButtonElement>('.message-send')!.click(); flushMicrotasks(); fixture.detectChanges();
    expect(area.value).toBe('Unsent synthetic details'); expect(el.querySelector('.message-saved')).toBeNull();
    expect(el.querySelector('.messages-waiting')).toBeNull();
    expect(el.querySelector('.message-send')?.textContent).toContain('Retry message'); fixture.destroy();
  }));

  it('announces a subsequent human reply once and shows the persisted closure explanation', fakeAsync(() => {
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [customerMessage] });
    const { fixture, page, el } = home(); void page.toggleMessages('P'); flushMicrotasks(); fixture.detectChanges();
    service.messages.and.resolveTo({ status: 'in_review', can_post: true, items: [customerMessage, humanMessage] });
    tick(30000); flushMicrotasks(); fixture.detectChanges(); expect(page.agentReplyNotice()).toBeTrue(); expect(el.querySelector('.messages-waiting')).toBeNull();
    page.agentReplyNotice.set(false); tick(30000); flushMicrotasks(); expect(page.agentReplyNotice()).toBeFalse();
    service.reports.and.resolveTo({ items: [{ ...report, status: 'closed', next_step: 'closed_by_person', closing_note: 'Human explanation, no refund started.' }], has_more: false });
    service.messages.and.resolveTo({ status: 'closed', can_post: false, items: [customerMessage, humanMessage] });
    tick(30000); flushMicrotasks(); fixture.detectChanges(); expect(el.querySelector('.closing-explanation')?.textContent).toContain('Human explanation, no refund started.');
    expect(el.querySelector('.messages-waiting')).toBeNull(); expect(el.querySelector('textarea')).toBeNull();
    page.reports.set({ items: [{ ...report, status: 'closed' }], has_more: false }); fixture.detectChanges();
    expect(el.querySelector('.closing-explanation')?.textContent).toContain(page.t().closingLegacy); fixture.destroy();
  }));

  for (const lang of ['es', 'pt', 'en'] as const) for (const status of ['received', 'in_review', 'closed'] as const) {
    it(`explains freshly read ${status} in ${lang} with receipt/check times and no writes`, fakeAsync(() => {
      const { fixture, page, el } = home(); page.lang.set(lang);
      const latest = { ...report, status, next_step: status === 'closed' ? 'closed_by_person' as const : status === 'in_review' ? 'being_reviewed' as const : 'review_pending' as const,
        closing_note: status === 'closed' ? 'Recorded closure' : null };
      service.reports.and.resolveTo({ items: [latest], has_more: false }); tick(1000); void check(page); flushMicrotasks(); fixture.detectChanges();
      const answer = el.querySelector('.status-explanation'); expect(answer).not.toBeNull();
      expect(answer?.textContent).toContain(page.t()[page.statusChip[status]]);
      expect(answer?.textContent).toContain(page.statusHelp(latest));
      expect(answer?.textContent).toContain(page.t().automaticStatus);
      expect(answer?.textContent).toContain(page.t().statusUpdateUnavailable);
      expect(answer?.textContent).toContain('2026-10-04 12:00:00');
      expect(answer?.querySelector('.status-checked')?.textContent).toContain(new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' '));
      if (status === 'closed') expect(answer?.textContent).toContain('Recorded closure');
      expect(answer?.querySelector('.status-source-time')?.textContent).not.toBe(answer?.querySelector('.status-checked')?.textContent);
      expect(service.postMessage).not.toHaveBeenCalled(); expect(service.requestUpdate).not.toHaveBeenCalled(); expect(service.messages).not.toHaveBeenCalled();
      expect(service.reports.calls.count()).toBe(2); fixture.destroy();
    }));
  }
  it('coalesces repeated status clicks and never reads a foreign reference', fakeAsync(() => {
    const { fixture, page } = home(); let resolve!: (value: { items: Report[]; has_more: boolean }) => void;
    service.reports.and.returnValue(new Promise(r => resolve = r)); void check(page, 'foreign'); expect(service.reports.calls.count()).toBe(1);
    void check(page); void check(page); expect(service.reports.calls.count()).toBe(2);
    resolve({ items: [report], has_more: false }); flushMicrotasks(); expect(service.postMessage).not.toHaveBeenCalled(); fixture.destroy();
  }));
  it('shows unavailable when the owned refresh no longer returns the report', fakeAsync(() => {
    const { fixture, page, el } = home(); service.reports.and.resolveTo({ items: [], has_more: false }); void check(page); flushMicrotasks();
    expect(page.reports()!.items).toEqual([]); expect(page.statusExplanation()?.failed).toBeTrue();
    // Its row is gone, so an old answer cannot remain under a different report.
    fixture.detectChanges(); expect(el.querySelector('.status-explanation')).toBeNull(); fixture.destroy();
  }));
  it('marks failed checks stale and does not claim a new confirmed check', fakeAsync(() => {
    const { fixture, page, el } = home(); page.lang.set('en'); tick(1000); void check(page); flushMicrotasks(); fixture.detectChanges();
    const confirmed = el.querySelector('.status-checked')?.textContent;
    service.reports.and.rejectWith(new ApiError(503)); tick(1000); void check(page); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('.status-explanation')?.textContent).toContain(page.t().refreshFailed);
    expect(el.querySelector('.status-checked')?.textContent).toBe(confirmed); fixture.destroy();
  }));
  for (const change of ['report', 'session', 'language'] as const) it(`discards a late status answer on ${change} change`, fakeAsync(() => {
    const { fixture, page, el } = home(); void page.toggleMessages('P'); flushMicrotasks();
    let resolve!: (value: { items: Report[]; has_more: boolean }) => void;
    service.reports.and.returnValue(new Promise(r => resolve = r)); tick(1000); void check(page);
    if (change === 'report') void page.toggleMessages('Q');
    else if (change === 'session') { void page.signOut(); flushMicrotasks(); }
    else page.lang.set(page.lang.lang() === 'en' ? 'es' : 'en');
    resolve({ items: [{ ...report, status: 'closed' }], has_more: false }); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('.status-explanation')).toBeNull(); fixture.destroy();
  }));
});
