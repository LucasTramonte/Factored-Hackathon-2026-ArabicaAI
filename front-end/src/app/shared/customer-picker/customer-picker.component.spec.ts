import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CustomerPicker } from './customer-picker.component';
import { Identity } from '../models/intake.model';

describe('CustomerPicker', () => {
  let fixture: ComponentFixture<CustomerPicker>;
  let picker: CustomerPicker;
  const base: Identity[] = [
    { customer_id: 'demo-ana', display_name: 'Ana (demo)', country: null },
    { customer_id: 'CLI-AR1', display_name: 'Zoë O.', country: 'Argentina' },
    { customer_id: 'CLI-MX1', display_name: 'Luis P.', country: 'México' }];
  const many = (n: number): Identity[] => Array.from({ length: n }, (_, i) => ({ customer_id: `CLI-${i}`, display_name: `Person ${i}`, country: 'Colombia' }));
  const el = () => fixture.nativeElement as HTMLElement;
  const names = () => [...el().querySelectorAll('.ar-row-name')].map(n => n.textContent?.trim());
  const type = (selector: string, value: string, event: string) => {
    const input = el().querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event(event));
    fixture.detectChanges();
  };

  function render(identities: Identity[], value = '', disabled = false) {
    fixture = TestBed.createComponent(CustomerPicker);
    picker = fixture.componentInstance;
    fixture.componentRef.setInput('identities', identities);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('disabled', disabled);
    fixture.detectChanges();
  }

  it('searches by name ignoring case and accents, and by id', () => {
    render(base);
    type('input[type=search]', 'zoe', 'input');
    expect(names()).toEqual(['Zoë O.']);
    type('input[type=search]', 'mx1', 'input');
    expect(names()).toEqual(['Luis P.']);
    expect(el().querySelector('[role=status]')?.textContent?.trim()).toBe(`1 ${picker.t().pickerMatch}`);
    type('input[type=search]', '', 'input');
    expect(el().querySelector('[role=status]')?.textContent?.trim()).toBe(`3 ${picker.t().pickerMatches}`);
  });

  it('filters by country, and lists identities without one under their own option', () => {
    render(base);
    const options = [...el().querySelectorAll('option')].map(o => o.textContent?.trim());
    expect(options).toEqual([picker.t().pickerAllCountries, 'Argentina', 'México', picker.t().pickerNoCountry]);
    type('select', picker.noCountry, 'change');
    expect(names()).toEqual(['Ana (demo)']);
    type('select', 'México', 'change');
    expect(names()).toEqual(['Luis P.']);
  });

  it('renders at most 50 matches, counts all of them and asks to refine', () => {
    render(many(120));
    expect(names().length).toBe(50);
    expect(el().querySelector('[role=status]')?.textContent).toContain('120');
    expect(el().textContent).toContain(picker.t().pickerRefine);
    type('input[type=search]', 'Person 11', 'input');
    expect(names()).toEqual(['Person 11', 'Person 110', 'Person 111', 'Person 112', 'Person 113', 'Person 114',
      'Person 115', 'Person 116', 'Person 117', 'Person 118', 'Person 119']);
    expect(el().textContent).not.toContain(picker.t().pickerRefine);
  });

  it('pins a selected identity the filter hides apart from the matches, tagged as selected', () => {
    const listed = () => [...el().querySelectorAll('.picker-list .ar-row-name')].map(n => n.textContent?.trim());
    const pinned = () => el().querySelector('.picker-pinned label');
    render(many(120), 'CLI-99');
    expect(pinned()?.textContent).toContain('Person 99');
    expect(pinned()?.textContent).toContain(picker.t().selected);
    expect(listed().length).toBe(50);
    expect(el().querySelector('[role=status]')?.textContent).toContain('120');
    type('input[type=search]', 'nobody', 'input');
    expect(listed()).toEqual([]);
    expect(pinned()?.textContent).toContain('Person 99');
    expect(el().querySelector('[role=status]')?.textContent).toContain(picker.t().pickerNone);
    type('input[type=search]', 'Person 99', 'input');
    expect(pinned()).toBeNull();
    expect(listed()).toEqual(['Person 99']);
  });

  it('names the group once, with the visible legend', () => {
    render(base);
    expect(el().querySelector('legend')?.textContent?.trim()).toBe(picker.t().chooseIdentity);
    expect(el().querySelector('legend')?.classList).not.toContain('sr-only');
  });

  it('selecting a radio updates the value', () => {
    render(base, 'demo-ana');
    el().querySelectorAll<HTMLInputElement>('input[type=radio]')[2].click();
    expect(picker.value()).toBe('CLI-MX1');
  });

  it('while locked, every control is disabled and the selection cannot change', () => {
    render(base, 'demo-ana', true);
    const controls = [...el().querySelectorAll<HTMLInputElement>('input, select')];
    expect(controls.every(c => c.matches(':disabled'))).toBeTrue();
    el().querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    expect(picker.value()).toBe('demo-ana');
  });
});
