import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { IntakeReceipt } from '../../shared/models/intake.model';

describe('CustomerPage focus', () => {
  it('leaves focus alone on first render, then moves it to each new step heading', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions'], { client: signal(''), card: signal(null), receipts: signal([]) }); // untyped: only what this flow calls
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
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions'], { client: signal(''), card: signal(null), receipts: signal([]) });
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
    page.intakeReceipt.set({ kind: 'complete', protocol: 'P-1', replayed: false } as unknown as IntakeReceipt);
    await fixture.whenStable();
    const newReport = [...fixture.nativeElement.querySelectorAll('.chat .ar-btn-secondary')].find((b: Element) => b.textContent!.trim() === page.t().chatNew) as HTMLButtonElement;
    newReport.focus();
    newReport.click();
    await fixture.whenStable();
    expect(page.chatStep()).toBe('describe');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('#chat-title'));
    fixture.nativeElement.remove();
  });

  it('makes the page behind the open chat inert only at narrow widths, never the chat or its toggle', async () => {
    const service = jasmine.createSpyObj('CustomerService', ['identities', 'signIn', 'transactions'], { client: signal(''), card: signal(null), receipts: signal([]) });
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
    const inert = () => ['nav', 'main', '.chat-toggle', '#intake-chat'].map(sel => el.querySelector<HTMLElement>(sel)?.inert ?? null);
    page.narrow.set(true);
    await fixture.whenStable();
    expect(inert()).toEqual([false, false, false, null]);
    page.chatOpen.set(true);
    await fixture.whenStable();
    expect(inert()).toEqual([true, true, false, false]);
    page.narrow.set(false);
    await fixture.whenStable();
    expect(inert()).toEqual([false, false, false, false]);
  });
});
