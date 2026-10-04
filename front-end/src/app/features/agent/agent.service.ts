import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { AgentIntakeDetail, AgentIntakeList, AgentSession, IntakeTransition, MessageThread, ReportMessage, Role, SuggestionMark, SuggestionMarkValue } from '../../shared/models/intake.model';

/** Agent calls: a separate session, read-only views and the one status step a person takes. Nothing refunds, blocks or decides. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly api = inject(ApiService);
  /** Tab-scoped session roles that survive in-app navigation; set by a sign-in on either page (an admin's opens both). */
  readonly roles = signal<Role[]>([]);

  /** An agent session from a Cognito ID token (groups ``agent`` or ``admin``); without one, the local one-click session (``DEMO_PICKER`` only). */
  signIn(idToken?: string): Promise<AgentSession> {
    return this.api.request<AgentSession>('/demo/agent-session', {}, idToken ? { Authorization: 'Bearer ' + idToken } : {});
  }

  /** Newest 50 acknowledged guided handoffs; ``has_more`` says more exist (the API has no cursor). */
  intakes(): Promise<AgentIntakeList> {
    return this.api.request<AgentIntakeList>('/agent/intakes');
  }

  intakeDetail(protocol: string): Promise<AgentIntakeDetail> {
    return this.api.request<AgentIntakeDetail>('/agent/intake-detail?protocol=' + encodeURIComponent(protocol));
  }

  /** Move a report one step forward (received → in_review → closed); 409 when someone already moved it. */
  setStatus(protocol: string, status: IntakeTransition['status']): Promise<IntakeTransition> {
    return this.api.request<IntakeTransition>('/agent/intake-status', { protocol, status });
  }

  /** Mark the charge a customer confirmed from a suggestion as correct or wrong; the first mark stands (409 on a different one). */
  markSuggestion(protocol: string, mark: SuggestionMarkValue): Promise<SuggestionMark> {
    return this.api.request<SuggestionMark>('/agent/suggestion-mark', { protocol, mark });
  }

  /** The report's message thread with the customer (ADR-015). */
  messages(protocol: string): Promise<MessageThread> {
    return this.api.request<MessageThread>('/agent/intake-messages?protocol=' + encodeURIComponent(protocol));
  }

  /** Write to the customer; the same ``key`` on a retry stores one message (409 once the report is closed). */
  postMessage(protocol: string, body: string, key: string): Promise<ReportMessage> {
    return this.api.request<ReportMessage>('/agent/intake-messages', { protocol, body, idempotency_key: key });
  }
}
