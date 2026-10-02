import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { AgentIntakeDetail, AgentIntakeList, IntakeTransition } from '../../shared/models/intake.model';

/** Agent calls: a separate session, read-only views and the one status step a person takes. Nothing refunds, blocks or decides. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly api = inject(ApiService);

  /** An agent session from a Cognito ID token (group ``agent``); without one, the local one-click session (``DEMO_PICKER`` only). */
  async signIn(idToken?: string): Promise<void> {
    await this.api.request('/demo/agent-session', {}, idToken ? { Authorization: 'Bearer ' + idToken } : {});
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
}
