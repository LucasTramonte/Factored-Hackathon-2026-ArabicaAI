import { Component, ElementRef, OnDestroy, OnInit, Signal, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { Lang, LangService, Strings, errorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { Mark } from '../../shared/mark/mark.component';
import { CustomerPicker } from '../../shared/customer-picker/customer-picker.component';
import { ApiError } from '../../core/http/api.service';
import { CaseBody, ContextCard, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeLang, IntakeReceipt, IntakeStart, IntakeStartBody, Receipt,
  Transaction } from '../../shared/models/intake.model';
import { CustomerService } from './customer.service';

/**
 * The customer flow as one connected screen: intro, sign-in, home. The disc is a single element that
 * travels between the three steps. Sign in, pick one of your own charges, describe it and confirm.
 * A submitted payload and its idempotency key stay frozen until acceptance is known, so a retry
 * can never create a second case or send edited content. A definitive rejection (404, 409, 413 or 422)
 * releases the form so the customer can correct it; that submission then gets a new key.
 */
/** Rejections that retrying can't fix; 401, 503 and network failures keep the frozen retry. */
const DEFINITIVE = new Set([404, 409, 413, 422]);
export type Step = 'intro' | 'login' | 'home';
export type ChatStep = 'describe' | 'choose' | 'receipt' | 'ended';
/** A chat line. Guide lines and FAQ questions are i18n keys, so they follow the interface language; the customer's own words are kept as typed. */
export type ChatLine = { from: 'bot' | 'me'; key: keyof Strings } | { from: 'me'; text: string };
type Frozen = { path: 'start'; body: IntakeStartBody } | { path: 'confirm'; body: IntakeConfirmBody } | { path: 'handoff'; body: IntakeHandoffBody };

/** Provisional (Q1, pending team decision): es and pt map to themselves; English has no report language, so the chat asks. */
export function intakeLanguage(ui: Lang): IntakeLang | null {
  return ui === 'en' ? null : ui;
}
/** FAQ question → fixed answer. Only the dispute process; nothing is answered from free text. */
export const FAQ = { faqNextQ: 'faqNextA', faqTimeQ: 'faqTimeA', faqMissingQ: 'faqMissingA' } as const;
/** Provisional receipt copy per server-decided kind (Q4c). */
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
  readonly client = signal('');
  readonly transactions = signal<Transaction[]>([]);
  readonly receipt = signal<Receipt | null>(null);
  readonly pending = signal<CaseBody | null>(null);
  readonly identities = signal<Identity[]>([]);
  readonly card = signal<ContextCard | null>(null);
  readonly chatOpen = signal(false);
  readonly chosenLang = signal<IntakeLang | null>(null);
  readonly reportLang = computed(() => this.chosenLang() ?? intakeLanguage(this.lang.lang()));
  readonly episode = signal<IntakeStart | null>(null);
  readonly frozen = signal<Frozen | null>(null);
  readonly intakeReceipt = signal<IntakeReceipt | null>(null);
  readonly ended = signal(false);
  readonly chatError = signal('');
  readonly log = signal<ChatLine[]>([{ from: 'bot', key: 'chatHello' }]);
  readonly chatStep = computed<ChatStep>(() => this.intakeReceipt() ? 'receipt' : this.ended() ? 'ended' : this.episode() ? 'choose' : 'describe');
  readonly receiptTitle = computed(() => { const r = this.intakeReceipt(); return r ? this.t()[RECEIPT_TITLE[r.kind]] : ''; });
  readonly faqs = Object.keys(FAQ) as (keyof typeof FAQ)[];
  /** Locked while a request is frozen or a guided report is open: renewing must keep the same customer. */
  readonly identityLocked = computed(() => this.pending() !== null || this.frozen() !== null || this.chatStep() === 'choose');
  readonly step = signal<Step>('intro');
  readonly booted = signal(false);
  readonly sourceTime = formatSourceTime;
  identity = '';
  selected = '';
  statement = '';
  confirmed = false;
  chatStatement = '';
  choice = '';
  chatConfirmed = false;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private shownStep: Step = 'intro';

  /** On a step change (not the first render), move focus to the new step's heading so it doesn't fall to <body>. */
  private readonly focusStepHeading = afterRenderEffect(() => {
    const step = this.step();
    if (step === this.shownStep) return;
    this.shownStep = step;
    this.host.nativeElement.querySelector<HTMLElement>('.step h1')?.focus();
  });

  /** Where the disc sits: boot centre, top dot, login form, sidebar mark. */
  readonly discClass = computed(() => {
    const step = this.step();
    if (step === 'login') return 'disc disc--login';
    if (step === 'home') return 'disc disc--home';
    return this.booted() ? 'disc disc--top' : 'disc disc--boot';
  });
  readonly displayName = computed(() => this.identities().find(i => i.customer_id === this.client())?.display_name ?? this.client());
  readonly initials = computed(() => this.displayName().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'AA');
  /** The charge being reported: the frozen one while a request is pending, else the one chosen in the list. A method, not a computed, because `selected` is a plain field. */
  selectedTx(): Transaction | null {
    return this.transactions().find(tx => tx.transaction_id === (this.pending()?.transaction_id ?? this.selected)) ?? null;
  }
  /** Totals of the loaded charges, per source currency; never converted. */
  readonly totals = computed(() => {
    const sums = new Map<string, number>();
    for (const tx of this.transactions()) {
      const n = Number(tx.amount);
      if (Number.isFinite(n)) sums.set(tx.currency, (sums.get(tx.currency) ?? 0) + n);
    }
    return [...sums.entries()].map(([currency, total]) => ({ currency, total: formatAmount(total) }));
  });

  constructor() {
    // Move focus to the report panel, the receipts and the chat when each appears.
    for (const name of ['reportPanel', 'legacyReceipt', 'intakeReceiptEl', 'chatPanel'] as const) {
      const el: Signal<ElementRef<HTMLElement> | undefined> = this[name];
      effect(() => el()?.nativeElement.focus());
    }
  }
  private readonly reportPanel = viewChild<ElementRef<HTMLElement>>('reportPanel');
  private readonly legacyReceipt = viewChild<ElementRef<HTMLElement>>('legacyReceipt');
  private readonly intakeReceiptEl = viewChild<ElementRef<HTMLElement>>('intakeReceiptEl');
  private readonly chatPanel = viewChild<ElementRef<HTMLElement>>('chatPanel');

  /** Load the identity choices from the API; they come from the same config as the server allowlist. */
  async ngOnInit(): Promise<void> {
    this.bootTimer = setTimeout(() => this.booted.set(true), 2400);
    try {
      this.identities.set(await this.service.identities());
      this.identity ||= this.identities()[0]?.customer_id ?? '';
    } catch (e) {
      this.fail(e);
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.bootTimer);
  }

  start(): void {
    this.booted.set(true);
    this.step.set('login');
  }

  /** Sign in; while a request is pending, re-authenticate as the same identity. */
  async login(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const identity = this.identityLocked() ? this.client() : this.identity;
    if (!this.identityLocked()) this.reset();
    try {
      this.card.set((await this.service.signIn(identity))?.context_card ?? null);
      this.client.set(identity);
      this.transactions.set(await this.service.transactions());
      this.step.set('home');
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Choose the charge to report; the report panel opens under the list. */
  select(transactionId: string): void {
    if (this.pending() || this.receipt()) return;
    this.selected = transactionId;
    this.confirmed = false;
    this.error.set('');
  }

  cancel(): void {
    if (this.pending()) return;
    this.selected = '';
    this.statement = '';
    this.confirmed = false;
    this.receipt.set(null);
    this.error.set('');
  }

  /** Submit once; retries resend the frozen payload with the same key. */
  async submit(): Promise<void> {
    if (this.busy() || this.receipt()) return;
    if (!this.pending()) {
      if (!this.selected || !this.confirmed || [...this.statement.trim()].length < 10) {
        this.error.set(this.t().validation);
        return;
      }
      this.pending.set({ transaction_id: this.selected, customer_statement: this.statement.trim(),
        customer_confirmed: true, idempotency_key: crypto.randomUUID() });
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.receipt.set(await this.service.submitCase(this.pending()!));
      this.pending.set(null);
    } catch (e) {
      if (e instanceof ApiError && DEFINITIVE.has(e.status)) this.pending.set(null);
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  openChat(): void {
    this.chatOpen.set(true);
  }

  /** Start the guided report: statement and report language only; no reference comes back. */
  async send(): Promise<void> {
    if (this.busy() || this.chatStep() !== 'describe') return;
    if (!this.frozen()) {
      const statement = this.chatStatement.trim();
      const language = this.reportLang();
      if (!language || [...statement].length < 10) {
        this.chatError.set(this.t().chatValidation);
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
      const tx = this.transactions().find(t => t.transaction_id === this.choice);
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

  /** Customer-initiated only: a fresh report with a new start key. */
  newReport(): void {
    if (!this.busy() && !this.frozen()) this.clearChat();
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
      }
    } catch (e) {
      if (e instanceof ApiError && DEFINITIVE.has(e.status)) {
        this.frozen.set(null);
        if (frozen.path !== 'start' && e.status === 409) this.ended.set(true);
        if (frozen.path !== 'start') this.chatConfirmed = false;
      }
      this.chatError.set(errorText(this.t(), e));
    } finally {
      this.busy.set(false);
    }
  }

  private call(f: Frozen): Promise<IntakeStart | IntakeReceipt> {
    return f.path === 'start' ? this.service.startIntake(f.body) : f.path === 'confirm' ? this.service.confirmIntake(f.body) : this.service.handoffIntake(f.body);
  }

  merchantInitials(tx: Transaction): string {
    return tx.merchant_name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  private reset(): void {
    this.client.set('');
    this.transactions.set([]);
    this.selected = '';
    this.statement = '';
    this.confirmed = false;
    this.receipt.set(null);
    this.card.set(null);
    this.chosenLang.set(null);
    this.clearChat();
  }

  private fail(e: unknown): void {
    this.error.set(errorText(this.t(), e));
  }
}

/** 1234567.5 → "1 234 567.50": thin-space grouping, always two decimals, the currency code goes beside it. */
export function formatAmount(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + dec;
}
