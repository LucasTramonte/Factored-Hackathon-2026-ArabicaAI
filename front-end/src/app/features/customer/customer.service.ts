import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { ContextCard, CustomerSession, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeReceipt, IntakeStart, IntakeStartBody,
  TransactionList } from '../../shared/models/intake.model';

/** A receipt read back in this tab, with the charge the customer confirmed (null for a handoff without one). */
export interface ReceiptEntry {
  receipt: IntakeReceipt;
  transactionId: string | null;
}

/** Customer calls: simulated sign-in, own charges and the guided intake. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly api = inject(ApiService);
  /** Tab-scoped state that survives in-app navigation: the signed-in customer, their card and the receipts already shown. */
  readonly client = signal('');
  readonly card = signal<ContextCard | null>(null);
  readonly receipts = signal<ReceiptEntry[]>([]);

  async identities(): Promise<Identity[]> {
    return (await this.api.request<{ items: Identity[] }>('/demo/identities')).items;
  }

  /** The session response; its context card is a snapshot and never sets the report language. */
  signIn(customerId: string): Promise<CustomerSession> {
    return this.api.request<CustomerSession>('/demo/session', { customer_id: customerId });
  }

  transactions(): Promise<TransactionList> {
    return this.api.request<TransactionList>('/transactions');
  }

  startIntake(body: IntakeStartBody): Promise<IntakeStart> {
    return this.api.request<IntakeStart>('/intake/start', body);
  }

  confirmIntake(body: IntakeConfirmBody): Promise<IntakeReceipt> {
    return this.api.request<IntakeReceipt>('/intake/confirm', body);
  }

  handoffIntake(body: IntakeHandoffBody): Promise<IntakeReceipt> {
    return this.api.request<IntakeReceipt>('/intake/handoff', body);
  }
}
