import { Component, computed, inject, input, model, signal } from '@angular/core';
import { LangService } from '../i18n/lang.service';
import { Identity } from '../models/intake.model';

// ponytail: renders at most 50 matches (the cohort is ~800); add virtual scrolling only if all must show at once.
const CAP = 50;
/** Select value for identities whose country is null; can't collide with a real country name. */
const NO_COUNTRY = '\u0000none';
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Pick a demo identity by name or id, narrowed by country. Native radios, so arrow keys and the
 * disabled fieldset work as usual. The selected identity always stays in the list, so the caller
 * never signs in someone the customer can't see.
 */
@Component({
  selector: 'app-customer-picker',
  templateUrl: './customer-picker.component.html',
  styleUrl: './customer-picker.component.css'
})
export class CustomerPicker {
  readonly t = inject(LangService).t;
  readonly identities = input<Identity[]>([]);
  readonly disabled = input(false);
  readonly value = model('');
  readonly query = signal('');
  readonly country = signal('');
  readonly noCountry = NO_COUNTRY;

  readonly countries = computed(() =>
    [...new Set(this.identities().flatMap(i => i.country ? [i.country] : []))].sort((a, b) => a.localeCompare(b)));
  readonly matches = computed(() => {
    const q = fold(this.query().trim());
    const c = this.country();
    return this.identities().filter(i => (!c || (c === NO_COUNTRY ? !i.country : i.country === c))
      && (!q || fold(i.display_name).includes(q) || fold(i.customer_id).includes(q)));
  });
  readonly shown = computed(() => {
    const shown = this.matches().slice(0, CAP);
    const selected = this.identities().find(i => i.customer_id === this.value());
    return selected && !shown.includes(selected) ? [selected, ...shown.slice(0, CAP - 1)] : shown;
  });
  readonly capped = computed(() => this.matches().length > CAP);
}
