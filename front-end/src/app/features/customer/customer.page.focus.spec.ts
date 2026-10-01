import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomerPage } from './customer.page';
import { CustomerService } from './customer.service';

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
});
