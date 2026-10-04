import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { LangService } from '../../shared/i18n/lang.service';
import type { SessionState } from '../../shared/models/intake.model';
import { ContextCard, CustomerSession, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeReceipt, IntakeStart, IntakeStartBody,
  ReportList, Role, SuggestionChoice, SuggestionList, TransactionList, AlertResponse, ServiceTimes, MessageThread, ReportMessage } from '../../shared/models/intake.model';

/** Customer calls: email sign-in (simulated in local development), own charges and the guided intake. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private readonly api = inject(ApiService);
  private readonly lang = inject(LangService);
  /** Tab-scoped state that survives in-app navigation: the signed-in customer, their card and session roles (the page writes them). */
  readonly client = signal('');
  readonly card = signal<ContextCard | null>(null);
  readonly roles = signal<Role[]>([]);

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

  /** The browser's live sessions (ADR-013, phase 0): a reload restores the signed-in state from the cookies. */
  me(): Promise<SessionState> {
    return this.api.request<SessionState>('/auth/me');
  }

  /** Admins only (ADR-007, decision 10): every customer an admin may act as; the server checks the session's admin mark. */
  async adminCustomers(): Promise<Identity[]> {
    return (await this.api.request<{ items: Identity[] }>('/admin/customers')).items;
  }

  /** Admins only: replace the session with one for ``customerId``; the response is a customer session (``admin_act_as``). */
  actAs(customerId: string): Promise<CustomerSession> {
    return this.api.request<CustomerSession>('/admin/act-as', { customer_id: customerId });
  }

  /** The proactive alert (ADR-011): at most one bank-flagged charge of this customer, not yet answered or reported. */
  alert(): Promise<AlertResponse> {
    return this.api.request<AlertResponse>('/alerts');
  }

  /** Answer the alert once: ``mine`` (recognized) or ``report`` (opening the guided report); the first answer stands. */
  answerAlert(transactionId: string, answer: 'mine' | 'report'): Promise<unknown> {
    return this.api.request('/alerts/answer', { transaction_id: transactionId, answer });
  }

  /** Revoke the browser's customer session cookie (always 204). */
  logout(): Promise<unknown> {
    return this.api.request('/auth/logout', {});
  }

  /** The customer's charges in the interface language; the server records the view and returns its ``view_ref`` (ADR-009). */
  transactions(): Promise<TransactionList> {
    return this.api.request<TransactionList>(`/transactions?lang=${this.lang.lang()}`);
  }

  /** Acknowledge that a recorded view's rows are on screen (idempotent on the server). */
  displayed(viewRef: string): Promise<unknown> {
    return this.api.request('/transactions/displayed', { view_ref: viewRef });
  }

  reports(): Promise<ReportList> {
    return this.api.request<ReportList>('/reports');
  }

  /** One own report's message thread with the agent (ADR-015), by protocol or short reference. */
  messages(reference: string): Promise<MessageThread> {
    return this.api.request<MessageThread>(`/intake/handoff/${encodeURIComponent(reference)}/messages`);
  }

  /** Write to the agent on an own report; the same ``key`` on a retry stores one message (409 once it is closed). */
  postMessage(reference: string, body: string, key: string): Promise<ReportMessage> {
    return this.api.request<ReportMessage>(`/intake/handoff/${encodeURIComponent(reference)}/messages`, { body, idempotency_key: key });
  }

  /** This bank's historical response times for unrecognized-charge reports (a reviewed aggregate, the same for everyone). */
  serviceTimes(): Promise<ServiceTimes> {
    return this.api.request<ServiceTimes>('/intake/service-times');
  }

  /** The receipt answer "was it easy to report this charge?" for an own report; the first answer stands (409 on a different one). */
  sendFeedback(protocol: string, easy: boolean): Promise<{ protocol: string; easy: boolean; recorded_at: string }> {
    return this.api.request('/reports/feedback', { protocol, easy });
  }

  /** Queue a status email for one own report (202; 409 no email; 429 another request is queued or recently accepted). */
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

  /** Suggested charges for one own report (ADR-012): ``pending`` while the service reads the details, then ``none`` or up to three. */
  suggestions(protocol: string): Promise<SuggestionList> {
    return this.api.request<SuggestionList>(`/intake/handoff/${encodeURIComponent(protocol)}/suggestions`);
  }

  /** Answer the suggestions once: one suggested charge, or none of them; a different later answer is 409. Nothing is closed or decided. */
  answerSuggestions(protocol: string, transactionId: string | null): Promise<SuggestionChoice> {
    return this.api.request<SuggestionChoice>(`/intake/handoff/${encodeURIComponent(protocol)}/suggestions/confirm`,
      transactionId ? { transaction_id: transactionId } : { none: true });
  }
}
