import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';
import { Transaction, TransactionDiscovery } from '../../shared/models/intake.model';

const tx: Transaction = { transaction_id: 'synthetic-charge', merchant_name: 'Streaming', amount: '90000.00', currency: 'ARS',
  occurred_at: '2026-04-15T12:00:00Z', source_occurred_at: null };
const result: TransactionDiscovery = {
  criteria: { merchant_hint: 'Streaming', date_from: '2026-04-01', date_to: '2026-04-30', currency: 'ARS', amount_operator: 'gt', amount: 85000 },
  missing_fields: [], confidence: 0.9, status: 'candidates', items: [tx]
};

describe('Customer transaction discovery', () => {
  let service: jasmine.SpyObj<CustomerService>;
  let fixture: ComponentFixture<CustomerPage>;
  let page: CustomerPage;

  beforeEach(() => {
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['discoverTransactions', 'confirmIntake', 'handoffIntake'],
      { client: signal('demo-ana'), card: signal(null), roles: signal([]) });
    service.discoverTransactions.and.resolveTo(result);
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]),
      { provide: CustomerService, useValue: service }, { provide: CognitoService, useValue: { forget: () => undefined } }] });
    fixture = TestBed.createComponent(CustomerPage); page = fixture.componentInstance;
    // These unit tests set the report state directly; session restoration and polling have their own specs.
    spyOn(page, 'ngOnInit').and.stub();
    page.lang.set('en'); page.step.set('home'); page.chatOpen.set(true);
    page.episode.set({ episode_id: 'synthetic-episode', state: 'selection_required', language: 'en', mode: 'guided', replayed: false });
    page.asking.set(true); page.chatDetails = 'Streaming in April for more than 85000 ARS';
  });

  afterEach(() => fixture.destroy());

  for (const language of ['es', 'pt', 'en'] as const) {
    it(`sends trimmed details in the selected ${language} report language without submitting a report`, async () => {
      page.chosenLang.set(language); page.chatDetails = '  Streaming in April  ';
      await page.discover();
      expect(service.discoverTransactions).toHaveBeenCalledOnceWith('Streaming in April', language, 'synthetic-episode', jasmine.stringMatching(/^[0-9a-f-]{36}$/));
      expect(page.discovery()).toEqual(result); expect(page.discoveryBusy()).toBeFalse(); expect(page.discoveryError()).toBeNull();
      expect(page.chatDetails).toBe('  Streaming in April  ');
      expect(service.confirmIntake).not.toHaveBeenCalled(); expect(service.handoffIntake).not.toHaveBeenCalled();
    });
  }

  it('counts Unicode code points at the ten-character minimum', async () => {
    for (const description of ['', ' \t ', '123456789', '😀'.repeat(9)]) {
      page.chatDetails = description; await page.discover();
    }
    expect(service.discoverTransactions).not.toHaveBeenCalled();
    page.chatDetails = '😀'.repeat(10); await page.discover();
    expect(service.discoverTransactions).toHaveBeenCalledOnceWith('😀'.repeat(10), 'en', 'synthetic-episode', jasmine.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it('clears old results and errors while pending, suppresses duplicate clicks and replaces a correction', async () => {
    let finish!: (value: TransactionDiscovery) => void;
    service.discoverTransactions.and.returnValue(new Promise(resolve => finish = resolve));
    page.discovery.set(result); page.discoveryError.set('unavailable');
    const pending = page.discover();
    expect(page.discoveryBusy()).toBeTrue(); expect(page.discovery()).toBeNull(); expect(page.discoveryError()).toBeNull();
    await page.discover(); expect(service.discoverTransactions).toHaveBeenCalledTimes(1);
    const corrected: TransactionDiscovery = { ...result, status: 'none', items: [] };
    finish(corrected); await pending;
    expect(page.discovery()).toEqual(corrected); expect(page.discoveryBusy()).toBeFalse();
  });

  it('preserves manual details after failure and allows a deliberate retry', async () => {
    service.discoverTransactions.and.rejectWith(new Error('private provider details'));
    page.discovery.set(result); const description = page.chatDetails;
    await page.discover();
    expect(page.discovery()).toBeNull(); expect(page.discoveryError()).toBe('unavailable'); expect(page.discoveryBusy()).toBeFalse();
    expect(page.chatDetails).toBe(description);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(page.t().discoveryUnavailable);
    expect(fixture.nativeElement.textContent).not.toContain('private provider details');
    service.discoverTransactions.and.resolveTo(result); await page.discover();
    expect(page.discoveryError()).toBeNull(); expect(page.discovery()).toEqual(result);
    expect(service.discoverTransactions).toHaveBeenCalledTimes(2);
  });

  it('ignores candidate ids absent from the current result, including replaced results', async () => {
    page.choice = 'previous-choice'; page.chatConfirmed = true;
    const log = page.log();
    page.useDiscovery(tx.transaction_id);
    page.discovery.set({ ...result, items: [{ ...tx, transaction_id: 'replacement' }] });
    page.useDiscovery(tx.transaction_id); page.useDiscovery('foreign-id');
    expect(page.choice).toBe('previous-choice'); expect(page.chatConfirmed).toBeTrue();
    expect(page.asking()).toBeTrue(); expect(page.log()).toEqual(log);
    expect(service.confirmIntake).not.toHaveBeenCalled();
  });

  it('selects only a returned candidate and resets explicit confirmation without sending', async () => {
    page.transactions.set([tx]); page.discovery.set(result); page.chatConfirmed = true;
    const previousLog = page.log(); page.useDiscovery(tx.transaction_id);
    expect(page.choice).toBe(tx.transaction_id); expect(page.chatConfirmed).toBeFalse();
    expect(page.asking()).toBeFalse(); expect(page.chatStep()).toBe('choose');
    expect(page.log()).toEqual([...previousLog, { from: 'bot', key: 'chatChoose' }]);
    expect(service.confirmIntake).not.toHaveBeenCalled(); expect(service.handoffIntake).not.toHaveBeenCalled();
    await page.confirmCharge();
    expect(service.confirmIntake).not.toHaveBeenCalled(); expect(page.chatError()).toBe(page.t().chatChooseValidation);
  });

  for (const status of ['none', 'ambiguous', 'candidates'] as const) {
    it(`renders the localized ${status} response and only returned candidate buttons`, () => {
      const items = status === 'none' ? [] : [tx, { ...tx, transaction_id: 'second', merchant_name: '<img src=x onerror=alert(1)>' }];
      page.discovery.set({ ...result, status, items }); fixture.detectChanges();
      const panel = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.suggestions')!;
      expect(panel).not.toBeNull(); expect(panel.getAttribute('aria-live')).toBe('polite');
      expect(panel.textContent).toContain(status === 'none' ? page.t().suggestNoMatch : status === 'ambiguous' ? page.t().chatChoose : page.t().suggestIntro);
      expect(panel.querySelectorAll('button').length).toBe(items.length); expect(panel.querySelector('img')).toBeNull();
      if (items.length) {
        expect(panel.textContent).toContain(items[1].merchant_name);
        panel.querySelector<HTMLButtonElement>('button')!.click();
        expect(page.choice).toBe(tx.transaction_id); expect(page.chatConfirmed).toBeFalse();
      }
    });
  }

  it('disables discovery for empty details, another discovery, or a busy report', () => {
    fixture.detectChanges();
    const button = () => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.chat-actions .ar-btn-secondary')!;
    expect(button().disabled).toBeFalse();
    page.chatDetails = ' '; fixture.detectChanges(); expect(button().disabled).toBeTrue();
    page.chatDetails = 'Streaming in April'; page.discoveryBusy.set(true); fixture.detectChanges(); expect(button().disabled).toBeTrue();
    expect(button().textContent).toContain(page.t().working);
    page.discoveryBusy.set(false); page.busy.set(true); fixture.detectChanges(); expect(button().disabled).toBeTrue();
  });

  it('requires an active episode and discards results after its replacement or removal', async () => {
    const episode = page.episode()!;
    page.episode.set(null); await page.discover(); expect(service.discoverTransactions).not.toHaveBeenCalled();
    for (const replacement of [null, { ...episode, episode_id: 'new-episode' }]) {
      page.episode.set(episode);
      let finish!: (value: TransactionDiscovery) => void;
      service.discoverTransactions.and.returnValue(new Promise(resolve => finish = resolve));
      const pending = page.discover(); page.episode.set(replacement); finish(result); await pending;
      expect(page.discovery()).toBeNull(); expect(page.discoveryBusy()).toBeFalse();
    }
  });

  it('gives each deliberate correction a fresh request id', async () => {
    await page.discover(); page.chatDetails = 'Streaming in May instead'; await page.discover();
    const [first, second] = service.discoverTransactions.calls.allArgs();
    expect(first[2]).toBe('synthetic-episode'); expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[3]); expect(second[0]).toBe('Streaming in May instead');
  });

  it('renders a request to narrow the description for 422 and clears it on a new attempt', async () => {
    service.discoverTransactions.and.rejectWith(new ApiError(422)); await page.discover(); fixture.detectChanges();
    expect(page.discoveryError()).toBe('narrow'); expect(fixture.nativeElement.textContent).toContain(page.t().discoveryNarrow);
    service.discoverTransactions.and.resolveTo(result); await page.discover(); expect(page.discoveryError()).toBeNull();
  });

  it('keeps discovery ephemeral across a fresh component instance', async () => {
    const writeLocal = spyOn(localStorage, 'setItem'); const writeSession = spyOn(sessionStorage, 'setItem');
    await page.discover();
    expect(writeLocal).not.toHaveBeenCalled(); expect(writeSession).not.toHaveBeenCalled();
    const fresh = TestBed.createComponent(CustomerPage);
    expect(fresh.componentInstance.discovery()).toBeNull(); expect(fresh.componentInstance.discoveryBusy()).toBeFalse();
    fresh.destroy();
  });
});
