import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Report, MessageThread, IntakeReceipt, IntakeStart } from '../../shared/models/intake.model';
const report: Report = { protocol: 'P', reference_short: 'AR-AAAA-BBBB', status: 'received', kind: 'incomplete', transaction_id: null, accepted_at: '2026-10-04T12:00:00Z', closing_note: null, next_step: 'review_pending' };
describe('Customer bounded refresh', () => {
  let visible: DocumentVisibilityState, online: boolean;
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v2', 'dismissed');
    visible = 'visible'; online = true;
    spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visible);
    spyOnProperty(navigator, 'onLine', 'get').and.callFake(() => online);
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed', 'messages', 'postMessage', 'logout', 'startIntake', 'confirmIntake', 'handoffIntake', 'suggestions'],
      { client: signal(''), card: signal(null), roles: signal([]) });
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', roles: ['customer'], mode: 'simulated_login' });
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.reports.and.resolveTo({ items: [report], has_more: false }); service.alert.and.resolveTo({ alert: null }); service.identities.and.resolveTo([]);
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] }); service.logout.and.resolveTo(undefined);
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]), { provide: CustomerService, useValue: service },
      { provide: CognitoService, useValue: { forget: () => undefined } }] });
  });
  afterEach(() => localStorage.removeItem('arabica.customer-tour.v2'));
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

  for (const resource of ['transactions', 'reports'] as const) for (const failed of [false, true]) it(`does not continue sign-in after destruction during initial ${resource} ${failed ? 'failure' : 'success'}`, fakeAsync(() => {
    let settle!: () => void;
    if (resource === 'transactions') service.transactions.and.returnValue(new Promise((resolve, reject) => settle = () => failed ? reject(new ApiError(503)) : resolve({ items: [], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null })));
    else service.reports.and.returnValue(new Promise((resolve, reject) => settle = () => failed ? reject(new ApiError(503)) : resolve({ items: [report], has_more: false })));
    const fixture = TestBed.createComponent(CustomerPage); fixture.detectChanges(); const page = fixture.componentInstance; page.identity = 'demo-ana'; void page.login(); flushMicrotasks();
    const count = service.reports.calls.count(); const step = page.step(); const error = page.error(); fixture.destroy(); settle(); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(page.step()).toBe(step); expect(page.error()).toBe(error); expect(service.reports.calls.count()).toBe(count); expect(service.alert).not.toHaveBeenCalled();
  }));

  for (const resource of ['reports', 'messages'] as const) it(`retains the global ${resource}401 pause through close/reopen/switch until successful sign-in`, fakeAsync(() => {
    const { fixture, page } = home(); void page.toggleMessages('P'); flushMicrotasks(); service[resource].and.rejectWith(new ApiError(401)); tick(30000); flushMicrotasks();
    const reads = [service.reports.calls.count(), service.messages.calls.count()]; service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] });
    void page.toggleMessages('P'); void page.toggleMessages('P'); void page.toggleMessages('Q'); page.refreshReports(); window.dispatchEvent(new Event('focus')); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect([service.reports.calls.count(), service.messages.calls.count()]).toEqual(reads); expect(page.thread()).toBeNull();
    service.reports.and.resolveTo({ items: [report], has_more: false }); void page.login(); flushMicrotasks(); tick(30000); flushMicrotasks();
    expect(service.reports.calls.count()).toBeGreaterThan(reads[0]); expect(service.messages.calls.count()).toBeGreaterThan(reads[1]); expect(page.thread()?.status).toBe('received'); fixture.destroy();
  }));

  it('reads back a posted message after an earlier polling read settles without overlapping reads', fakeAsync(() => {
    const { fixture, page } = home(); void page.toggleMessages('P'); flushMicrotasks();
    let beforePost!: (value: MessageThread) => void; let outstanding = 1;
    service.messages.and.returnValue(new Promise(resolve => beforePost = value => { outstanding--; resolve(value); })); tick(30000); flushMicrotasks();
    const stored = { message_id: 'stored', author: 'customer' as const, body: 'Just posted details', created_at: '2026-10-04T12:00:00Z' }; service.postMessage.and.resolveTo(stored);
    service.messages.and.callFake(() => { expect(outstanding).toBe(0); return Promise.resolve({ status: 'received', can_post: true, items: [stored] }); });
    let finished = false; void page.sendMessage(stored.body).then(() => finished = true); flushMicrotasks(); expect(finished).toBeFalse(); expect(service.messages.calls.count()).toBe(2);
    beforePost({ status: 'received', can_post: true, items: [] }); flushMicrotasks(); expect(finished).toBeTrue(); expect(page.thread()?.items).toEqual([stored]); expect(service.messages.calls.count()).toBe(3); fixture.destroy();
  }));

  for (const resource of ['reports', 'messages'] as const) it(`keeps passive events inside ${resource}60/120s backoff and permits explicit recovery`, fakeAsync(() => {
    const { fixture, page } = home(); void page.toggleMessages('P'); flushMicrotasks(); service[resource].and.rejectWith(new ApiError(503)); tick(30000); flushMicrotasks();
    const count = service[resource].calls.count();
    for (const elapsed of [1000, 29000, 29999]) {
      tick(elapsed); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); flushMicrotasks();
      expect(service[resource].calls.count()).toBe(count);
    }
    tick(1); flushMicrotasks(); expect(service[resource].calls.count()).toBe(count + 1);
    for (const elapsed of [1000, 59000, 59999]) {
      tick(elapsed); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); flushMicrotasks();
      expect(service[resource].calls.count()).toBe(count + 1);
    }
    tick(1); flushMicrotasks(); expect(service[resource].calls.count()).toBe(count + 2);
    tick(1000); if (resource === 'reports') service.reports.and.resolveTo({ items: [report], has_more: false });
    else service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] }); page.refreshReports(); flushMicrotasks();
    expect(service[resource].calls.count()).toBe(count + 3); expect(resource === 'reports' ? page.reportsFailed() : page.threadFailed()).toBeFalse();
    tick(30000); flushMicrotasks(); expect(service[resource].calls.count()).toBe(count + 4); fixture.destroy();
  }));

  it('shows a terminal session error instead of Loading when an empty thread opens during401 pause', fakeAsync(() => {
    const { fixture, page, el } = home(); service.reports.and.rejectWith(new ApiError(401)); tick(30000); flushMicrotasks(); const count = service.messages.calls.count();
    for (const protocol of ['P', 'P', 'P']) { void page.toggleMessages(protocol); flushMicrotasks(); fixture.detectChanges(); }
    expect(service.messages.calls.count()).toBe(count); expect(page.threadFailed()).toBeTrue(); expect(el.querySelector('app-message-thread')?.textContent).not.toContain(page.t().messagesLoading);
    expect(el.querySelector('app-message-thread')?.textContent).toContain(page.t().err401);
    const q = { ...report, protocol: 'Q' }; page.reports.set({ items: [report, q], has_more: false }); void page.toggleMessages('Q'); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('app-message-thread')?.textContent).toContain(page.t().err401); expect(service.messages.calls.count()).toBe(count); fixture.destroy();
  }));

  const receipt: IntakeReceipt = { episode_id: 'E', protocol: 'P', reference_short: 'AR-AAAA-BBBB', kind: 'incomplete', accepted_at: '2026-10-04T12:00:00Z', replayed: false, actions_taken: [], unresolved_questions: [], next_step_code: 'await_human_review', urgency: 'normal' };
  function freeze(page: CustomerPage, path: 'start' | 'confirm' | 'handoff') {
    if (path === 'start') page.frozen.set({ path, body: { customer_statement: 'Synthetic statement', idempotency_key: 'K', language: 'es', mode: 'guided', reason: 'not_mine', report_type: 'unrecognized_charge' } });
    else if (path === 'confirm') page.frozen.set({ path, body: { episode_id: 'E', idempotency_key: 'K', transaction_id: 'T', customer_confirmed: true } });
    else page.frozen.set({ path, body: { episode_id: 'E', idempotency_key: 'K', kind: 'incomplete', details: 'Synthetic charge details' } });
  }
  for (const path of ['start', 'confirm', 'handoff'] as const) for (const failed of [false, true]) it(`discards late intake ${path} ${failed ? 'failure' : 'success'} after destruction`, fakeAsync(() => {
    const { fixture, page } = home(); let settle!: () => void; const result: IntakeStart | IntakeReceipt = path === 'start' ? { episode_id: 'E', state: 'selection_required', language: 'es', mode: 'guided', replayed: false } : receipt;
    const call = path === 'start' ? service.startIntake : path === 'confirm' ? service.confirmIntake : service.handoffIntake;
    call.and.returnValue(new Promise((resolve, reject) => settle = () => failed ? reject(new ApiError(503)) : resolve(result)) as never);
    freeze(page, path); void page.run(); const counts = [service.reports.calls.count(), service.alert.calls.count()]; const log = page.log(); fixture.destroy(); settle(); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(page.intakeReceipt()).toBeNull(); expect(page.episode()).toBeNull(); expect(page.chatError()).toBe(''); expect(page.log()).toEqual(log);
    expect([service.reports.calls.count(), service.alert.calls.count()]).toEqual(counts); expect(service.suggestions).not.toHaveBeenCalled();
  }));

  it('does not continue intake into alert reads after destruction during receipt list refresh', fakeAsync(() => {
    const { fixture, page } = home(); service.confirmIntake.and.resolveTo(receipt); service.reports.and.returnValue(new Promise(() => undefined)); freeze(page, 'confirm'); void page.run(); flushMicrotasks();
    const count = service.alert.calls.count(); fixture.destroy(); flushMicrotasks(); tick(60000); flushMicrotasks(); expect(service.alert.calls.count()).toBe(count);
  }));

  it('discards late intake renewal without retrying or changing the card after destruction', fakeAsync(() => {
    const { fixture, page } = home(); let renew!: (value: Awaited<ReturnType<CustomerService['signIn']>>) => void;
    service.startIntake.and.rejectWith(new ApiError(401)); service.signIn.and.returnValue(new Promise(resolve => renew = resolve)); freeze(page, 'start'); void page.run(); flushMicrotasks();
    const card = page.card(); fixture.destroy(); renew({ customer_id: 'demo-ana', roles: ['customer'], mode: 'simulated_login', context_card: { version: 1, snapshot_at: '2026-10-04', first_name: 'Late renewal', locale_hint: 'es', products: [] } }); flushMicrotasks();
    expect(service.startIntake.calls.count()).toBe(1); expect(page.card()).toBe(card); expect(page.log().some(line => 'key' in line && line.key === 'sessionRenewed')).toBeFalse();
  }));

  it('refuses act-as while intake is pending and discards its answer after an owned reset', fakeAsync(() => {
    const { fixture, page } = home(); let complete!: (value: IntakeReceipt) => void; service.confirmIntake.and.returnValue(new Promise(resolve => complete = resolve));
    Object.assign(service, { actAs: jasmine.createSpy('actAs').and.resolveTo({ customer_id: 'demo-bruno', roles: ['admin'], mode: 'admin_act_as' }) });
    page.actAsIdentities.set([{ customer_id: 'demo-bruno', display_name: 'Bruno' }]); page.actAsChoice = 'demo-bruno'; freeze(page, 'confirm'); void page.run(); void page.actAs(); flushMicrotasks();
    expect(service.actAs).not.toHaveBeenCalled(); const count = service.reports.calls.count(); page['reset'](); page.client.set('demo-bruno'); complete(receipt); flushMicrotasks();
    expect(page.intakeReceipt()).toBeNull(); expect(page.episode()).toBeNull(); expect(service.reports.calls.count()).toBe(count); fixture.destroy();
  }));

  it('resumes refresh after a successful current-customer silent intake renewal', fakeAsync(() => {
    const { fixture, page } = home(); service.reports.and.rejectWith(new ApiError(401)); tick(30000); flushMicrotasks();
    service.reports.and.resolveTo({ items: [report], has_more: false }); service.startIntake.and.returnValues(Promise.reject(new ApiError(401)), Promise.resolve({ episode_id: 'E', state: 'selection_required', language: 'es', mode: 'guided', replayed: false }));
    const count = service.reports.calls.count(); freeze(page, 'start'); void page.run(); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(service.reports.calls.count()).toBeGreaterThan(count); expect(page.reportsFailed()).toBeFalse(); fixture.destroy();
  }));

  it('refuses new refresh reads on a destroyed page even while shared session state remains populated', fakeAsync(() => {
    const { fixture, page } = home(); const reports = service.reports.calls.count(); fixture.destroy(); page.openThread.set('P'); void page['loadReports'](); void page['loadThread'](); page.refreshReports(); flushMicrotasks(); tick(60000); flushMicrotasks();
    expect(service.reports.calls.count()).toBe(reports); expect(service.messages).not.toHaveBeenCalled();
  }));

  it('does not mark a loaded thread failed merely because an additional paused read is skipped', fakeAsync(() => {
    const { fixture, page } = home(); void page.toggleMessages('P'); flushMicrotasks(); service.reports.and.rejectWith(new ApiError(401)); tick(30000); flushMicrotasks();
    const stored = page.thread(); const failed = page.threadFailed(); const count = service.messages.calls.count(); void page['loadThread'](); flushMicrotasks();
    expect(page.thread()).toBe(stored); expect(page.threadFailed()).toBe(failed); expect(service.messages.calls.count()).toBe(count); fixture.destroy();
  }));
});
