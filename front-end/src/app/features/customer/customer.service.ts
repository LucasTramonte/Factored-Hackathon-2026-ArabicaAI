import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { ContextCard, CustomerSession, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeReceipt, IntakeStart, IntakeStartBody,
  ReportList, TransactionList } from '../../shared/models/intake.model';

/** Customer calls: email sign-in (simulated in local development), own charges and the guided intake. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly api = inject(ApiService);
  /** Tab-scoped state that survives in-app navigation: the signed-in customer and their card. */
  readonly client = signal('');
  readonly card = signal<ContextCard | null>(null);

  async identities(): Promise<Identity[]> {
    return (await this.api.request<{ items: Identity[] }>('/demo/identities')).items;
  }

  /** The session response; its context card is a snapshot and never sets the report language. */
  signIn(customerId: string): Promise<CustomerSession> {
    return this.api.request<CustomerSession>('/demo/session', { customer_id: customerId });
  }

  /** Exchange a verified Cognito ID token for the session cookie. POST with an empty JSON body: the token travels only in the header. */
  signInWithToken(idToken: string): Promise<CustomerSession> {
    return this.api.request<CustomerSession>('/auth/session', {}, { Authorization: 'Bearer ' + idToken });
  }

  /** Revoke the browser's customer session cookie (always 204). */
  logout(): Promise<unknown> {
    return this.api.request('/auth/logout', {});
  }

  transactions(): Promise<TransactionList> {
    return this.api.request<TransactionList>('/transactions');
  }

  reports(): Promise<ReportList> {
    return this.api.request<ReportList>('/reports');
  }

  /** Ask for a status email about one of the customer's reports (202; 409 no email on file; 429 sent recently). */
  requestUpdate(protocol: string): Promise<{ queued: true }> {
    return this.api.request<{ queued: true }>('/reports/update', { protocol });
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
