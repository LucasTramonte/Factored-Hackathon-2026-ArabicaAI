import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { AgentIntakeDetail, AgentIntakeList } from '../../shared/models/intake.model';

/** Agent calls: a separate simulated session and read-only views. Nothing here changes a case. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly api = inject(ApiService);

  async signIn(): Promise<void> {
    await this.api.request('/demo/agent-session', {});
  }

  /** Newest 50 acknowledged guided handoffs; ``has_more`` says more exist (the API has no cursor). */
  intakes(): Promise<AgentIntakeList> {
    return this.api.request<AgentIntakeList>('/agent/intakes');
  }

  intakeDetail(protocol: string): Promise<AgentIntakeDetail> {
    return this.api.request<AgentIntakeDetail>('/agent/intake-detail?protocol=' + encodeURIComponent(protocol));
  }
}
