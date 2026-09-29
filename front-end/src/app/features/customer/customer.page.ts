import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { CaseBody, Receipt, Transaction } from '../../shared/models/intake.model';
import { CustomerService } from './customer.service';

/**
 * Customer flow: sign in, pick one of your own charges, describe it and confirm.
 * A submitted payload and its idempotency key stay frozen until acceptance is known, so a retry
 * can never create a second case or send edited content.
 */
@Component({
  selector: 'app-customer-page',
  imports: [DatePipe, FormsModule],
  templateUrl: './customer.page.html'
})
export class CustomerPage {
  private readonly service = inject(CustomerService);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly client = signal('');
  readonly transactions = signal<Transaction[]>([]);
  readonly receipt = signal<Receipt | null>(null);
  readonly pending = signal<CaseBody | null>(null);
  readonly identityLocked = computed(() => this.pending() !== null);
  readonly sourceTime = formatSourceTime;
  identity = 'demo-bruno';
  selected = '';
  statement = '';
  confirmed = false;

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
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Submit once; retries resend the frozen payload with the same key. */
  async submit(): Promise<void> {
    if (this.busy() || this.receipt()) return;
    if (!this.pending()) {
      if (!this.selected || !this.confirmed || this.statement.trim().length < 10) {
        this.error.set('Select a charge, describe the issue in at least 10 characters, and confirm.');
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
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
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
    this.error.set(e instanceof Error ? e.message : 'Request failed.');
  }
}
