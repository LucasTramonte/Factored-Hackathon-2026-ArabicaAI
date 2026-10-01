import { Component, DestroyRef, computed, effect, inject, input, model, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { LangService } from '../i18n/lang.service';
import { Identity } from '../models/intake.model';

/** At most this many matches render (the cohort is about 800); add virtual scrolling only if all must show at once. */
const CAP = 50;
/** How long typing must pause before the count is announced, so a screen reader isn't interrupted per keystroke. */
const ANNOUNCE_DELAY_MS = 500;
/** Select value for identities whose country is null; can't collide with a real country name. */
const NO_COUNTRY = '\u0000none';
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Pick a demo identity by name or id, narrowed by country. Native radios, so arrow keys and the
 * disabled fieldset work as usual. A selected identity the filter or cap hides is pinned apart from
 * the matches and tagged as selected, so the caller never signs in someone the customer can't see
 * and the count describes only the matches.
 */
@Component({
  selector: 'app-customer-picker',
  imports: [NgTemplateOutlet],
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
  readonly shown = computed(() => this.matches().slice(0, CAP));
  readonly pinned = computed(() => {
    const selected = this.identities().find(i => i.customer_id === this.value());
    return selected && !this.shown().includes(selected) ? selected : null;
  });
  readonly capped = computed(() => this.matches().length > CAP);
  readonly countText = computed(() => {
    const n = this.matches().length;
    if (!n) return this.t().pickerNone;
    return `${n} ${n === 1 ? this.t().pickerMatch : this.t().pickerMatches}` + (this.capped() ? `. ${this.t().pickerRefine}` : '');
  });
  /** The live-region text: the count, once typing has paused for ANNOUNCE_DELAY_MS. */
  readonly announced = signal('');

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const text = this.countText();
      clearTimeout(timer);
      timer = setTimeout(() => this.announced.set(text), ANNOUNCE_DELAY_MS);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }
}
