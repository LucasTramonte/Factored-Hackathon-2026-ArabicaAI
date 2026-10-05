import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { ApiError } from '../../core/http/api.service';

describe('Evaluator access request on the sign-in screen', () => {
  let service: jasmine.SpyObj<CustomerService>;
  beforeEach(() => {
    localStorage.setItem('arabica.customer-tour.v2', 'dismissed');
    service = jasmine.createSpyObj<CustomerService>('CustomerService', ['requestAccess', 'identities'], { client: signal(''), card: signal(null), roles: signal([]) });
    service.identities.and.resolveTo([]);
    service.requestAccess.and.resolveTo({ status: 'received' });
    TestBed.configureTestingModule({ imports: [CustomerPage], providers: [provideRouter([]), { provide: CustomerService, useValue: service }, { provide: CognitoService, useValue: { forget: () => undefined } }] });
  });
  afterEach(() => localStorage.removeItem('arabica.customer-tour.v2'));
  /** Render the sign-in step in the document so access-request tests can inspect its content and focus. */
  function login() {
    const fixture = TestBed.createComponent(CustomerPage); document.body.append(fixture.nativeElement); fixture.detectChanges();
    const page = fixture.componentInstance; page.step.set('login'); fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }

  it('offers the request in every language, opens it with the typed address focused, and says the data is fictitious', fakeAsync(() => {
    const { fixture, page, el } = login();
    for (const lang of ['es', 'pt', 'en'] as const) {
      page.lang.set(lang); fixture.detectChanges();
      expect(el.querySelector('#access-open')?.textContent?.trim()).toBe(page.t().accessAsk);
      expect(page.t().accessIntro).toMatch(/fict[ií]/i);
    }
    page.email = ' judge@factored.ai ';
    el.querySelector<HTMLButtonElement>('#access-open')!.click(); fixture.detectChanges(); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('#access-open')).toBeNull();
    expect(el.querySelector('#access-title')?.textContent?.trim()).toBe(page.t().accessAsk);
    expect(el.querySelector('#access-intro')?.textContent?.trim()).toBe(page.t().accessIntro);
    expect(page.accessEmail).toBe('judge@factored.ai');
    expect(document.activeElement?.id).toBe('access-email');
    fixture.destroy();
  }));

  it('sends the trimmed fields once, leaves out empty optional ones, and then shows only the confirmation', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.openAccessRequest(); fixture.detectChanges();
    let done!: (value: { status: 'received' }) => void;
    service.requestAccess.and.returnValue(new Promise(resolve => done = resolve));
    page.accessEmail = ' judge@factored.ai '; page.accessName = '  '; page.accessNote = ' Assigned to ArabicaAI ';
    void page.sendAccessRequest(); void page.sendAccessRequest();
    expect(service.requestAccess).toHaveBeenCalledOnceWith({ email: 'judge@factored.ai', note: 'Assigned to ArabicaAI' });
    done({ status: 'received' }); flushMicrotasks(); fixture.detectChanges();
    expect(el.querySelector('#access-sent')?.textContent?.trim()).toBe(page.t().accessSent);
    expect(el.querySelector('#access-email')).toBeNull();
    fixture.destroy();
  }));

  it('maps 422, 429 and any other failure to its own message, never server text, and keeps the form for a retry', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.openAccessRequest(); fixture.detectChanges(); page.accessEmail = 'judge@factored.ai';
    for (const [status, key] of [[422, 'accessInvalid'], [429, 'accessLimited'], [503, 'accessFailed'], [0, 'accessFailed']] as const) {
      service.requestAccess.and.rejectWith(new ApiError(status, 'server detail'));
      void page.sendAccessRequest(); flushMicrotasks(); fixture.detectChanges();
      expect(el.querySelector('#access-error')?.textContent?.trim()).toBe(page.t()[key]);
      expect(el.textContent).not.toContain('server detail');
      expect(el.querySelector('#access-email')?.getAttribute('aria-describedby')).toBe('access-intro access-error');
    }
    service.requestAccess.and.resolveTo({ status: 'received' });
    void page.sendAccessRequest(); flushMicrotasks(); fixture.detectChanges();
    expect(page.accessState()).toBe('sent');
    fixture.destroy();
  }));

  it('submits bound form inputs, disables actions while pending, and restores them after a network error', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.openAccessRequest(); fixture.detectChanges(); flushMicrotasks();
    for (const [id, value] of [['access-email', 'judge@example.com'], ['access-name', '  Judge One  '], ['access-note', '  Please enrol me  ']]) {
      const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    let reject!: (reason: unknown) => void;
    service.requestAccess.and.returnValue(new Promise((_resolve, fail) => reject = fail));
    const form = el.querySelector<HTMLFormElement>('#access-email')!.closest('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(service.requestAccess).toHaveBeenCalledOnceWith({ email: 'judge@example.com', name: 'Judge One', note: 'Please enrol me' });
    expect(page.busy()).toBeTrue();
    expect([...form.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBeTrue();
    reject(new Error('private network detail'));
    flushMicrotasks(); fixture.detectChanges();
    expect(page.busy()).toBeFalse();
    expect([...form.querySelectorAll<HTMLButtonElement>('button')].every(button => !button.disabled)).toBeTrue();
    expect(el.querySelector('#access-error')?.textContent?.trim()).toBe(page.t().accessFailed);
    expect(el.textContent).not.toContain('private network detail');
    expect(page.accessName).toBe('  Judge One  ');
    expect(page.accessNote).toBe('  Please enrol me  ');
    fixture.destroy();
  }));

  it('closing and reopening keeps the request draft and clears the prior error', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.email = 'signin@example.com';
    page.openAccessRequest(); fixture.detectChanges();
    page.accessEmail = 'request@example.com'; page.accessName = 'Judge'; page.accessNote = 'Assigned panel';
    service.requestAccess.and.rejectWith(new ApiError(422, 'invalid'));
    void page.sendAccessRequest(); flushMicrotasks(); fixture.detectChanges();
    expect(page.accessState()).toBe('invalid');
    el.querySelector<HTMLButtonElement>('#access-email')!.closest('form')!.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('#access-email')).toBeNull();
    expect(page.accessOpen()).toBeFalse();
    page.email = 'different-signin@example.com';
    el.querySelector<HTMLButtonElement>('#access-open')!.click(); fixture.detectChanges(); flushMicrotasks();
    expect(page.accessEmail).toBe('request@example.com');
    expect(page.accessName).toBe('Judge');
    expect(page.accessNote).toBe('Assigned panel');
    expect(page.accessState()).toBe('idle');
    expect(el.querySelector('#access-error')).toBeNull();
    expect(el.querySelector('#access-email')?.getAttribute('aria-describedby')).toBe('access-intro');
    expect(document.activeElement?.id).toBe('access-email');
    fixture.destroy();
  }));

  it('omits both blank optional fields and releases busy after a successful send', fakeAsync(() => {
    const { fixture, page } = login();
    page.accessEmail = ' judge@example.com '; page.accessName = '  '; page.accessNote = '  ';
    void page.sendAccessRequest(); flushMicrotasks();
    expect(service.requestAccess).toHaveBeenCalledOnceWith({ email: 'judge@example.com' });
    expect(page.accessState()).toBe('sent');
    expect(page.busy()).toBeFalse();
    fixture.destroy();
  }));

  it('does not submit an access request while sign-in is busy', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.busy.set(true); fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('#access-open')!.disabled).toBeTrue();
    void page.sendAccessRequest(); flushMicrotasks();
    expect(service.requestAccess).not.toHaveBeenCalled();
    expect(page.busy()).toBeTrue();
    expect(page.accessState()).toBe('idle');
    fixture.destroy();
  }));

  it('declares native email validation and the API field limits', fakeAsync(() => {
    const { fixture, page, el } = login();
    page.openAccessRequest(); fixture.detectChanges(); flushMicrotasks();
    const email = el.querySelector<HTMLInputElement>('#access-email')!;
    const form = email.closest('form')!;
    expect(form.noValidate).toBeFalse();
    expect(email.required).toBeTrue();
    expect(email.type).toBe('email');
    expect(email.maxLength).toBe(254);
    expect(el.querySelector<HTMLInputElement>('#access-name')!.maxLength).toBe(100);
    expect(el.querySelector<HTMLTextAreaElement>('#access-note')!.maxLength).toBe(500);
    email.value = ''; expect(email.checkValidity()).toBeFalse();
    email.value = 'invalid'; expect(email.checkValidity()).toBeFalse();
    email.value = 'judge@example.com'; expect(form.checkValidity()).toBeTrue();
    fixture.destroy();
  }));

});
