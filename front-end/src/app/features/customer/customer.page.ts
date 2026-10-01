import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { LangService, errorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { ApiError } from '../../core/http/api.service';
import { CaseBody, Identity, Receipt, Transaction } from '../../shared/models/intake.model';
import { CustomerService } from './customer.service';

/**
 * The customer flow as one connected screen: intro, sign-in, home. The disc is a single element that
 * travels between the three steps. Sign in, pick one of your own charges, describe it and confirm.
 * A submitted payload and its idempotency key stay frozen until acceptance is known, so a retry
 * can never create a second case or send edited content. A definitive rejection (404, 409, 413 or 422)
 * releases the form so the customer can correct it; that submission then gets a new key.
 */
/** Rejections that retrying can't fix; 401, 503 and network failures keep the frozen retry. */
const DEFINITIVE = new Set([404, 409, 413, 422]);
export type Step = 'intro' | 'login' | 'home';

@Component({
  selector: 'app-customer-page',
  imports: [DatePipe, FormsModule, RouterLink, LangSwitch, Mark],
  templateUrl: './customer.page.html'
})
export class CustomerPage implements OnInit, OnDestroy {
  private readonly service = inject(CustomerService);
  readonly lang = inject(LangService);
  readonly t = this.lang.t;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly client = signal('');
  readonly transactions = signal<Transaction[]>([]);
  readonly receipt = signal<Receipt | null>(null);
  readonly pending = signal<CaseBody | null>(null);
  readonly identities = signal<Identity[]>([]);
  readonly identityLocked = computed(() => this.pending() !== null);
  readonly step = signal<Step>('intro');
  readonly booted = signal(false);
  readonly sourceTime = formatSourceTime;
  identity = '';
  selected = '';
  statement = '';
  confirmed = false;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;

  /** Where the disc sits: boot centre, top dot, login form, sidebar mark. */
  readonly discClass = computed(() => {
    const step = this.step();
    if (step === 'login') return 'disc disc--login';
    if (step === 'home') return 'disc disc--home';
    return this.booted() ? 'disc disc--top' : 'disc disc--boot';
  });
  readonly displayName = computed(() => this.identities().find(i => i.customer_id === this.client())?.display_name ?? this.client());
  readonly initials = computed(() => this.displayName().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'AA');
  /** The charge being reported: the frozen one while a request is pending, else the one chosen in the list. A method, not a computed, because `selected` is a plain field. */
  selectedTx(): Transaction | null {
    return this.transactions().find(tx => tx.transaction_id === (this.pending()?.transaction_id ?? this.selected)) ?? null;
  }
  /** Totals of the loaded charges, per source currency; never converted. */
  readonly totals = computed(() => {
    const sums = new Map<string, number>();
    for (const tx of this.transactions()) {
      const n = Number(tx.amount);
      if (Number.isFinite(n)) sums.set(tx.currency, (sums.get(tx.currency) ?? 0) + n);
    }
    return [...sums.entries()].map(([currency, total]) => ({ currency, total: formatAmount(total) }));
  });

  /** Load the identity choices from the API; they come from the same config as the server allowlist. */
  async ngOnInit(): Promise<void> {
    this.bootTimer = setTimeout(() => this.booted.set(true), 2400);
    try {
      this.identities.set(await this.service.identities());
      this.identity ||= this.identities()[0]?.customer_id ?? '';
    } catch (e) {
      this.fail(e);
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.bootTimer);
  }

  start(): void {
    this.booted.set(true);
    this.step.set('login');
  }

  /** Sign in; while a request is pending, re-authenticate as the same identity. */
  async login(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const identity = this.identityLocked() ? this.client() : this.identity;
    if (!this.identityLocked()) this.reset();
    try {
      await this.service.signIn(identity);
      this.client.set(identity);
      this.transactions.set(await this.service.transactions());
      this.step.set('home');
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Choose the charge to report; the report panel opens under the list. */
  select(transactionId: string): void {
    if (this.pending() || this.receipt()) return;
    this.selected = transactionId;
    this.confirmed = false;
    this.error.set('');
  }

  cancel(): void {
    if (this.pending()) return;
    this.selected = '';
    this.statement = '';
    this.confirmed = false;
    this.receipt.set(null);
    this.error.set('');
  }

  /** Submit once; retries resend the frozen payload with the same key. */
  async submit(): Promise<void> {
    if (this.busy() || this.receipt()) return;
    if (!this.pending()) {
      if (!this.selected || !this.confirmed || [...this.statement.trim()].length < 10) {
        this.error.set(this.t().validation);
        return;
      }
      this.pending.set({ transaction_id: this.selected, customer_statement: this.statement.trim(),
        customer_confirmed: true, idempotency_key: crypto.randomUUID() });
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.receipt.set(await this.service.submitCase(this.pending()!));
      this.pending.set(null);
    } catch (e) {
      if (e instanceof ApiError && DEFINITIVE.has(e.status)) this.pending.set(null);
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  merchantInitials(tx: Transaction): string {
    return tx.merchant_name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  private reset(): void {
    this.client.set('');
    this.transactions.set([]);
    this.selected = '';
    this.statement = '';
    this.confirmed = false;
    this.receipt.set(null);
  }

  private fail(e: unknown): void {
    this.error.set(errorText(this.t(), e));
  }
}

/** 1234567.5 → "1 234 567.50": thin-space grouping, always two decimals, the currency code goes beside it. */
export function formatAmount(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + dec;
}
