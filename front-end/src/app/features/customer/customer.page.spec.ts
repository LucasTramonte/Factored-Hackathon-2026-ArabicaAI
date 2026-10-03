import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { CustomerPage, initialsOf } from './customer.page';
import { LangService, errorText } from '../../shared/i18n/lang.service';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { Identity, IntakeReceipt, IntakeStart, Report, Transaction } from '../../shared/models/intake.model';

describe('CustomerPage', () => {
  let service: jasmine.SpyObj<CustomerService>;
  let page: CustomerPage;
  let cognito: jasmine.SpyObj<CognitoService>;
  const tx: Transaction = { transaction_id: 'demo-tx-001', merchant_name: 'Mercado', occurred_at: null,
    source_occurred_at: '2026-02-26T13:21:51', amount: '125.50', currency: 'BRL' };

  beforeEach(async () => {
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['identities', 'signIn', 'signInWithToken', 'logout', 'transactions',
      'startIntake', 'confirmIntake', 'handoffIntake', 'reports', 'requestUpdate', 'displayed'], { client: signal(''), card: signal(null), roles: signal([]) });
    service.identities.and.resolveTo([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' },
      { customer_id: 'demo-bruno', display_name: 'Bruno (demo)' }]);
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', mode: 'simulated_login', context_card: null, roles: ['customer'] });
    service.transactions.and.resolveTo({ items: [tx], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
    service.signInWithToken.and.resolveTo({ customer_id: 'CLI-1', mode: 'email_otp', context_card: null, roles: ['customer'] });
    service.logout.and.resolveTo();
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.displayed.and.resolveTo({});
    cognito = jasmine.createSpyObj<CognitoService>('CognitoService', ['requestCode', 'submitCode', 'forget']);
    cognito.requestCode.and.resolveTo();
    cognito.submitCode.and.resolveTo('id.token');
    await TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service },
      { provide: CognitoService, useValue: cognito }, provideRouter([])] })
      .compileComponents();
    page = TestBed.createComponent(CustomerPage).componentInstance;
  });

  it('starts on the intro, moves to sign-in on start, and to the home once charges are loaded', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    const p = fixture.componentInstance;
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(p.step()).toBe('intro');
    expect(p.discClass()).toBe('disc disc--boot');
    expect(el.querySelector('.intro')).not.toBeNull();
    p.start();
    fixture.detectChanges();
    expect(p.step()).toBe('login');
    expect(p.discClass()).toBe('disc disc--login');
    expect(el.querySelector('.step h1')?.textContent?.trim()).toBe(p.t().whoAreYou);
    expect([...el.querySelectorAll('.login-promise p')].map(li => li.textContent?.trim()))
      .toEqual([p.t().promise1, p.t().promise2, p.t().promise3]);
    p.identity = 'demo-ana';
    await p.login();
    expect(p.step()).toBe('home');
    expect(p.discClass()).toBe('disc disc--home');
  });

  it('shows the promise from the first frame of the intro, not hidden or faded by any animation', () => {
    const fixture = TestBed.createComponent(CustomerPage);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const el = root.querySelector<HTMLElement>('.intro .promise-line');
    expect(el?.textContent?.trim()).toBe(fixture.componentInstance.t().promiseLine);
    for (let n: HTMLElement | null = el; n && n !== root.parentElement; n = n.parentElement) {
      const style = getComputedStyle(n);
      expect(style.visibility).withContext(n.className).not.toBe('hidden');
      expect(style.opacity).withContext(n.className).toBe('1');
    }
  });

  it('puts the promise above the email field on sign-in', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    const p = fixture.componentInstance;
    Object.defineProperty(p, 'demoPicker', { value: false });
    p.start();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const promise = el.querySelector('.login-form .promise-line');
    expect(promise?.textContent?.trim()).toBe(p.t().promiseLine);
    expect(promise!.compareDocumentPosition(el.querySelector('#login-email')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says on sign-in that it is simulated and shows only your own charges', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    const p = fixture.componentInstance;
    p.start();
    fixture.detectChanges();
    const note = (fixture.nativeElement as HTMLElement).querySelector('.login-form > p.ar-small')?.textContent ?? '';
    expect(note).toContain(p.t().synthetic);
    expect(note).toContain(p.t().onlyYours);
  });

  it('signs in and lists only what the API returns', async () => {
    page.identity = 'demo-ana';
    await page.login();
    expect(service.signIn).toHaveBeenCalledWith('demo-ana');
    expect(page.transactions()).toEqual([tx]);
  });

  it('stays on sign-in and shows the mapped error when sign-in fails', async () => {
    service.signIn.and.rejectWith(new ApiError(503, 'unavailable'));
    page.start();
    page.identity = 'demo-ana';
    await page.login();
    expect(page.step()).toBe('login');
    expect(page.error()).toBe(TestBed.inject(LangService).t().err503);
  });

  it('shows a loading line until the identities arrive, then the picker', async () => {
    let resolve!: (v: Identity[]) => void;
    service.identities.and.returnValue(new Promise<Identity[]>(r => { resolve = r; }));
    const fixture = TestBed.createComponent(CustomerPage);
    const init = fixture.componentInstance.ngOnInit();
    fixture.componentInstance.start();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#identities-loading')?.textContent).toContain(fixture.componentInstance.t().working);
    resolve([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' }]);
    await init;
    fixture.detectChanges();
    expect(el.querySelector('#identities-loading')).toBeNull();
    expect(el.querySelector('app-customer-picker')).not.toBeNull();
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

  describe('email sign-in', () => {
    beforeEach(() => TestBed.inject(LangService).set('es')); // es has a report language; the chat specs rely on it
    async function open(demoPicker: boolean) {
      const fixture = TestBed.createComponent(CustomerPage);
      const p = fixture.componentInstance;
      Object.defineProperty(p, 'demoPicker', { value: demoPicker });
      await p.ngOnInit();
      p.start();
      fixture.detectChanges();
      return { fixture, p, el: fixture.nativeElement as HTMLElement };
    }
    async function toCode(p: CustomerPage) {
      p.email = ' ana@example.com ';
      await p.requestCode();
    }

    it('sends a code, shows where it went, and verifies into the home', async () => {
      const { fixture, p, el } = await open(false);
      expect(el.querySelector<HTMLInputElement>('input[type=email]')?.labels?.[0].textContent).toContain(p.t().emailLabel);
      await toCode(p);
      fixture.detectChanges();
      expect(cognito.requestCode).toHaveBeenCalledWith('ana@example.com');
      expect(el.querySelector('#code-sent')?.textContent).toContain('ana@example.com');
      const code = el.querySelector<HTMLInputElement>('#login-code')!;
      expect([code.inputMode, code.autocomplete, code.maxLength, code.pattern]).toEqual(['numeric', 'one-time-code', 8, '[0-9]*']);
      p.code = '12345678';
      await p.verify();
      expect(cognito.submitCode).toHaveBeenCalledWith('ana@example.com', '12345678');
      expect(service.signInWithToken).toHaveBeenCalledWith('id.token');
      expect(p.client()).toBe('CLI-1');
      expect(p.step()).toBe('home');
    });

    it('maps each failure to its own text and keeps the right step', async () => {
      const { p } = await open(false);
      const t = p.t();
      cognito.requestCode.and.rejectWith(new ApiError(401));
      await toCode(p);
      expect([p.codeSent(), p.error()]).toEqual([false, t.errSendCode]);
      cognito.requestCode.and.rejectWith(new ApiError(429));
      await toCode(p);
      expect(p.error()).toBe(t.errTooMany);
      cognito.requestCode.and.resolveTo();
      await toCode(p);
      const cases: [jasmine.Spy, number, string][] = [[cognito.submitCode, 401, t.errCode], [service.signInWithToken, 403, t.errNotEnrolled],
        [cognito.submitCode, 429, t.errTooMany], [cognito.submitCode, 0, t.err503], [service.signInWithToken, 503, t.err503]];
      for (const [spy, status, text] of cases) {
        cognito.submitCode.and.resolveTo('id.token');
        service.signInWithToken.and.resolveTo({ customer_id: 'CLI-1', mode: 'email_otp', roles: ['customer'] });
        spy.and.rejectWith(new ApiError(status));
        if (!p.codeSent()) await toCode(p);
        await p.verify();
        // A Cognito failure keeps the code step; a Worker failure spent the code, so it is back to the email step.
        expect([p.step(), p.codeSent(), p.error()]).withContext(String(status)).toEqual(['login', spy === cognito.submitCode, text]);
      }
    });

    it('after Cognito accepts the code, a failed Worker exchange returns to the email step for a new code', async () => {
      const real = new CognitoService();
      cognito.requestCode.and.callFake(e => real.requestCode(e));
      cognito.submitCode.and.callFake((e, c) => real.submitCode(e, c));
      const fetchSpy = spyOn(globalThis, 'fetch');
      const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      const { p } = await open(false);
      for (const [status, text] of [[403, p.t().errNotEnrolled], [503, p.t().err503]] as const) {
        fetchSpy.and.returnValues(reply({ ChallengeName: 'EMAIL_OTP', Session: 's' }), reply({ AuthenticationResult: { IdToken: 'id' } }));
        service.signInWithToken.and.rejectWith(new ApiError(status));
        await toCode(p);
        await p.verify();
        expect([p.step(), p.codeSent(), p.email, p.error()]).withContext(String(status)).toEqual(['login', false, ' ana@example.com ', text]);
      }
      expect(cognito.submitCode).toHaveBeenCalledTimes(2);
    });

    it('a failed logout after a refused renewal drops the open report so nothing goes out under the other cookie', async () => {
      const { p } = await open(false);
      await toCode(p);
      await p.verify();
      service.startIntake.and.resolveTo({ episode_id: 'e', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      p.step.set('login');
      service.signInWithToken.and.resolveTo({ customer_id: 'CLI-2', mode: 'email_otp', roles: ['customer'] });
      service.logout.and.rejectWith(new ApiError(0));
      await toCode(p);
      await p.verify();
      expect([p.step(), p.client(), p.frozen(), p.chatStep(), p.error()]).toEqual(['login', '', null, 'describe', p.t().err503]);
    });

    it('refuses a renewal that signs in another customer and keeps the open report', async () => {
      const { p } = await open(false);
      await toCode(p);
      await p.verify();
      service.startIntake.and.resolveTo({ episode_id: 'e', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      expect(p.identityLocked()).toBeTrue();
      p.step.set('login');
      service.signInWithToken.and.resolveTo({ customer_id: 'CLI-2', mode: 'email_otp', roles: ['customer'] });
      await toCode(p);
      await p.verify();
      expect([p.step(), p.client(), p.chatStep(), p.error()]).toEqual(['login', 'CLI-1', 'choose', p.t().errOtherCustomer]);
      expect(service.logout).toHaveBeenCalledTimes(1);
      service.signInWithToken.and.resolveTo({ customer_id: 'CLI-1', mode: 'email_otp', roles: ['customer'] });
      await toCode(p);
      await p.verify();
      expect([p.step(), p.chatStep()]).toEqual(['home', 'choose']);
      expect(service.logout).toHaveBeenCalledTimes(1); // a matching renewal keeps its session
    });

    it('in production an email renewal resends the frozen start with the same key and body, with no reset', async () => {
      const { fixture, p, el } = await open(false);
      await toCode(p);
      await p.verify();
      p.openChat();
      service.startIntake.and.returnValues(Promise.reject(new ApiError(401)),
        Promise.resolve({ episode_id: 'e', state: 'selection_required', language: 'es', mode: 'guided', replayed: false }));
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      const frozen = p.frozen();
      expect(frozen?.path).toBe('start');
      expect([p.chatError(), service.signIn.calls.count()]).toEqual([p.t().err401, 0]); // no silent demo renewal
      fixture.detectChanges();
      [...el.querySelectorAll<HTMLButtonElement>('.chat button')].find(b => b.textContent!.trim() === p.t().renew)!.click();
      expect(p.step()).toBe('login');
      await toCode(p);
      await p.verify();
      expect([p.step(), p.client(), p.frozen()]).toEqual(['home', 'CLI-1', frozen]);
      expect(p.log()).toContain({ from: 'me', text: 'No reconozco este cargo.' });
      expect(service.logout).not.toHaveBeenCalled();
      await p.run();
      const [first, second] = service.startIntake.calls.allArgs().map(a => a[0]);
      expect(second).toEqual(first);
      expect(second.idempotency_key).toBe((frozen!.body as { idempotency_key: string }).idempotency_key);
      expect(p.chatStep()).toBe('choose');
    });

    it('in production renders no picker, never lists identities, and says the sign-in is an email code', async () => {
      const { p, el } = await open(false);
      expect(service.identities).not.toHaveBeenCalled();
      expect(el.querySelector('app-customer-picker')).toBeNull();
      const note = el.querySelector('.login-form > p.ar-small')?.textContent ?? '';
      expect(note).toContain(p.t().emailSignIn);
      expect(note).not.toContain(p.t().synthetic);
      expect(note).toContain(p.t().onlyYours);
    });

    it('in development keeps the picker under its own heading', async () => {
      const { p, el } = await open(true);
      expect(service.identities).toHaveBeenCalled();
      expect(el.querySelector('app-customer-picker')).not.toBeNull();
      expect(el.querySelector('#local-identities')?.textContent?.trim()).toBe(p.t().localIdentities);
      expect(el.querySelector('input[type=email]')).not.toBeNull();
    });
  });

  it('takes initials only from words that start with a letter', () => {
    expect(initialsOf('Ana (demo)')).toBe('A');
    expect(initialsOf('Ángela Núñez (demo)')).toBe('ÁN');
    expect(initialsOf('(demo) 7-Eleven')).toBe('');
  });

  describe('guided intake chat', () => {
    const started: IntakeStart = { episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'selection_required', language: 'es', mode: 'guided', replayed: false };
    const intakeReceipt: IntakeReceipt = { episode_id: started.episode_id, protocol: '99999999-8888-4777-8666-555555555555', kind: 'complete',
      accepted_at: '2026-09-30T12:00:00Z', replayed: false, actions_taken: ['owned_transaction_retrieved', 'customer_confirmation_recorded'],
      unresolved_questions: [], reference_short: 'AR-7K3M-2Q4X', next_step_code: 'await_human_review', urgency: 'normal' };
    const openReport: Report = { protocol: intakeReceipt.protocol, reference_short: 'AR-7K3M-2Q4X', kind: 'complete', status: 'received',
      next_step: 'review_pending', accepted_at: intakeReceipt.accepted_at, transaction_id: 'demo-tx-001' };
    let lang: LangService;

    beforeEach(async () => {
      lang = TestBed.inject(LangService);
      lang.set('es');
      page.identity = 'demo-ana';
      await page.login();
      page.openChat();
    });
    afterEach(() => lang.set('es'));

    async function startEpisode() {
      service.startIntake.and.resolveTo(started);
      page.chatStatement = '  No reconozco este cargo.  ';
      await page.send();
    }
    /** The "can't find it" path: the guide asks once what the customer remembers, and the answer goes with the handoff. */
    async function review(details = 'Unos 50 euros el martes, en una tienda de ropa.') {
      page.cannotFind();
      page.chatDetails = details;
      await page.handoff();
    }

    it('starts with exactly the guided fields and shows no reference before the receipt', async () => {
      await startEpisode();
      const body = service.startIntake.calls.mostRecent().args[0];
      expect(Object.keys(body).sort()).toEqual(['customer_statement', 'idempotency_key', 'language', 'mode', 'report_type']);
      expect(body).toEqual(jasmine.objectContaining({ customer_statement: 'No reconozco este cargo.', language: 'es', mode: 'guided', report_type: 'unrecognized_charge' }));
      expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(page.chatStep()).toBe('choose');
      expect(page.intakeReceipt()).toBeNull();
    });

    it('defaults the report language to the interface language, English included', async () => {
      lang.set('pt');
      expect(page.reportLang()).toBe('pt');
      lang.set('en');
      expect(page.reportLang()).toBe('en');
      page.chatStatement = 'I do not recognize this charge.';
      service.startIntake.and.resolveTo({ ...started, language: 'en' });
      await page.send();
      expect(service.startIntake.calls.mostRecent().args[0].language).toBe('en');
    });

    /** The chat rendered, for the report-language choice. */
    async function chat() {
      const fixture = TestBed.createComponent(CustomerPage);
      fixture.componentInstance.identity = 'demo-ana';
      await fixture.componentInstance.login();
      fixture.componentInstance.openChat();
      fixture.detectChanges();
      return { fixture, p: fixture.componentInstance };
    }

    it('in English lists Español, Português and English, English checked, and sends the one chosen', async () => {
      lang.set('en');
      const { fixture, p } = await chat();
      const radios = [...fixture.nativeElement.querySelectorAll('input[name="report-lang"]')] as HTMLInputElement[];
      expect(radios.map(r => [r.value, r.checked, r.parentElement!.textContent!.trim()])).toEqual(
        [['es', false, 'Español'], ['pt', false, 'Português'], ['en', true, 'English']]);
      expect(fixture.nativeElement.querySelector('.chat-lang legend').textContent).not.toContain('not supported');
      radios[1].click();
      fixture.detectChanges();
      p.chatStatement = 'Não reconheço esta cobrança.';
      service.startIntake.and.resolveTo({ ...started, language: 'pt' });
      await p.send();
      expect(service.startIntake.calls.mostRecent().args[0].language).toBe('pt');
    });

    it('asks for the report language only in English, as before', async () => {
      const { fixture } = await chat();
      expect(fixture.nativeElement.querySelector('input[name="report-lang"]')).toBeNull();
      lang.set('pt'); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('input[name="report-lang"]')).toBeNull();
    });

    it('refuses a statement under 10 code points in every interface language', async () => {
      page.chatStatement = '😀😀😀😀😀';
      for (const code of ['es', 'pt', 'en'] as const) {
        lang.set(code);
        await page.send();
        expect(page.chatError()).toBe(lang.t().chatValidationShort);
      }
      expect(service.startIntake).not.toHaveBeenCalled();
    });

    it('freezes the start and resends the same body after a 503, even if the text changes', async () => {
      service.startIntake.and.returnValues(Promise.reject(new ApiError(503, 'x')), Promise.resolve(started));
      page.chatStatement = 'No reconozco este cargo.';
      await page.send();
      expect(page.identityLocked()).toBeTrue();
      page.chatStatement = 'Edited, must not be sent.';
      await page.send();
      const [first, second] = service.startIntake.calls.allArgs().map(a => a[0]);
      expect(second).toEqual(first);
      expect(page.chatStep()).toBe('choose');
    });

    it('on 401 renews the same customer once and retries with the same key', async () => {
      service.startIntake.and.returnValues(Promise.reject(new ApiError(401, 'x')), Promise.resolve(started));
      page.identity = 'demo-bruno';
      page.chatStatement = 'No reconozco este cargo.';
      await page.send();
      expect(service.signIn.calls.mostRecent().args[0]).toBe('demo-ana');
      const [first, second] = service.startIntake.calls.allArgs().map(a => a[0]);
      expect(second).toEqual(first);
      expect(page.chatStep()).toBe('choose');
      // The renewal is visible: the guide says the session was renewed and the same request was resent.
      expect(page.log()).toContain({ from: 'bot', key: 'sessionRenewed' });
    });

    it('after a second 401 keeps the request frozen for a manual renew and retry', async () => {
      service.startIntake.and.rejectWith(new ApiError(401, 'x'));
      page.chatStatement = 'No reconozco este cargo.';
      await page.send();
      expect(service.startIntake).toHaveBeenCalledTimes(2);
      expect(page.frozen()).not.toBeNull();
      expect(page.chatError()).toBe(lang.t().err401);
    });

    it('confirms one owned charge with a new key, distinct from the start key', async () => {
      await startEpisode();
      service.confirmIntake.and.resolveTo(intakeReceipt);
      page.choice = 'demo-tx-001';
      await page.confirmCharge();
      expect(service.confirmIntake).not.toHaveBeenCalled();
      page.chatConfirmed = true;
      await page.confirmCharge();
      const body = service.confirmIntake.calls.mostRecent().args[0];
      expect(body).toEqual({ customer_confirmed: true, episode_id: started.episode_id, idempotency_key: jasmine.any(String), transaction_id: 'demo-tx-001' });
      expect(body.idempotency_key).not.toBe(service.startIntake.calls.mostRecent().args[0].idempotency_key);
      expect(page.intakeReceipt()).toEqual(intakeReceipt);
      expect(page.chatStep()).toBe('receipt');
      expect(page.identityLocked()).toBeFalse();
    });

    it('"can\'t find it" asks once what the customer remembers before anything is sent, then sends it with the incomplete handoff', async () => {
      await startEpisode();
      service.handoffIntake.and.resolveTo({ ...intakeReceipt, kind: 'incomplete' });
      page.cannotFind();
      expect(service.handoffIntake).not.toHaveBeenCalled();
      expect(page.chatStep()).toBe('details');
      expect(page.identityLocked()).toBeTrue();
      expect(page.log().slice(-2)).toEqual([{ from: 'me', key: 'chatCannotFind' }, { from: 'bot', key: 'chatDetailsPrompt' }]);
      page.chatDetails = '😀😀😀😀😀';
      await page.handoff();
      expect(service.handoffIntake).not.toHaveBeenCalled();
      expect(page.chatError()).toBe(lang.t().chatValidationShort);
      page.chatDetails = '  Unos 50 euros el martes, en una tienda de ropa.  ';
      await page.handoff();
      expect(service.handoffIntake.calls.mostRecent().args[0]).toEqual({ details: 'Unos 50 euros el martes, en una tienda de ropa.',
        episode_id: started.episode_id, idempotency_key: jasmine.any(String), kind: 'incomplete' });
      expect(page.log().at(-1)).toEqual({ from: 'me', text: 'Unos 50 euros el martes, en una tienda de ropa.' });
      expect(page.receiptTitle()).toBe(lang.t().receiptIncomplete);
      expect(page.identityLocked()).toBeFalse();
    });

    it('the details field cannot outgrow the statement column, and with no room left the handoff goes without the question', async () => {
      service.startIntake.and.resolveTo(started);
      page.chatStatement = 'x'.repeat(1991);
      await page.send();
      service.handoffIntake.and.resolveTo({ ...intakeReceipt, kind: 'incomplete' });
      expect(page.room).toBe(8);
      await page.cannotFind();
      expect(page.chatStep()).toBe('receipt');
      expect(service.handoffIntake.calls.mostRecent().args[0]).toEqual({ episode_id: started.episode_id, idempotency_key: jasmine.any(String), kind: 'incomplete' });
    });

    it('picking a charge row while the guide waits for details goes back to choosing it', async () => {
      await startEpisode();
      page.cannotFind();
      page.openChat('demo-tx-001');
      expect(page.chatStep()).toBe('choose');
      expect(page.choice).toBe('demo-tx-001');
      expect(page.log().at(-1)).toEqual({ from: 'bot', key: 'chatChoose' });
    });

    it('a pending finish cannot switch between confirm and handoff', async () => {
      await startEpisode();
      service.confirmIntake.and.rejectWith(new ApiError(503, 'x'));
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      service.handoffIntake.and.resolveTo(intakeReceipt);
      await page.cannotFind();
      expect(service.handoffIntake).not.toHaveBeenCalled();
      expect(page.frozen()?.path).toBe('confirm');
      await page.confirmCharge();
      const [first, second] = service.confirmIntake.calls.allArgs().map(a => a[0]);
      expect(second).toEqual(first);
    });

    it('a 404 releases the choice; the next confirm uses a new key', async () => {
      await startEpisode();
      service.confirmIntake.and.returnValues(Promise.reject(new ApiError(404, 'x')), Promise.resolve(intakeReceipt));
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(page.frozen()).toBeNull();
      expect(page.chatStep()).toBe('choose');
      page.chatConfirmed = true;
      await page.confirmCharge();
      const [first, second] = service.confirmIntake.calls.allArgs().map(a => a[0]);
      expect(second.idempotency_key).not.toBe(first.idempotency_key);
    });

    it('a 409 on start keeps the generic message and lets the customer send again with a new key', async () => {
      service.startIntake.and.rejectWith(new ApiError(409, 'x'));
      page.chatStatement = 'No reconozco este cargo.';
      await page.send();
      expect(page.chatStep()).toBe('describe');
      expect(page.frozen()).toBeNull();
      expect(page.chatError()).toBe(lang.t().err409);
    });

    it('a confirm 409 for an open report on the charge says so in each language and ends the episode', async () => {
      await startEpisode();
      service.confirmIntake.and.rejectWith(new ApiError(409, undefined, true));
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(page.chatStep()).toBe('ended');
      expect(page.chatError()).toBe('Este cargo ya tiene un reporte abierto.');
      for (const [code, text] of [['pt', 'Esta cobrança já tem um relato aberto.'], ['en', 'This charge already has an open report.']] as const) {
        lang.set(code);
        expect(lang.t().err409OpenReport).toBe(text);
      }
    });

    it('a 409 on finish ends the episode and offers a customer-initiated new report', async () => {
      await startEpisode();
      service.handoffIntake.and.rejectWith(new ApiError(409, 'x'));
      await review();
      expect(page.chatStep()).toBe('ended');
      expect(page.chatError()).toBe(lang.t().err409Finish);
      expect(lang.t().err409Finish).not.toBe(lang.t().err409);
      expect(service.startIntake).toHaveBeenCalledTimes(1);
      page.newReport();
      expect(page.chatStep()).toBe('describe');
      expect(page.chatStatement).toBe('');
    });

    it('keeps the same identity while a report is open, even if another is picked', async () => {
      await startEpisode();
      expect(page.identityLocked()).toBeTrue();
      page.identity = 'demo-bruno';
      await page.login();
      expect(service.signIn.calls.mostRecent().args[0]).toBe('demo-ana');
      expect(page.chatStep()).toBe('choose');
    });

    it('does not send twice while busy or after a receipt', async () => {
      await startEpisode();
      service.confirmIntake.and.resolveTo(intakeReceipt);
      service.reports.and.resolveTo({ items: [openReport], has_more: false });
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await Promise.all([page.confirmCharge(), page.confirmCharge()]);
      await page.confirmCharge();
      await page.cannotFind();
      expect(service.confirmIntake).toHaveBeenCalledTimes(1);
      expect(service.handoffIntake).not.toHaveBeenCalled();
      expect(page.reportOf('demo-tx-001')?.status).toBe('received');
    });

    it('a charge row opens the chat with that charge preselected but unconfirmed', async () => {
      page.chatOpen.set(false);
      page.openChat('demo-tx-001');
      expect(page.chatOpen()).toBeTrue();
      expect(page.choice).toBe('demo-tx-001');
      expect(page.chatConfirmed).toBeFalse();
    });

    it('a charge with an open server report is not offered again after a new report; a closed one is', async () => {
      await startEpisode();
      service.confirmIntake.and.resolveTo(intakeReceipt);
      service.reports.and.resolveTo({ items: [openReport], has_more: false });
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      page.newReport();
      expect(page.choosable()).toEqual([]);
      await startEpisode();
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(service.confirmIntake).toHaveBeenCalledTimes(1);
      page.reports.set({ items: [{ ...openReport, status: 'closed', next_step: 'closed_by_person' }], has_more: false });
      expect(page.choosable()).toEqual([tx]);
    });

    it('marks a pending confirmation as not confirmed, never as accepted', async () => {
      await startEpisode();
      service.confirmIntake.and.rejectWith(new ApiError(503, 'x'));
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(page.pending('demo-tx-001')).toBeTrue();
      expect(page.reportOf('demo-tx-001')).toBeUndefined();
    });

    it('answers FAQs from fixed translated text only', () => {
      page.ask('faqTimeQ');
      expect(page.log().slice(-2)).toEqual([{ from: 'me', key: 'faqTimeQ' }, { from: 'bot', key: 'faqTimeA' }]);
      expect(() => page.ask('nope' as never)).toThrow();
    });

    it('titles the receipt by the server kind', async () => {
      await startEpisode();
      service.confirmIntake.and.resolveTo({ ...intakeReceipt, kind: 'technical' });
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(page.receiptTitle()).toBe(lang.t().receiptTechnical);
    });
  });

  describe('rendered home', () => {
    async function home(card: unknown = null) {
      TestBed.inject(LangService).set('es'); // other specs may leave English selected, which shows the report-language choice
      service.signIn.and.resolveTo({ customer_id: 'demo-ana', mode: 'simulated_login', context_card: card as never, roles: ['customer'] });
      const fixture = TestBed.createComponent(CustomerPage);
      const p = fixture.componentInstance;
      await p.ngOnInit();
      p.identity = 'demo-ana';
      await p.login();
      fixture.detectChanges();
      return { fixture, p, el: fixture.nativeElement as HTMLElement };
    }

    it('greets by the context card name and lists products with last4, showing missing fields as missing', async () => {
      const { el } = await home({ version: 1, snapshot_at: '2026-06-01', first_name: 'Ana', locale_hint: 'es-CO',
        products: [{ product_type: 'credit_card', last4: '1234', currency: 'COP' }, { product_type: null, last4: null, currency: null }] });
      expect(el.querySelector('h1')?.textContent).toContain('Ana');
      const products = [...el.querySelectorAll('.products li')].map(li => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(products[0]).toContain('1234');
      expect(products[1]).toContain(TestBed.inject(LangService).t().notListed);
    });

    it('falls back to the display name without a context card', async () => {
      const { el } = await home(null);
      expect(el.querySelector('h1')?.textContent).toContain('Ana (demo)');
      expect(el.querySelector('.products')).toBeNull();
    });

    it('shows an administrator, and only them, a banner linking the agent view; reset clears the roles', async () => {
      TestBed.inject(LangService).set('es');
      service.signIn.and.resolveTo({ customer_id: 'demo-ana', mode: 'email_otp', context_card: null, roles: ['admin'] });
      const fixture = TestBed.createComponent(CustomerPage);
      const p = fixture.componentInstance;
      const el = fixture.nativeElement as HTMLElement;
      p.identity = 'demo-ana';
      await p.login();
      fixture.detectChanges();
      expect(service.roles()).toEqual(['admin']);
      const banner = el.querySelector('aside.role-banner[role=status]');
      expect(banner?.textContent).toContain(p.t().adminChip);
      expect(banner?.querySelector('a[href="/agent"]')).not.toBeNull();
      p['reset']();
      expect(service.roles()).toEqual([]);
      service.signIn.and.resolveTo({ customer_id: 'demo-bruno', mode: 'email_otp', context_card: null, roles: ['customer'] });
      p.identity = 'demo-bruno';
      await p.login();
      fixture.detectChanges();
      expect(service.roles()).toEqual(['customer']);
      expect(el.querySelector('.role-banner')).toBeNull();
    });

    it('while a request is pending the agent link is disabled, and the server reports and the home survive in-app navigation', async () => {
      const { fixture, p, el } = await home();
      service.startIntake.and.rejectWith(new ApiError(503, 'x'));
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      fixture.detectChanges();
      const link = () => el.querySelector<HTMLAnchorElement>('.ar-nav a[aria-label="' + p.t().agentView + '"]')!;
      expect(link().hasAttribute('href')).toBeFalse();
      expect(link().getAttribute('aria-disabled')).toBe('true');
      p.frozen.set(null);
      fixture.detectChanges();
      expect(link().getAttribute('href')).toBe('/agent');
      fixture.destroy();
      service.reports.and.resolveTo({ items: [report('incomplete', 'AR-3F9Q-1Z7P')], has_more: false });
      const again = TestBed.createComponent(CustomerPage);
      await again.componentInstance.ngOnInit();
      await again.whenStable();
      again.detectChanges();
      const html = again.nativeElement as HTMLElement;
      expect(again.componentInstance.step()).toBe('home');
      expect(html.textContent).toContain('AR-3F9Q-1Z7P'); // the home shows the short code; the UUID lives in the receipt panel as the case id
      expect(html.querySelector('.ar-count')).withContext('no receipt badge on the agent link: it read as a queue count').toBeNull();
      const reports = [...html.querySelectorAll('.your-reports li')].map(li => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(reports.length).toBe(1);
      expect(reports[0]).toContain(p.t().kindIncomplete);
      expect(reports[0]).toContain('AR-3F9Q-1Z7P'); // the short code is the reference a customer keeps
      expect(reports[0]).not.toContain('99999999-8888-4777-8666-555555555555');
    });

    const report = (kind: 'complete' | 'incomplete' | 'technical', ref: string | null, at = '2026-10-01T12:00:00Z', protocol = '99999999-8888-4777-8666-555555555555') =>
      ({ protocol, reference_short: ref, kind, status: 'received', next_step: 'review_pending', accepted_at: at, transaction_id: null } as const);
    const rows = (el: HTMLElement) => [...el.querySelectorAll('.your-reports li')].map(li => li.textContent?.replace(/\s+/g, ' ').trim() ?? '');

    it('after sign-in lists the server reports in server order (newest first), with reference, kind and status as text', async () => {
      service.reports.and.resolveTo({ items: [report('complete', 'AR-AAAA-BBBB', '2026-10-02T09:30:00Z'),
        report('technical', null, '2026-10-01T08:00:00Z', '11111111-2222-4333-8444-555555555555')], has_more: false });
      const { el, p } = await home();
      expect(service.reports).toHaveBeenCalled();
      expect(el.querySelector('.your-reports h3')?.textContent?.trim()).toBe(p.t().yourReports);
      const [first, second] = rows(el);
      expect(first).toContain('AR-AAAA-BBBB');
      expect(first).not.toContain(p.t().receiptComplete); // a complete report needs no kind word
      expect(el.querySelectorAll('.your-reports .report-kind').length).toBe(1);
      expect(first).toContain(p.t().statusReceived);
      expect(first).toContain(p.t().nextStepReview);
      expect(first).toContain('2026-10-02 09:30:00');
      expect(second).toContain('11111111-2222-4333-8444-555555555555'); // no short code: the protocol
      expect(second).toContain(p.t().kindTechnical);
      expect(el.textContent).not.toContain(p.t().moreReports);
    });

    describe('after a fresh sign-in, each charge row follows its server report', () => {
      const chip = (el: HTMLElement) => el.querySelector('.td-state .ar-chip')?.textContent?.replace(/\s+/g, ' ').trim();
      const listed = (status: 'received' | 'in_review' | 'closed') => service.reports.and.resolveTo({ items: [{ ...report('complete', 'AR-AAAA-BBBB'),
        status, next_step: status === 'received' ? 'review_pending' : status === 'in_review' ? 'being_reviewed' : 'closed_by_person', transaction_id: 'demo-tx-001' }], has_more: false });

      it('an open report shows its status and reference and no Report button; the chat does not offer the charge', async () => {
        listed('received');
        const { el, p } = await home();
        expect(chip(el)).toBe(p.t().statusReceived + ' AR-AAAA-BBBB');
        expect(el.querySelector('.td-state .ar-btn')).toBeNull();
        expect(p.choosable()).toEqual([]);
      });

      it('in review shows the in-review text', async () => {
        listed('in_review');
        const { el, p } = await home();
        expect(chip(el)).toBe(p.t().inReview + ' AR-AAAA-BBBB');
        expect(el.querySelector('.td-state .ar-btn')).toBeNull();
      });

      it('a closed report shows the closed chip and the Report button again', async () => {
        listed('closed');
        const { el, p } = await home();
        expect(chip(el)).toBe(p.t().chipClosed + ' AR-AAAA-BBBB');
        expect(el.querySelector('.td-state .ar-btn')).not.toBeNull();
        expect(p.choosable()).toEqual([tx]);
      });

      for (const status of ['received', 'in_review', 'closed'] as const) {
        it(`"Your reports" shows the ${status} status as the same chip term as the charge row`, async () => {
          listed(status);
          const { el, p } = await home();
          const term = el.querySelector('.your-reports li .report-status .ar-chip')?.textContent?.trim();
          expect(term).toBe(p.t()[p.statusChip[status]]);
          expect(chip(el)).toBe(term + ' AR-AAAA-BBBB');
        });
      }

      it('"Your reports" names the charge by merchant and amount', async () => {
        listed('received');
        const { el } = await home();
        expect(rows(el)[0]).toContain('Mercado');
        expect(rows(el)[0]).toContain('125.50 BRL');
      });
    });

    it('shows the status a person set: received, in review, closed; never resolved', async () => {
      service.reports.and.resolveTo({ items: [report('complete', 'AR-AAAA-BBBB'),
        { ...report('complete', 'AR-CCCC-DDDD', undefined, '11111111-2222-4333-8444-555555555555'), status: 'in_review', next_step: 'being_reviewed' },
        { ...report('complete', 'AR-EEEE-FFFF', undefined, '22222222-2222-4333-8444-555555555555'), status: 'closed', next_step: 'closed_by_person' }], has_more: false });
      const { el, p } = await home();
      const [received, inReview, closed] = rows(el);
      expect([...el.querySelectorAll('.your-reports .report-status .ar-chip')].map(c => c.textContent!.trim()))
        .toEqual([p.t().statusReceived, p.t().inReview, p.t().chipClosed]);
      expect(received).toContain(p.t().nextStepReview);
      expect(inReview).toContain(p.t().statusInReview);
      expect(inReview).not.toContain(p.t().nextStepReview);
      expect(closed).toContain(p.t().statusClosed);
      expect(closed).not.toContain(p.t().nextStepReview);
      expect(el.querySelector('.your-reports')!.textContent).not.toMatch(/resuelt|resolvid|resolved/i);
    });

    it('reloads the reports after a receipt', async () => {
      const { fixture, p, el } = await home();
      expect(el.querySelector('.your-reports')).toBeNull();
      service.startIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'guided' } as never);
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      const before = service.reports.calls.count();
      service.reports.and.resolveTo({ items: [report('incomplete', 'AR-CCCC-DDDD')], has_more: false });
      service.handoffIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555',
        kind: 'incomplete', accepted_at: 'x', replayed: false, actions_taken: [], unresolved_questions: [], reference_short: 'AR-CCCC-DDDD',
        next_step_code: 'await_human_review', urgency: 'normal' });
      await p.handoff();
      fixture.detectChanges();
      expect(service.reports.calls.count()).toBe(before + 1);
      expect(rows(el)[0]).toContain('AR-CCCC-DDDD');
    });

    it('each report row has an update button labelled with its reference; each answer maps to its own text, focus stays', async () => {
      service.reports.and.resolveTo({ items: [report('complete', 'AR-AAAA-BBBB'),
        report('technical', null, '2026-10-01T08:00:00Z', '11111111-2222-4333-8444-555555555555')], has_more: false });
      const { fixture, el, p } = await home();
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('.your-reports li .update-btn')];
      expect(buttons.map(b => b.textContent?.trim())).toEqual([p.t().updateMe, p.t().updateMe]);
      expect(buttons.every(b => b.classList.contains('ar-btn-sm'))).withContext('the same compact size as the row Report button').toBeTrue();
      expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual([p.t().updateMe + ': AR-AAAA-BBBB', p.t().updateMe + ': 11111111-2222-4333-8444-555555555555']);
      let finish!: () => void;
      service.requestUpdate.and.returnValue(new Promise(done => { finish = () => done({ queued: true }); }));
      await fixture.whenStable();
      buttons[0].focus(); buttons[0].click(); fixture.detectChanges();
      expect(service.requestUpdate).toHaveBeenCalledWith('99999999-8888-4777-8666-555555555555');
      expect(buttons[0].disabled).toBeTrue();
      finish(); await fixture.whenStable(); fixture.detectChanges();
      expect(buttons[0].disabled).toBeFalse();
      expect(document.activeElement).toBe(buttons[0]);
      const status = (row = 0) => el.querySelectorAll('.your-reports [role="status"]')[row]?.textContent?.trim();
      expect(status()).toBe(p.t().updateSent);
      for (const [error, key] of [[429, 'updateRecent'], [409, 'updateNoEmail'], [503, null]] as const) {
        service.requestUpdate.and.rejectWith(new ApiError(error, 'x'));
        await p.requestUpdate('11111111-2222-4333-8444-555555555555'); fixture.detectChanges();
        expect(status(0)).toBe('', 'the answer belongs to the other row');
        expect(status(1)).toBe(key ? p.t()[key] : errorText(p.t(), new ApiError(error, 'x')));
      }
    });

    it('one update request at a time: every row waits, and a second click sends nothing', async () => {
      service.reports.and.resolveTo({ items: [report('complete', 'AR-AAAA-BBBB'),
        report('technical', null, '2026-10-01T08:00:00Z', '11111111-2222-4333-8444-555555555555')], has_more: false });
      const { fixture, el, p } = await home();
      let finish!: () => void;
      service.requestUpdate.and.returnValue(new Promise(done => { finish = () => done({ queued: true }); }));
      const first = p.requestUpdate('99999999-8888-4777-8666-555555555555'); fixture.detectChanges();
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('.your-reports li .update-btn')];
      expect(buttons.map(b => b.disabled)).toEqual([true, true]);
      await p.requestUpdate('11111111-2222-4333-8444-555555555555');
      expect(service.requestUpdate).toHaveBeenCalledTimes(1);
      finish(); await first; fixture.detectChanges();
      expect(buttons.map(b => b.disabled)).toEqual([false, false]);
    });

    it('says when more reports exist than are listed', async () => {
      service.reports.and.resolveTo({ items: [report('complete', 'AR-AAAA-BBBB')], has_more: true });
      const { el, p } = await home();
      expect(el.textContent).toContain(p.t().moreReports);
    });

    it('a failed reports load shows one muted line and keeps the charges', async () => {
      service.reports.and.rejectWith(new ApiError(503, 'x'));
      const { el, p } = await home();
      expect(p.step()).toBe('home');
      expect(el.textContent).toContain(p.t().reportsFailed);
      expect(el.querySelector('.your-reports')).toBeNull();
      expect(el.querySelectorAll('.td-state .ar-btn').length).toBe(1);
      expect(el.querySelector('.ar-alert')).toBeNull();
    });

    it('shows only the greeting, the charges and the report panel; no hero, stats, currency box or floating toggle', async () => {
      const { el } = await home();
      expect(el.querySelector('h1')).not.toBeNull();
      expect(el.querySelector('#cargos')).not.toBeNull();
      for (const gone of ['.ar-card', '.agent-panel', '.stats', '.chat-toggle', '.home-top', '.your-reports']) expect(el.querySelector(gone)).withContext(gone).toBeNull(); // the hero is .ar-card; there is no .hero class
      expect(el.querySelectorAll('.box').length).toBe(1);
      expect(el.querySelectorAll('.td-state .ar-btn').length).toBe(1);
    });

    it('captions the charges with what every data source supports: recent purchases in the demo data, newest first, no risk scores', async () => {
    const { el, p } = await home();
    expect(el.querySelector('#cargos .box-body > .ar-caption')?.textContent?.trim()).toBe(p.t().windowCaption);
  });

  it('says when more charges exist than are listed', async () => {
      service.transactions.and.resolveTo({ items: [tx], has_more: true, coverage: 'fictitious_demo_data_only', view_ref: null });
      const { el, p } = await home();
      expect(el.textContent).toContain(p.t().moreCharges);
    });

    it('points aria-controls at the chat only while it exists, and does not repeat the choose prompt as the legend', async () => {
      const { fixture, p, el } = await home();
      const button = el.querySelector<HTMLButtonElement>('.td-state .ar-btn')!;
      expect(button.hasAttribute('aria-controls')).toBeFalse();
      button.click();
      fixture.detectChanges();
      expect(button.getAttribute('aria-controls')).toBe('intake-chat');
      expect(el.querySelector('#intake-chat')).not.toBeNull();
      service.startIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      fixture.detectChanges();
      const panel = el.querySelector('#intake-chat')!;
      expect(panel.textContent!.split(p.t().chatChoose).length - 1).toBe(1);
    });

    it('exposes the charges as table rows and cells', async () => {
      const { el } = await home();
      const table = el.querySelector('[role="table"]')!;
      expect(table.querySelectorAll('[role="row"]').length).toBe(2);
      expect(table.querySelectorAll('[role="columnheader"]').length).toBe(4);
      expect(table.querySelectorAll('[role="cell"]').length).toBe(4);
      expect(table.querySelectorAll(':scope > :not([role="row"])').length).toBe(0);
    });

    it('opens the chat from a charge row, links the textarea to its error, and focuses the receipt', async () => {
      const { fixture, p, el } = await home();
      el.querySelector<HTMLButtonElement>('.td-state .ar-btn')!.click();
      fixture.detectChanges();
      expect(p.choice).toBe('demo-tx-001');
      p.chatStatement = 'short';
      await p.send();
      fixture.detectChanges();
      const area = el.querySelector<HTMLTextAreaElement>('#chat-statement')!;
      expect(area.required).toBeTrue();
      expect(area.getAttribute('aria-describedby')).toContain('chat-error');
      expect(el.querySelector('#chat-error')?.textContent).toContain(p.t().chatValidationShort);
      service.startIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      service.confirmIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555', kind: 'complete',
        accepted_at: 'x', replayed: false, actions_taken: ['owned_transaction_retrieved', 'customer_confirmation_recorded'], unresolved_questions: [], reference_short: 'AR-7K3M-2Q4X', next_step_code: 'await_human_review', urgency: 'normal' });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(document.activeElement).toBe(el.querySelector('#chat-choose'));
      p.choice = 'demo-tx-001';
      p.chatConfirmed = true;
      await p.confirmCharge();
      fixture.detectChanges();
      await fixture.whenStable();
      const receiptEl = el.querySelector('#intake-receipt')!;
      expect(receiptEl.textContent).toContain('99999999-8888-4777-8666-555555555555');
      expect(document.activeElement).toBe(receiptEl);
      // The sentence that says a person reviews the case and nothing was refunded comes right after the reference, before the checks.
      const order = [...receiptEl.children].map(c => c.className || c.tagName);
      expect(order.indexOf('next-step')).toBe(order.indexOf('ar-ref') + 1);
      expect(order.indexOf('next-step')).toBeLessThan(order.indexOf('checks'));
      expect(receiptEl.querySelector('.ar-ref-code')?.textContent?.trim()).toBe('AR-7K3M-2Q4X');
      expect(receiptEl.querySelector('.case-id')?.textContent).toContain('99999999-8888-4777-8666-555555555555'); // the UUID stays, smaller, as the case id
      const checks = [...receiptEl.querySelectorAll('.checks li')].map(li => li.textContent?.trim());
      expect(checks).toEqual([p.t().check_owned_transaction_retrieved, p.t().check_customer_confirmation_recorded]);
      expect(receiptEl.querySelector('.open-questions')).toBeNull();
    });

    it('lists the open questions on a receipt without a confirmed charge', async () => {
      const { fixture, p, el } = await home();
      p.openChat();
      service.startIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      service.handoffIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555', kind: 'incomplete',
        accepted_at: 'x', replayed: false, actions_taken: [], unresolved_questions: ['matching_transaction', 'customer_confirmation'], reference_short: 'AR-7K3M-2Q4X', next_step_code: 'await_human_review', urgency: 'normal' });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      p.cannotFind();
      fixture.detectChanges();
      // The details step: a labelled field, Send instead of a second "can't find" button, nothing sent yet.
      const field = el.querySelector<HTMLTextAreaElement>('#chat-details')!;
      expect(el.querySelector('label[for="chat-details"]')?.textContent).toContain(p.t().chatDetailsLabel);
      expect(field.getAttribute('maxlength')).toBe(String(2000 - 1 - 'No reconozco este cargo.'.length));
      expect(service.handoffIntake).not.toHaveBeenCalled();
      p.chatDetails = 'Unos 50 euros el martes, en una tienda de ropa.';
      await p.handoff();
      fixture.detectChanges();
      const receiptEl = el.querySelector('#intake-receipt')!;
      expect([...receiptEl.querySelectorAll('.open-questions li')].map(li => li.textContent?.trim()))
        .toEqual([p.t().check_matching_transaction, p.t().check_customer_confirmation]);
      expect(receiptEl.querySelector('.checks')?.textContent).toContain(p.t().none);
    });

    it('shows the call-your-bank line with the number as text only on a high-urgency receipt', async () => {
      const { fixture, p, el } = await home();
      p.openChat();
      const base: IntakeReceipt = { episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555', kind: 'complete',
        accepted_at: 'x', replayed: false, urgency: 'normal', actions_taken: [], unresolved_questions: [], reference_short: 'AR-7K3M-2Q4X', next_step_code: 'await_human_review' };
      p.intakeReceipt.set(base);
      fixture.detectChanges();
      expect(el.querySelector('#intake-receipt')).not.toBeNull();
      expect(el.querySelector('.urgent-line')).toBeNull();
      p.intakeReceipt.set({ ...base, urgency: 'high', block_card_line: '+52 55 0000 0000 (demo)' });
      fixture.detectChanges();
      const line = el.querySelector('.urgent-line')!;
      expect(line.textContent).toContain(p.t().blockCardCall);
      expect(line.textContent).toContain(p.t().blockCardNote);
      expect(line.querySelector('.ar-mono')?.textContent?.trim()).toBe('+52 55 0000 0000 (demo)');
      expect(line.querySelector('a')).toBeNull();
    });

    it('after a receipt, another row\'s Report starts a new report on that charge; a frozen request still disables the rows', async () => {
      const tx2: Transaction = { ...tx, transaction_id: 'demo-tx-002', merchant_name: 'Loja' };
      service.transactions.and.resolveTo({ items: [tx, tx2], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: null });
      const { fixture, p, el } = await home();
      p.openChat('demo-tx-001');
      p.intakeReceipt.set({ episode_id: 'E', protocol: 'P', kind: 'complete', accepted_at: 'x', replayed: false, urgency: 'normal',
        actions_taken: [], unresolved_questions: [], reference_short: 'AR-AAAA-BBBB', next_step_code: 'await_human_review' });
      fixture.detectChanges();
      const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('.td-state .ar-btn')];
      expect(buttons().map(b => b.disabled)).toEqual([false, false]);
      buttons()[1].click();
      fixture.detectChanges();
      expect(p.chatStep()).toBe('describe');
      expect(p.intakeReceipt()).toBeNull();
      expect(p.choice).toBe('demo-tx-002');
      expect(p.log()).toEqual([{ from: 'bot', key: 'chatHello' }]);
      p.frozen.set({ path: 'start', body: {} as never });
      fixture.detectChanges();
      expect(buttons().map(b => b.disabled)).toEqual([true, true]);
    });

    it('acknowledges a recorded view once, after the rows are on screen', async () => {
      const ref = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      service.transactions.and.resolveTo({ items: [tx], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: ref });
      const { fixture, el } = await home();
      await fixture.whenStable();
      expect(el.querySelectorAll('.td-state .ar-btn').length).toBe(1);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(service.displayed.calls.allArgs()).toEqual([[ref]]);
    });

    it('sends no acknowledgement when no view was recorded', async () => {
      const { fixture } = await home();
      await fixture.whenStable();
      expect(service.displayed).not.toHaveBeenCalled();
    });

    it('keeps the page as it is when the acknowledgement fails', async () => {
      service.transactions.and.resolveTo({ items: [tx], has_more: false, coverage: 'fictitious_demo_data_only', view_ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      service.displayed.and.rejectWith(new ApiError(503));
      const { fixture, p, el } = await home();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(service.displayed).toHaveBeenCalledTimes(1);
      expect(p.error()).toBe('');
      expect(el.querySelector('.ar-alert')).toBeNull();
      expect(el.querySelectorAll('.td-state .ar-btn').length).toBe(1);
    });

    it('gives every charge a compact Report button named after its merchant that opens the chat on it', async () => {
      const { fixture, p, el } = await home();
      const button = el.querySelector<HTMLButtonElement>('.td-state .ar-btn')!;
      expect(button.classList).toContain('ar-btn-sm');
      expect(button.textContent).toContain(p.t().reportCharge);
      expect(button.textContent).toContain('Mercado');
      button.click();
      fixture.detectChanges();
      expect(p.chatOpen()).toBeTrue();
      expect(p.choice).toBe('demo-tx-001');
    });
  });
});

