import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { ApiError } from '../../core/http/api.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { LangService } from '../../shared/i18n/lang.service';
import { AgentIntake, AgentIntakeDetail } from '../../shared/models/intake.model';
import { AgentPage } from './agent.page';
import { AgentService } from './agent.service';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const intake = (protocol: string, kind: AgentIntake['kind'] = 'complete'): AgentIntake =>
  ({ protocol, reference_short: protocol === P1 ? 'AR-7K3M-2Q4X' : null, episode_id: P2, kind, status: 'received', tool_status: 'ok', destination: 'case_service', priority: 'normal', urgency: 'normal', accepted_at: '2026-09-30T12:00:00.000Z' });
const detail = (protocol: string, over: Partial<AgentIntakeDetail> = {}): AgentIntakeDetail => ({
  ...intake(protocol), language: 'es', customer_statement: 'No reconozco este cargo',
  verified_evidence: { transaction: { transaction_id: 'TX-9', merchant_name: 'Café', occurred_at: null, source_occurred_at: '2026-09-01 10:00:00', amount: '12.50', currency: 'MXN' } },
  actions_taken: ['owned_transaction_retrieved'], unresolved_questions: [], history: [{ seq: 1, event: 'intake_started', ts: '2026-09-30T11:59:00.000Z' }],
  history_has_more: false, model_reading: { mode: 'off', model_version: null, llm_calls: 0 }, scope: 'synthetic_demo_only', ...over
});

