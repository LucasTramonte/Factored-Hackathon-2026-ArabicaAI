import { Component, effect, inject, input, output, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LangService } from '../i18n/lang.service';
import { MessageThread, MessageDraft } from '../models/intake.model';

/**
 * One report's messages between the customer and the agent (ADR-015), shared by both views. Presentational: the page
 * loads the thread and posts (``send`` emits the trimmed text); ``sent`` changing clears the draft after a success.
 * Text is rendered as text (interpolation), never as HTML.
 */
@Component({
  selector: 'app-message-thread',
  standalone: true,
  imports: [DatePipe, FormsModule],
  template: `
    <section class="message-thread" [attr.aria-labelledby]="idPrefix() + '-title'">
      <h3 [id]="idPrefix() + '-title'">{{ viewer() === 'customer' ? t().messagesTeamTitle : t().messagesTitle }}</h3>
      <ol class="messages" role="log" aria-live="polite">
        @for (m of thread()?.items ?? []; track m.message_id) {
          <li [class]="'message message-' + m.author + (m.author === viewer() ? ' message-mine' : '')">
            <span class="ar-caption">{{ m.author === viewer() ? t().messageYou : m.author === 'agent' ? t().messageAgent : t().messageCustomer }}
              · {{ m.created_at | date:'yyyy-MM-dd HH:mm':'UTC' }} {{ t().utc }}</span>
            <p>{{ m.body }}</p>
          </li>
        } @empty {
          <li class="ar-caption messages-empty">{{ thread() ? t().messagesNone : failed() ? '' : t().messagesLoading }}</li>
        }
      </ol>
      @if (thread()?.can_post || draft) {
        <label class="ar-field" [for]="idPrefix() + '-draft'"><span class="ar-field-label">{{ t().messageLabel }}</span></label>
        <!-- The customer must know before sending that a person, not the AI help, reads this (ADR-002). -->
        @if (viewer() === 'customer') { <p class="ar-caption message-human-note" role="note" [id]="idPrefix() + '-human'">{{ t().messageHumanNote }}</p> }
        <textarea class="ar-textarea" [id]="idPrefix() + '-draft'" [(ngModel)]="draft" rows="3" maxlength="2000" [readOnly]="!thread()?.can_post"
          [attr.aria-invalid]="empty ? true : null" [attr.aria-describedby]="describedBy()"></textarea>
        <div class="report-actions"><button type="button" class="ar-btn ar-btn-sm message-send" (click)="submit()" [disabled]="!thread()?.can_post || sendBlocked()" [attr.aria-disabled]="sending() || !thread()?.can_post || sendBlocked()">{{ retry() ? t().messageRetry : viewer() === 'customer' ? t().messageSendTeam : t().messageSend }}</button></div>
      }
      @if (thread() && !thread()!.can_post) {
        <p class="ar-caption messages-readonly">{{ thread()!.status === 'closed' ? t().messagesClosed : t().messagesFull }}</p>
      }
      @if (empty || failed()) { <p class="ar-small" role="alert" [id]="idPrefix() + '-error'">{{ empty ? t().messageEmpty : failed() }}</p> }
    </section>
  `,
  styles: [`
    .message-thread { margin-top: 12px; display: grid; gap: 8px; }
    .messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .message { max-width: 85%; padding: 8px 12px; border-radius: var(--radius-md); overflow-wrap: anywhere; align-self: flex-start;
      background: var(--surface-sunken); }
    .message-mine { align-self: flex-end; background: var(--accent-soft); }
    .message p { margin: 2px 0 0; white-space: pre-wrap; font: 400 14px/20px var(--font-sans); }
    .message-human-note { margin: -4px 0 0; }
  `]
})
export class MessageThreadView {
  readonly t = inject(LangService).t;
  readonly thread = input<MessageThread | null>(null);
  /** Who is reading: their own messages are labelled "You". */
  readonly viewer = input<'agent' | 'customer'>('customer');
  readonly idPrefix = input('messages');
  readonly sending = input(false);
  readonly failed = input('');
  readonly retry = input(false);
  /** Bumped by the page after a successful post on this report, which clears the draft. */
  readonly sent = input(0);
  /** The report shown (its protocol): a different report never inherits the previous one's draft. */
  readonly scope = input('');
  readonly send = output<string>();
  /** Parent explicitly accepted this version, confirming any unsent-text replacement first. Null invalidates only an applied AI draft. */
  readonly acceptedDraft = input<MessageDraft | null>(null);
  readonly sendBlocked = input(false);
  private acceptedVersion: number | null = null;
  draft = '';
  empty = false;

  constructor() {
    effect(() => { this.sent(); this.scope(); untracked(() => { this.draft = ''; this.empty = false; this.acceptedVersion = null; }); });
    effect(() => {
      const seed = this.acceptedDraft();
      const scope = this.scope();
      untracked(() => {
        if (seed?.scope === scope && seed.version !== this.acceptedVersion) {
          this.draft = seed.body; this.empty = false; this.acceptedVersion = seed.version;
        } else if (!seed && this.acceptedVersion !== null) {
          this.draft = ''; this.acceptedVersion = null;
        }
      });
    });
  }

  /** The customer's textarea is described by the human-team note, plus the error once there is one. */
  describedBy(): string | null {
    const ids = [this.viewer() === 'customer' ? this.idPrefix() + '-human' : '', this.empty || this.failed() ? this.idPrefix() + '-error' : ''].filter(Boolean);
    return ids.length ? ids.join(' ') : null;
  }

  submit(): void {
    if (this.sending() || this.sendBlocked() || !this.thread()?.can_post) return;
    const body = this.draft.trim();
    this.empty = !body;
    if (body) this.send.emit(body);
  }
}
