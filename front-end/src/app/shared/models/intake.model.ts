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

// Agent intake (W4 fe-agent-console): /agent/intakes and /agent/intake-detail.
export type IntakeKind = 'complete' | 'technical' | 'incomplete';

export interface AgentIntake {
  protocol: string;
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
