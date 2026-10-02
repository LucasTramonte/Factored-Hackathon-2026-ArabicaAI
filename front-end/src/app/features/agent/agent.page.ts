import { Component, ElementRef, Injector, afterNextRender, effect, inject, signal, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { LangService, Strings, checkText, errorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { AgentIntake, AgentIntakeDetail, HandoffStatus, IntakeKind } from '../../shared/models/intake.model';
import { AgentService } from './agent.service';

const STATUS_KEYS: Record<HandoffStatus, keyof Strings> = { received: 'statusReceived', in_review: 'inReview', closed: 'reviewClosed' };
const KIND_KEYS: Record<IntakeKind, keyof Strings> = { complete: 'kindComplete', technical: 'kindTechnical', incomplete: 'kindIncomplete' };

/** Agent view: the guided intake queue with a detail panel. The only change a person can make is the next status step. */
@Component({
  selector: 'app-agent-page',
  imports: [DatePipe, RouterLink, LangSwitch, Mark],
  templateUrl: './agent.page.html',
  styleUrl: './agent.page.css'
})
export class AgentPage {
  private readonly service = inject(AgentService);
  private readonly injector = inject(Injector);
  readonly t = inject(LangService).t;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly loaded = signal(false);
  readonly intakes = signal<AgentIntake[]>([]);
  readonly intakesHasMore = signal(false);
  readonly detail = signal<AgentIntakeDetail | null>(null);
  /** The protocol whose detail is open or loading. */
  readonly openProtocol = signal<string | null>(null);
  private detailRequest = 0;
  readonly sourceTime = formatSourceTime;
  private readonly detailHeading = viewChild<ElementRef<HTMLElement>>('detailHeading');
  private readonly signInButton = viewChild<ElementRef<HTMLButtonElement>>('signIn');
  private readonly statusText = viewChild<ElementRef<HTMLElement>>('statusText');
  private readonly queueHeading = viewChild<ElementRef<HTMLElement>>('queueHeading');
  private trigger: HTMLElement | null = null;

  constructor() {
    // The route title is static, so the tab title follows the interface language here.
    const title = inject(Title);
    effect(() => title.setTitle(`ArabicaAI · ${this.t().agentTitle}`));
  }

  /** A server check or open-question code in the interface language; the raw code stays visible beside it. */
  check(code: string): string {
    return checkText(this.t(), code);
  }

  kindLabel(kind: IntakeKind): string {
    return this.t()[KIND_KEYS[kind]];
  }

  statusLabel(status: HandoffStatus): string {
    return this.t()[STATUS_KEYS[status]];
  }

  /** Take the next status step for the open report. On 409 someone else moved it: reload the detail and say so. Focus lands on the status text. */
  async advance(d: AgentIntakeDetail): Promise<void> {
    if (this.busy() || d.status === 'closed') return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.applyStatus(d.protocol, (await this.service.setStatus(d.protocol, d.status === 'received' ? 'in_review' : 'closed')).status);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) this.fail(e);
      else try {
        const fresh = await this.service.intakeDetail(d.protocol);
        this.detail.update(x => x?.protocol === d.protocol ? fresh : x);
        this.applyStatus(d.protocol, fresh.status);
        this.error.set(this.t().agentErr409);
      } catch (again) { this.fail(again); }
    } finally {
      this.busy.set(false);
      afterNextRender(() => this.statusText()?.nativeElement.focus(), { injector: this.injector });
    }
  }

  /** Update the queue row and, if still open, the detail in place. */
  private applyStatus(protocol: string, status: HandoffStatus): void {
    this.intakes.update(xs => xs.map(x => x.protocol === protocol ? { ...x, status } : x));
    this.detail.update(x => x?.protocol === protocol ? { ...x, status } : x);
  }

  /** Start an agent session, then load the intake queue. The button is disabled while busy, which drops its focus: focus then goes to the queue, or back to the button on failure. */
  async load(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.reset();
    try {
      await this.service.signIn();
      const intakes = await this.service.intakes();
      this.intakes.set(intakes.items);
      this.intakesHasMore.set(intakes.has_more);
      this.loaded.set(true);
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      afterNextRender(() => (this.loaded() ? this.queueHeading() : this.signInButton())?.nativeElement.focus(), { injector: this.injector });
    }
  }

  /** Open one intake's detail; focus moves to its heading once it renders. */
  async open(protocol: string, trigger: HTMLElement): Promise<void> {
    // Each request gets a number; only the latest may change the panel, even for the same protocol
    // (a double click whose first request fails must not hide the second one's detail).
    const request = ++this.detailRequest;
    this.trigger = trigger;
    this.openProtocol.set(protocol);
    this.detail.set(null);
    this.error.set('');
    try {
      const detail = await this.service.intakeDetail(protocol);
      if (request !== this.detailRequest) return;
      this.detail.set(detail);
      afterNextRender(() => this.detailHeading()?.nativeElement.focus(), { injector: this.injector });
    } catch (e) {
      if (request !== this.detailRequest) return;
      this.openProtocol.set(null);
      this.detail.set(null);
      this.fail(e);
    }
  }

  /** Close the detail and return focus to the button that opened it. */
  close(): void {
    this.detailRequest++;
    this.openProtocol.set(null);
    this.detail.set(null);
    this.trigger?.focus();
    this.trigger = null;
  }

  private reset(): void {
    this.detailRequest++;
    this.error.set('');
    this.loaded.set(false);
    this.intakes.set([]);
    this.intakesHasMore.set(false);
    this.openProtocol.set(null);
    this.detail.set(null);
  }

  /** An expired agent session drops everything shown, so nothing stale stays on screen. */
  private fail(e: unknown): void {
    const status = e instanceof ApiError ? e.status : -1;
    if (status === 401) {
      this.reset();
      // The focused row or detail is gone; keep keyboard users on the way back in.
      afterNextRender(() => this.signInButton()?.nativeElement.focus(), { injector: this.injector });
    }
    this.error.set(status === 401 ? this.t().agentErr401 : status === 404 ? this.t().agentErr404 : errorText(this.t(), e));
  }
}
