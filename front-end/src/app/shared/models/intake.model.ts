/** API shapes, kept in step with front-end/contracts/intake-api.schema.json. */
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
