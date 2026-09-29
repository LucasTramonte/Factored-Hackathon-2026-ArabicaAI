import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { CaseBody, Identity, Receipt, Transaction, TransactionList } from '../../shared/models/intake.model';

/** Customer calls: simulated sign-in, own charges, case submission. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly api = inject(ApiService);

  async identities(): Promise<Identity[]> {
    return (await this.api.request<{ items: Identity[] }>('/demo/identities')).items;
  }

  async signIn(customerId: string): Promise<void> {
    await this.api.request('/demo/session', { customer_id: customerId });
  }

  async transactions(): Promise<Transaction[]> {
    return (await this.api.request<TransactionList>('/transactions')).items;
  }

  submitCase(body: CaseBody): Promise<Receipt> {
    return this.api.request<Receipt>('/cases', body);
  }
}
