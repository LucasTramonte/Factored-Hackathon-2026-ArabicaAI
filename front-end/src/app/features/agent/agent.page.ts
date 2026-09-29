import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { AgentCase } from '../../shared/models/intake.model';
import { AgentService } from './agent.service';

/** Agent queue: the most recent accepted cases with their transaction evidence. Read-only. */
@Component({
  selector: 'app-agent-page',
  imports: [DatePipe],
  templateUrl: './agent.page.html'
})
export class AgentPage {
  private readonly service = inject(AgentService);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly loaded = signal(false);
  readonly cases = signal<AgentCase[]>([]);
  readonly sourceTime = formatSourceTime;

  /** Start an agent session, then load the queue. */
  async load(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.loaded.set(false);
    this.cases.set([]);
    try {
      await this.service.signIn();
      this.cases.set(await this.service.cases());
      this.loaded.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      this.busy.set(false);
    }
  }
}
