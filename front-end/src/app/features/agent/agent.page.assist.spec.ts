import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { AgentPage } from './agent.page';
import { AgentService } from './agent.service';
import { CustomerService } from '../customer/customer.service';
import { LangService } from '../../shared/i18n/lang.service';
import { MessageThreadView } from '../../shared/messages/message-thread.component';
import { AgentIntakeDetail, ReviewerAssist, Role } from '../../shared/models/intake.model';
import { ApiError } from '../../core/http/api.service';

const protocol = '11111111-1111-4111-8111-111111111111';
const result: ReviewerAssist = { summary: '<b>Synthetic summary</b>', missing_fields: ['merchant'], draft: 'Please confirm the merchant.', language: 'en', snapshot: { status: 'received', message_count: 0 }, context_truncated: true };
const detail: AgentIntakeDetail = { reference_short: null, episode_id: protocol, reason: 'not_mine', tool_status: 'ok', destination: 'case_service', priority: 'normal', urgency: 'normal', closing_note: null, first_opened_at: '2026-10-04T18:00:00Z', history_has_more: false, customer_suggestion: null, scope: 'synthetic_demo_only', protocol, status: 'received', kind: 'incomplete', language: 'en', customer_statement: 'Synthetic charge', accepted_at: '2026-10-04T18:00:00Z', model_reading: { mode: 'off', model_version: null, llm_calls: 0 }, customer_history: { reports: 0, open: 0, high_urgency: 0, last_status: null, last_accepted_at: null, has_more: false }, verified_evidence: { transaction: null }, actions_taken: [], unresolved_questions: [], history: [] };

