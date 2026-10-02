/** API shapes, kept in step with front-end/contracts/intake-api.schema.json. */
export interface Identity {
  customer_id: string;
  display_name: string;
  /** Set for dataset customers loaded in D1; null for the committed fictitious identities. */
  country?: string | null;
}

export interface Transaction {
  transaction_id: string;
  merchant_name: string;
  occurred_at: string | null;
  source_occurred_at: string | null;
  amount: string;
  currency: string;
}

export interface TransactionList {
  items: Transaction[];
  has_more: boolean;
  coverage: string;
}

export interface CaseBody {
  transaction_id: string;
  customer_statement: string;
  customer_confirmed: true;
  idempotency_key: string;
}

export interface Receipt {
  protocol: string;
  transaction_id: string;
  status: 'accepted';
  accepted_at: string;
  replayed: boolean;
  scope: 'synthetic_demo_only';
  next_step: string;
}

export interface AgentCase extends Transaction {
  protocol: string;
  customer_id: string;
  display_name: string;
  customer_statement: string;
  customer_confirmed: true;
  status: 'accepted';
  accepted_at: string;
}

export interface AgentCaseList {
  items: AgentCase[];
  has_more: boolean;
  scope: 'synthetic_demo_only';
}

// Agent intake: /agent/intakes and /agent/intake-detail.
export type IntakeKind = 'complete' | 'technical' | 'incomplete';

export interface AgentIntake {
  protocol: string;
  /** Short human reference (AR-XXXX-XXXX) stored 1:1 with the handoff; null for handoffs stored before migration 0008. */
  reference_short: string | null;
  episode_id: string;
  kind: IntakeKind;
  tool_status: 'ok' | 'failed' | 'timeout';
  destination: string;
  priority: string;
  accepted_at: string;
}

export interface AgentIntakeList {
  items: AgentIntake[];
  has_more: boolean;
  scope: 'synthetic_demo_only';
}

/** One recorded service event; optional fields appear only on the events that carry them. */
export interface IntakeTransition {
  seq: number;
  event: string;
  ts: string;
  transaction_ref?: string;
  case_ref?: string;
  kind?: IntakeKind;
  tool_status?: string;
  accepted_by?: string;
  outcome?: string;
  missing?: string[];
}

export interface AgentIntakeDetail extends AgentIntake {
  language: 'es' | 'pt';
  customer_statement: string;
  verified_evidence: { transaction: Transaction | null };
  actions_taken: string[];
  unresolved_questions: string[];
  history: IntakeTransition[];
  history_has_more: boolean;
  scope: 'synthetic_demo_only';
}

// Guided intake (W5 fe-intake-chat): POST /demo/session context card and the /intake/* bodies and receipts.
export interface ContextCard {
  version: 1;
  snapshot_at: string;
  first_name: string | null;
  locale_hint: string;
  products: { product_type: string | null; last4: string | null; currency: string | null }[];
}

export interface CustomerSession {
  customer_id: string;
  mode: 'simulated_login';
  context_card?: ContextCard | null;
}

/** The back-end accepts only these report languages. */
export type IntakeLang = 'es' | 'pt';

export interface IntakeStartBody {
  customer_statement: string;
  idempotency_key: string;
  language: IntakeLang;
  mode: 'guided';
  report_type: 'unrecognized_charge';
}

/** A start never carries a reference; the customer must still choose the charge. */
export interface IntakeStart {
  episode_id: string;
  state: 'selection_required';
  language: IntakeLang;
  mode: 'guided';
  replayed: boolean;
}

export interface IntakeConfirmBody {
  customer_confirmed: true;
  episode_id: string;
  idempotency_key: string;
  transaction_id: string;
}

export interface IntakeHandoffBody {
  /** What the customer remembers about the charge (10–2000 code points); the server appends it to the statement. */
  details?: string;
  episode_id: string;
  idempotency_key: string;
  kind: 'incomplete';
}

/** Returned only after the handoff has been read back; ``kind`` is decided by the server. */
export interface IntakeReceipt {
  episode_id: string;
  protocol: string;
  /** Short human reference (AR-XXXX-XXXX), the one a customer keeps; the UUID ``protocol`` stays the case id. */
  reference_short: string | null;
  kind: 'complete' | 'technical' | 'incomplete';
  accepted_at: string;
  replayed: boolean;
  /** Server codes read back with the handoff: what was checked and what is still open. */
  actions_taken: string[];
  unresolved_questions: string[];
  next_step_code: 'await_human_review';
}
