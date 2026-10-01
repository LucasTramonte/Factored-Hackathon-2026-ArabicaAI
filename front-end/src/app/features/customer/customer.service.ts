import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { CaseBody, CustomerSession, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeReceipt, IntakeStart, IntakeStartBody,
  Receipt, Transaction, TransactionList } from '../../shared/models/intake.model';

/** Customer calls: simulated sign-in, own charges, case submission and the guided intake. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly api = inject(ApiService);

  async identities(): Promise<Identity[]> {
    return (await this.api.request<{ items: Identity[] }>('/demo/identities')).items;
  }

  /** The session response; its context card is a snapshot and never sets the report language. */
  signIn(customerId: string): Promise<CustomerSession> {
    return this.api.request<CustomerSession>('/demo/session', { customer_id: customerId });
  }

  async transactions(): Promise<Transaction[]> {
    return (await this.api.request<TransactionList>('/transactions')).items;
  }

  submitCase(body: CaseBody): Promise<Receipt> {
    return this.api.request<Receipt>('/cases', body);
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
