import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

interface Transaction {
  transaction_id: string; merchant_name: string;
  occurred_at: string | null; source_occurred_at: string | null; amount: string; currency: string;
}
interface Receipt {
  protocol: string; status: string; replayed: boolean;
}
interface AgentCase extends Transaction {
  protocol: string; display_name: string; customer_statement: string;
  status: string; accepted_at: string;
}
interface CaseBody {
  transaction_id: string; customer_statement: string;
  customer_confirmed: boolean; idempotency_key: string;
}

/** Local fictitious-data demo; preserve each submitted request across retries. */
@Component({
  selector: 'app-root', imports: [CommonModule, FormsModule],
  templateUrl: './app.html', styleUrl: './app.css'
})
export class App {
  readonly title = signal('ArabicaAI');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly client = signal('');
  readonly transactions = signal<Transaction[]>([]);
  readonly receipt = signal<Receipt | null>(null);
  readonly cases = signal<AgentCase[]>([]);
  readonly agentLoaded = signal(false);
  readonly pending = signal<CaseBody | null>(null);
  identity = 'demo-bruno';
  selected = '';
  statement = '';
  confirmed = false;

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'Session expired. Sign in again with the same identity to continue.',
        404: 'Charge not found for this session.',
        409: 'This request key was used for different content. Do not start another request; ask an agent to check the case.',
        422: 'Check the fields and confirm the request.',
        503: 'Service unavailable. Acceptance was not confirmed. Retry the same request.'
      };
      throw new Error(messages[response.status] ?? ('HTTP error ' + response.status));
    }
    return response.json() as Promise<T>;
  }

  /** Reauthenticate without changing ownership of an unresolved request. */
  async login(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    const identity = this.pending() ? this.client() : this.identity;
    if (!this.pending()) {
      this.client.set(''); this.transactions.set([]);
      this.selected = ''; this.statement = ''; this.confirmed = false;
      this.receipt.set(null);
    }
    try {
      await this.api('/demo/session', {customer_id: identity});
      this.client.set(identity);
      const result = await this.api<{items: Transaction[]}>('/transactions');
      this.transactions.set(result.items);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  /** Freeze the confirmed payload and reuse its key until acceptance is known. */
  async submit(): Promise<void> {
    if (this.busy() || this.receipt()) return;
    if (!this.pending()) {
      if (!this.selected || !this.confirmed || this.statement.trim().length < 10) {
        this.error.set('Select a charge, describe the issue in at least 10 characters, and confirm.');
        return;
      }
      this.pending.set({transaction_id: this.selected,
        customer_statement: this.statement.trim(), customer_confirmed: true,
        idempotency_key: crypto.randomUUID()});
    }
    this.busy.set(true); this.error.set('');
    try {
      const result = await this.api<Receipt>('/cases', this.pending());
      this.receipt.set(result); this.pending.set(null);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  /** Fetch persisted cases with a separate, explicitly simulated agent session. */
  async loadAgent(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.agentLoaded.set(false);
    this.cases.set([]);
    try {
      await this.api('/demo/agent-session', {});
      const result = await this.api<{items: AgentCase[]}>('/agent/cases');
      this.cases.set(result.items); this.agentLoaded.set(true);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  /** Format wall time as text; never let the browser assign a timezone. */
  sourceDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(value);
    return match
      ? match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4]
      : value;
  }

  private fail(e: unknown): void {
    this.error.set(e instanceof Error ? e.message : 'Request failed.');
  }
}
