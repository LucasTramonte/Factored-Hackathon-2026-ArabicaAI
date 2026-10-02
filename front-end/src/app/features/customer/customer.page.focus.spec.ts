import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { IntakeReceipt } from '../../shared/models/intake.model';

describe('CustomerPage focus', () => {
  it('leaves focus alone on first render, then moves it to each new step heading', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions', 'reports'], { client: signal(''), card: signal(null) }); // untyped: only what this flow calls
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.identities.and.resolveTo([{ customer_id: 'demo-ana', display_name: 'Ana (demo)' }]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(document.body);
    const heading = () => fixture.nativeElement.querySelector('.step h1') as HTMLElement;

    fixture.componentInstance.start();
    await fixture.whenStable();
    expect(document.activeElement).toBe(heading());
    expect(heading().classList).toContain('headline');

    fixture.componentInstance.identity = 'demo-ana';
    await fixture.componentInstance.login();
    await fixture.whenStable();
    expect(document.activeElement).toBe(heading());
    expect(heading().classList).toContain('ar-h1');
    fixture.nativeElement.remove();
  });

  it('moves focus to the chat heading when a new report replaces the receipt', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions', 'reports'], { client: signal(''), card: signal(null) });
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.identities.and.resolveTo([]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.autoDetectChanges();
    const page = fixture.componentInstance;
    page.identity = 'demo-ana';
    await page.login();
    page.chatOpen.set(true);
    page.intakeReceipt.set({ kind: 'complete', protocol: 'P-1', replayed: false, actions_taken: [], unresolved_questions: [] } as unknown as IntakeReceipt);
    await fixture.whenStable();
    const newReport = [...fixture.nativeElement.querySelectorAll('.chat .ar-btn-secondary')].find((b: Element) => b.textContent!.trim() === page.t().chatNew) as HTMLButtonElement;
    newReport.focus();
    newReport.click();
    await fixture.whenStable();
    expect(page.chatStep()).toBe('describe');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('#chat-title'));
    fixture.nativeElement.remove();
  });

  it('makes the page behind the open chat inert only at narrow widths, never the chat itself', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions', 'reports'], { client: signal(''), card: signal(null) });
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.identities.and.resolveTo([]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    fixture.autoDetectChanges();
    const page = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    page.identity = 'demo-ana';
    await page.login();
    const inert = () => ['nav', 'main', '#intake-chat'].map(sel => el.querySelector<HTMLElement>(sel)?.inert ?? null);
    page.narrow.set(true);
    await fixture.whenStable();
    expect(inert()).toEqual([false, false, null]);
    page.chatOpen.set(true);
    await fixture.whenStable();
    expect(inert()).toEqual([true, true, false]);
    page.narrow.set(false);
    await fixture.whenStable();
    expect(inert()).toEqual([false, false, false]);
  });

  async function home() {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions', 'reports'], { client: signal(''), card: signal(null) });
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.identities.and.resolveTo([]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo({ items: [], has_more: false, coverage: 'fictitious_demo_data_only' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.autoDetectChanges();
    const page = fixture.componentInstance;
    page.identity = 'demo-ana';
    await page.login();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }

  it('acts as a modal dialog only at narrow widths, and Escape closes it back to the page heading when nothing opened it', async () => {
    const { fixture, page, el } = await home();
    page.chatOpen.set(true);
    page.narrow.set(false);
    await fixture.whenStable();
    const chat = () => el.querySelector<HTMLElement>('#intake-chat');
    expect(chat()!.getAttribute('role')).toBeNull();
    expect(chat()!.getAttribute('aria-modal')).toBeNull();
    page.narrow.set(true);
    await fixture.whenStable();
    expect(chat()!.getAttribute('role')).toBe('dialog');
    expect(chat()!.getAttribute('aria-modal')).toBe('true');
    chat()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(page.chatOpen()).toBeFalse();
    expect(document.activeElement).toBe(el.querySelector('.step h1'));
    fixture.nativeElement.remove();
  });

  it('describes the focused choose step with the guide\'s prompt, so the step change is announced', async () => {
    const { fixture, page, el } = await home();
    page.chatOpen.set(true);
    page.episode.set({ episode_id: 'E-1', state: 'selection_required', language: 'es', mode: 'guided', replayed: false } as never);
    page.log.update(l => [...l, { from: 'me', text: 'x' }, { from: 'bot', key: 'chatChoose' }]);
    await fixture.whenStable();
    const step = el.querySelector<HTMLElement>('#chat-choose')!;
    const describedBy = step.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(el.querySelector('#' + describedBy)!.textContent).toContain(page.t().chatChoose);
    fixture.nativeElement.remove();
  });

  it('moves focus to the details field when "can\'t find it" replaces the choose step, described by the guide\'s question', async () => {
    const { fixture, page, el } = await home();
    page.chatOpen.set(true);
    page.episode.set({ episode_id: 'E-1', state: 'selection_required', language: 'es', mode: 'guided', replayed: false } as never);
    page.chatStatement = 'No reconozco este cargo.';
    await fixture.whenStable();
    const cannotFind = [...el.querySelectorAll('.chat .ar-btn-secondary')].find((b: Element) => b.textContent!.trim() === page.t().chatCannotFind) as HTMLButtonElement;
    cannotFind.focus();
    cannotFind.click();
    await fixture.whenStable();
    const field = el.querySelector<HTMLTextAreaElement>('#chat-details')!;
    expect(document.activeElement).toBe(field);
    expect(el.querySelector('#' + field.getAttribute('aria-describedby'))!.textContent).toContain(page.t().chatDetailsPrompt);
    fixture.nativeElement.remove();
  });

  it('focuses the chat heading when the panel is reopened on the choose step', async () => {
    const { fixture, page, el } = await home();
    page.chatOpen.set(true);
    page.episode.set({ episode_id: 'E-1', state: 'selection_required', language: 'es', mode: 'guided', replayed: false } as never);
    await fixture.whenStable();
    page.chatOpen.set(false);
    await fixture.whenStable();
    page.chatOpen.set(true);
    await fixture.whenStable();
    expect(document.activeElement).toBe(el.querySelector('#chat-title'));
    fixture.nativeElement.remove();
  });

  it('gives the panel its own close button at every width, so touch and screen-reader users can leave it', async () => {
    const { fixture, page, el } = await home();
    page.narrow.set(true);
    page.chatOpen.set(true);
    await fixture.whenStable();
    const close = el.querySelector<HTMLButtonElement>('#intake-chat .chat-close');
    expect(close).withContext('a close control inside the dialog').not.toBeNull();
    expect(close!.textContent!.trim()).toBe(page.t().chatClose);
    close!.click();
    await fixture.whenStable();
    expect(page.chatOpen()).toBeFalse();
    expect(document.activeElement).toBe(el.querySelector('.step h1'));
    page.narrow.set(false);
    page.chatOpen.set(true);
    await fixture.whenStable();
    expect(el.querySelector('#intake-chat .chat-close')).withContext('wide: the panel still carries its own close').not.toBeNull();
    fixture.nativeElement.remove();
  });

  it('returns focus to the charge row button that opened the panel', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions', 'reports'], { client: signal(''), card: signal(null) });
    service.reports.and.resolveTo({ items: [], has_more: false });
    service.identities.and.resolveTo([]);
    service.signIn.and.resolveTo();
    service.transactions.and.resolveTo({ items: [{ transaction_id: 'demo-tx-001', merchant_name: 'Mercado', occurred_at: null, source_occurred_at: '2026-02-26T13:21:51', amount: '125.50', currency: 'BRL' }], has_more: false, coverage: 'fictitious_demo_data_only' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.autoDetectChanges();
    const page = fixture.componentInstance;
    page.identity = 'demo-ana';
    await page.login();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector<HTMLButtonElement>('.report-btn')!;
    button.focus();
    button.click();
    await fixture.whenStable();
    expect(page.chatOpen()).toBeTrue();
    page.closeChat();
    await fixture.whenStable();
    expect(document.activeElement).toBe(button);
    fixture.nativeElement.remove();
  });

  it('focuses the code field when it appears and the email field on "use another email"', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'transactions', 'reports'], { client: signal(''), card: signal(null) });
    service.reports.and.resolveTo({ items: [], has_more: false });
    const cognito = jasmine.createSpyObj<CognitoService>('CognitoService', ['requestCode', 'submitCode', 'forget']);
    cognito.requestCode.and.resolveTo();
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [{ provide: CustomerService, useValue: service },
      { provide: CognitoService, useValue: cognito }, provideRouter([])] });
    const fixture = TestBed.createComponent(CustomerPage);
    document.body.appendChild(fixture.nativeElement);
    const page = fixture.componentInstance;
    Object.defineProperty(page, 'demoPicker', { value: false });
    fixture.autoDetectChanges();
    page.start();
    await fixture.whenStable();
    page.email = 'ana@example.com';
    await page.requestCode();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('login-code');
    page.anotherEmail();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('login-email');
    expect(cognito.forget).toHaveBeenCalled();
    fixture.nativeElement.remove();
  });
});
