import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { CustomerPage, initialsOf } from './customer.page';
import { LangService } from '../../shared/i18n/lang.service';
import { CustomerService } from './customer.service';
import { IntakeReceipt, IntakeStart, Transaction } from '../../shared/models/intake.model';

describe('CustomerPage', () => {
  let service: jasmine.SpyObj<CustomerService>;
  let page: CustomerPage;
  const tx: Transaction = { transaction_id: 'demo-tx-001', merchant_name: 'Mercado', occurred_at: null,
    source_occurred_at: '2026-02-26T13:21:51', amount: '125.50', currency: 'BRL' };

  beforeEach(async () => {
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['identities', 'signIn', 'transactions',
      'startIntake', 'confirmIntake', 'handoffIntake'], { client: signal(''), card: signal(null), receipts: signal([]) });
    service.identities.and.resolveTo([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' },
      { customer_id: 'demo-bruno', display_name: 'Bruno (demo)' }]);
    service.signIn.and.resolveTo({ customer_id: 'demo-ana', mode: 'simulated_login', context_card: null });
    service.transactions.and.resolveTo({ items: [tx], has_more: false, coverage: 'fictitious_demo_data_only' });
    await TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] })
      .compileComponents();
    page = TestBed.createComponent(CustomerPage).componentInstance;
  });

  it('opens on sign-in with the purpose and the three explanation lines, then goes home once charges are loaded', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    const p = fixture.componentInstance;
    await p.ngOnInit();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(p.step()).toBe('login');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe(p.t().greeting);
    expect(el.querySelector('.purpose')?.textContent?.trim()).toBe(p.t().tagline);
    expect([...el.querySelectorAll('.explain li')].map(li => li.textContent?.trim()))
      .toEqual([p.t().explain1, p.t().explain2, p.t().explain3]);
    expect(el.querySelector('.intro')).toBeNull();
    p.identity = 'demo-ana';
    await p.login();
    expect(p.step()).toBe('home');
  });

  it('signs in and lists only what the API returns', async () => {
    page.identity = 'demo-ana';
    await page.login();
    expect(service.signIn).toHaveBeenCalledWith('demo-ana');
    expect(page.transactions()).toEqual([tx]);
  });

  it('stays on sign-in and shows the mapped error when sign-in fails', async () => {
    service.signIn.and.rejectWith(new ApiError(503, 'unavailable'));
    page.identity = 'demo-ana';
    await page.login();
    expect(page.step()).toBe('login');
    expect(page.error()).toBe(TestBed.inject(LangService).t().err503);
  });

  it('loads the identity choices from the API instead of a hard-coded list', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.ar-row-name')].map(o => o.textContent?.trim());
    expect(rows).toEqual(['Ana (demo)', 'Bruno (demo)']);
    expect(fixture.componentInstance.identity).toBe('demo-ana');
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
      unresolved_questions: [], next_step_code: 'await_human_review' };
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

    it('starts with exactly the guided fields and shows no reference before the receipt', async () => {
      await startEpisode();
      const body = service.startIntake.calls.mostRecent().args[0];
      expect(Object.keys(body).sort()).toEqual(['customer_statement', 'idempotency_key', 'language', 'mode', 'report_type']);
      expect(body).toEqual(jasmine.objectContaining({ customer_statement: 'No reconozco este cargo.', language: 'es', mode: 'guided', report_type: 'unrecognized_charge' }));
      expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(page.chatStep()).toBe('choose');
      expect(page.intakeReceipt()).toBeNull();
    });

    it('maps pt to pt, and in English asks for the report language with no default', async () => {
      lang.set('pt');
      expect(page.reportLang()).toBe('pt');
      lang.set('en');
      expect(page.reportLang()).toBeNull();
      page.chatStatement = 'I do not recognize this charge.';
      await page.send();
      expect(service.startIntake).not.toHaveBeenCalled();
      expect(page.chatError()).toBe(lang.t().chatValidation);
      page.chosenLang.set('pt');
      service.startIntake.and.resolveTo({ ...started, language: 'pt' });
      await page.send();
      expect(service.startIntake.calls.mostRecent().args[0].language).toBe('pt');
    });

    it('refuses a statement under 10 code points; the error names the language only when it is asked', async () => {
      page.chatStatement = '😀😀😀😀😀';
      await page.send();
      expect(service.startIntake).not.toHaveBeenCalled();
      expect(page.chatError()).toBe(lang.t().chatValidationShort);
      lang.set('pt');
      await page.send();
      expect(page.chatError()).toBe(lang.t().chatValidationShort);
      lang.set('en');
      await page.send();
      expect(page.chatError()).toBe(lang.t().chatValidation);
      page.chosenLang.set('pt');
      await page.send();
      expect(page.chatError()).toBe(lang.t().chatValidation);
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

    it('asks for human review without a charge, sending kind incomplete', async () => {
      await startEpisode();
      service.handoffIntake.and.resolveTo({ ...intakeReceipt, kind: 'incomplete' });
      await page.cannotFind();
      expect(service.handoffIntake.calls.mostRecent().args[0]).toEqual({ episode_id: started.episode_id, idempotency_key: jasmine.any(String), kind: 'incomplete' });
      expect(page.receiptTitle()).toBe(lang.t().receiptIncomplete);
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

    it('a 409 on finish ends the episode and offers a customer-initiated new report', async () => {
      await startEpisode();
      service.handoffIntake.and.rejectWith(new ApiError(409, 'x'));
      await page.cannotFind();
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
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await Promise.all([page.confirmCharge(), page.confirmCharge()]);
      await page.confirmCharge();
      await page.cannotFind();
      expect(service.confirmIntake).toHaveBeenCalledTimes(1);
      expect(service.handoffIntake).not.toHaveBeenCalled();
      expect(page.reportedState('demo-tx-001')).toBe('accepted');
    });

    it('a charge row opens the chat with that charge preselected but unconfirmed', async () => {
      page.chatOpen.set(false);
      page.openChat('demo-tx-001');
      expect(page.chatOpen()).toBeTrue();
      expect(page.choice).toBe('demo-tx-001');
      expect(page.chatConfirmed).toBeFalse();
    });

    it('keeps every receipt of the session after a new report; an accepted charge is not offered again', async () => {
      await startEpisode();
      service.confirmIntake.and.resolveTo(intakeReceipt);
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      page.newReport();
      expect(page.receipts().length).toBe(1);
      expect(page.reportedState('demo-tx-001')).toBe('accepted');
      expect(page.choosable()).toEqual([]);
      await startEpisode();
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(service.confirmIntake).toHaveBeenCalledTimes(1);
      service.handoffIntake.and.resolveTo({ ...intakeReceipt, protocol: '77777777-8888-4777-8666-555555555555', kind: 'incomplete' });
      await page.cannotFind();
      expect(page.receipts().map(r => [r.receipt.kind, r.transactionId])).toEqual([['complete', 'demo-tx-001'], ['incomplete', null]]);
    });

    it('marks a pending confirmation as not confirmed, never as accepted', async () => {
      await startEpisode();
      service.confirmIntake.and.rejectWith(new ApiError(503, 'x'));
      page.choice = 'demo-tx-001';
      page.chatConfirmed = true;
      await page.confirmCharge();
      expect(page.reportedState('demo-tx-001')).toBe('chipPending');
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
      TestBed.inject(LangService).set('es'); // other specs may leave English selected, which asks for the report language
      service.signIn.and.resolveTo({ customer_id: 'demo-ana', mode: 'simulated_login', context_card: card as never });
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

    it('while a request is pending the agent link is disabled, and receipts and the home survive in-app navigation', async () => {
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
      service.receipts.set([{ receipt: { episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555',
        kind: 'incomplete', accepted_at: 'x', replayed: false, actions_taken: [], unresolved_questions: ['matching_transaction', 'customer_confirmation'],
        next_step_code: 'await_human_review' }, transactionId: null }]);
      fixture.destroy();
      const again = TestBed.createComponent(CustomerPage);
      await again.componentInstance.ngOnInit();
      await again.whenStable();
      again.detectChanges();
      const html = again.nativeElement as HTMLElement;
      expect(again.componentInstance.step()).toBe('home');
      expect(html.textContent).toContain('99999999-8888-4777-8666-555555555555');
      expect(html.querySelector('.ar-count')?.textContent).toBe('1');
      const reports = [...html.querySelectorAll('.your-reports li')].map(li => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(reports.length).toBe(1);
      expect(reports[0]).toContain(p.t().receiptIncomplete);
      expect(reports[0]).toContain('99999999-8888-4777-8666-555555555555');
    });

    it('shows only the greeting, the charges and the report panel; no hero, stats, currency box or floating toggle', async () => {
      const { el } = await home();
      expect(el.querySelector('h1')).not.toBeNull();
      expect(el.querySelector('#cargos')).not.toBeNull();
      for (const gone of ['.ar-card', '.agent-panel', '.stats', '.chat-toggle', '.home-top', '.your-reports']) expect(el.querySelector(gone)).withContext(gone).toBeNull(); // the hero is .ar-card; there is no .hero class
      expect(el.querySelectorAll('.box').length).toBe(1);
      expect(el.querySelectorAll('.report-btn').length).toBe(1);
    });

    it('says when more charges exist than are listed', async () => {
      service.transactions.and.resolveTo({ items: [tx], has_more: true, coverage: 'fictitious_demo_data_only' });
      const { el, p } = await home();
      expect(el.textContent).toContain(p.t().moreCharges);
    });

    it('points aria-controls at the chat only while it exists, and does not repeat the choose prompt as the legend', async () => {
      const { fixture, p, el } = await home();
      const button = el.querySelector<HTMLButtonElement>('.report-btn')!;
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
      el.querySelector<HTMLButtonElement>('.report-btn')!.click();
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
        accepted_at: 'x', replayed: false, actions_taken: ['owned_transaction_retrieved', 'customer_confirmation_recorded'], unresolved_questions: [], next_step_code: 'await_human_review' });
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
      const checks = [...receiptEl.querySelectorAll('.checks li')].map(li => li.textContent?.trim());
      expect(checks).toEqual([p.t().check_owned_transaction_retrieved, p.t().check_customer_confirmation_recorded]);
      expect(receiptEl.querySelector('.open-questions')).toBeNull();
    });

    it('lists the open questions on a receipt without a confirmed charge', async () => {
      const { fixture, p, el } = await home();
      p.openChat();
      service.startIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'selection_required', language: 'es', mode: 'guided', replayed: false });
      service.handoffIntake.and.resolveTo({ episode_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', protocol: '99999999-8888-4777-8666-555555555555', kind: 'incomplete',
        accepted_at: 'x', replayed: false, actions_taken: [], unresolved_questions: ['matching_transaction', 'customer_confirmation'], next_step_code: 'await_human_review' });
      p.chatStatement = 'No reconozco este cargo.';
      await p.send();
      await p.cannotFind();
      fixture.detectChanges();
      const receiptEl = el.querySelector('#intake-receipt')!;
      expect([...receiptEl.querySelectorAll('.open-questions li')].map(li => li.textContent?.trim()))
        .toEqual([p.t().check_matching_transaction, p.t().check_customer_confirmation]);
      expect(receiptEl.querySelector('.checks')?.textContent).toContain(p.t().none);
    });

    it('gives every charge a Report button named after its merchant that opens the chat on it', async () => {
      const { fixture, p, el } = await home();
      const button = el.querySelector<HTMLButtonElement>('.report-btn')!;
      expect(button.textContent).toContain(p.t().reportCharge);
      expect(button.textContent).toContain('Mercado');
      button.click();
      fixture.detectChanges();
      expect(p.chatOpen()).toBeTrue();
      expect(p.choice).toBe('demo-tx-001');
    });
  });
});

