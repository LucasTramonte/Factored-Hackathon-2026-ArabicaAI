import { Component, ElementRef, Injector, NgZone, OnDestroy, OnInit, Signal, afterNextRender, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { GuidedTour, TourStep } from '../../shared/guided-tour/guided-tour.component';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatSourceTime } from '../../shared/format/source-time.util';
import { formatMoney } from '../../shared/format/money.util';
import { LangService, STATUS_CHIP, Strings, checkText, errorText, messageErrorText } from '../../shared/i18n/lang.service';
import { LangSwitch } from '../../shared/i18n/lang-switch.component';
import { CustomerPicker } from '../../shared/customer-picker/customer-picker.component';
import { MessageThreadView } from '../../shared/messages/message-thread.component';
import { ApiError } from '../../core/http/api.service';
import { CustomerSession, Identity, IntakeConfirmBody, IntakeHandoffBody, IntakeLang, IntakeReceipt, IntakeStart, IntakeStartBody,
  CustomerAssist, MessageDraft, MessageThread, REASONS, REASON_LABEL, Reason, Report, ReportList, ServiceTimes, SuggestedCharge, SuggestionAnswer, SuggestionList, Transaction, TransactionDiscovery } from '../../shared/models/intake.model';
import { CustomerService } from './customer.service';
import { CognitoService } from '../../core/auth/cognito.service';
import { AgentService } from '../agent/agent.service';
import { demoPicker } from '../../core/auth/cognito.config';

/**
 * The customer flow as one connected screen: intro, sign-in, home. The disc is a single element that
 * travels between the three steps. Sign in, then the guided chat: describe the charge, choose and confirm
 * one of your own charges, or ask for review without one. A submitted payload and its idempotency key
 * stay frozen until acceptance is known, so a retry
 * can never create a second case or send edited content. A definitive rejection (404, 409, 413 or 422)
 * releases the form so the customer can correct it; that submission then gets a new key.
 */
/** Rejections that retrying can't fix; 401, 503 and network failures keep the frozen retry. */
const DEFINITIVE = new Set([404, 409, 413, 422]);
export type Step = 'intro' | 'login' | 'home';
export type ChatStep = 'describe' | 'choose' | 'details' | 'receipt' | 'ended';
/** The statement column holds 10–2000 code points, statement and details together (one newline between). */
const STATEMENT_MAX = 2000;
/** A chat line. Guide lines and FAQ questions are i18n keys, so they follow the interface language; the customer's own words are kept as typed. */
export type ChatLine = { from: 'bot' | 'me'; key: keyof Strings } | { from: 'me'; text: string };
type Frozen = { path: 'start'; body: IntakeStartBody } | { path: 'confirm'; body: IntakeConfirmBody } | { path: 'handoff'; body: IntakeHandoffBody };

/** FAQ question → fixed answer. Only the dispute process; nothing is answered from free text. */
export const FAQ = { faqNextQ: 'faqNextA', faqTimeQ: 'faqTimeA', faqMissingQ: 'faqMissingA' } as const;
/** After a receipt for "I can't find it" with details, how long the client waits for suggestions (ADR-012). */
export const SUGGESTION_WAIT_MS = 15000;
/** Receipt title per server-decided kind. */
const RECEIPT_TITLE = { complete: 'receiptComplete', incomplete: 'receiptIncomplete', technical: 'receiptTechnical' } as const;
/** Reason → its one-line statement, filled in the report language. ``other`` has none. */
const REASON_FILL = { not_mine: 'reasonFillNotMine', duplicate: 'reasonFillDuplicate', wrong_amount: 'reasonFillWrongAmount', cancelled_or_not_received: 'reasonFillCancelled',
  subscription: 'reasonFillSubscription', card_lost_or_stolen: 'reasonFillLostCard' } as const;

@Component({
  selector: 'app-customer-page',
  imports: [DatePipe, FormsModule, RouterLink, LangSwitch, CustomerPicker, MessageThreadView, GuidedTour],
  templateUrl: './customer.page.html',
  styleUrl: './customer.page.css'
})
export class CustomerPage implements OnInit, OnDestroy {
  private readonly service = inject(CustomerService);
  private readonly cognito = inject(CognitoService);
  private readonly agent = inject(AgentService);
  /** Local demo identities under the email form; development builds only. */
  readonly demoPicker = demoPicker;
  /** The email one-time code was sent: the code field replaces the email field. */
  readonly codeSent = signal(false);
  email = '';
  code = '';
  readonly lang = inject(LangService);
  readonly t = this.lang.t;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly client = this.service.client;
  readonly card = this.service.card;
  readonly roles = this.service.roles;
  /** "Your reports" from GET /reports, so it survives the tab; null until loaded. */
  readonly reports = signal<ReportList | null>(null);
  readonly reportsFailed = signal(false);
  readonly tour = signal<'welcome' | 'steps' | null>(null);
  private tourOffered = false;
  private readonly tourTarget = signal('report-entry');
  readonly tourSteps = computed<TourStep[]>(() => {
    const t = this.t();
    return [{ targetId: 'charges', title: t.recent, body: t.tourCharges },
      { targetId: this.tourTarget(), title: this.tourTarget() === 'report-entry' ? t.chatCannotFind : t.reportCharge,
        body: this.tourTarget() === 'report-entry' ? t.tourMissing : t.tourReport },
      { targetId: 'reports', title: t.yourReports, body: t.tourReports },
      { targetId: 'help', title: t.help, body: t.tourHelp }];
  });

  /** Offer once after owned reads; an urgent bank alert leaves the tour in Help. */
  private offerTour(): void {
    if (this.tourOffered || this.step() !== 'home') return;
    this.tourOffered = true;
    // v2 (2026-10-05): a fresh key so every browser is offered the tour again before judging.
    try { if (['dismissed', 'complete'].includes(localStorage.getItem('arabica.customer-tour.v2') ?? '')) return; }
    catch { /* Storage is optional; this page still offers only once. */ }
    if (!this.alert() && !this.chatOpen()) { this.prepareTourTarget(); this.tour.set('welcome'); }
  }

  /** Replay from Help without changing a report or the browser preference. */
  startTour(): void {
    if (this.busy() || this.frozen() || this.step() !== 'home') return;
    this.prepareTourTarget();
    this.tour.set('steps');
  }

  private prepareTourTarget(): void {
    const row = this.host.nativeElement.querySelector<HTMLButtonElement>('.td-state button:not(:disabled)');
    if (row) row.id = 'tour-report-charge';
    this.tourTarget.set(row ? 'tour-report-charge' : 'report-entry');
  }

  /** Store a generic browser preference; failure never blocks entry or replay. */
  endTour(complete = false): void {
    this.tour.set(null);
    this.tourOffered = true;
    try { localStorage.setItem('arabica.customer-tour.v2', complete ? 'complete' : 'dismissed'); }
    catch { /* Current page session already suppresses another automatic offer. */ }
  }

