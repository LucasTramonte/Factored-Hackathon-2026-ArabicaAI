import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { ApiError } from '../../core/http/api.service';
import { LangService } from '../../shared/i18n/lang.service';
import { AgentIntake, AgentIntakeDetail } from '../../shared/models/intake.model';
import { AgentPage } from './agent.page';
import { AgentService } from './agent.service';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const intake = (protocol: string, kind: AgentIntake['kind'] = 'complete'): AgentIntake =>
  ({ protocol, episode_id: P2, kind, tool_status: 'ok', destination: 'case_service', priority: 'normal', accepted_at: '2026-09-30T12:00:00.000Z' });
const detail = (protocol: string, over: Partial<AgentIntakeDetail> = {}): AgentIntakeDetail => ({
  ...intake(protocol), language: 'es', customer_statement: 'No reconozco este cargo',
  verified_evidence: { transaction: { transaction_id: 'TX-9', merchant_name: 'Café', occurred_at: null, source_occurred_at: '2026-09-01 10:00:00', amount: '12.50', currency: 'MXN' } },
  actions_taken: ['owned_transaction_retrieved'], unresolved_questions: [], history: [{ seq: 1, event: 'intake_started', ts: '2026-09-30T11:59:00.000Z' }],
  history_has_more: false, scope: 'synthetic_demo_only', ...over
});

describe('AgentPage', () => {
  let service: jasmine.SpyObj<AgentService>;
  let fixture: ComponentFixture<AgentPage>;
  let page: AgentPage;
  let t: () => ReturnType<LangService['t']>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    service = jasmine.createSpyObj<AgentService>('AgentService', ['signIn', 'cases', 'intakes', 'intakeDetail']);
    service.signIn.and.resolveTo();
    service.cases.and.resolveTo([]);
    service.intakes.and.resolveTo({ items: [intake(P1), intake(P2, 'technical')], has_more: true, scope: 'synthetic_demo_only' });
    await TestBed.configureTestingModule({ imports: [AgentPage], providers: [{ provide: AgentService, useValue: service }, provideRouter([])] })
      .compileComponents();
    fixture = TestBed.createComponent(AgentPage);
    page = fixture.componentInstance;
    const lang = TestBed.inject(LangService);
    lang.set('en');
    t = lang.t;
  });

  async function loadAndOpen(protocol = P1): Promise<HTMLButtonElement> {
    await page.load();
    fixture.detectChanges();
    const button = [...el().querySelectorAll<HTMLButtonElement>('.intake-row')].find(b => b.textContent!.includes(protocol))!;
    button.focus();
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    return button;
  }

  it('loads cases and intakes only after starting an agent session', async () => {
    const order: string[] = [];
    service.signIn.and.callFake(async () => { order.push('session'); });
    service.cases.and.callFake(async () => { order.push('cases'); return []; });
    await page.load();
    expect(order).toEqual(['session', 'cases']);
    expect(service.intakes).toHaveBeenCalledTimes(1);
    expect(page.loaded()).toBeTrue();
  });

  it('shows translated kinds, the has_more note and no hard-coded TX label', async () => {
    service.cases.and.resolveTo([{ ...detail(P1).verified_evidence.transaction!, protocol: P1, customer_id: 'c', display_name: 'Ana', customer_statement: 'x'.repeat(10), customer_confirmed: true, status: 'accepted', accepted_at: '2026-09-30T12:00:00.000Z' }]);
    await page.load();
    fixture.detectChanges();
    const text = el().textContent!;
    expect(text).toContain(t().kindComplete);
    expect(text).toContain(t().kindTechnical);
    expect(text).toContain(t().queueMore);
    expect(text).toContain(t().transactionId);
    expect(el().querySelector('.case-meta b')!.textContent).toBe(t().transactionId);
  });

  it('opens a detail, moves focus to its heading and returns focus on close', async () => {
    service.intakeDetail.and.resolveTo(detail(P1));
    const button = await loadAndOpen();
    expect(service.intakeDetail).toHaveBeenCalledOnceWith(P1);
    const heading = el().querySelector('#intake-detail-title')!;
    expect(document.activeElement).toBe(heading);
    expect(el().textContent).toContain('owned_transaction_retrieved');
    expect(el().textContent).toContain('12.50 MXN');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    page.close();
    fixture.detectChanges();
    expect(el().querySelector('#intake-detail')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('says so when there is no verified transaction', async () => {
    service.intakeDetail.and.resolveTo(detail(P1, { verified_evidence: { transaction: null }, history_has_more: true }));
    await loadAndOpen();
    expect(el().textContent).toContain(t().noEvidence);
    expect(el().textContent).toContain(t().historyMore);
  });

  it('drops a stale detail response when another intake was opened meanwhile', async () => {
    let resolveFirst!: (d: AgentIntakeDetail) => void;
    service.intakeDetail.and.returnValues(new Promise(r => { resolveFirst = r; }), Promise.resolve(detail(P2)));
    await page.load();
    const button = document.createElement('button');
    const first = page.open(P1, button);
    await page.open(P2, button);
    resolveFirst(detail(P1));
    await first;
    expect(page.detail()!.protocol).toBe(P2);
  });

  it('clears everything on an expired agent session', async () => {
    await page.load();
    service.intakeDetail.and.rejectWith(new ApiError(401, 'raw'));
    await page.open(P1, document.createElement('button'));
    expect(page.error()).toBe(t().agentErr401);
    expect(page.loaded()).toBeFalse();
    expect(page.intakes()).toEqual([]);
    expect(page.detail()).toBeNull();
  });

  it('shows the agent not-found text and keeps the queue on 404', async () => {
    await page.load();
    service.intakeDetail.and.rejectWith(new ApiError(404, 'raw'));
    await page.open(P1, document.createElement('button'));
    expect(page.error()).toBe(t().agentErr404);
    expect(page.intakes().length).toBe(2);
  });

  it('shows the mapped error and no stale cases when sign-in fails', async () => {
    service.signIn.and.rejectWith(new ApiError(401, 'Session expired.'));
    await page.load();
    expect(page.error()).toBe(t().agentErr401);
    expect(page.cases()).toEqual([]);
    expect(page.loaded()).toBeFalse();
  });

  it('titles the tab in the interface language and follows a language switch', () => {
    const lang = TestBed.inject(LangService);
    lang.set('pt');
    fixture.detectChanges();
    expect(TestBed.inject(Title).getTitle()).toBe('ArabicaAI · Visão do agente');
    lang.set('en');
    fixture.detectChanges();
    expect(TestBed.inject(Title).getTitle()).toBe('ArabicaAI · Agent view');
  });

  afterEach(() => TestBed.inject(LangService).set('es'));
});
