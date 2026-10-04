import { Component, effect, inject, input, output, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LangService } from '../i18n/lang.service';
import { MessageThread } from '../models/intake.model';

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
      <h3 [id]="idPrefix() + '-title'">{{ t().messagesTitle }}</h3>
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
        <textarea class="ar-textarea" [id]="idPrefix() + '-draft'" [(ngModel)]="draft" rows="3" maxlength="2000" [readOnly]="!thread()?.can_post"
          [attr.aria-invalid]="empty ? true : null" [attr.aria-describedby]="empty || failed() ? idPrefix() + '-error' : null"></textarea>
        <div class="report-actions"><button type="button" class="ar-btn ar-btn-sm message-send" (click)="submit()" [disabled]="!thread()?.can_post" [attr.aria-disabled]="sending() || !thread()?.can_post">{{ t().messageSend }}</button></div>
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
  /** Bumped by the page after a successful post on this report, which clears the draft. */
  readonly sent = input(0);
  /** The report shown (its protocol): a different report never inherits the previous one's draft. */
  readonly scope = input('');
  readonly send = output<string>();
  draft = '';
  empty = false;

  constructor() {
    effect(() => { this.sent(); this.scope(); untracked(() => { this.draft = ''; this.empty = false; }); });
  }

  submit(): void {
    if (this.sending() || !this.thread()?.can_post) return;
    const body = this.draft.trim();
    this.empty = !body;
    if (body) this.send.emit(body);
  }
}