describe('Agent reviewer assistance', () => {
  let service: jasmine.SpyObj<AgentService>, page: AgentPage, fixture: ComponentFixture<AgentPage>, lang: LangService;
  beforeEach(async () => {
    service = jasmine.createSpyObj<AgentService>('AgentService', ['intakes', 'intakeDetail', 'messages', 'postMessage', 'prepareReply'], { roles: signal<Role[]>(['agent']) });
    service.intakes.and.resolveTo({ items: [], has_more: false, scope: 'synthetic_demo_only' }); service.intakeDetail.and.resolveTo(detail);
    service.messages.and.resolveTo({ status: 'received', can_post: true, items: [] }); service.prepareReply.and.resolveTo(result);
    service.postMessage.and.resolveTo({ message_id: protocol, author: 'agent', body: 'Synthetic reply', created_at: '2026-10-04T18:00:00Z' });
    await TestBed.configureTestingModule({ imports: [AgentPage], providers: [provideRouter([]), { provide: AgentService, useValue: service }, { provide: CustomerService, useValue: { me: async () => null } }] }).compileComponents();
    lang = TestBed.inject(LangService); lang.set('en'); fixture = TestBed.createComponent(AgentPage); page = fixture.componentInstance;
    await fixture.whenStable(); await page.open(protocol, document.createElement('button')); await fixture.whenStable(); fixture.detectChanges();
  });
  const composer = () => fixture.debugElement.query(By.directive(MessageThreadView)).componentInstance as MessageThreadView;
  it('generates plain-text AI labels but never posts, and seeds only after explicit apply before an edited snapshot send', async () => {
    await page.prepareReply(); fixture.detectChanges();
    expect(service.postMessage).not.toHaveBeenCalled(); expect(composer().draft).toBe('');
    expect(fixture.nativeElement.querySelector('.reviewer-assist').textContent).toContain('AI');
    expect(fixture.nativeElement.querySelector('.reviewer-assist b')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Older conversation');
    page.applyReply(); fixture.detectChanges(); expect(composer().draft).toBe(result.draft);
    composer().draft = 'Edited by a person'; composer().submit(); await fixture.whenStable();
    expect(service.postMessage.calls.mostRecent().args[3]).toEqual(result.snapshot);
    expect(service.postMessage.calls.mostRecent().args[1]).toBe('Edited by a person');
  });
  it('requires explicit confirmation before replacing manual text', async () => {
    composer().draft = 'Manual work'; await page.prepareReply(); fixture.detectChanges();
    spyOn(window, 'confirm').and.returnValue(false); page.applyReply(); fixture.detectChanges(); expect(composer().draft).toBe('Manual work');
    (window.confirm as jasmine.Spy).and.returnValue(true); page.applyReply(); fixture.detectChanges(); expect(composer().draft).toBe(result.draft);
  });
  it('keeps manual work usable after disabled/provider failure', async () => {
    composer().draft = 'Manual work'; service.prepareReply.and.rejectWith(new ApiError(503));
    await page.prepareReply(); fixture.detectChanges(); expect(composer().draft).toBe('Manual work');
    composer().submit(); await fixture.whenStable(); expect(service.postMessage.calls.mostRecent().args.length).toBe(3);
  });
  for (const change of ['language', 'report', 'session']) it(`discards late generation on ${change} change`, async () => {
    let finish!: (r: ReviewerAssist) => void; service.prepareReply.and.returnValue(new Promise(r => finish = r));
    const pending = page.prepareReply();
    if (change === 'language') lang.set('pt'); else if (change === 'report') page.close(); else service.roles.set([]);
    fixture.detectChanges(); finish(result); await pending; fixture.detectChanges(); expect(page.assistance()).toBeNull();
  });
  it('keeps stale assisted text editable but blocks sending until refresh and explicit manual review', async () => {
    document.body.append(fixture.nativeElement);
    await page.prepareReply(); page.applyReply(); fixture.detectChanges(); composer().draft = 'Retain edits';
    service.postMessage.and.rejectWith(new ApiError(409)); composer().submit(); await fixture.whenStable(); fixture.detectChanges();
    expect(composer().draft).toBe('Retain edits'); expect(page.assistedStale()).toBeTrue(); await fixture.whenStable();
    expect(document.activeElement?.id).toBe('agent-messages-draft');
    composer().submit(); expect(service.postMessage).toHaveBeenCalledTimes(1);
    await page.refreshReplyContext(); fixture.detectChanges(); page.reviewManually(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement?.id).toBe('agent-messages-draft');
    service.postMessage.and.resolveTo({ message_id: protocol, author: 'agent', body: 'Synthetic reply', created_at: '2026-10-04T18:00:00Z' }); composer().submit(); await fixture.whenStable(); expect(service.postMessage.calls.mostRecent().args.length).toBe(3);
  });
  it('blocks generation for closed reports and repeated clicks', async () => {
    page.detail.set({ ...detail, status: 'closed' }); await page.prepareReply(); expect(service.prepareReply).not.toHaveBeenCalled();
    page.detail.set(detail); let finish!: (r: ReviewerAssist) => void; service.prepareReply.and.returnValue(new Promise(r => finish = r));
    const pending = page.prepareReply(); await page.prepareReply(); expect(service.prepareReply).toHaveBeenCalledTimes(1); finish(result); await pending;
  });
  it('invalidates applied text on language change while keeping ordinary manual text', async () => {
    composer().draft = 'Manual'; lang.set('pt'); fixture.detectChanges(); expect(composer().draft).toBe('Manual');
    lang.set('en'); fixture.detectChanges(); composer().draft = ''; await page.prepareReply(); page.applyReply(); fixture.detectChanges();
    composer().draft = 'Edited assistance'; lang.set('pt'); fixture.detectChanges(); expect(composer().draft).toBe(''); expect(page.replySnapshot()).toBeNull();
  });
  it('rejects generation that arrives after a new message or closure and synchronously blocks a locally stale send', async () => {
    let finish!: (r: ReviewerAssist) => void; service.prepareReply.and.returnValue(new Promise(r => finish = r));
    const pending = page.prepareReply(); page.thread.set({ status: 'received', can_post: true, items: [{ message_id: protocol, author: 'customer', body: 'New synthetic detail', created_at: '2026-10-04T18:00:01Z' }] }); finish(result); await pending;
    expect(page.assistance()).toBeNull();
    page.thread.set({ status: 'received', can_post: true, items: [] }); service.prepareReply.and.resolveTo(result);
    await page.prepareReply(); page.applyReply(); fixture.detectChanges(); page.detail.set({ ...detail, status: 'closed' });
    await page.sendMessage('Do not send'); expect(service.postMessage).not.toHaveBeenCalled(); expect(page.assistedStale()).toBeTrue();
  });

  for (const code of ['es', 'pt', 'en'] as const) it(`labels all reviewer controls and suggested fields in ${code}`, () => {
    lang.set(code); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#reviewer-assist-title').textContent).toBe(lang.t().assistTitle);
    expect(fixture.nativeElement.querySelector('.assist-prepare').textContent).toBe(lang.t().assistPrepare);
    expect(page.assistField('currency')).toBe(lang.t().assistCurrency);
  });
  it('clears AI state and agent detail when generation detects an expired session', async () => {
    await page.prepareReply(); page.applyReply(); fixture.detectChanges();
    service.prepareReply.and.rejectWith(new ApiError(401)); await page.prepareReply(); fixture.detectChanges();
    expect(page.detail()).toBeNull(); expect(page.assistance()).toBeNull(); expect(page.roles()).toEqual([]);
  });

  for (const change of ['language', 'session']) it(`cannot send unchanged applied AI text as manual after ${change} invalidation`, async () => {
    await page.prepareReply(); page.applyReply(); fixture.detectChanges(); await fixture.whenStable();
    expect(composer().draft).toBe(result.draft); expect(page.replySnapshot()).toEqual(result.snapshot);
    if (change === 'language') lang.set('pt'); else service.roles.set([]);
    fixture.detectChanges(); await fixture.whenStable();
    expect(composer().draft).toBe(''); expect(page.composerDraft()).toBeNull(); expect(page.replySnapshot()).toBeNull();
    composer().submit(); expect(service.postMessage).not.toHaveBeenCalled();
  });
  it('retains assisted provenance across provider failure until an explicit manual review', async () => {
    await page.prepareReply(); page.applyReply(); fixture.detectChanges(); await fixture.whenStable();
    service.prepareReply.and.rejectWith(new ApiError(503)); await page.prepareReply(); fixture.detectChanges();
    expect(composer().draft).toBe(result.draft); composer().submit(); await fixture.whenStable();
    expect(service.postMessage.calls.mostRecent().args[3]).toEqual(result.snapshot);
  });

});
