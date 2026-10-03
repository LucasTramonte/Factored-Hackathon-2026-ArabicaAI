import { Component, ElementRef, Injector, afterNextRender, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Title } from '@angular/platform-browser';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { demoPicker } from '../../core/auth/cognito.config';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { LangService, STATUS_CHIP, Strings, checkText, errorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { AgentIntake, AgentIntakeDetail, HandoffStatus, IntakeKind, REASON_LABEL, Role } from '../../shared/models/intake.model';
import { AgentService } from './agent.service';

const KIND_KEYS: Record<IntakeKind, keyof Strings> = { complete: 'kindComplete', technical: 'kindTechnical', incomplete: 'kindIncomplete' };

/**
 * Agent view: email-code sign-in (group ``agent``), then the guided intake queue with a detail panel. The only change a
 * person can make is the next status step. Development builds also offer the local one-click session.
 */
@Component({
  selector: 'app-agent-page',
  imports: [DatePipe, FormsModule, RouterLink, LangSwitch, Mark],
  templateUrl: './agent.page.html',
  styleUrl: './agent.page.css'
})
export class AgentPage {
  private readonly service = inject(AgentService);
  private readonly injector = inject(Injector);
  private readonly cognito = inject(CognitoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The local one-click agent session; development builds only. */
  readonly demoPicker = demoPicker;
  /** The email one-time code was sent: the code field replaces the email field. */
  readonly codeSent = signal(false);
  email = '';
  code = '';
  readonly t = inject(LangService).t;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly loaded = signal(false);
  /** Session roles from the last sign-in; a refresh keeps them, an expired session (401) clears them. */
  readonly roles = signal<Role[]>([]);
  readonly intakes = signal<AgentIntake[]>([]);
  readonly intakesHasMore = signal(false);
  readonly detail = signal<AgentIntakeDetail | null>(null);
  /** The protocol whose detail is open or loading. */
  readonly openProtocol = signal<string | null>(null);
  private detailRequest = 0;
  readonly sourceTime = formatSourceTime;
  readonly reasonLabel = REASON_LABEL;
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

  /** One line: whether a model read the case in shadow (count and version only; it decides nothing). */
  modelLine({ model_reading: m }: AgentIntakeDetail): string {
    return m.mode === 'shadow' ? this.t().modelShadow.replace('{n}', String(m.llm_calls)).replace('{calls}', m.llm_calls === 1 ? this.t().callOne : this.t().callMany).replace('{v}', m.model_version ?? '') : this.t().modelOff;
  }

  statusLabel(status: HandoffStatus): string {
    return this.t()[STATUS_CHIP[status]];
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
      } catch (again) {
        // No stale button for a status we could not confirm.
        this.openProtocol.set(null);
        this.detail.set(null);
        this.fail(again);
      }
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

  /** Local one-click agent session (development builds), then the queue. */
  load(): Promise<void> {
    return this.enter(async () => this.roles.set((await this.service.signIn()).roles));
  }

  /** Reload the queue with the current session. */
  refresh(): Promise<void> {
    return this.enter(async () => undefined);
  }

  /** Email the one-time code. A 401 reads as "could not send", so the UI never says whether the address exists. */
  async requestCode(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.cognito.requestCode(this.email.trim());
      this.codeSent.set(true);
      afterNextRender(() => this.focusSignIn(), { injector: this.injector });
    } catch (e) {
      this.error.set(this.signInError(e, 'errSendCode'));
    } finally {
      this.busy.set(false);
    }
  }

  /** Code → Cognito ID token → agent session → queue. Once Cognito accepts the code it is spent, so a later failure goes back to the email step. */
  verify(): Promise<void> {
    let spent = false;
    return this.enter(async () => {
      const token = await this.cognito.submitCode(this.email.trim(), this.code.trim());
      spent = true;
      this.roles.set((await this.service.signIn(token)).roles);
    }, e => {
      if (spent) this.anotherEmail();
      this.error.set(this.signInError(e, spent ? 'errOther' : 'errCode'));
    });
  }

  /** Back to the email field; the pending challenge is forgotten. */
  anotherEmail(): void {
    this.cognito.forget();
    this.codeSent.set(false);
    this.code = '';
  }

  /**
   * Start a session with ``start``, then load the intake queue. Buttons are disabled while busy, which drops their focus:
   * focus then goes to the queue, or back to the sign-in control on failure.
   */
  private async enter(start: () => Promise<void>, onError: (e: unknown) => void = e => this.fail(e)): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.reset();
    try {
      await start();
      const intakes = await this.service.intakes();
      this.intakes.set(intakes.items);
      this.intakesHasMore.set(intakes.has_more);
      this.loaded.set(true);
      this.anotherEmail();
    } catch (e) {
      onError(e);
    } finally {
      this.busy.set(false);
      afterNextRender(() => this.loaded() ? this.queueHeading()?.nativeElement.focus() : this.focusSignIn(), { injector: this.injector });
    }
  }

  /** The code field when waiting for a code; else the one-click button (development) or the email field. */
  private focusSignIn(): void {
    const field = this.host.nativeElement.querySelector<HTMLElement>('#agent-code');
    (field ?? this.signInButton()?.nativeElement ?? this.host.nativeElement.querySelector<HTMLElement>('#agent-email'))?.focus();
  }

  /** Sign-in failures: 401 gets the step's own text, 403 not an agent, 429 wait; the rest the generic text. */
  private signInError(e: unknown, on401: keyof Strings): string {
    const status = e instanceof ApiError ? e.status : -1;
    const key = status === 401 ? on401 : status === 403 ? 'agentErr403' : status === 429 ? 'errTooMany' : null;
    return key ? this.t()[key] : errorText(this.t(), e);
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
      this.roles.set([]);
      // The focused row or detail is gone; keep keyboard users on the way back in.
      afterNextRender(() => this.focusSignIn(), { injector: this.injector });
    }
    this.error.set(status === 401 ? this.t().agentErr401 : status === 404 ? this.t().agentErr404 : errorText(this.t(), e));
  }
}