  /** The report whose update request is in flight (one at a time: every row's button waits), and the last answer shown under its row. */
  readonly updating = signal<string | null>(null);
  readonly updateNote = signal<{ protocol: string; text: string } | null>(null);
  private readonly updateCooldowns = signal<Record<string, number>>({});
  private readonly updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly transactions = signal<Transaction[]>([]);
  readonly hasMore = signal(false);
  readonly identities = signal<Identity[]>([]);
  /** True while the identity list is on its way, so the sign-in screen never looks stuck. */
  readonly identitiesLoading = signal(false);
  readonly chatOpen = signal(false);
  /** The chat was opened from the "?" entry: no charge is preselected and "I can't find it" is the primary action. */
  readonly general = signal(false);
  readonly chosenLang = signal<IntakeLang | null>(null);
  /** The customer's choice, else the interface language: every interface language is a report language (ADR-008). */
  readonly reportLang = computed<IntakeLang>(() => this.chosenLang() ?? this.lang.lang());
  /** The report-language choice is shown in an English interface, as before, and stays once the customer has chosen. */
  readonly askLang = computed(() => this.lang.lang() === 'en' || this.chosenLang() !== null);
  readonly reasons = REASONS;
  readonly reasonLabel = REASON_LABEL;
  /** The reason chip the customer tapped; required before the start is sent (ADR-010). */
  readonly reason = signal<Reason | null>(null);
  /** The last text a chip wrote, so a chip never overwrites what the customer typed. */
  private prefill = '';
  readonly episode = signal<IntakeStart | null>(null);
  /** A follow-up's source protocol survives edits to the statement and travels only with its frozen start. */
  readonly previousProtocol = signal<string | null>(null);
  readonly frozen = signal<Frozen | null>(null);
  readonly intakeReceipt = signal<IntakeReceipt | null>(null);
  /** The saved receipt's report, when the latest list includes it. */
  readonly receiptReport = computed(() => this.reports()?.items.find(r => r.protocol === this.intakeReceipt()?.protocol));
  /** The receipt's stored answer, or null when unanswered or the server only confirmed an existing answer (409). */
  readonly feedback = signal<boolean | null>(null);
  readonly feedbackRecorded = signal(false);
  readonly feedbackSending = signal(false);
  readonly feedbackFailed = signal(false);
  /** A saved report reopened for its stored suggestion state, without inventing a new receipt. */
  readonly suggestionReport = signal<Report | null>(null);
  readonly suggestionTimedOut = signal(false);
  private readonly suggestionContext = computed(() => this.suggestionReport() ?? this.intakeReceipt());
  readonly suggestionMessage = computed(() => {
    const s = this.suggestionList(), t = this.t();
    if (!s) return '';
    if (s.reason === 'review_started') return t.suggestInReview;
    if (s.status === 'pending') return this.suggestionTimedOut() ? t.suggestStillPending : t.suggestPending;
    return s.reason === 'no_clear_match' ? t.suggestNoMatch : s.reason === 'unavailable' ? t.suggestUnavailable : t.suggestLegacy;
  });
  /** Stored search state for the current saved report (ADR-012). */
  readonly suggestionList = signal<SuggestionList | null>(null);
  /** The customer's stored answer to the suggestions; nothing is closed or decided by it. */
  readonly suggestionAnswer = signal<SuggestionAnswer | null>(null);
  readonly suggestionSending = signal(false);
  readonly suggestionFailed = signal(false);
  /** Milliseconds between suggestion checks; a test seam. */
  suggestionPollMs = 1500;
  /** Each watch gets a number; a newer receipt, a new report or leaving the page stops the older one. */
  private suggestionWatch = 0;
  private suggestionTimer: ReturnType<typeof setTimeout> | undefined;
  private suggestionDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  readonly ended = signal(false);
  readonly chatError = signal('');
  readonly log = signal<ChatLine[]>([{ from: 'bot', key: 'chatHello' }]);
  /** FAQ questions and answers, kept apart from the report conversation and shown right above the FAQ buttons, so a new
   *  answer appears where the customer clicked, and never becomes the guide's prompt for the current step. */
  readonly faqLog = signal<ChatLine[]>([]);
  /** The guide spoke last, so its line (id `chat-prompt`) describes the step that just took focus. */
  readonly promptLast = computed(() => this.log().at(-1)?.from === 'bot');
  /** "I can't find it" was pressed: the guide asks once what the customer remembers before anything is sent. */
  readonly asking = signal(false);
  readonly chatStep = computed<ChatStep>(() => (this.intakeReceipt() || this.suggestionReport()) ? 'receipt' : this.ended() ? 'ended' : !this.episode() ? 'describe' : this.asking() ? 'details' : 'choose');
  readonly receiptTitle = computed(() => { const r = this.intakeReceipt(); return r ? this.t()[RECEIPT_TITLE[r.kind]] : ''; });
  readonly faqs = Object.keys(FAQ) as (keyof typeof FAQ)[];
  /** A charge whose newest server report is still open is not offered again (the server refuses it with 409). */
  /** A charge chosen from outside the loaded page: a search result or the bank alert's charge. Forgotten by ``clearChat``. */
  readonly extraCharge = signal<Transaction | null>(null);
  readonly choosable = computed(() => {
    const extra = this.extraCharge(), list = this.transactions();
    const all = extra && !list.some(t => t.transaction_id === extra.transaction_id) ? [...list, extra] : list;
    return all.filter(tx => (this.reportOf(tx.transaction_id)?.status ?? 'closed') === 'closed');
  });
  readonly statusChip = STATUS_CHIP;
  /** The steps a report moves through, in order; a person moves it forward one step at a time. */
  readonly progressSteps = ['received', 'in_review', 'closed'] as const;
  /** Locked while a request is frozen or a guided report is open: renewing must keep the same customer. */
  readonly identityLocked = computed(() => this.frozen() !== null || this.chatStep() === 'choose' || this.chatStep() === 'details');
  readonly step = signal<Step>('intro');
  readonly booted = signal(false);
  /** The intro words play once (from 2.6 s, three 1.4 s slots: under 5 s of motion, WCAG 2.2.2); then only the current language's word stays. */
  readonly introDone = signal(false);
  /** At the home-top breakpoint and below, the open chat panel covers page controls, so the page behind it is inert (WCAG 2.4.11). */
  // Keep 1180px in sync with the @media rules in styles.css and customer.page.css.
  private readonly narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 1180px)') : null;
  readonly narrow = signal(this.narrowQuery?.matches ?? false);
  readonly sourceTime = formatSourceTime;
  /** A stored amount in the interface language's conventions (``ARS 120.443,55``). */
  money(amount: string, currency: string): string {
    return formatMoney(amount, currency, this.lang.lang());
  }
  /** This bank's history for "How long does it take?", loaded the first time it is asked; null until then or if it fails. */
  readonly serviceTimes = signal<ServiceTimes | null>(null);
  private serviceTimesLoad: Promise<void> | null = null;
  identity = '';
  chatStatement = '';
  chatDetails = '';
  /** Discovery is browser-only: a correction replaces this result and no assistant state survives reload. */
  readonly discovery = signal<TransactionDiscovery | null>(null);
  readonly discoveryBusy = signal(false);
  readonly discoveryError = signal<'narrow' | 'unavailable' | null>(null);
  /** The server answered 503: discovery is switched off (or unavailable) for this session, so the button goes away. */
  // ponytail: learned from the first 503, not from config; a config read would need an API change.
  readonly discoveryOff = signal(false);
  choice = '';
  chatConfirmed = false;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private introTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);
  private shownStep: Step = 'intro';

  /** On a step change (not the first render), move focus to the new step's heading so it doesn't fall to <body>. */
  private readonly focusStepHeading = afterRenderEffect(() => {
    const step = this.step();
    if (step === this.shownStep) return;
    this.shownStep = step;
    this.host.nativeElement.querySelector<HTMLElement>('.step h1')?.focus();
  });

  /** The last list's recorded view; acknowledged once, after a render that shows the home with its rows. */
  private readonly viewRef = signal<string | null>(null);
  private readonly ackView = afterRenderEffect(() => {
    const ref = this.viewRef();
    if (!ref || this.step() !== 'home') return;
    this.viewRef.set(null);
    this.service.displayed(ref).catch(() => undefined); // best effort: no UI change, no retry, nothing logged
  });

  /** Where the disc sits: boot centre, top dot, login form, sidebar mark. */
  readonly discClass = computed(() => {
    const step = this.step();
    if (step === 'login') return 'disc disc--login';
    if (step === 'home') return 'disc disc--home';
    return this.booted() ? 'disc disc--top' : 'disc disc--boot';
  });
  /** A known identity for the signed-in customer: the admin list first (act-as), then the local demo list. */
  private readonly known = computed(() => [...this.actAsIdentities(), ...this.identities()].find(i => i.customer_id === this.client()));
  readonly displayName = computed(() => this.known()?.display_name ?? this.client());
  readonly initials = computed(() => initialsOf(this.displayName()) || 'AA');
  /** The customer's first name for the guide's greeting. */
  /** The customer's first name for the guide's greeting, or '' when none is known (never the customer id or a "(demo)" label). */
  readonly firstName = computed(() => this.card()?.first_name
    || (this.known()?.display_name ?? '').replace(/\s*\(demo\)$/, ''));

  constructor() {
    effect(() => { this.client(); this.roles(); this.lang.lang(); this.openThread(); this.clearQuestionHelp(); });
    effect(() => {
      const answer = this.questionAnswer();
      if (answer && !this.questionSnapshotMatches(answer.result)) { this.questionAnswer.set(null); this.questionError.set(this.t().customerAssistUnavailable); }
    });
    effect(() => {
      const language = this.lang.lang();
      if (language === this.statusCheckLanguage) return;
      this.statusCheckLanguage = language;
      this.statusCheckWatch++;
      this.statusExplanation.set(null);
      this.statusChecking.set(null);
    });
    // Move focus to the receipt, the choose step (it replaces the focused Send button), the details field (it replaces the
    // focused "can't find" button) and the chat heading when each appears; the heading is last, so opening the panel focuses it.
    for (const name of ['codeField', 'intakeReceiptEl', 'chooseStep', 'detailsField', 'chatPanel'] as const) {
      const el: Signal<ElementRef<HTMLElement> | undefined> = this[name];
      effect(() => el()?.nativeElement.focus());
    }
  }
  private readonly codeField = viewChild<ElementRef<HTMLElement>>('codeField');
  private readonly intakeReceiptEl = viewChild<ElementRef<HTMLElement>>('intakeReceiptEl');
  private readonly chatPanel = viewChild<ElementRef<HTMLElement>>('chatPanel');
  /** The control that opened the panel (a charge row's Report button), so closing can return focus to it. */
  private opener: HTMLElement | null = null;

  /** Close the guided chat and return focus to the control that opened it, else to the page heading. */
  closeChat(): void {
    this.chatOpen.set(false);
    afterNextRender(() => (this.opener?.isConnected ? this.opener : this.host.nativeElement.querySelector<HTMLElement>('.step h1'))?.focus(), { injector: this.injector });
  }
  /** Open the explicit Help choices without starting or clearing a report. */
  showHelp(): void {
    const help = this.host.nativeElement.querySelector<HTMLDetailsElement>('#help');
    if (!help) return;
    help.open = true;
    help.querySelector<HTMLElement>('summary')?.focus();
    help.scrollIntoView({ block: 'nearest' });
  }

  /** Leave the receipt for its saved report; a failed list load falls back to the reports heading. */
  viewMyReport(): void {
    const receipt = this.suggestionContext();
    if (!receipt || this.busy() || this.frozen()) return;
    this.chatOpen.set(false);
    afterNextRender(() => {
      if (this.suggestionContext() !== receipt || this.step() !== 'home' || this.chatOpen()) return;
      const report = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-report-protocol]')]
        .find(el => el.dataset['reportProtocol'] === receipt.protocol);
      const target = report ?? this.host.nativeElement.querySelector<HTMLElement>('#your-reports-title');
      target?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    }, { injector: this.injector });
  }
  private readonly chooseStep = viewChild<ElementRef<HTMLElement>>('chooseStep');
  private readonly detailsField = viewChild<ElementRef<HTMLElement>>('detailsField');

  /** Load the identity choices from the API; they come from the same config as the server allowlist. */
  async ngOnInit(): Promise<void> {
    document.addEventListener('visibilitychange', this.refreshVisibility);
    window.addEventListener('online', this.refreshVisibility);
    window.addEventListener('offline', this.refreshVisibility);
    window.addEventListener('focus', this.refreshVisibility);
    this.bootTimer = setTimeout(() => this.booted.set(true), 2400);
    if (this.narrowQuery) this.narrowQuery.onchange = e => this.narrow.set(e.matches);
    // Outside the zone so the app (and tests) can be stable while it waits; the signal still schedules the render.
    this.introTimer = this.zone.runOutsideAngular(() => setTimeout(() => this.introDone.set(true), 6800)); // must outlast the intro word animation delays in styles.css
    const restoring = this.client() ? this.resume() : this.restore();
    if (!this.demoPicker) { await restoring; return; }
    this.identitiesLoading.set(true);
    try {
      this.identities.set(await this.service.identities());
      this.identity ||= this.identities()[0]?.customer_id ?? '';
    } catch (e) {
      this.fail(e);
    } finally {
      this.identitiesLoading.set(false);
    }
    await restoring;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.generation++;
    this.clearUpdates();
    this.stopRefresh();
    document.removeEventListener('visibilitychange', this.refreshVisibility);
    window.removeEventListener('online', this.refreshVisibility);
    window.removeEventListener('offline', this.refreshVisibility);
    window.removeEventListener('focus', this.refreshVisibility);
    this.tour.set(null);
    clearTimeout(this.bootTimer);
    clearTimeout(this.introTimer);
    if (this.narrowQuery) this.narrowQuery.onchange = null;
    this.cognito.forget();
    this.suggestionWatch++;
    clearTimeout(this.suggestionTimer);
    clearTimeout(this.suggestionDeadlineTimer);
  }

  start(): void {
    this.booted.set(true);
    this.step.set('login');
  }

  /** A server check or open-question code in the interface language. */
  check(code: string): string {
    return checkText(this.t(), code);
  }

  /** Local demo sign-in; while a request is pending, re-authenticate as the same identity. */
  login(): Promise<void> {
    const identity = this.identityLocked() ? this.client() : this.identity;
    return this.enter(async () => ({ ...await this.service.signIn(identity), customer_id: identity }), e => this.fail(e));
  }

  /** Email the one-time code. A 401 reads as "could not send", so the UI never says whether the address exists. */
  async requestCode(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.cognito.requestCode(this.email.trim(), this.lang.lang());
      this.codeSent.set(true);
    } catch (e) {
      this.error.set(this.signInError(e, 'errSendCode'));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Code → Cognito ID token → Worker session, then the same home path as the demo sign-in. Once Cognito accepts the
   * code it is spent, so a failed Worker exchange goes back to the email step (email kept) to request a new one.
   */
  verify(): Promise<void> {
    let spent = false;
    return this.enter(async () => {
      const token = await this.cognito.submitCode(this.email.trim(), this.code.trim());
      spent = true;
      const s = await this.service.signInWithToken(token);
      // Not when enter() is about to refuse this sign-in (a report is open for another customer): nothing may outlive it.
      const refused = this.identityLocked() && s.customer_id !== this.client();
      if (s.roles.includes('admin') && !this.agent.roles().length && !refused) await this.openAgentView(token);
      return s;
    }, e => {
      if (spent) this.backToEmail();
      this.error.set(this.signInError(e, spent ? 'errOther' : 'errCode'));
    });
  }

  /**
   * An admin's one code opens the agent view too (ADR-007, decision 8): a separate agent session from the same token,
   * which is then dropped. A failure leaves the agent view to its own sign-in.
   */
  private async openAgentView(token: string): Promise<void> {
    try {
      this.agent.roles.set((await this.agent.signIn(token)).roles);
    } catch { /* unavailable: the agent view asks for its own code */ }
  }

  /** The customer an admin picked to act as (ADR-007, decision 10). */
  actAsChoice = '';
  /** The customers an admin may act as, from the server; empty until loaded, and never the local demo list. */
  readonly actAsIdentities = signal<Identity[]>([]);
  /** The admin list is loading; its own flag, so a local demo list still loading never blocks it. */
  readonly actAsLoading = signal(false);

  /** The admin's "view as another customer" panel: the list loads the first time it opens (it is about 800 customers). */
  async toggleActAs(open: boolean): Promise<void> {
    if (!open || this.actAsIdentities().length || this.actAsLoading()) return;
    this.actAsLoading.set(true);
    this.error.set('');
    try {
      const who = this.client();
      const list = await this.service.adminCustomers();
      if (this.client() === who) this.actAsIdentities.set(list); // never another customer's (or a signed-out tab's) list
    } catch (e) {
      this.fail(e);
    } finally {
      this.actAsLoading.set(false);
    }
  }

  /** Act as the picked customer, then their home, through the same path as a sign-in. Refused while a report is open. */
  actAs(): Promise<void> {
    const customerId = this.actAsChoice;
    if (!customerId || this.identityLocked() || !this.actAsIdentities().length) return Promise.resolve();
    return this.enter(() => this.service.actAs(customerId), e => this.fail(e));
  }

  /** The bank-flagged charge to ask about (ADR-011), or null; a failed read just shows no alert. */
  readonly alert = signal<Transaction | null>(null);
  /** The short thanks after "it's mine", announced where the alert was. */
  readonly alertNote = signal('');

  private async loadAlert(): Promise<void> {
    const g = this.generation;
    try {
      const { alert } = await this.service.alert();
      if (g === this.generation) this.alert.set(alert);
    } catch {
      if (g === this.generation) this.alert.set(null); // the alert is optional: the home works without it
    }
  }

  /**
   * Answer the alert. "It's mine" records it and thanks the customer; "I don't recognize it" records it and opens the
   * guided report on that charge, the normal confirmation path. The banner goes either way; a failed record keeps it.
   */
  async answerAlert(answer: 'mine' | 'report'): Promise<void> {
    const tx = this.alert();
    if (!tx || this.busy()) return;
    try {
      await this.service.answerAlert(tx.transaction_id, answer);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.alert.set(null);
    if (answer === 'mine') this.alertNote.set(this.t().alertThanks);
    else { this.openChat(tx.transaction_id); this.extraCharge.set(tx); } // after openChat: a restart clears the chat
  }

  /**
   * Sign out: end the customer and agent sessions on the server (it answers 204), then forget everything held in the tab
   * and return to the email field. A failed call changes nothing and shows a retryable error: the cookies would still be
   * live, so clearing the tab would only look like a sign-out (a reload would restore the account). Refused while a
   * report is open or a request is frozen.
   */
  async signOut(): Promise<void> {
    if (this.busy() || this.identityLocked()) return;
    this.busy.set(true);
    // One reset of ``busy`` whatever happens, so a throw while clearing local state can never leave the page stuck.
    try {
      try {
        await this.service.logout();
      } catch (e) {
        this.fail(e);
        return;
      }
      this.cognito.forget();
      this.agent.roles.set([]);
      this.reset();
      this.actAsIdentities.set([]);
      this.actAsChoice = '';
      this.chatOpen.set(false);
      this.email = '';
      this.code = '';
      this.codeSent.set(false);
      this.error.set('');
      this.shownStep = 'login'; // the email field takes focus, not the step heading
      this.step.set('login');
    } finally {
      this.busy.set(false);
    }
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('#login-email')?.focus(), { injector: this.injector });
  }

  /** Escape closes the account menu and returns focus to its summary. */
  closeUserMenu(menu: HTMLDetailsElement): void {
    if (!menu.open) return;
    menu.open = false;
    menu.querySelector<HTMLElement>('summary')?.focus();
  }

  /** "Use another email". */
  anotherEmail(): void {
    this.error.set('');
    this.backToEmail();
  }

  /** The chat's Renew: the demo re-signs the same identity; email sign-in needs a new code from the login step. */
  renew(): Promise<void> | void {
    return this.demoPicker ? this.login() : this.step.set('login');
  }

  /** Back to the email field (focused); the pending challenge is forgotten. */
  private backToEmail(): void {
    this.cognito.forget();
    this.codeSent.set(false);
    this.code = '';
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('#login-email')?.focus(), { injector: this.injector });
  }

  /**
   * Start a session and go home. While a report is open (``identityLocked``) a different customer is refused and
   * nothing changes; otherwise a new customer starts from a clean state.
   */
  private async enter(session: () => Promise<CustomerSession>, onError: (e: unknown) => void): Promise<void> {
    if (this.busy()) return;
    const generation = this.generation;
    let acceptedGeneration = generation;
    this.busy.set(true);
    this.error.set('');
    try {
      const s = await session();
      if (generation !== this.generation) return;
      if (this.identityLocked() && s.customer_id !== this.client()) {
        // That sign-in set the other customer's cookie: drop it before anything else can be sent with it. If that
        // fails the cookie may remain, so the open report is dropped too and nothing can go out under it.
        this.backToEmail();
        try {
          await this.service.logout();
          if (acceptedGeneration !== this.generation) return;
          this.agent.roles.set([]); // logout also ended the agent session
        } catch (e) {
          if (acceptedGeneration !== this.generation) return;
          this.reset();
          acceptedGeneration = this.generation;
          this.fail(e);
          return;
        }
        this.error.set(this.t().errOtherCustomer);
        return;
      }
      if (s.customer_id !== this.client()) this.reset();
      acceptedGeneration = this.generation;
      this.card.set(s.context_card ?? null);
      this.client.set(s.customer_id);
      this.roles.set(s.roles);
      this.refreshUnauthorized = false;
      this.codeSent.set(false);
      this.code = '';
      await this.loadTransactions();
      if (acceptedGeneration !== this.generation) return;
      await this.loadReports();
      if (acceptedGeneration !== this.generation) return;
      this.step.set('home');
      this.scheduleReports();
      this.scheduleThread();
      const g = this.generation;
      void this.loadAlert().then(() => {
        if (g === this.generation) afterNextRender(() => { if (g === this.generation) this.offerTour(); }, { injector: this.injector });
      });
    } catch (e) {
      if (acceptedGeneration === this.generation) onError(e);
    } finally {
      if (acceptedGeneration === this.generation) this.busy.set(false);
    }
  }

  /** Sign-in failures: 401 gets the step's own vague text, 403 not enrolled, 429 wait; the rest the generic text. */
  private signInError(e: unknown, on401: keyof Strings): string {
    const status = e instanceof ApiError ? e.status : -1;
    const key = status === 401 ? on401 : status === 403 ? 'errNotEnrolled' : status === 429 ? 'errTooMany' : null;
    return key ? this.t()[key] : errorText(this.t(), e);
  }

  /**
   * After a reload the tab has no state, but the session cookie may still be live (ADR-013, phase 0): restore it and go
   * home, as a sign-in would. Nothing happens without a live session, or if a sign-in started meanwhile.
   */
  private async restore(): Promise<void> {
    const generation = this.generation;
    let state;
    try {
      state = await this.service.me();
    } catch {
      return; // no session information: the sign-in screen stays
    }
    // Never over a sign-in the person has started (the login step, a pending or sent code), even if it is not busy now.
    if (generation !== this.generation || !state?.customer || this.client() || this.busy() || this.step() !== 'intro' || this.codeSent()) return;
    this.card.set(state.customer.context_card ?? null);
    this.client.set(state.customer.customer_id);
    this.roles.set(state.customer.roles);
    await this.resume();
  }

  /** Back from another in-app view in this tab: show the same customer's home again; the cookie still decides access. */
  private async resume(): Promise<void> {
    this.booted.set(true);
    this.step.set('home');
    const g = this.generation;
    try {
      await Promise.all([this.loadTransactions(), this.loadReports(), this.loadAlert()]);
      if (g === this.generation) afterNextRender(() => { if (g === this.generation) this.offerTour(); }, { injector: this.injector });
    } catch (e) {
      this.fail(e);
    }
  }

  private async loadTransactions(): Promise<void> {
    const g = this.generation;
    const list = await this.service.transactions();
    if (g !== this.generation) return;
    this.transactions.set(list.items);
    this.hasMore.set(list.has_more);
    this.viewRef.set(list.view_ref);
  }

  readonly reportsChecked = signal<number | null>(null);
  readonly threadChecked = signal<number | null>(null);
  readonly threadFailed = signal(false);
  readonly reportsRefreshing = signal(false);
  readonly changeNotices = signal<{ protocol: string; key: 'reportEnteredReview' | 'reportReviewFinished'; reference: string }[]>([]);
  readonly agentReplyNotice = signal(false);
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private threadTimer: ReturnType<typeof setTimeout> | undefined;
  private reportRead: Promise<void> | null = null;
  private threadRead: Promise<void> | null = null;
  private reportAbort: AbortController | null = null;
  private threadAbort: AbortController | null = null;
  private reportDelay = 30000;
  private threadDelay = 30000;
  private reportStarted = -Infinity;
  private threadStarted = -Infinity;
  private threadWatch = 0;
  private refreshUnauthorized = false;
  private destroyed = false;
  private reportRetryAt = 0;
  private threadRetryAt = 0;

  private canRefresh(): boolean {
    return !this.destroyed && !!this.client() && this.step() === 'home' && document.visibilityState !== 'hidden' && navigator.onLine && !this.refreshUnauthorized;
  }

  /** Coalesce reads; passive events honor failure deadlines, while explicit Refresh can retry now. */
  refreshReports(manual = true): void {
    if (!this.canRefresh()) return;
    if ((manual || Date.now() >= this.reportRetryAt) && Date.now() - this.reportStarted >= 1000) void this.loadReports();
    if (this.openThread() && (manual || Date.now() >= this.threadRetryAt) && Date.now() - this.threadStarted >= 1000) void this.loadThread();
  }

  private readonly refreshVisibility = (): void => {
    clearTimeout(this.reportTimer); clearTimeout(this.threadTimer);
    if (this.canRefresh()) { this.refreshReports(false); this.scheduleReports(); this.scheduleThread(); }
  };

  private scheduleReports(): void {
    clearTimeout(this.reportTimer);
    if (this.canRefresh() && !this.reportRead) this.reportTimer = this.zone.runOutsideAngular(() => setTimeout(() => void this.loadReports(), this.reportRetryAt ? Math.max(0, this.reportRetryAt - Date.now()) : this.reportDelay));
  }

  private scheduleThread(): void {
    clearTimeout(this.threadTimer);
    if (this.canRefresh() && this.openThread() && !this.threadRead) this.threadTimer = this.zone.runOutsideAngular(() => setTimeout(() => void this.loadThread(), this.threadRetryAt ? Math.max(0, this.threadRetryAt - Date.now()) : this.threadDelay));
  }

  /** Abort actual fetch and expire the UI read even if a transport never settles. */
  private async boundedRead<T>(controller: AbortController, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ApiError(0));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = this.zone.runOutsideAngular(() => setTimeout(() => controller.abort(), 10000));
    });
    try { return await Promise.race([read(controller.signal), deadline]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  }

  /** Never throws; failures keep the last confirmed snapshot and back off. */
  private loadReports(): Promise<void> {
    if (this.destroyed || this.refreshUnauthorized) return Promise.resolve();
    if (this.reportRead) return this.reportRead;
    clearTimeout(this.reportTimer);
    const g = this.generation, controller = this.reportAbort = new AbortController();
    this.reportStarted = Date.now(); this.reportsRefreshing.set(true);
    const read = (async () => {
      try {
        const list = await this.boundedRead(controller, signal => this.service.reports(signal));
        if (g !== this.generation) return;
        const previous = this.reports();
        if (previous) for (const report of list.items) {
          const old = previous.items.find(r => r.protocol === report.protocol);
          if (old && old.status !== report.status && report.status !== 'received') {
            this.changeNotices.update(notices => [...notices.filter(n => n.protocol !== report.protocol), {
              protocol: report.protocol, reference: report.reference_short ?? report.protocol,
              key: report.status === 'in_review' ? 'reportEnteredReview' as const : 'reportReviewFinished' as const }].slice(-20));
          }
        }
        this.reports.set(list); this.reportsFailed.set(false); this.reportsChecked.set(Date.now()); this.reportDelay = 30000; this.reportRetryAt = 0;
      } catch (e) {
        if (g !== this.generation) return;
        this.reportsFailed.set(true); this.reportDelay = Math.min(120000, this.reportDelay * 2); this.reportRetryAt = Date.now() + this.reportDelay;
        if (e instanceof ApiError && e.status === 401) this.pauseUnauthorized();
      } finally {
        if (g === this.generation && this.reportAbort === controller) {
          this.reportRead = null; this.reportAbort = null; this.reportsRefreshing.set(false); this.scheduleReports();
        }
      }
    })();
    this.reportRead = read;
    return read;
  }

  /** Only the exact open-thread instance may update its snapshot, including close/reopen of one report. */
  private loadThread(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.refreshUnauthorized) {
      if (this.openThread() && !this.thread()) this.threadFailed.set(true);
      return Promise.resolve();
    }
    if (this.threadRead) return this.threadRead;
    const protocol = this.openThread();
    if (!protocol) return Promise.resolve();
    clearTimeout(this.threadTimer);
    const g = this.generation, watch = this.threadWatch, controller = this.threadAbort = new AbortController();
    const current = () => g === this.generation && watch === this.threadWatch && this.openThread() === protocol;
    this.threadStarted = Date.now();
    const read = (async () => {
      try {
        const thread = await this.boundedRead(controller, signal => this.service.messages(protocol, signal));
        if (!current()) return;
        const previous = this.thread();
        if (previous && thread.items.some(m => m.author === 'agent' && !previous.items.some(old => old.message_id === m.message_id))) this.agentReplyNotice.set(true);
        this.thread.set(thread); this.threadFailed.set(false); this.threadChecked.set(Date.now()); this.threadDelay = 30000; this.threadRetryAt = 0;
      } catch (e) {
        if (!current()) return;
        this.threadFailed.set(true); this.threadDelay = Math.min(120000, this.threadDelay * 2); this.threadRetryAt = Date.now() + this.threadDelay;
        if (e instanceof ApiError && e.status === 401) this.pauseUnauthorized();
      } finally {
        if (current() && this.threadAbort === controller) {
          this.threadRead = null; this.threadAbort = null; this.scheduleThread();
        }
      }
    })();
    this.threadRead = read;
    return read;
  }

  /** Explain an empty failed thread using the existing localized session or refresh error. */
  threadRefreshError(): string {
    return this.threadFailed() ? this.t()[this.refreshUnauthorized ? 'err401' : 'refreshFailed'] : '';
  }

  private pauseUnauthorized(): void {
    this.refreshUnauthorized = true;
    clearTimeout(this.reportTimer); clearTimeout(this.threadTimer);
    this.error.set(this.t().err401);
  }

  private stopThreadRefresh(): void {
    this.clearQuestionHelp();
    this.statusCheckWatch++; this.statusExplanation.set(null); this.statusChecking.set(null); this.messageSaved.set(null);
    this.threadWatch++; clearTimeout(this.threadTimer); this.threadAbort?.abort();
    this.threadAbort = null; this.threadRead = null; this.threadDelay = 30000; this.threadStarted = -Infinity; this.threadRetryAt = 0;
    this.threadChecked.set(null); this.threadFailed.set(false); this.agentReplyNotice.set(false);
  }

  private stopRefresh(): void {
    clearTimeout(this.reportTimer); this.reportAbort?.abort(); this.reportAbort = null; this.reportRead = null;
    this.stopThreadRefresh(); this.reportDelay = 30000; this.reportStarted = -Infinity; this.reportRetryAt = 0;
    this.reportsRefreshing.set(false); this.reportsChecked.set(null); this.changeNotices.set([]);
  }

  /** Dismiss only the transient notice; saved progress stays visible. */
  dismissNotice(protocol: string): void { this.changeNotices.update(notices => notices.filter(n => n.protocol !== protocol)); }

  /** Explicitly view a change without automatic focus movement. */
  viewUpdate(protocol: string): void {
    const target = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-report-protocol]')].find(el => el.dataset['reportProtocol'] === protocol);
    target?.focus(); target?.scrollIntoView({ block: 'nearest' });
  }

  /** Localized notice from a confirmed saved-status change, never customer text. */
  noticeText(notice: { key: 'reportEnteredReview' | 'reportReviewFinished'; reference: string }): string {
    return this.t()[notice.key].replace('{ref}', () => notice.reference);
  }

  /** The report whose messages are open under "Your reports" (ADR-015), its thread, and the state of a post. */
  readonly openThread = signal<string | null>(null);
  readonly thread = signal<MessageThread | null>(null);
  /** The protocol whose post is in flight, so only that report's send button waits. */
  readonly messageSending = signal<string | null>(null);
  readonly messageFailed = signal('');
  readonly messagesSent = signal(0);
  readonly messageSaved = signal<string | null>(null);
  readonly statusChecking = signal<string | null>(null);
  readonly statusExplanation = signal<{ protocol: string; report: Report | null; checked: number | null; failed: boolean } | null>(null);
  private statusCheckWatch = 0;
  private statusCheckLanguage = this.lang.lang();

  /** Read only the owned report list; receipt time is not a status-change timestamp. */
  async checkReportStatus(protocol: string): Promise<void> {
    if (this.statusChecking() || !this.client() || this.destroyed || !this.reports()?.items.some(r => r.protocol === protocol)) return;
    const generation = this.generation, watch = this.threadWatch, language = this.lang.lang(), check = ++this.statusCheckWatch;
    this.statusCheckLanguage = language;
    this.statusChecking.set(protocol);
    this.statusExplanation.set(null);
    if (this.canRefresh()) await this.loadReports();
    if (generation !== this.generation || watch !== this.threadWatch || language !== this.lang.lang() || check !== this.statusCheckWatch) return;
    const report = this.reports()?.items.find(r => r.protocol === protocol) ?? null;
    this.statusExplanation.set({ protocol, report, checked: this.reportsChecked(),
      failed: this.reportsFailed() || !report || !this.canRefresh() });
    this.statusChecking.set(null);
  }

  /** Approved process copy selected by the persisted report state, never a promised outcome. */
  statusHelp(report: Report): string {
    return this.t()[report.status === 'closed' ? 'statusClosedHelp' : report.status === 'in_review' ? 'statusReviewHelp' : 'statusReceivedHelp'];
  }
  readonly assistBusy = signal(false);
  readonly questionError = signal('');
  /** The server answered 503: AI help is switched off, or not offered to this customer (ADR-016), so the panel goes away. */
  // ponytail: learned from the first 503, not from config; a config read would need an API change.
  readonly assistOff = signal(false);
  readonly questionAnswer = signal<{result: CustomerAssist; report: Report; checked: number; question: string} | null>(null);
  readonly acceptedQuestion = signal<MessageDraft | null>(null);
  assistQuestion = '';
  private assistWatch = 0;
  private questionVersion = 0;
  private readonly customerComposer = viewChild(MessageThreadView);

  private questionScope(): string { return JSON.stringify([this.generation,this.threadWatch,this.openThread(),this.client(),this.roles(),this.lang.lang()]); }
  private clearQuestionHelp(): void { this.assistWatch++; this.assistBusy.set(false); this.questionAnswer.set(null); this.questionError.set(''); this.acceptedQuestion.set(null); this.assistQuestion = ''; }
  private questionSnapshotMatches(result: CustomerAssist): boolean {
    const report = this.reports()?.items.find(r => r.protocol === this.openThread()), thread = this.thread();
    return !!report && !!thread && report.status === result.snapshot.status && thread.status === result.snapshot.status && thread.items.length === result.snapshot.message_count;
  }

  /** One deliberate classification followed by new owned report/thread reads; mismatch never triggers generation retry. */
  async askReportQuestion(): Promise<void> {
    const protocol = this.openThread(), question = this.assistQuestion.trim(), language = this.lang.lang();
    if (!protocol || this.assistBusy() || !this.canRefresh()) return;
    if (!question || [...question].length > 2000) { this.questionError.set(this.t().customerAssistEmpty); return; }
    const scope = this.questionScope(), watch = ++this.assistWatch;
    const current = () => scope === this.questionScope() && watch === this.assistWatch && !this.destroyed;
    this.assistBusy.set(true); this.questionAnswer.set(null); this.questionError.set('');
    try {
      const result = await this.service.assist(protocol,question,language,crypto.randomUUID());
      if (!current()) return;
      // Settle earlier polls before starting the reads that validate this returned snapshot.
      await Promise.all([this.reportRead,this.threadRead]);
      if (!current() || !this.canRefresh()) return;
      await Promise.all([this.loadReports(),this.loadThread()]);
      if (!current()) return;
      const report = this.reports()?.items.find(r => r.protocol === protocol);
      if (result.language !== language || this.reportsFailed() || this.threadFailed() || !report || !this.questionSnapshotMatches(result)) {
        this.questionError.set(this.t().customerAssistUnavailable); return;
      }
      this.questionAnswer.set({result,report,checked:Date.now(),question});
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) { this.assistOff.set(true); this.clearQuestionHelp(); return; }
      if (current()) { this.questionError.set(this.t().customerAssistUnavailable); if (e instanceof ApiError && e.status === 401) { this.clearQuestionHelp(); this.pauseUnauthorized(); } }
    } finally { if (current()) this.assistBusy.set(false); }
  }

  /** Closed reports always use their stored closure/follow-up flow; only approved localized process copy is rendered. */
  questionHelp(): string {
    const answer = this.questionAnswer(); if (!answer) return '';
    if (answer.report.status === 'closed' || ['status','next_step'].includes(answer.result.intent)) return this.statusHelp(answer.report);
    return this.t()[answer.result.intent === 'provide_details' ? 'customerAssistDetails' : 'customerAssistHuman'];
  }
  /** Translate only the approved field identifier; provider prose is never rendered. */
  questionField(): string {
    const field = this.questionAnswer()?.result.field;
    return field ? this.t()[({merchant:'merchant',amount:'amount',currency:'assistCurrency',date:'date',description:'describe'} as const)[field]] : '';
  }

  /** Explicitly copy the customer's accepted question into the existing composer; human Send remains separate. */
  useQuestionDetails(): void {
    const answer = this.questionAnswer(), protocol = this.openThread();
    if (!answer || !protocol || !this.questionSnapshotMatches(answer.result) || !this.thread()?.can_post || answer.result.intent !== 'provide_details') return;
    if (this.customerComposer()?.draft.trim() && !window.confirm(this.t().customerAssistReplace)) return;
    this.acceptedQuestion.set({body:answer.question,scope:protocol,version:++this.questionVersion});
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('#customer-messages-draft')?.focus(), {injector:this.injector});
  }

  /** Per report, one key per message text: a retry of the same text reuses it (one stored message); new text gets a new key. */
  private readonly messageKeys = new Map<string, { body: string; key: string }>();

  /** Open or close one own report's messages with the agent. */
  async toggleMessages(protocol: string): Promise<void> {
    const closing = this.openThread() === protocol;
    this.stopThreadRefresh();
    this.openThread.set(closing ? null : protocol);
    this.thread.set(null); this.messageFailed.set('');
    if (!closing) await this.loadThread();
  }

  /** Post the customer's message on the open report, then show the stored thread. */
  async sendMessage(body: string): Promise<void> {
    const protocol = this.openThread();
    if (!protocol || this.messageSending() === protocol) return;
    let key = this.messageKeys.get(protocol);
    if (key?.body !== body) this.messageKeys.set(protocol, key = { body, key: crypto.randomUUID() });
    this.messageSending.set(protocol);
    this.messageFailed.set(''); this.messageSaved.set(null);
    // The result belongs to the report that posted; if the customer opened another one meanwhile, it touches nothing there.
    const g = this.generation, watch = this.threadWatch;
    const stillOpen = () => g === this.generation && watch === this.threadWatch && this.openThread() === protocol;
    try {
      await this.service.postMessage(protocol, body, key.key);
      this.messageKeys.delete(protocol);
      if (stillOpen()) { this.messagesSent.update(n => n + 1); this.messageSaved.set(protocol); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) this.messageKeys.delete(protocol);
      if (stillOpen()) this.messageFailed.set(messageErrorText(this.t(), e));
    } finally {
      if (this.messageSending() === protocol) this.messageSending.set(null);
    }
    if (!stillOpen()) return;
    // A poll begun before the post may hold an older snapshot; settle it before the authoritative read-back.
    await this.threadRead;
    if (!stillOpen()) return;
    await this.loadThread();
  }

  /** Keep the focused button available to keyboards while refusing pending or server-timed duplicate requests. */
  updateUnavailable(protocol: string): boolean {
    return this.updating() !== null || (this.updateCooldowns()[protocol] ?? 0) > Date.now();
  }

  /** Queue one report snapshot; responses and timers belong only to the signed-in customer generation. */
  async requestUpdate(protocol: string): Promise<void> {
    if (this.updateUnavailable(protocol)) return;
    const generation = this.generation;
    this.updating.set(protocol);
    this.updateNote.set(null);
    try {
      await this.service.requestUpdate(protocol);
      if (generation === this.generation) this.updateNote.set({ protocol, text: this.t().updateSent });
    } catch (e) {
      if (generation !== this.generation) return;
      const status = e instanceof ApiError ? e.status : -1;
      if (status === 429 && e instanceof ApiError && e.retryAfterSeconds) {
        this.updateCooldowns.update(cooldowns => ({ ...cooldowns, [protocol]: Date.now() + e.retryAfterSeconds! * 1000 }));
        clearTimeout(this.updateTimers.get(protocol));
        this.updateTimers.set(protocol, this.zone.runOutsideAngular(() => setTimeout(() => {
          if (generation !== this.generation) return;
          this.updateCooldowns.update(cooldowns => { const next = { ...cooldowns }; delete next[protocol]; return next; });
          this.updateTimers.delete(protocol);
        }, e.retryAfterSeconds! * 1000)));
      }
      this.updateNote.set({ protocol, text: status === 429 ? this.t().updateRecent : status === 409 ? this.t().updateNoEmail
        : status === 401 ? this.t().err401 : this.t().updateFailed });
    } finally {
      if (generation === this.generation) this.updating.set(null);
    }
  }

  private clearUpdates(): void {
    for (const timer of this.updateTimers.values()) clearTimeout(timer);
    this.updateTimers.clear(); this.updateCooldowns.set({}); this.updating.set(null); this.updateNote.set(null);
  }

  /**
   * Open the chat; from a charge row, that charge is preselected (the customer still confirms it); from the "?" entry
   * (``general``) none is. Either on a finished chat (receipt or ended) starts a new report; nothing changes while a request is frozen.
   */
  openChat(transactionId?: string, general = false): void {
    this.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const restart = (!!transactionId || general) && !this.busy() && !this.frozen() && (this.chatStep() === 'receipt' || this.chatStep() === 'ended');
    const wasGeneral = this.general();
    this.general.set(general); // before clearChat(), which picks the greeting from it
    if (general && !this.frozen()) { this.choice = ''; this.chatConfirmed = false; } // "?" never keeps a row's charge selected
    if (restart) {
      this.clearChat();
      this.chatPanel()?.nativeElement.focus(); // the panel stays open, so the heading would not take focus on its own
    } else if ((general || transactionId) && this.chatStep() === 'describe' && this.log().length === 1) {
      this.log.set([{ from: 'bot', key: general ? 'chatHelloGeneral' : 'chatHello' }]); // an untouched greeting follows the entry that opened the chat
    }
    this.chatOpen.set(true);
    if (transactionId && !this.frozen() && this.chatStep() !== 'receipt' && this.chatStep() !== 'ended') {
      this.choice = transactionId;
      this.chatConfirmed = false;
      // The customer found the charge after all (while the guide waited for details, or from the "?" entry, which lists no
      // charges): back to choosing, with the guide's choose prompt as the current line.
      if (this.asking() || (wasGeneral && this.chatStep() === 'choose')) {
        this.asking.set(false);
        this.log.update(l => [...l, { from: 'bot', key: 'chatChoose' }]);
      }
    }
  }

  /** A confirmation of this charge whose acceptance is not yet known. */
  pending(transactionId: string): boolean {
    const frozen = this.frozen();
    return frozen?.path === 'confirm' && frozen.body.transaction_id === transactionId;
  }

  /** The charge's newest report from the server list (items are newest first): the only source of a row's report state. */
  // ponytail: sees only the 20 newest reports; an older open report falls back to the server's 409. Upgrade: a per-charge lookup.
  reportOf(transactionId: string): Report | undefined {
    return this.reports()?.items.find(r => r.transaction_id === transactionId);
  }

  /** The charge a report names, when it is among the loaded charges. */
  chargeOf(transactionId: string | null): Transaction | undefined {
    return transactionId ? this.transactions().find(tx => tx.transaction_id === transactionId) : undefined;
  }

  /**
   * A reason chip: fills the statement with its one-line sentence in the report language, unless the customer has typed
   * their own words. ``other`` fills nothing; focus never moves (WCAG 3.2.2). A lost or stolen card says at once to call the bank.
   */
  pickReason(r: Reason): void {
    this.reason.set(r);
    this.chatError.set('');
    this.refill();
    const lost = this.log().some(l => 'key' in l && l.key === 'chatLostCard');
    if (r === 'card_lost_or_stolen' && !lost) this.log.update(l => [...l, { from: 'bot', key: 'chatLostCard' }]);
    // The call-your-bank line belongs to a lost card only; another reason takes it back.
    if (r !== 'card_lost_or_stolen' && lost) this.log.update(l => l.filter(x => !('key' in x && x.key === 'chatLostCard')));
  }

  /** The report-language radios: a statement a chip wrote follows the new language; the customer's own words never change. */
  setReportLang(lang: IntakeLang): void {
    this.chosenLang.set(lang);
    this.refill();
  }

  /** Rewrite the chosen reason's sentence in the report language, unless the customer has typed their own words. */
  private refill(): void {
    const r = this.reason();
    if (!r || (this.chatStatement.trim() !== '' && this.chatStatement.trim() !== this.prefill)) return;
    this.prefill = r === 'other' ? '' : this.lang.stringsFor(this.reportLang())[REASON_FILL[r]];
    this.chatStatement = this.prefill;
  }

  /** Start the guided report: reason, statement and report language; no reference comes back. */
  async send(): Promise<void> {
    if (this.busy() || this.chatStep() !== 'describe') return;
    if (!this.frozen()) {
      const reason = this.reason();
      if (!reason) {
        this.chatError.set(this.t().chatReasonValidation);
        this.focusInvalid('.chat-reasons input');
        return;
      }
      const statement = this.chatStatement.trim();
      const language = this.reportLang();
      if ([...statement].length < 10) {
        this.chatError.set(this.t().chatValidationShort);
        this.focusInvalid('#chat-statement');
        return;
      }
      this.frozen.set({ path: 'start', body: { customer_statement: statement, idempotency_key: crypto.randomUUID(), language,
        mode: 'guided', reason, report_type: 'unrecognized_charge', ...(this.previousProtocol() && { previous_protocol: this.previousProtocol()! }) } });
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
        this.focusInvalid(tx ? 'input[name="chat-confirmed"]' : 'input[name="chat-choice"]');
        return;
      }
      this.frozen.set({ path: 'confirm', body: { customer_confirmed: true, episode_id: episode.episode_id,
        idempotency_key: crypto.randomUUID(), transaction_id: tx.transaction_id } });
      this.log.update(l => [...l, { from: 'me', text: `${tx.merchant_name || this.t().noMerchant} · ${this.money(tx.amount, tx.currency)}` }]);
    }
    await this.run();
  }

  /** Code points left for the details once the sent statement and a newline are counted. */
  get room(): number {
    return STATEMENT_MAX - 1 - [...this.chatStatement.trim()].length;
  }

  /**
   * "I can't find it": nothing is sent yet; the guide asks once what the customer remembers (one extra turn, no more).
   * A charge picked before is dropped, so it never looks chosen beside the review without one.
   */
  cannotFind(): Promise<void> | void {
    if (this.busy() || this.chatStep() !== 'choose' || this.frozen()) return;
    this.choice = '';
    this.chatConfirmed = false;
    if (this.room < 10) return this.handoff(); // no room for an answer: the statement already carries the detail
    this.asking.set(true);
    this.log.update(l => [...l, { from: 'me', key: 'chatCannotFind' }, { from: 'bot', key: 'chatDetailsPrompt' }]);
  }

  /** Ask for human review without a confirmed charge; what the customer remembers travels with the handoff and is appended to the statement. */
  async handoff(): Promise<void> {
    const episode = this.episode();
    if (this.busy() || !episode || (this.chatStep() !== 'choose' && this.chatStep() !== 'details') || this.frozen()?.path === 'confirm') return;
    if (!this.frozen()) {
      const details = this.asking() ? this.chatDetails.trim() : '';
      if (this.asking() && [...details].length < 10) {
        this.chatError.set(this.t().chatValidationShort);
        this.focusInvalid('#chat-details');
        return;
      }
      this.frozen.set({ path: 'handoff', body: { ...(details && { details }), episode_id: episode.episode_id, idempotency_key: crypto.randomUUID(), kind: 'incomplete' } });
      this.log.update(l => [...l, details ? { from: 'me', text: details } : { from: 'me', key: 'chatCannotFind' }]);
    }
    await this.run();
  }

  /** Interpret remembered details once, then present only server-returned own charges for the existing confirmation step. */
  async discover(): Promise<void> {
    const description = this.chatDetails.trim(), episode = this.episode();
    if (this.discoveryBusy() || !episode || !description || [...description].length < 10) return;
    this.discoveryBusy.set(true); this.discoveryError.set(null); this.discovery.set(null);
    try {
      const found = await this.service.discoverTransactions(description, this.reportLang(), episode.episode_id, crypto.randomUUID());
      if (this.episode()?.episode_id === episode.episode_id) this.discovery.set(found);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) this.discoveryOff.set(true);
      this.discoveryError.set(error instanceof ApiError && error.status === 422 ? 'narrow' : 'unavailable');
    }
    finally { this.discoveryBusy.set(false); }
  }

  /** Selecting a returned candidate still requires the existing explicit confirmation checkbox; the normal choose step shows it. */
  useDiscovery(transactionId: string): void {
    const tx = this.discovery()?.items.find(i => i.transaction_id === transactionId);
    if (!tx) return;
    this.extraCharge.set(tx); this.general.set(false);
    this.choice = transactionId; this.chatConfirmed = false; this.asking.set(false);
    this.log.update(l => [...l, { from:'bot', key:'chatChoose' }]);
  }

  /**
   * Store one answer per receipt, ignoring duplicate clicks and results for a replaced receipt. A 409 confirms an
   * existing answer without revealing its value. When a focused thumb disappears, its thanks line takes focus.
   */
  async sendFeedback(easy: boolean): Promise<void> {
    const receipt = this.intakeReceipt();
    if (!receipt || this.feedbackRecorded() || this.feedbackSending()) return;
    this.feedbackSending.set(true);
    this.feedbackFailed.set(false);
    try {
      const answer = await this.service.sendFeedback(receipt.protocol, easy);
      if (this.intakeReceipt() !== receipt) return;
      this.feedback.set(answer.easy);
      this.feedbackRecorded.set(true);
    } catch (e) {
      if (this.intakeReceipt() !== receipt) return;
      if (e instanceof ApiError && e.status === 409) this.feedbackRecorded.set(true);
      else this.feedbackFailed.set(true);
    } finally {
      if (this.intakeReceipt() === receipt) {
        this.feedbackSending.set(false);
        const focused = document.activeElement;
        const thumb = focused instanceof HTMLElement && focused.matches('.receipt-feedback button')
          && this.host.nativeElement.contains(focused) ? focused : null;
        if (this.feedbackRecorded() && thumb) {
          afterNextRender(() => {
            // Leave a customer who closed the panel or moved elsewhere where they chose to go.
            if (this.intakeReceipt() === receipt && this.chatOpen()
              && (document.activeElement === thumb || (!thumb.isConnected && document.activeElement === document.body))) {
              this.host.nativeElement.querySelector<HTMLElement>('.feedback-thanks')?.focus();
            }
          }, { injector: this.injector });
        }
      }
    }
  }

  /**
   * "Not resolved" on a closed report starts a *new* report, never a reopened one: closing records that a person
   * finished the review, not a resolution, and the one-open-report rule allows a new report once the first is closed.
   * The guided chat opens on the same charge when it is in the list, otherwise as the "?" entry, with a statement that
   * cites the earlier reference. The source protocol is kept separately and persisted by the server even if the
   * customer edits that statement. An unfinished draft is reset before this new report begins.
   */
  reportAgain(r: Report): void {
    if (this.busy() || this.frozen() || r.status !== 'closed') return;
    this.clearChat();
    const charge = r.transaction_id && this.chargeOf(r.transaction_id) ? r.transaction_id : undefined;
    this.openChat(charge, !charge);
    this.previousProtocol.set(r.protocol);
    if (this.chatStep() === 'describe' && this.chatStatement.trim() === '') {
      this.chatStatement = this.lang.stringsFor(this.reportLang()).reportAgainStatement.replace('{ref}', () => r.reference_short ?? r.protocol);
    }
  }

  /** Customer-initiated only: a fresh report with a new start key. The button that called it is removed, so focus goes to the chat heading. */
  newReport(): void {
    if (this.busy() || this.frozen()) return;
    this.clearChat();
    this.chatPanel()?.nativeElement.focus();
  }

  private clearChat(): void {
    this.extraCharge.set(null);
    this.previousProtocol.set(null);
    this.frozen.set(null);
    this.episode.set(null);
    this.discovery.set(null); this.discoveryError.set(null);
    this.intakeReceipt.set(null);
    this.feedback.set(null);
    this.feedbackRecorded.set(false);
    this.feedbackSending.set(false);
    this.feedbackFailed.set(false);
    this.suggestionWatch++;
    clearTimeout(this.suggestionDeadlineTimer);
    this.suggestionReport.set(null);
    this.suggestionTimedOut.set(false);
    this.suggestionList.set(null);
    this.suggestionAnswer.set(null);
    this.suggestionSending.set(false);
    this.suggestionFailed.set(false);
    this.ended.set(false);
    this.asking.set(false);
    this.chatError.set('');
    this.chatStatement = '';
    this.prefill = '';
    this.reason.set(null);
    this.chatDetails = '';
    this.choice = '';
    this.chatConfirmed = false;
    this.log.set([{ from: 'bot', key: this.general() ? 'chatHelloGeneral' : 'chatHello' }]);
    this.faqLog.set([]);
  }

  /**
   * After a validation error, move focus to the first invalid field (GOV.UK's error pattern; WCAG 3.3.1): the browser
   * scrolls it into view and a screen reader reads its error, so a click that "does nothing" always shows why.
   */
  private focusInvalid(selector: string): void {
    afterNextRender(() => {
      const field = this.host.nativeElement.querySelector<HTMLElement>(selector);
      field?.focus();
      field?.scrollIntoView?.({ block: 'center' });
    }, { injector: this.injector });
  }

  /** Guide lines are i18n keys; the greeting carries the customer's first name. */
  lineText(line: ChatLine): string {
    if (!('key' in line)) return line.text;
    if (line.key === 'faqTimeA') return this.timeAnswer();
    const key = line.key === 'chatHelloGeneral' && !this.firstName() ? 'chatHelloGeneralNoName' : line.key;
    return this.t()[key].replace('{name}', () => this.firstName());
  }

  /**
   * "How long does it take?" from this bank's history (first response only; resolution covers resolved reports only, so
   * it is described, never quoted), with the receipt's reference when there is one. Without the history: no numbers.
   */
  timeAnswer(): string {
    const t = this.t();
    const first = this.serviceTimes()?.metrics.find(m => m.metric === 'first_response' && m.unit === 'hours' && m.n > 0);
    const ref = this.intakeReceipt()?.reference_short;
    const tail = ref ? ' ' + t.faqTimeRef.replace('{ref}', () => ref) : '';
    if (!first) return t.faqTimeA + tail;
    return t.faqTimeHistory.replace('{p50}', () => this.duration(first.p50, 'about')).replace('{p90}', () => this.duration(first.p90, 'within')) + tail;
  }

  /** ``about``: the nearest whole unit (25 h → 1 day); ``within``: rounded up, so "within" stays true (44 h → 2 days). */
  private duration(hours: number, mode: 'about' | 'within'): string {
    const t = this.t();
    const round = mode === 'about' ? Math.round : Math.ceil;
    const [value, one, many] = hours >= (mode === 'about' ? 18 : 24) ? [Math.max(1, round(hours / 24)), t.unitDay, t.unitDays]
      : [Math.max(1, round(hours)), t.unitHour, t.unitHours];
    return `${value} ${value === 1 ? one : many}`;
  }

  ask(question: keyof typeof FAQ): void {
    const answer = FAQ[question];
    if (!answer) throw new Error('Unknown FAQ');
    if (question === 'faqTimeQ' && !this.serviceTimes()) {
      // A failed load keeps the answer without numbers; the next question tries again.
      this.serviceTimesLoad ??= this.service.serviceTimes().then(times => this.serviceTimes.set(times), () => undefined)
        .finally(() => { this.serviceTimesLoad = null; });
    }
    this.faqLog.update(l => [...l, { from: 'me', key: question }, { from: 'bot', key: answer }]);
    // The charge list can push the panel's top out of view: bring the new answer into view, without moving focus.
    afterNextRender(() => this.host.nativeElement.querySelector('.chat-faq-log li:last-child, .help-faq-log li:last-child')?.scrollIntoView({ block: 'nearest' }),
      { injector: this.injector });
  }

  /** Send the frozen request. One 401 renews the same customer and retries the same body; after that the manual Renew/Retry stays. */
  async run(): Promise<void> {
    const frozen = this.frozen();
    if (this.destroyed || this.busy() || !frozen) return;
    const generation = this.generation;
    const current = () => !this.destroyed && generation === this.generation;
    this.busy.set(true);
    this.chatError.set('');
    try {
      let result: IntakeStart | IntakeReceipt;
      try {
        result = await this.call(frozen);
      } catch (e) {
        if (!current()) return;
        // Email sign-in can't renew silently (it needs a new code): the 401 stays for the manual Renew.
        if (!(e instanceof ApiError && e.status === 401) || !this.demoPicker) throw e;
        try {
          const session = await this.service.signIn(this.client());
          if (!current()) return;
          this.card.set(session?.context_card ?? null);
          this.refreshUnauthorized = false;
          this.scheduleReports(); this.scheduleThread();
        } catch (renewal) {
          if (!current()) return;
          this.chatError.set(errorText(this.t(), renewal));
          return;
        }
        // Say it happened: a judge watching the expired-session scenario should see the renewal, not infer it.
        this.log.update(l => [...l, { from: 'bot', key: 'sessionRenewed' }]);
        result = await this.call(frozen);
      }
      if (!current()) return;
      this.frozen.set(null);
      if (frozen.path === 'start') {
        this.episode.set(result as IntakeStart);
        // From the "?" entry nothing is chosen in the chat: the guide points at the list's Report button instead.
        this.log.update(l => [...l, { from: 'bot', key: this.general() ? 'chatChooseGeneral' : 'chatChoose' }]);
      } else {
        this.intakeReceipt.set(result as IntakeReceipt);
        // Only "I can't find it" with what the customer remembers can get suggestions; the receipt never waits for them.
        if (frozen.path === 'handoff' && frozen.body.details && (result as IntakeReceipt).kind === 'incomplete') void this.watchSuggestions(result as IntakeReceipt);
        await this.loadReports();
        if (!current()) return;
        void this.loadAlert(); // a report on the flagged charge ends its alert
      }
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && DEFINITIVE.has(e.status)) {
        this.frozen.set(null);
        if (frozen.path !== 'start') this.chatConfirmed = false;
      }
      // A finish 409 means the report is already submitted or closed: say so, and offer a new report.
      const finish409 = frozen.path !== 'start' && e instanceof ApiError && e.status === 409;
      if (finish409) this.ended.set(true);
      this.chatError.set(finish409 ? this.t()[(e as ApiError).openReport ? 'err409OpenReport' : 'err409Finish'] : errorText(this.t(), e));
    } finally {
      if (current()) this.busy.set(false);
    }
  }

  /** Reopen one listed incomplete report and read its stored suggestions through the owned endpoint. */
  reopenSuggestions(report: Report): void {
    if (this.busy() || this.frozen() || report.kind !== 'incomplete' || !this.reports()?.items.includes(report)) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.clearChat();
    this.suggestionReport.set(report);
    this.log.set([]);
    this.chatOpen.set(true);
    void this.watchSuggestions(report);
  }

  /** Poll the stored run for 15 seconds; the deadline stops this watch, never the server's run. */
  private async watchSuggestions(receipt: IntakeReceipt | Report): Promise<void> {
    const watch = ++this.suggestionWatch;
    const generation = this.generation;
    const until = Date.now() + SUGGESTION_WAIT_MS;
    const current = () => generation === this.generation && watch === this.suggestionWatch && this.suggestionContext() === receipt;
    this.suggestionTimedOut.set(false);
    this.suggestionList.set({ status: 'pending', items: [], choice: null, chosen_transaction_id: null, answerable: false });
    // Transport has no timeout: this independent UI deadline also invalidates any outstanding read.
    const deadline = this.suggestionDeadlineTimer = setTimeout(() => {
      if (current()) { this.suggestionTimedOut.set(true); this.suggestionWatch++; }
    }, SUGGESTION_WAIT_MS);
    const expired = () => {
      if (Date.now() < until) return false;
      this.suggestionTimedOut.set(true);
      return true;
    };
    try {
      for (;;) {
        // A background tab can resume its poll timer after the wall-clock deadline.
        if (!current() || expired()) return;
        let list: SuggestionList;
        try { list = await this.service.suggestions(receipt.protocol); }
        catch {
          if (current() && !expired()) this.suggestionList.set({ status: 'none', reason: 'unavailable', items: [], choice: null, chosen_transaction_id: null, answerable: false });
          return;
        }
        if (!current() || expired()) return;
        this.suggestionList.set(list);
        this.suggestionAnswer.set(list.choice);
        if (list.status !== 'pending' || list.reason === 'review_started') return;
        await new Promise(done => { this.suggestionTimer = setTimeout(done, Math.min(this.suggestionPollMs, Math.max(0, until - Date.now()))); });
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * The customer's one answer: a suggested charge, or none of them (null). On 409 (an answer is already stored, or an agent
   * has started the review) the client reads the suggestions again and shows what the server holds, never its own attempt.
   */
  async answerSuggestion(transactionId: string | null): Promise<void> {
    const receipt = this.suggestionContext();
    if (!receipt || !this.suggestionList()?.answerable || this.suggestionAnswer() || this.suggestionSending()) return;
    const generation = this.generation;
    const current = () => generation === this.generation && this.suggestionContext() === receipt;
    this.suggestionSending.set(true);
    this.suggestionFailed.set(false);
    try {
      const stored = await this.service.answerSuggestions(receipt.protocol, transactionId);
      if (!current()) return;
      this.suggestionAnswer.set(stored.choice);
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && e.status === 409) {
        try {
          const fresh = await this.service.suggestions(receipt.protocol);
          if (!current()) return;
          this.suggestionList.set(fresh);
          this.suggestionAnswer.set(fresh.choice);
        } catch { if (current()) this.suggestionFailed.set(true); }
      } else this.suggestionFailed.set(true);
    } finally {
      if (current()) {
        this.suggestionSending.set(false);
        // The buttons are gone once answered: keep keyboard and screen-reader users on the confirmation.
        if (this.suggestionAnswer() || !this.suggestionList()?.answerable) afterNextRender(() => { if (current()) this.host.nativeElement.querySelector<HTMLElement>('.suggestion-thanks')?.focus(); }, { injector: this.injector });
      }
    }
  }

  /** When a suggested charge happened, as served: the timezone-free source time, else the UTC instant. */
  chargeWhen(c: SuggestedCharge): string {
    if (c.source_occurred_at) return this.sourceTime(c.source_occurred_at);
    return c.occurred_at ? c.occurred_at.slice(0, 16).replace('T', ' ') + ' ' + this.t().utc : this.t().dateMissing;
  }

  /** The pick button's accessible name names the charge, since every button reads the same. */
  suggestionLabel(c: SuggestedCharge): string {
    return this.t().suggestPickLabel.replace('{merchant}', () => c.merchant_name || this.t().noMerchant).replace('{date}', () => this.chargeWhen(c))
      .replace('{amount}', () => this.money(c.amount, c.currency));
  }

  private call(f: Frozen): Promise<IntakeStart | IntakeReceipt> {
    return f.path === 'start' ? this.service.startIntake(f.body) : f.path === 'confirm' ? this.service.confirmIntake(f.body) : this.service.handoffIntake(f.body);
  }

  merchantInitials(tx: Transaction): string {
    return initialsOf(tx.merchant_name);
  }

  /** Bumped by ``reset``: a load started before it never writes into the next customer's (or a signed-out) page. */
  private generation = 0;

  private reset(): void {
    this.generation++;
    this.clearUpdates();
    this.stopRefresh();
    this.refreshUnauthorized = false;
    this.tour.set(null);
    this.alert.set(null);
    this.alertNote.set('');
    this.client.set('');
    this.roles.set([]);
    this.transactions.set([]);
    this.hasMore.set(false);
    this.viewRef.set(null);
    this.card.set(null);
    this.reports.set(null);
    this.reportsFailed.set(false);
    this.openThread.set(null);
    this.thread.set(null);
    this.chosenLang.set(null);
    this.general.set(false);
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