describe('AgentPage', () => {
  let service: jasmine.SpyObj<AgentService>;
  let cognito: jasmine.SpyObj<CognitoService>;
  let fixture: ComponentFixture<AgentPage>;
  let page: AgentPage;
  let t: () => ReturnType<LangService['t']>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    service = jasmine.createSpyObj<AgentService>('AgentService', ['signIn', 'intakes', 'intakeDetail', 'setStatus']);
    service.signIn.and.resolveTo();
    cognito = jasmine.createSpyObj<CognitoService>('CognitoService', ['requestCode', 'submitCode', 'forget']);
    cognito.requestCode.and.resolveTo();
    cognito.submitCode.and.resolveTo('id.token');
    service.intakes.and.resolveTo({ items: [intake(P1), intake(P2, 'technical')], has_more: true, scope: 'synthetic_demo_only' });
    await TestBed.configureTestingModule({ imports: [AgentPage], providers: [{ provide: AgentService, useValue: service }, { provide: CognitoService, useValue: cognito }, provideRouter([])] })
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
    const button = el().querySelector<HTMLButtonElement>(`.intake-row[data-protocol="${protocol}"]`)!; // the row shows the short code, so find it by its case id
    button.focus();
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    return button;
  }

  it('shows the intake queue only before a detail is opened; no legacy case list', async () => {
    await page.load();
    fixture.detectChanges();
    expect(el().querySelectorAll('section.box').length).toBe(1);
  });

  it('loads the intake queue only after starting an agent session', async () => {
    const order: string[] = [];
    service.signIn.and.callFake(async () => { order.push('session'); });
    service.intakes.and.callFake(async () => { order.push('intakes'); return { items: [], has_more: false, scope: 'synthetic_demo_only' as const }; });
    await page.load();
    expect(order).toEqual(['session', 'intakes']);
    expect(service.intakes).toHaveBeenCalledTimes(1);
    expect(page.loaded()).toBeTrue();
  });

  it('shows translated kinds, the has_more note and no hard-coded TX label', async () => {
    service.intakeDetail.and.resolveTo(detail(P1));
    await loadAndOpen();
    const text = el().textContent!;
    expect(text).toContain(t().kindComplete);
    expect(text).toContain(t().kindTechnical);
    expect(text).toContain(t().queueMore);
    expect([...el().querySelectorAll('.detail-meta dt')].map(d => d.textContent)).toContain(t().transactionId);
    expect(text).not.toMatch(/\bTX\b/);
  });

  it('opens a detail, moves focus to its heading and returns focus on close', async () => {
    service.intakeDetail.and.resolveTo(detail(P1));
    const button = await loadAndOpen();
    expect(service.intakeDetail).toHaveBeenCalledOnceWith(P1);
    const heading = el().querySelector('#intake-detail-title')!;
    expect(document.activeElement).toBe(heading);
    const checks = el().querySelector('#intake-checks')!;
    expect(checks.querySelector('h3')?.textContent).toContain(t().whatWeChecked);
    expect(checks.textContent).toContain(t().check_owned_transaction_retrieved);
    expect(checks.textContent).toContain('owned_transaction_retrieved');
    expect(el().textContent).toContain('12.50 MXN');
    // The queue row and the detail show the short code; the detail keeps the UUID as the case id. A null code falls back to the UUID.
    const rows = [...el().querySelectorAll('.intake-row')].map(r => r.textContent!);
    expect(rows.find(r => r.includes('AR-7K3M-2Q4X'))).toBeDefined();
    expect(rows.find(r => r.includes(P2))).toBeDefined();
    const detailText = el().querySelector('#intake-detail')!.textContent!;
    expect(detailText).toContain('AR-7K3M-2Q4X');
    expect(detailText).toContain(P1);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    page.close();
    fixture.detectChanges();
    expect(el().querySelector('#intake-detail')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('points aria-controls at the detail only while it is rendered', async () => {
    await page.load();
    fixture.detectChanges();
    expect(el().querySelector('[aria-controls]')).toBeNull();
    service.intakeDetail.and.resolveTo(detail(P1));
    const button = await loadAndOpen();
    expect(button.getAttribute('aria-controls')).toBe('intake-detail');
    expect(el().querySelector('#intake-detail')).not.toBeNull();
  });

  it('moves focus to the sign-in button when an expired session clears the page', async () => {
    service.intakeDetail.and.rejectWith(new ApiError(401, 'raw'));
    await loadAndOpen();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(document.activeElement).toBe(el().querySelector('#agent-one-click'));
  });

  it('keeps keyboard focus on the page after loading: the queue heading on success, the sign-in button on failure', async () => {
    document.body.appendChild(el());
    fixture.autoDetectChanges();
    const signIn = () => el().querySelector<HTMLButtonElement>('#agent-one-click')!;
    service.signIn.and.rejectWith(new ApiError(503, 'raw'));
    signIn().focus();
    signIn().click();
    await fixture.whenStable();
    expect(document.activeElement).toBe(signIn());
    service.signIn.and.resolveTo();
    cognito = jasmine.createSpyObj<CognitoService>('CognitoService', ['requestCode', 'submitCode', 'forget']);
    cognito.requestCode.and.resolveTo();
    cognito.submitCode.and.resolveTo('id.token');
    signIn().click();
    await fixture.whenStable();
    expect(document.activeElement).toBe(el().querySelector('#intake-queue-title'));
    el().remove();
  });

  it('says in one line whether the model read the case, in every language', async () => {
    service.intakeDetail.and.resolveTo(detail(P1));
    await loadAndOpen();
    const line = () => el().querySelector('#model-reading')!.textContent!.trim();
    expect(line()).toBe('Model reading: off.');
    service.intakeDetail.and.resolveTo(detail(P1, { model_reading: { mode: 'shadow', model_version: 'extractor-v1@a270773600cf', llm_calls: 2 } }));
    await page.open(P1, el().querySelector<HTMLButtonElement>('.intake-row')!);
    fixture.detectChanges();
    expect(line()).toBe('Model reading: in shadow, 2 calls, version extractor-v1@a270773600cf. The model decides nothing.');
    TestBed.inject(LangService).set('es');
    fixture.detectChanges();
    expect(line()).toBe('Lectura del modelo: en sombra, 2 llamadas, versión extractor-v1@a270773600cf. El modelo no decide nada.');
    TestBed.inject(LangService).set('pt');
    fixture.detectChanges();
    expect(line()).toBe('Leitura do modelo: em sombra, 2 chamadas, versão extractor-v1@a270773600cf. O modelo não decide nada.');
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

  it('shows the mapped error and no stale intakes when sign-in fails', async () => {
    service.signIn.and.rejectWith(new ApiError(401, 'Session expired.'));
    await page.load();
    expect(page.error()).toBe(t().agentErr401);
    expect(page.intakes()).toEqual([]);
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

  it('keeps the latest detail request for a protocol even when an earlier one for the same protocol fails', async () => {
    let rejectFirst!: (e: unknown) => void;
    const first = new Promise<AgentIntakeDetail>((_, reject) => (rejectFirst = reject));
    service.intakeDetail.and.returnValues(first, Promise.resolve(detail(P1)));
    const row = document.createElement('button');
    const earlier = page.open(P1, row);
    await page.open(P1, row);
    rejectFirst(new ApiError(503));
    await earlier;
    expect(page.detail()?.protocol).toBe(P1);
    expect(page.error()).toBe('');
    expect(page.openProtocol()).toBe(P1);
  });

  it('clears a shown detail when the latest request for it fails', async () => {
    service.intakeDetail.and.returnValues(Promise.resolve(detail(P1)), Promise.reject(new ApiError(503)));
    const row = document.createElement('button');
    await page.open(P1, row);
    await page.open(P1, row);
    expect(page.detail()).toBeNull();
    expect(page.error()).not.toBe('');
  });

  describe('email sign-in', () => {
    const production = () => { Object.defineProperty(page, 'demoPicker', { value: false }); fixture.detectChanges(); };
    it('shows the one-click agent session only in development builds', () => {
      fixture.detectChanges();
      expect(el().querySelector('#agent-one-click')).not.toBeNull();
      production();
      expect(el().querySelector('#agent-one-click')).toBeNull();
      expect(el().querySelector('#agent-email')).not.toBeNull();
    });

    it('goes email → code → queue, sending the ID token to the agent session and focusing the queue', async () => {
      document.body.appendChild(el());
      production();
      page.email = ' agent@example.com ';
      await page.requestCode();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(cognito.requestCode).toHaveBeenCalledOnceWith('agent@example.com');
      expect(el().querySelector('#agent-email')).toBeNull();
      expect(document.activeElement).toBe(el().querySelector('#agent-code'));
      expect(el().querySelector('#agent-code-sent')!.textContent).toContain('agent@example.com');
      page.code = '12345678';
      await page.verify();
      fixture.detectChanges();
      expect(cognito.submitCode).toHaveBeenCalledOnceWith('agent@example.com', '12345678');
      expect(service.signIn).toHaveBeenCalledOnceWith('id.token');
      expect(page.loaded()).toBeTrue();
      expect(el().querySelector('form')).toBeNull();
      await fixture.whenStable();
      expect(document.activeElement).toBe(el().querySelector('#intake-queue-title'));
      service.signIn.calls.reset();
      el().querySelector<HTMLButtonElement>('button.ar-btn')!.click();
      await fixture.whenStable();
      expect(service.signIn).not.toHaveBeenCalled();
      expect(service.intakes).toHaveBeenCalledTimes(2);
      el().remove();
    });

    it('maps sign-in errors: wrong code stays on the code step; not an agent, rate limits and outages go back to the email', async () => {
      production();
      page.email = 'agent@example.com';
      cognito.requestCode.and.rejectWith(new ApiError(401));
      await page.requestCode();
      expect(page.error()).toBe(t().errSendCode);
      expect(page.codeSent()).toBeFalse();
      cognito.requestCode.and.resolveTo();
      await page.requestCode();
      cognito.submitCode.and.rejectWith(new ApiError(401));
      await page.verify();
      expect(page.error()).toBe(t().errCode);
      expect(page.codeSent()).toBeTrue();
      expect(service.signIn).not.toHaveBeenCalled();
      cognito.submitCode.and.resolveTo('id.token');
      for (const [status, text] of [[403, t().agentErr403], [429, t().errTooMany], [0, t().err503], [503, t().err503]] as const) {
        await page.requestCode();
        service.signIn.and.rejectWith(new ApiError(status));
        await page.verify();
        expect(page.error()).toBe(text);
        expect(page.codeSent()).toBeFalse();
        expect(page.loaded()).toBeFalse();
      }
    });
  });

  describe('status', () => {
    const action = () => el().querySelectorAll<HTMLButtonElement>('#intake-detail .status-action');
    const statusText = () => el().querySelector('#intake-status')!;

    it('offers exactly one next step per status, and none once closed', async () => {
      for (const [status, label] of [['received', t().takeCase], ['in_review', t().closeReview]] as const) {
        service.intakeDetail.and.resolveTo(detail(P1, { status }));
        await loadAndOpen();
        expect(action().length).toBe(1);
        expect(action()[0].textContent!.trim()).toBe(label);
      }
      service.intakeDetail.and.resolveTo(detail(P1, { status: 'closed' }));
      await loadAndOpen();
      expect(action().length).toBe(0);
      expect(statusText().textContent).toContain(t().reviewClosed);
    });

    it('shows the status as text on every queue row', async () => {
      await page.load();
      fixture.detectChanges();
      expect([...el().querySelectorAll('.intake-row .status-chip')].map(c => c.textContent!.trim())).toEqual([t().statusReceived, t().statusReceived]);
    });

    it('marks a high-urgency row with a translated chip, and only that row', async () => {
      service.intakes.and.resolveTo({ items: [{ ...intake(P1), urgency: 'high' }, intake(P2)], has_more: false, scope: 'synthetic_demo_only' });
      for (const lang of ['es', 'pt', 'en'] as const) {
        TestBed.inject(LangService).set(lang);
        await page.load();
        fixture.detectChanges();
        const chips = [...el().querySelectorAll('.intake-row')].map(row => row.querySelector('.urgency-chip')?.textContent?.trim() ?? null);
        expect(chips).toEqual([t().urgencyHigh, null]);
      }
      expect(t().urgencyHigh).toBe('High priority');
    });

    it('takes the case, then closes it, updating row and detail in place and focusing the new status', async () => {
      document.body.appendChild(el());
      service.intakeDetail.and.resolveTo(detail(P1));
      service.setStatus.and.callFake(async (protocol, status) => ({ protocol, status, changed_at: '2026-10-02T10:00:00.000Z' }));
      await loadAndOpen();
      action()[0].click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(service.setStatus).toHaveBeenCalledOnceWith(P1, 'in_review');
      expect(page.detail()!.status).toBe('in_review');
      expect(page.intakes().find(i => i.protocol === P1)!.status).toBe('in_review');
      expect(el().querySelector(`.intake-row[data-protocol="${P1}"] .status-chip`)!.textContent!.trim()).toBe(t().inReview);
      expect(document.activeElement).toBe(statusText());
      action()[0].click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(service.setStatus).toHaveBeenCalledWith(P1, 'closed');
      expect(action().length).toBe(0);
      expect(statusText().textContent).toContain(t().reviewClosed);
      expect(document.activeElement).toBe(statusText());
      el().remove();
    });

    it('disables the action while the change is pending', async () => {
      service.intakeDetail.and.resolveTo(detail(P1));
      let finish!: () => void;
      service.setStatus.and.returnValue(new Promise(r => (finish = () => r({ protocol: P1, status: 'in_review', changed_at: 'x' }))));
      await loadAndOpen();
      action()[0].click();
      fixture.detectChanges();
      expect(action()[0].disabled).toBeTrue();
      finish();
      await fixture.whenStable();
    });

    it('on 409 reloads the detail and says someone else changed it', async () => {
      service.intakeDetail.and.returnValues(Promise.resolve(detail(P1)), Promise.resolve(detail(P1, { status: 'closed' })));
      service.setStatus.and.rejectWith(new ApiError(409, 'Status can only move forward one step'));
      await loadAndOpen();
      action()[0].click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(service.intakeDetail).toHaveBeenCalledTimes(2);
      expect(page.detail()!.status).toBe('closed');
      expect(page.intakes().find(i => i.protocol === P1)!.status).toBe('closed');
      expect(el().querySelector('[role="alert"]')!.textContent).toContain(t().agentErr409);
      expect(action().length).toBe(0);
    });

    it('leaves no stale button when the reload after a 409 also fails', async () => {
      service.intakeDetail.and.returnValues(Promise.resolve(detail(P1)), Promise.reject(new ApiError(503, 'raw')));
      service.setStatus.and.rejectWith(new ApiError(409, 'raw'));
      await loadAndOpen();
      action()[0].click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(page.detail()).toBeNull();
      expect(action().length).toBe(0);
      expect(page.error()).toBe(t().err503);
    });

    it('shows the generic error text for other failures', async () => {
      service.intakeDetail.and.resolveTo(detail(P1));
      service.setStatus.and.rejectWith(new ApiError(503, 'raw'));
      await loadAndOpen();
      action()[0].click();
      await fixture.whenStable();
      expect(page.error()).toBe(t().err503);
      expect(page.detail()!.status).toBe('received');
    });

    it('offers no refund, block or verdict anywhere in the agent view, in any language', async () => {
      for (const status of ['received', 'in_review', 'closed'] as const) {
        for (const lang of ['es', 'pt', 'en'] as const) {
          TestBed.inject(LangService).set(lang);
          service.intakeDetail.and.resolveTo(detail(P1, { status }));
          await loadAndOpen();
          expect(el().textContent).not.toMatch(/reembols|bloque|fraude|refund|block|verdict/i);
        }
      }
    });
  });
});
