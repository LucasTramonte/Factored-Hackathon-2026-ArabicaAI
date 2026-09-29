import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/http/api.service';
import { AgentCase, AgentCaseList } from '../../shared/models/intake.model';

/** Agent calls: a separate simulated session and the read-only case list. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly api = inject(ApiService);

  async signIn(): Promise<void> {
    await this.api.request('/demo/agent-session', {});
  }

  async cases(): Promise<AgentCase[]> {
    return (await this.api.request<AgentCaseList>('/agent/cases')).items;
  }
}
