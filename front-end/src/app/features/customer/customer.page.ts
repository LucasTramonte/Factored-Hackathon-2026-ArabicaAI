import { Component, ElementRef, Injector, OnDestroy, OnInit, Signal, afterNextRender, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { Lang, LangService, Strings, checkText, errorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { CustomerPicker } from '../../shared/customer-picker/customer-picker.component';
import { ApiError } from '../../core/http/api.service';
import { Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeLang, IntakeReceipt, IntakeStart, IntakeStartBody,
  Transaction } from '../../shared/models/intake.model';
import { CustomerService } from './customer.service';

/**
 * The customer flow: sign-in (with the purpose stated on the same screen), then home. Nothing animates and
 * nothing waits on a timer. Sign in, then the guided chat: describe the charge, choose and confirm
 * one of your own charges, or ask for review without one. A submitted payload and its idempotency key
 * stay frozen until acceptance is known, so a retry
 * can never create a second case or send edited content. A definitive rejection (404, 409, 413 or 422)
 * releases the form so the customer can correct it; that submission then gets a new key.
 */
/** Rejections that retrying can't fix; 401, 503 and network failures keep the frozen retry. */
const DEFINITIVE = new Set([404, 409, 413, 422]);
export type Step = 'login' | 'home';
export type ChatStep = 'describe' | 'choose' | 'receipt' | 'ended';
/** A chat line. Guide lines and FAQ questions are i18n keys, so they follow the interface language; the customer's own words are kept as typed. */
export type ChatLine = { from: 'bot' | 'me'; key: keyof Strings } | { from: 'me'; text: string };
type Frozen = { path: 'start'; body: IntakeStartBody } | { path: 'confirm'; body: IntakeConfirmBody } | { path: 'handoff'; body: IntakeHandoffBody };

/** es and pt map to themselves; English has no report language, so the chat asks (no default). */
export function intakeLanguage(ui: Lang): IntakeLang | null {
  return ui === 'en' ? null : ui;
}
/** FAQ question → fixed answer. Only the dispute process; nothing is answered from free text. */
export const FAQ = { faqNextQ: 'faqNextA', faqTimeQ: 'faqTimeA', faqMissingQ: 'faqMissingA' } as const;
/** Receipt title per server-decided kind. */
const RECEIPT_TITLE = { complete: 'receiptComplete', incomplete: 'receiptIncomplete', technical: 'receiptTechnical' } as const;

@Component({
  selector: 'app-customer-page',
  imports: [DatePipe, FormsModule, RouterLink, LangSwitch, Mark, CustomerPicker],
  templateUrl: './customer.page.html',
  styleUrl: './customer.page.css'
})
export class CustomerPage implements OnInit, OnDestroy {
  private readonly service = inject(CustomerService);
  readonly lang = inject(LangService);
  readonly t = this.lang.t;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly client = this.service.client;
  readonly card = this.service.card;
  /** Every receipt from this tab's session, newest last; kept across new reports and in-app navigation. */
  readonly receipts = this.service.receipts;
  readonly transactions = signal<Transaction[]>([]);
  readonly hasMore = signal(false);
  readonly identities = signal<Identity[]>([]);
  /** True while the identity list is on its way, so the sign-in screen never looks stuck. */
  readonly identitiesLoading = signal(false);
  readonly chatOpen = signal(false);
  readonly chosenLang = signal<IntakeLang | null>(null);
  readonly reportLang = computed(() => this.chosenLang() ?? intakeLanguage(this.lang.lang()));
  /** The report-language choice is shown when the interface has no report language, and stays once the customer has chosen. */
  readonly askLang = computed(() => !this.reportLang() || this.chosenLang() !== null);
  readonly episode = signal<IntakeStart | null>(null);
  readonly frozen = signal<Frozen | null>(null);
  readonly intakeReceipt = signal<IntakeReceipt | null>(null);
  readonly ended = signal(false);
  readonly chatError = signal('');
  readonly log = signal<ChatLine[]>([{ from: 'bot', key: 'chatHello' }]);
  /** The guide spoke last, so its line (id `chat-prompt`) describes the step that just took focus. */
  readonly promptLast = computed(() => this.log().at(-1)?.from === 'bot');
  readonly chatStep = computed<ChatStep>(() => this.intakeReceipt() ? 'receipt' : this.ended() ? 'ended' : this.episode() ? 'choose' : 'describe');
  readonly receiptTitle = computed(() => { const r = this.intakeReceipt(); return r ? this.t()[RECEIPT_TITLE[r.kind]] : ''; });
  readonly faqs = Object.keys(FAQ) as (keyof typeof FAQ)[];
  readonly receiptTitleKey = RECEIPT_TITLE;
  /** Charges already accepted in this session are not offered again. */
  readonly choosable = computed(() => this.transactions().filter(tx => !this.receipts().some(r => r.receipt.kind === 'complete' && r.transactionId === tx.transaction_id)));
  /** Locked while a request is frozen or a guided report is open: renewing must keep the same customer. */
  readonly identityLocked = computed(() => this.frozen() !== null || this.chatStep() === 'choose');
  readonly step = signal<Step>('login');
  /** At the home-top breakpoint and below, the open chat panel covers page controls, so the page behind it is inert (WCAG 2.4.11). */
  // Keep 1180px in sync with the @media rules in styles.css and customer.page.css.
  private readonly narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 1180px)') : null;
  readonly narrow = signal(this.narrowQuery?.matches ?? false);
  readonly sourceTime = formatSourceTime;
  identity = '';
  chatStatement = '';
  choice = '';
  chatConfirmed = false;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private shownStep: Step = 'login';

  /** On a step change (not the first render), move focus to the new step's heading so it doesn't fall to <body>. */
  private readonly focusStepHeading = afterRenderEffect(() => {
    const step = this.step();
    if (step === this.shownStep) return;
    this.shownStep = step;
    this.host.nativeElement.querySelector<HTMLElement>('.step h1')?.focus();
  });

  readonly displayName = computed(() => this.identities().find(i => i.customer_id === this.client())?.display_name ?? this.client());
  readonly initials = computed(() => initialsOf(this.displayName()) || 'AA');

  constructor() {
    // Move focus to the receipt, the choose step (it replaces the focused Send button) and the chat heading when each appears;
    // the heading is last, so opening the panel focuses it.
    for (const name of ['intakeReceiptEl', 'chooseStep', 'chatPanel'] as const) {
      const el: Signal<ElementRef<HTMLElement> | undefined> = this[name];
      effect(() => el()?.nativeElement.focus());
    }
  }
  private readonly intakeReceiptEl = viewChild<ElementRef<HTMLElement>>('intakeReceiptEl');
  private readonly chatPanel = viewChild<ElementRef<HTMLElement>>('chatPanel');
  /** The control that opened the panel (a charge row's Report button), so closing can return focus to it. */
  private opener: HTMLElement | null = null;

  /** Close the guided chat and return focus to the control that opened it, else to the page heading. */
  closeChat(): void {
    this.chatOpen.set(false);
    afterNextRender(() => (this.opener?.isConnected ? this.opener : this.host.nativeElement.querySelector<HTMLElement>('.step h1'))?.focus(), { injector: this.injector });
  }
  private readonly chooseStep = viewChild<ElementRef<HTMLElement>>('chooseStep');

  /** Load the identity choices from the API; they come from the same config as the server allowlist. */
  async ngOnInit(): Promise<void> {
    if (this.narrowQuery) this.narrowQuery.onchange = e => this.narrow.set(e.matches);
    if (this.client()) void this.resume();
    this.identitiesLoading.set(true);
    try {
      this.identities.set(await this.service.identities());
      this.identity ||= this.identities()[0]?.customer_id ?? '';
    } catch (e) {
      this.fail(e);
    } finally {
      this.identitiesLoading.set(false);
    }
  }

  ngOnDestroy(): void {
    if (this.narrowQuery) this.narrowQuery.onchange = null;
  }

  /** A server check or open-question code in the interface language. */
  check(code: string): string {
    return checkText(this.t(), code);
  }

  /** Sign in; while a request is pending, re-authenticate as the same identity. */
  async login(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const identity = this.identityLocked() ? this.client() : this.identity;
    if (!this.identityLocked() && identity !== this.client()) this.reset();
    try {
      this.card.set((await this.service.signIn(identity))?.context_card ?? null);
      this.client.set(identity);
      await this.loadTransactions();
      this.step.set('home');
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Back from another in-app view in this tab: show the same customer's home again; the cookie still decides access. */
  private async resume(): Promise<void> {
    this.step.set('home');
    try {
      await this.loadTransactions();
    } catch (e) {
      this.fail(e);
    }
  }

  private async loadTransactions(): Promise<void> {
    const list = await this.service.transactions();
    this.transactions.set(list.items);
    this.hasMore.set(list.has_more);
  }

  /** Open the chat; from a charge row, that charge is preselected (the customer still confirms it). */
  openChat(transactionId?: string): void {
    this.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    this.chatOpen.set(true);
    if (transactionId && !this.frozen() && this.chatStep() !== 'receipt' && this.chatStep() !== 'ended') {
      this.choice = transactionId;
      this.chatConfirmed = false;
    }
  }

  /** The row chip: accepted in this session, or a confirmation whose acceptance is not yet known. */
  reportedState(transactionId: string): 'accepted' | 'chipPending' | null {
    const frozen = this.frozen();
    if (frozen?.path === 'confirm' && frozen.body.transaction_id === transactionId) return 'chipPending';
    return this.receipts().some(r => r.receipt.kind === 'complete' && r.transactionId === transactionId) ? 'accepted' : null;
  }

  /** Start the guided report: statement and report language only; no reference comes back. */
  async send(): Promise<void> {
    if (this.busy() || this.chatStep() !== 'describe') return;
    if (!this.frozen()) {
      const statement = this.chatStatement.trim();
      const language = this.reportLang();
      if (!language || [...statement].length < 10) {
        this.chatError.set(this.askLang() ? this.t().chatValidation : this.t().chatValidationShort);
        return;
      }
      this.frozen.set({ path: 'start', body: { customer_statement: statement, idempotency_key: crypto.randomUUID(), language,
        mode: 'guided', report_type: 'unrecognized_charge' } });
      this.log.update(l => [...l, { from: 'me', text: statement }]);
    }
    await this.run();
  }

  /** Confirm one of the customer's own charges, with its own key. */
  async confirmCharge(): Promise<void> {
    const episode = this.episode();
    if (this.busy() || !episode || this.chatStep() !== 'choose' || this.frozen()?.path === 'handoff') return;
    if (!this.frozen()) {
      const tx = this.choosable().find(t => t.transaction_id === this.choice);
      if (!tx || !this.chatConfirmed) {
        this.chatError.set(this.t().chatChooseValidation);
        return;
      }
      this.frozen.set({ path: 'confirm', body: { customer_confirmed: true, episode_id: episode.episode_id,
        idempotency_key: crypto.randomUUID(), transaction_id: tx.transaction_id } });
      this.log.update(l => [...l, { from: 'me', text: `${tx.merchant_name || this.t().noMerchant} · ${tx.amount} ${tx.currency}` }]);
    }
    await this.run();
  }

  /** Ask for human review without a confirmed charge. */
  async cannotFind(): Promise<void> {
    const episode = this.episode();
    if (this.busy() || !episode || this.chatStep() !== 'choose' || this.frozen()?.path === 'confirm') return;
    if (!this.frozen()) {
      this.frozen.set({ path: 'handoff', body: { episode_id: episode.episode_id, idempotency_key: crypto.randomUUID(), kind: 'incomplete' } });
      this.log.update(l => [...l, { from: 'me', key: 'chatCannotFind' }]);
    }
    await this.run();
  }

  /** Customer-initiated only: a fresh report with a new start key. The button that called it is removed, so focus goes to the chat heading. */
  newReport(): void {
    if (this.busy() || this.frozen()) return;
    this.clearChat();
    this.chatPanel()?.nativeElement.focus();
  }

  private clearChat(): void {
    this.frozen.set(null);
    this.episode.set(null);
    this.intakeReceipt.set(null);
    this.ended.set(false);
    this.chatError.set('');
    this.chatStatement = '';
    this.choice = '';
    this.chatConfirmed = false;
    this.log.set([{ from: 'bot', key: 'chatHello' }]);
  }

  ask(question: keyof typeof FAQ): void {
    const answer = FAQ[question];
    if (!answer) throw new Error('Unknown FAQ');
    this.log.update(l => [...l, { from: 'me', key: question }, { from: 'bot', key: answer }]);
  }

  /** Send the frozen request. One 401 renews the same customer and retries the same body; after that the manual Renew/Retry stays. */
  async run(): Promise<void> {
    const frozen = this.frozen();
    if (this.busy() || !frozen) return;
    this.busy.set(true);
    this.chatError.set('');
    try {
      let result: IntakeStart | IntakeReceipt;
      try {
        result = await this.call(frozen);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        try {
          this.card.set((await this.service.signIn(this.client()))?.context_card ?? null);
        } catch (renewal) {
          this.chatError.set(errorText(this.t(), renewal));
          return;
        }
        result = await this.call(frozen);
      }
      this.frozen.set(null);
      if (frozen.path === 'start') {
        this.episode.set(result as IntakeStart);
        this.log.update(l => [...l, { from: 'bot', key: 'chatChoose' }]);
      } else {
        this.intakeReceipt.set(result as IntakeReceipt);
        this.receipts.update(list => [...list, { receipt: result as IntakeReceipt, transactionId: frozen.path === 'confirm' ? frozen.body.transaction_id : null }]);
      }
    } catch (e) {
      if (e instanceof ApiError && DEFINITIVE.has(e.status)) {
        this.frozen.set(null);
        if (frozen.path !== 'start') this.chatConfirmed = false;
      }
      // A finish 409 means the report is already submitted or closed: say so, and offer a new report.
      const finish409 = frozen.path !== 'start' && e instanceof ApiError && e.status === 409;
      if (finish409) this.ended.set(true);
      this.chatError.set(finish409 ? this.t().err409Finish : errorText(this.t(), e));
    } finally {
      this.busy.set(false);
    }
  }

  private call(f: Frozen): Promise<IntakeStart | IntakeReceipt> {
    return f.path === 'start' ? this.service.startIntake(f.body) : f.path === 'confirm' ? this.service.confirmIntake(f.body) : this.service.handoffIntake(f.body);
  }

  merchantInitials(tx: Transaction): string {
    return initialsOf(tx.merchant_name);
  }

  private reset(): void {
    this.client.set('');
    this.transactions.set([]);
    this.hasMore.set(false);
    this.card.set(null);
    this.receipts.set([]);
    this.chosenLang.set(null);
    this.clearChat();
  }

  private fail(e: unknown): void {
    this.error.set(errorText(this.t(), e));
  }
}


/** Up to two initials from the words that start with a Unicode letter: "Ana (demo)" → "A", "José da Silva" → "JD". */
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(w => /^\p{L}/u.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
