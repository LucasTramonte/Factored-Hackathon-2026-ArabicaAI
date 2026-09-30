import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { LangService } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { AgentCase } from '../../shared/models/intake.model';
import { AgentService } from './agent.service';

/** Agent queue: the most recent accepted cases with their transaction evidence. Read-only. */
@Component({
  selector: 'app-agent-page',
  imports: [DatePipe, RouterLink, LangSwitch, Mark],
  templateUrl: './agent.page.html'
})
export class AgentPage {
  private readonly service = inject(AgentService);
  readonly t = inject(LangService).t;
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
