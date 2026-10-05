import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Report, CustomerAssist } from '../../shared/models/intake.model';

const report: Report = { protocol: 'P', reference_short: 'AR-AAAA-BBBB', status: 'received', kind: 'incomplete', transaction_id: null,
  accepted_at: '2026-10-04T12:00:00Z', closing_note: null, next_step: 'review_pending' };
const customerMessage = { message_id: 'customer-1', author: 'customer' as const, body: 'Synthetic merchant details', created_at: '2026-10-04T12:01:00Z' };

describe('Customer bounded assistance', () => {
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v2', 'dismissed');
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['signIn', 'transactions', 'reports', 'alert', 'identities', 'displayed', 'messages', 'postMessage', 'logout', 'requestUpdate', 'assist'],
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
    const page = fixture.componentInstance; page.lang.set('en'); page.identity = 'demo-ana'; void page.login(); flushMicrotasks(); fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }

 it('classifies without sending and explicitly populates the human composer', fakeAsync(() => {
  const {fixture,page,el}=home(); void page.toggleMessages('P');flushMicrotasks();fixture.detectChanges();
  service.assist.and.resolveTo({intent:'provide_details',field:'merchant',language:'en',snapshot:{status:'received',message_count:0}});
  const p=page;
  p.assistQuestion='DETAILS merchant is a synthetic shop';void p.askReportQuestion();flushMicrotasks();fixture.detectChanges();
  expect(service.postMessage).not.toHaveBeenCalled();expect(el.querySelector('.customer-assist-answer')).not.toBeNull();
  p.useQuestionDetails();fixture.detectChanges();flushMicrotasks();fixture.detectChanges();
  expect(el.querySelector<HTMLTextAreaElement>('#customer-messages-draft')?.value).toBe(p.assistQuestion);expect(service.postMessage).not.toHaveBeenCalled();fixture.destroy();
 }));
 function opened() { const h=home();void h.page.toggleMessages('P');flushMicrotasks();h.fixture.detectChanges();flushMicrotasks();h.fixture.detectChanges();return h; }
 const classified: CustomerAssist={intent:'status',field:null,language:'en',snapshot:{status:'received',message_count:0}};
 for(const language of ['es','pt','en'] as const)it(`approved status and process copy in ${language} comes from fresh facts`,fakeAsync(()=>{
  const {fixture,page,el}=opened();page.lang.set(language);fixture.detectChanges();page.assistQuestion='status';service.assist.and.resolveTo({...classified,language});
  void page.askReportQuestion();flushMicrotasks();fixture.detectChanges();expect(el.querySelector('.customer-assist-answer')?.textContent).toContain(page.statusHelp(report));expect(el.textContent).toContain(page.t().customerAssistTitle);expect(service.postMessage).not.toHaveBeenCalled();fixture.destroy();
 }));
 it('discards a snapshot mismatch after fresh report and thread reads without retry',fakeAsync(()=>{
  const {fixture,page}=opened();page.assistQuestion='status';service.assist.and.resolveTo(classified);service.messages.and.resolveTo({status:'received',can_post:true,items:[customerMessage]});
  void page.askReportQuestion();flushMicrotasks();fixture.detectChanges();expect(page.questionAnswer()).toBeNull();expect(page.questionError()).toBe(page.t().customerAssistUnavailable);expect(service.assist).toHaveBeenCalledTimes(1);fixture.destroy();
 }));
 for(const change of ['language','session','report'])it(`discards late ${change} results synchronously`,fakeAsync(()=>{
  const {fixture,page}=opened();let finish!:(v:CustomerAssist)=>void;service.assist.and.returnValue(new Promise(r=>finish=r));page.assistQuestion='status';void page.askReportQuestion();flushMicrotasks();
  if(change==='language')page.lang.set('pt');if(change==='session')service.client.set('demo-bruno');if(change==='report')void page.toggleMessages('OTHER');
  finish(classified);flushMicrotasks();fixture.detectChanges();expect(page.questionAnswer()).toBeNull();expect(service.postMessage).not.toHaveBeenCalled();fixture.destroy();
 }));
 it('uses closure returned during generation and stored explanation without a writable action',fakeAsync(()=>{
  const {fixture,page,el}=opened();service.assist.and.resolveTo({...classified,snapshot:{status:'closed',message_count:0}});
  service.reports.and.resolveTo({items:[{...report,status:'closed',next_step:'closed_by_person',closing_note:'Stored human closure'}],has_more:false});service.messages.and.resolveTo({status:'closed',can_post:false,items:[]});
  page.assistQuestion='status';void page.askReportQuestion();flushMicrotasks();fixture.detectChanges();expect(el.querySelector('.customer-assist-answer')?.textContent).toContain('Stored human closure');expect(el.querySelector('.customer-assist-answer button')).toBeNull();expect(el.querySelector('.report-again-btn')).not.toBeNull();expect(service.postMessage).not.toHaveBeenCalled();fixture.destroy();
 }));
 it('requires overwrite confirmation, preserves cancellation and seeds only explicit accepted details',fakeAsync(()=>{
  const {fixture,page,el}=opened();service.assist.and.resolveTo({...classified,intent:'provide_details',field:'merchant'});page.assistQuestion='My supplied merchant';void page.askReportQuestion();flushMicrotasks();fixture.detectChanges();
  const area=el.querySelector<HTMLTextAreaElement>('#customer-messages-draft')!;area.value='Manual unsent';area.dispatchEvent(new Event('input'));flushMicrotasks();const confirm=spyOn(window,'confirm').and.returnValue(false);
  page.useQuestionDetails();fixture.detectChanges();expect(area.value).toBe('Manual unsent');confirm.and.returnValue(true);page.useQuestionDetails();fixture.detectChanges();flushMicrotasks();fixture.detectChanges();expect(area.value).toBe('My supplied merchant');expect(document.activeElement).toBe(area);expect(service.postMessage).not.toHaveBeenCalled();fixture.destroy();
 }));
 it('provider outage retains manual text, status action and human save across language changes',fakeAsync(()=>{
  const {fixture,page,el}=opened();const area=el.querySelector<HTMLTextAreaElement>('#customer-messages-draft')!;area.value='Manual details';area.dispatchEvent(new Event('input'));flushMicrotasks();service.assist.and.rejectWith(new ApiError(503));page.assistQuestion='status';void page.askReportQuestion();flushMicrotasks();fixture.detectChanges();expect(area.value).toBe('Manual details');
  void page.checkReportStatus('P');flushMicrotasks();fixture.detectChanges();expect(page.statusExplanation()?.report?.status).toBe('received');
  let saved!:(v:typeof customerMessage)=>void;service.postMessage.and.returnValue(new Promise(r=>saved=r));void page.sendMessage('Manual details');flushMicrotasks();page.lang.set('pt');saved(customerMessage);flushMicrotasks();fixture.detectChanges();expect(page.messageSaved()).toBe('P');flushMicrotasks();fixture.detectChanges();expect(area.value).toBe('');fixture.destroy();
 }));
 it('repeated click makes one generation; later saved changes invalidate the displayed answer',fakeAsync(()=>{
  const {fixture,page}=opened();let finish!:(v:CustomerAssist)=>void;service.assist.and.returnValue(new Promise(r=>finish=r));page.assistQuestion='status';void page.askReportQuestion();void page.askReportQuestion();flushMicrotasks();expect(service.assist).toHaveBeenCalledTimes(1);finish(classified);flushMicrotasks();fixture.detectChanges();expect(page.questionAnswer()).not.toBeNull();page.thread.set({status:'received',can_post:true,items:[customerMessage]});fixture.detectChanges();expect(page.questionAnswer()).toBeNull();fixture.destroy();
 }));


 it('a 503 keeps the panel, says AI help is unavailable right now (not that the report changed) and allows a retry', fakeAsync(() => {
  const {fixture,page,el}=opened();
  service.assist.and.rejectWith(new ApiError(503));
  page.assistQuestion='de que es este reporte?'; void page.askReportQuestion(); flushMicrotasks(); fixture.detectChanges();
  expect(el.querySelector('.customer-assist')).not.toBeNull();
  expect(el.textContent).toContain(page.t().customerAssistOff);
  expect(el.textContent).not.toContain(page.t().customerAssistUnavailable);
  expect(el.querySelector('#customer-messages-draft')).not.toBeNull(); // the human thread stays usable
  service.assist.and.resolveTo({intent:'status',field:null,language:'en',snapshot:{status:'received',message_count:0}});
  void page.askReportQuestion(); flushMicrotasks(); fixture.detectChanges(); flushMicrotasks(); fixture.detectChanges();
  expect(el.textContent).not.toContain(page.t().customerAssistOff);
  fixture.destroy();
 }));

 it('keeps the existing message after a failure that is not 503', fakeAsync(() => {
  const {fixture,page,el}=opened();
  service.assist.and.rejectWith(new ApiError(500));
  page.assistQuestion='status?'; void page.askReportQuestion(); flushMicrotasks(); fixture.detectChanges();
  expect(el.textContent).toContain(page.t().customerAssistUnavailable);
  fixture.destroy();
 }));
});
