import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Report, MessageThread } from '../../shared/models/intake.model';
const report: Report = { protocol: 'P', reference_short: 'AR-AAAA-BBBB', status: 'received', kind: 'incomplete', transaction_id: null, accepted_at: '2026-10-04T12:00:00Z', next_step: 'review_pending' };
describe('Customer bounded refresh', () => {
  let visible: DocumentVisibilityState, online: boolean;
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v1', 'dismissed');
    visible = 'visible'; online = true;
    spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visible);
    spyOnProperty(navigator, 'onLine', 'get').and.callFake(() => online);
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed', 'messages', 'logout'],
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
    const page = fixture.componentInstance; page.identity = 'demo-ana'; void page.login(); flushMicrotasks(); fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }
  it('refreshes the confirmed report at thirty seconds without replacing the page', fakeAsync(() => {
    const fixture = TestBed.createComponent(CustomerPage); fixture.detectChanges(); const page = fixture.componentInstance;
    page.identity = 'demo-ana'; void page.login(); flushMicrotasks(); fixture.detectChanges();
    service.reports.and.resolveTo({ items: [{ ...report, status: 'in_review' }], has_more: false });
    tick(29999); expect(page.reports()!.items[0].status).toBe('received');
    tick(1); flushMicrotasks(); expect(page.reports()!.items[0].status).toBe('in_review'); fixture.destroy();
  }));

  it('coalesces manual, focus and visible triggers while reading and immediately after success', fakeAsync(() => {
    const { fixture, page } = home(); tick(1000);
    let answer!: (value: { items: Report[]; has_more: boolean }) => void;
    service.reports.and.returnValue(new Promise(resolve => answer = resolve));
    page.refreshReports(); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); page.refreshReports();
    expect(service.reports.calls.count()).toBe(2); expect(page.reportsRefreshing()).toBeTrue();
    answer({ items: [{ ...report, status: 'in_review' }], has_more: false }); flushMicrotasks();
    page.refreshReports(); window.dispatchEvent(new Event('focus')); expect(service.reports.calls.count()).toBe(2);
    expect(page.reports()!.items[0].status).toBe('in_review'); fixture.destroy();
  }));

  it('pauses hidden and offline tabs, resumes once and cleans up on destruction', fakeAsync(() => {
    const { fixture, page } = home(); visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    tick(60000); expect(service.reports.calls.count()).toBe(1);
    online = false; visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); page.refreshReports();
    tick(60000); expect(service.reports.calls.count()).toBe(1);
    online = true; window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); flushMicrotasks();
    expect(service.reports.calls.count()).toBe(2); expect(page.reportsChecked()).toBe(Date.now());
    fixture.destroy(); tick(120000); window.dispatchEvent(new Event('focus')); expect(service.reports.calls.count()).toBe(2);
  }));

  it('retains confirmed state, backs off at60/120s and resets cadence after manual recovery', fakeAsync(() => {
    const { fixture, page, el } = home(); const checked = page.reportsChecked();
    service.reports.and.rejectWith(new ApiError(503)); tick(30000); flushMicrotasks(); fixture.detectChanges();
    expect(page.reports()!.items[0].status).toBe('received'); expect(page.reportsChecked()).toBe(checked);
    expect(el.querySelector('.report-stale')?.textContent).toContain(page.t().refreshFailed);
    tick(59999); expect(service.reports.calls.count()).toBe(2); tick(1); flushMicrotasks(); expect(service.reports.calls.count()).toBe(3);
    tick(119999); expect(service.reports.calls.count()).toBe(3); tick(1); flushMicrotasks(); expect(service.reports.calls.count()).toBe(4);
    tick(120000); flushMicrotasks(); expect(service.reports.calls.count()).toBe(5);
    tick(1000); service.reports.and.resolveTo({ items: [{ ...report, status: 'closed' }], has_more: false }); page.refreshReports(); flushMicrotasks();
    expect(page.reportsFailed()).toBeFalse(); expect(page.reports()!.items[0].status).toBe('closed');
    tick(29999); expect(service.reports.calls.count()).toBe(6); tick(1); flushMicrotasks(); expect(service.reports.calls.count()).toBe(7); fixture.destroy();
  }));

  for (const resource of ['reports', 'messages'] as const) it(`stops both resources on a ${resource}401 until reauthentication`, fakeAsync(() => {
    const { fixture, page } = home(); void page.toggleMessages('P'); flushMicrotasks();
    service[resource].and.rejectWith(new ApiError(401)); tick(30000); flushMicrotasks();
    const counts = [service.reports.calls.count(), service.messages.calls.count()];
    expect(page.error()).toBe(page.t().err401); tick(120000); page.refreshReports(); window.dispatchEvent(new Event('focus')); flushMicrotasks();
    expect([service.reports.calls.count(), service.messages.calls.count()]).toEqual(counts); fixture.destroy();
  }));

  it('expires an unanswered read, aborts transport and ignores its eventual stale success', fakeAsync(() => {
    const { fixture, page } = home(); let answer!: (value: { items: Report[]; has_more: boolean }) => void;
    service.reports.and.returnValue(new Promise(resolve => answer = resolve)); tick(30000);
    const signal = service.reports.calls.mostRecent().args[0]!;
    tick(9999); expect(page.reportsRefreshing()).toBeTrue(); expect(service.reports.calls.count()).toBe(2);
    tick(1); flushMicrotasks(); expect(signal.aborted).toBeTrue(); expect(page.reportsRefreshing()).toBeFalse(); expect(page.reportsFailed()).toBeTrue();
    answer({ items: [{ ...report, status: 'closed' }], has_more: false }); flushMicrotasks(); expect(page.reports()!.items[0].status).toBe('received');
    tick(59999); expect(service.reports.calls.count()).toBe(2); tick(1); expect(service.reports.calls.count()).toBe(3); fixture.destroy(); flushMicrotasks();
  }));

  it('polls only the open thread and discards close/reopen and switched-thread reads', fakeAsync(() => {
    const { fixture, page } = home(); let answer!: (value: MessageThread) => void;
    service.messages.and.returnValue(new Promise(resolve => answer = resolve)); void page.toggleMessages('P');
    const abandoned = service.messages.calls.mostRecent().args[1]!;
    void page.toggleMessages('P'); expect(abandoned.aborted).toBeTrue();
    service.messages.and.resolveTo({ status: 'in_review', can_post: true, items: [] }); void page.toggleMessages('P'); flushMicrotasks();
    answer({ status: 'closed', can_post: false, items: [] }); flushMicrotasks(); expect(page.thread()?.status).toBe('in_review');
    void page.toggleMessages('Q'); flushMicrotasks(); tick(30000); flushMicrotasks();
    expect(service.messages.calls.mostRecent().args[0]).toBe('Q');
    void page.toggleMessages('Q'); const count = service.messages.calls.count(); tick(60000); flushMicrotasks(); expect(service.messages.calls.count()).toBe(count); fixture.destroy();
  }));

  it('clears initial-thread loading after a never-settling read and allows manual recovery', fakeAsync(() => {
    const { fixture, page } = home(); service.messages.and.returnValue(new Promise(() => undefined)); void page.toggleMessages('P'); tick(10000); flushMicrotasks();
    expect(page.threadFailed()).toBeTrue(); expect(page.thread()).toBeNull();
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] }); page.refreshReports(); flushMicrotasks();
    expect(page.threadFailed()).toBeFalse(); expect(page.thread()?.status).toBe('received'); fixture.destroy();
  }));

  it('announces actual changes once without initial/new-report announcements and keeps saved progress after dismissal', fakeAsync(() => {
    service.reports.and.resolveTo({ items: [report, { ...report, protocol: 'Q', status: 'in_review' }, { ...report, protocol: 'R', status: 'closed' }], has_more: false });
    const { fixture, page, el } = home(); expect(page.changeNotices()).toEqual([]);
    expect([...el.querySelectorAll('.report-progress [aria-current="step"]')].map(node => node.textContent?.trim())).toEqual([page.t().statusReceived, page.t().inReview, '✓' + page.t().stepDone + ': ' + page.t().chipClosed]);
    service.reports.and.resolveTo({ items: [{ ...report, status: 'in_review' }, { ...report, protocol: 'Q', status: 'closed' }, { ...report, protocol: 'NEW', status: 'closed' }], has_more: false });
    tick(30000); flushMicrotasks(); expect(page.changeNotices().map(n => n.protocol)).toEqual(['P', 'Q']); fixture.detectChanges();
    for (const lang of ['es', 'pt', 'en'] as const) { page.lang.set(lang); fixture.detectChanges(); expect(el.querySelector('.report-notices')?.textContent).toContain(page.t().reportEnteredReview.replace('{ref}', report.reference_short!)); }
    page.dismissNotice('P'); page.dismissNotice('Q'); fixture.detectChanges(); expect(el.querySelectorAll('.report-progress').length).toBe(3);
    tick(30000); flushMicrotasks(); expect(page.changeNotices()).toEqual([]); fixture.destroy();
    const reloaded = home(); expect(reloaded.page.changeNotices()).toEqual([]); expect(reloaded.page.reports()!.items[0].status).toBe('in_review'); reloaded.fixture.destroy();
  }));

  it('detects new agent messages without announcing stored history or clearing a draft or moving focus', fakeAsync(() => {
    const stored = { message_id: 'old', author: 'agent' as const, body: 'Stored history', created_at: '2026-10-04T12:00:00Z' };
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [stored] });
    const { fixture, page, el } = home(); void page.toggleMessages('P'); flushMicrotasks(); fixture.detectChanges();
    flushMicrotasks(); fixture.detectChanges(); expect(page.agentReplyNotice()).toBeFalse(); const area = el.querySelector<HTMLTextAreaElement>('#customer-messages-draft')!;
    area.value = 'My unsent draft'; area.dispatchEvent(new Event('input')); flushMicrotasks(); fixture.detectChanges(); area.focus();
    service.messages.and.resolveTo({ status: 'in_review', can_post: true, items: [stored, { ...stored, message_id: 'new', body: 'New response' }] });
    tick(30000); flushMicrotasks(); fixture.detectChanges(); expect(page.agentReplyNotice()).toBeTrue(); expect(document.activeElement).toBe(area); expect(area.value).toBe('My unsent draft');
    page.agentReplyNotice.set(false); tick(30000); flushMicrotasks(); expect(page.agentReplyNotice()).toBeFalse();
    service.messages.and.resolveTo({ status: 'closed', can_post: false, items: [stored] }); tick(30000); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('#customer-messages-draft')).toBe(area); expect(document.activeElement).toBe(area); expect(area.value).toBe('My unsent draft'); expect(area.readOnly).toBeTrue(); fixture.destroy();
  }));

  for (const exit of ['logout', 'act-as', 'destroy'] as const) it(`discards pending report/thread reads after ${exit}`, fakeAsync(() => {
    const { fixture, page } = home(); let reports!: (value: { items: Report[]; has_more: boolean }) => void, messages!: (value: MessageThread) => void;
    service.reports.and.returnValue(new Promise(resolve => reports = resolve)); service.messages.and.returnValue(new Promise(resolve => messages = resolve));
    tick(30000); void page.toggleMessages('P'); const reportsSignal = service.reports.calls.mostRecent().args[0]!;
    if (exit === 'logout') { void page.signOut(); flushMicrotasks(); }
    else if (exit === 'destroy') fixture.destroy();
    else {
      Object.assign(service, { actAs: jasmine.createSpy('actAs').and.resolveTo({ customer_id: 'demo-bruno', roles: ['admin'], mode: 'admin_act_as' }) });
      service.reports.and.resolveTo({ items: [], has_more: false }); page.actAsIdentities.set([{ customer_id: 'demo-bruno', display_name: 'Bruno' }]); page.actAsChoice = 'demo-bruno'; void page.actAs(); flushMicrotasks();
    }
    expect(reportsSignal.aborted).toBeTrue(); reports({ items: [{ ...report, status: 'closed' }], has_more: false }); messages({ status: 'closed', can_post: false, items: [] }); flushMicrotasks();
    expect(page.thread()).toBeNull(); expect(page.reports()?.items.some(r => r.protocol === 'P' && r.status === 'closed')).not.toBeTrue();
    if (exit !== 'destroy') fixture.destroy();
  }));

  it('does not restart reads when an initial session restore arrives after destruction', fakeAsync(() => {
    let restore!: (value: unknown) => void;
    Object.assign(service, { me: jasmine.createSpy('me').and.returnValue(new Promise(resolve => restore = resolve)) });
    const fixture = TestBed.createComponent(CustomerPage); fixture.detectChanges(); fixture.destroy();
    restore({ customer: { customer_id: 'demo-ana', roles: ['customer'], context_card: null }, agent: false }); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(service.client()).toBe(''); expect(service.reports).not.toHaveBeenCalled();
  }));

  it('does not restart reads when sign-in completes after destruction', fakeAsync(() => {
    let signedIn!: (value: Awaited<ReturnType<CustomerService['signIn']>>) => void;
    service.signIn.and.returnValue(new Promise(resolve => signedIn = resolve));
    const fixture = TestBed.createComponent(CustomerPage); fixture.detectChanges(); const page = fixture.componentInstance; page.identity = 'demo-ana'; void page.login(); fixture.destroy();
    signedIn({ customer_id: 'demo-ana', roles: ['customer'], mode: 'simulated_login' }); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(service.client()).toBe(''); expect(service.reports).not.toHaveBeenCalled();
  }));
});
