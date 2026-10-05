# Pre-submission Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four customer-facing bugs found in the 2026-10-05 read-only bug hunt before the hackathon submission.

**Architecture:** Three small changes, no API or schema change. Two are client-only, in the customer page. One is a data fix: the demo charges are renamed to merchants in the frozen extractor vocabulary. A person applies it to remote D1 with one reviewed SQL file. The frozen matcher and prompt are not touched: their bytes are pinned by the parity tests and the evaluation.

**Tech Stack:** Angular (signals, Karma/Jasmine), Cloudflare Worker + D1 (node:test), Wrangler.

**Worktree:** `.claude/worktrees/presubmit-fixes`, branch `fix/pre-submission-bugs`, from `origin/main` `f905257`. Every command below runs from that worktree root. Before the first test run, symlink the dependencies once:

```bash
ln -s ../../../front-end/node_modules front-end/node_modules   # adjust if the relative path differs; it must point at the main checkout's front-end/node_modules
ln -s ../../../back-end/node_modules back-end/node_modules
```

Remove both symlinks before committing (`rm front-end/node_modules back-end/node_modules`); `git status` must not list them.

**Out of scope (ponytail ultra):** security headers, the agent-queue cap, the mid-report language switch, admin session renewal, the shared-laptop agent session, lost "received" emails, stuck pending runs, the workflow input injection, LICENSE. They are in the bug report and wait until after submission.

---

## Bugs and where each is fixed

| # | Bug | Root cause | Task |
|---|---|---|---|
| 1 | The search button reads "Tus cargos / Your charges" and stays visible although discovery is off; pressing it shows a failure note | The template reuses `t().recent`, the charge-list heading. The client cannot know the switch until a call answers 503 | Task 1 |
| 3 | From the Help entry, picking a search result leaves a choose step with no charges and no Confirm | `useDiscovery` never clears `general()`, and the general choose step shows only "I can't find it" | Task 2 |
| 4 | A search result or the alert's charge that is not in the loaded page cannot be confirmed | `choosable()` (and so `confirmCharge`) only knows `transactions()`, a 20-row page | Task 2 |
| 2 | AI suggestions almost never match for the six demo customers | Demo charges are named "X Demo". The model is told the dataset vocabulary and the frozen matcher compares names exactly, so neither the merchant nor its category ever matches | Task 3 |

---

### Task 1: Name the search button, and hide it once the server says discovery is off

**Files:**
- Modify: `front-end/src/app/shared/i18n/lang.service.ts` (one key per language, beside `discoveryNarrow`: es ~line 114, pt ~262, en ~404)
- Modify: `front-end/src/app/features/customer/customer.page.ts` (the `discovery*` signals ~line 216, and `discover()` ~line 1146)
- Modify: `front-end/src/app/features/customer/customer.page.html:378`
- Test: `front-end/src/app/features/customer/customer.page.discovery.spec.ts`

- [ ] **Step 1: Write the failing test.** Append inside the `describe` block of `customer.page.discovery.spec.ts`:

```ts
  it('labels the button as an AI search in every language, and hides it for the session once the server answers 503', async () => {
    for (const language of ['es', 'pt', 'en'] as const) {
      page.lang.set(language); fixture.detectChanges();
      const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(b => b.textContent!.trim() === page.t().discoverySearch);
      expect(button).withContext(language).toBeDefined();
      expect(page.t().discoverySearch).not.toBe(page.t().recent);
    }
    service.discoverTransactions.and.rejectWith(new ApiError(503));
    await page.discover(); fixture.detectChanges();
    expect(page.discoveryOff()).toBeTrue();
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain(page.t().discoveryUnavailable);
    expect(text).not.toContain(page.t().discoverySearch);
  });

  it('keeps the button for a deliberate retry after a failure that is not 503', async () => {
    service.discoverTransactions.and.rejectWith(new ApiError(500));
    await page.discover();
    expect(page.discoveryOff()).toBeFalse(); expect(page.discoveryError()).toBe('unavailable');
  });
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless --include='**/customer.page.discovery.spec.ts'`
Expected: FAIL. It does not compile: `discoverySearch` does not exist on the strings type, and `discoveryOff` does not exist on `CustomerPage`.

- [ ] **Step 3: Add the strings.** In `lang.service.ts`, add one line after each language's `discoveryNarrow` line:

```ts
    discoverySearch: 'Buscar el cargo con IA',        // es
    discoverySearch: 'Buscar a cobrança com IA',      // pt
    discoverySearch: 'Search for the charge with AI', // en
```

(Write only the key and value in each block; the comments here only say which block.)

- [ ] **Step 4: Add the signal and set it on 503.** In `customer.page.ts`, next to `readonly discoveryError = …`:

```ts
  /** The server answered 503: discovery is switched off (or unavailable) for this session, so the button goes away. */
  // ponytail: learned from the first 503, not from config; a config read would need an API change.
  readonly discoveryOff = signal(false);
```

In `discover()`, replace the `catch` line with:

```ts
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) this.discoveryOff.set(true);
      this.discoveryError.set(error instanceof ApiError && error.status === 422 ? 'narrow' : 'unavailable');
    }
```

- [ ] **Step 5: Use the label and hide the button.** In `customer.page.html` line 378, wrap the search button and change its label:

```html
                  @if (!discoveryOff()) { <button type="button" class="ar-btn ar-btn-secondary" (click)="discover()" [disabled]="busy() || discoveryBusy() || !chatDetails.trim()">{{ discoveryBusy() ? t().working : t().discoverySearch }}</button> }
```

- [ ] **Step 6: Run the spec and confirm it passes.**

Run the Step 2 command. Expected: every test in the file passes, including the earlier "preserves manual details after failure and allows a deliberate retry" test. Its error is a plain `Error`, not a 503, so the button stays.

- [ ] **Step 7: Commit.**

```bash
git add front-end/src/app/shared/i18n/lang.service.ts front-end/src/app/features/customer/customer.page.ts front-end/src/app/features/customer/customer.page.html front-end/src/app/features/customer/customer.page.discovery.spec.ts
git commit -m "fix(customer): call the discovery button an AI search and hide it once the server says it is off"
```

---

### Task 2: A charge picked from search or the alert can always be confirmed

**Files:**
- Modify: `front-end/src/app/features/customer/customer.page.ts`: `choosable` (~line 189), `answerAlert` (~line 471), `useDiscovery` (~line 1159), `clearChat` (the private method that resets the chat)
- Test: `front-end/src/app/features/customer/customer.page.discovery.spec.ts`

- [ ] **Step 1: Write the failing tests.** Append inside the same `describe`:

```ts
  it('from the Help entry, a picked search result shows the normal choose step and can be confirmed', async () => {
    page.general.set(true); page.discovery.set(result);
    page.useDiscovery(tx.transaction_id); page.chatConfirmed = true;
    expect(page.general()).toBeFalse();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector(`input[name="chat-choice"][value="${tx.transaction_id}"]`)).not.toBeNull();
    service.confirmIntake.and.resolveTo({} as never);
    await page.confirmCharge();
    expect(page.chatError()).not.toBe(page.t().chatChooseValidation);
    expect(service.confirmIntake).toHaveBeenCalledOnceWith(jasmine.objectContaining({ transaction_id: tx.transaction_id, customer_confirmed: true }));
  });

  it('a search result outside the loaded page of charges is choosable, and a new chat forgets it', () => {
    page.transactions.set([]); page.discovery.set(result);
    page.useDiscovery(tx.transaction_id);
    expect(page.choosable().map(t => t.transaction_id)).toEqual([tx.transaction_id]);
    page.openChat(undefined, true); page.cancelChat?.();
    (page as unknown as { clearChat(): void }).clearChat();
    expect(page.choosable()).toEqual([]);
  });

  it('the alert charge is choosable after "I don\'t recognize it" even when it is not in the loaded page', async () => {
    page.transactions.set([]); page.alert.set(tx);
    (service as unknown as { answerAlert: jasmine.Spy }).answerAlert = jasmine.createSpy('answerAlert').and.resolveTo(undefined);
    await page.answerAlert('report');
    expect(page.choosable().map(t => t.transaction_id)).toEqual([tx.transaction_id]);
    expect(page.choice).toBe(tx.transaction_id);
  });
```

If `page.cancelChat` does not exist, delete `page.cancelChat?.();`. The direct `clearChat()` call is what the test needs.

- [ ] **Step 2: Run it and confirm it fails.**

Run: `CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless --include='**/customer.page.discovery.spec.ts'`
Expected: the three new tests FAIL. In the first, `general()` stays true and there is no radio. In the second and third, `choosable()` is empty.

- [ ] **Step 3: Implement.** In `customer.page.ts`, replace the `choosable` line with:

```ts
  /** A charge chosen from outside the loaded page: a search result or the bank alert's charge. Forgotten by ``clearChat``. */
  readonly extraCharge = signal<Transaction | null>(null);
  readonly choosable = computed(() => {
    const extra = this.extraCharge(), list = this.transactions();
    const all = extra && !list.some(t => t.transaction_id === extra.transaction_id) ? [...list, extra] : list;
    return all.filter(tx => (this.reportOf(tx.transaction_id)?.status ?? 'closed') === 'closed');
  });
```

Replace `useDiscovery` with:

```ts
  /** Selecting a returned candidate still requires the existing explicit confirmation checkbox; the normal choose step shows it. */
  useDiscovery(transactionId: string): void {
    const tx = this.discovery()?.items.find(i => i.transaction_id === transactionId);
    if (!tx) return;
    this.extraCharge.set(tx); this.general.set(false);
    this.choice = transactionId; this.chatConfirmed = false; this.asking.set(false);
    this.log.update(l => [...l, { from:'bot', key:'chatChoose' }]);
  }
```

In `answerAlert`, replace `else this.openChat(tx.transaction_id);` with:

```ts
    else { this.openChat(tx.transaction_id); this.extraCharge.set(tx); } // after openChat: a restart clears the chat
```

In `clearChat()`, add as its first statement:

```ts
    this.extraCharge.set(null);
```

`clearChat()` also runs on sign-out (the reset block ends with `this.clearChat()`), so one customer's charge never reaches the next.

- [ ] **Step 4: Run the spec and confirm it passes.**

Run the Step 2 command. Expected: all tests pass, including the existing "selects only a returned candidate and resets explicit confirmation without sending" test. Its last assertion still expects the validation error, because `chatConfirmed` is false there.

- [ ] **Step 5: Commit.**

```bash
git add front-end/src/app/features/customer/customer.page.ts front-end/src/app/features/customer/customer.page.discovery.spec.ts
git commit -m "fix(customer): a charge from search or the alert can always be chosen and confirmed"
```

---

### Task 3: Name the demo charges after merchants the extractor and matcher know

The extractor prompt lists the dataset vocabulary (`back-end/src/modules/intake/ai-transport.js`, `BY_CATEGORY`), and the frozen matcher compares merchant names exactly and takes the category from that list (`suggestions.js` `record`). Renaming the 26 fictitious charges to vocabulary merchants makes "a taxi I don't recognise" (→ "Taxi Seguro" or category Transport) match. Ids, amounts, dates and currency stay; duplicate pairs stay duplicates.

| Old name | New name |
|---|---|
| Mercado Demo | Mercado Central |
| Loja Demo | Tienda General |
| Cafe Demo | Tienda Don José |
| Farmacia Demo | Farmacia Salud |
| Posto Demo | Estación de Servicio |
| Eletronicos Demo | Centro Comercial |
| Restaurante Demo | Restaurante El Buen Sabor |
| Streaming Demo | Streaming Music |
| Viagens Demo | Conciertos Live |
| Padaria Demo | Super Ahorro |
| Musica Demo | Streaming Music |
| Moveis Demo | Ferretería |
| Taxi Demo | Taxi Seguro |
| Nuvem Demo | Internet Plus |
| Joalheria Demo | Boutique Moda |
| Livraria Demo | Tienda General |
| Jornal Demo | Cable TV |
| Eletro Demo | Centro Comercial |

**Files:**
- Create: `back-end/test/unit/demo-seed-vocabulary.test.js`
- Modify: `back-end/seeds/seed_fictitious.sql` (the 26 `INSERT INTO transactions` lines)
- Create: `back-end/scripts/demo-merchant-names.sql` (the remote update a person runs)
- Modify: every test or doc that names an old merchant (found in Step 5)

- [ ] **Step 1: Write the failing test.** Create `back-end/test/unit/demo-seed-vocabulary.test.js`:

```js
/** The fictitious demo charges must name merchants the extractor is told about, or suggestions can never match them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOCABULARY } from '../../src/modules/intake/ai-transport.js';

const seed = readFileSync(new URL('../../seeds/seed_fictitious.sql', import.meta.url), 'utf8');
const update = readFileSync(new URL('../../scripts/demo-merchant-names.sql', import.meta.url), 'utf8');
const merchants = [...seed.matchAll(/INSERT INTO transactions\([^)]*\) VALUES \('[^']*','[^']*','[^']*',NULL,'([^']*)'/g)].map(m => m[1]);

test('every fictitious demo charge names a vocabulary merchant', () => {
  assert.equal(merchants.length, 26);
  for (const name of merchants) assert.ok(Object.hasOwn(VOCABULARY.merchants, name), name);
});

test('the remote update sets exactly the names the seed holds', () => {
  const set = new Set([...update.matchAll(/SET merchant_name='([^']*)'/g)].map(m => m[1]));
  assert.deepEqual([...set].sort(), [...new Set(merchants)].sort());
  assert.match(update, /customer_id IN \('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco'\)/);
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `node --test back-end/test/unit/demo-seed-vocabulary.test.js`
Expected: FAIL with `ENOENT` for `demo-merchant-names.sql`. After Step 4 creates that file, the first test fails on `Mercado Demo` until Step 3.

- [ ] **Step 3: Rename in the seed.** Only the `VALUES (…)` text changes. The `ON CONFLICT` clause compares with `excluded`, so it needs no edit. Run from the worktree root:

```bash
python3 - <<'PY'
import pathlib
MAP = {'Mercado Demo':'Mercado Central','Loja Demo':'Tienda General','Cafe Demo':'Tienda Don José','Farmacia Demo':'Farmacia Salud',
 'Posto Demo':'Estación de Servicio','Eletronicos Demo':'Centro Comercial','Restaurante Demo':'Restaurante El Buen Sabor',
 'Streaming Demo':'Streaming Music','Viagens Demo':'Conciertos Live','Padaria Demo':'Super Ahorro','Musica Demo':'Streaming Music',
 'Moveis Demo':'Ferretería','Taxi Demo':'Taxi Seguro','Nuvem Demo':'Internet Plus','Joalheria Demo':'Boutique Moda',
 'Livraria Demo':'Tienda General','Jornal Demo':'Cable TV','Eletro Demo':'Centro Comercial'}
p = pathlib.Path('back-end/seeds/seed_fictitious.sql'); s = p.read_text()
for old, new in MAP.items(): s = s.replace(f",NULL,'{old}',", f",NULL,'{new}',")
p.write_text(s)
PY
grep -c " Demo'," back-end/seeds/seed_fictitious.sql   # expected 0
```

- [ ] **Step 4: Create the remote update.** Create `back-end/scripts/demo-merchant-names.sql`:

```sql
-- One-off, reviewed data fix (2026-10-05): rename the fictitious demo charges to merchants in the extractor's vocabulary,
-- so "I can't find it" suggestions can match them. Same ids, amounts, dates and currency; seeds/seed_fictitious.sql holds
-- the same names, so a later seed reload agrees with remote D1. Dataset customers are untouched.
-- A person runs it once: cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file scripts/demo-merchant-names.sql
UPDATE transactions SET merchant_name='Mercado Central' WHERE merchant_name='Mercado Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda General' WHERE merchant_name='Loja Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda Don José' WHERE merchant_name='Cafe Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Farmacia Salud' WHERE merchant_name='Farmacia Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Estación de Servicio' WHERE merchant_name='Posto Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Centro Comercial' WHERE merchant_name='Eletronicos Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Restaurante El Buen Sabor' WHERE merchant_name='Restaurante Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Streaming Music' WHERE merchant_name='Streaming Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Conciertos Live' WHERE merchant_name='Viagens Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Super Ahorro' WHERE merchant_name='Padaria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Streaming Music' WHERE merchant_name='Musica Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Ferretería' WHERE merchant_name='Moveis Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Taxi Seguro' WHERE merchant_name='Taxi Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Internet Plus' WHERE merchant_name='Nuvem Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Boutique Moda' WHERE merchant_name='Joalheria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Tienda General' WHERE merchant_name='Livraria Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Cable TV' WHERE merchant_name='Jornal Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
UPDATE transactions SET merchant_name='Centro Comercial' WHERE merchant_name='Eletro Demo' AND customer_id IN ('demo-ana','demo-bruno','demo-carla','demo-diego','demo-elena','demo-marco');
```

- [ ] **Step 5: Update every test and doc that names an old merchant.** List them:

```bash
git grep -n -E "(Mercado|Loja|Cafe|Farmacia|Posto|Eletronicos|Restaurante|Streaming|Viagens|Padaria|Musica|Moveis|Taxi|Nuvem|Joalheria|Livraria|Jornal|Eletro) Demo" -- back-end Docs README.md evals ':!back-end/scripts/demo-merchant-names.sql'
```

Apply the table's mapping in every **back-end test, fixture and doc** that the command lists. Known hits: `back-end/test/fixtures/kpi-journeys.json`, `back-end/test/integration/budget.test.js`, `back-end/test/integration/suggestions.test.js`, `back-end/test/unit/intake-storage.test.js`. They seed or assert against D1 rows, so the names must match. Front-end specs build their own fixtures and need no change. Apply the same `python3` replacement as Step 3, with `MAP` over each listed file, and replace the bare `'Old Demo'` text. Re-run the grep. Expected: no hits outside the update script.

- [ ] **Step 6: Run the tests and confirm they pass.**

```bash
node --test back-end/test/unit/demo-seed-vocabulary.test.js
npm --prefix back-end test
```

Expected: the new file shows 2/2. The full backend run shows 0 failures across unit, accounting, integration and budget. In particular, `run-local.mjs` reloads the renamed seed twice and refuses the divergent drift fixture as before. Then check that a taxi report now matches, with a one-off script:

```bash
cd back-end && node --input-type=module -e "
import { suggestionFor } from './src/modules/intake/suggestions.js';
const rows=[{transaction_id:'demo-tx-018',merchant_name:'Taxi Seguro',amount:'42.00',currency:'BRL',occurred_at:'2026-09-26T22:05:00+00:00',source_occurred_at:null},{transaction_id:'demo-tx-019',merchant_name:'Taxi Seguro',amount:'42.00',currency:'BRL',occurred_at:'2026-09-26T22:06:00+00:00',source_occurred_at:null}];
for (const f of [{merchant:'Taxi Seguro'},{category:'Transport'}]) console.log(JSON.stringify(f), JSON.stringify(suggestionFor({intent:'report',stated_facts:f,invalid:null,demand:null,injection:false}, {country:null,cards:[]}, rows, '2026-10-05')));
"; cd ..
```

Expected: both print `suggested`. If `suggestionFor` has a different signature, read its JSDoc in `suggestions.js` and adapt the call. Do not change the function.

- [ ] **Step 7: Commit.**

```bash
git add back-end/seeds/seed_fictitious.sql back-end/scripts/demo-merchant-names.sql back-end/test Docs README.md
git commit -m "fix(data): name demo charges after merchants the extractor knows, so suggestions can match them"
```

---

### Task 4: Full verification, PR and human steps

- [ ] **Step 1: Full suites.**

```bash
npm --prefix back-end test
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm --prefix front-end test -- --watch=false --browsers=ChromeHeadless
npm --prefix front-end run build
python3 -m unittest evals.support_assist.test_score evals.support_assist.test_discovery_score
```

Expected: 0 failures everywhere. The build succeeds, with the existing 500 kB warning only. The scorer tests are unchanged, because no frozen file was touched: `ai-transport.js`, `assist.js`, `assist-prompts.js` and `matcher.js` have no diff (`git diff origin/main --stat` must not list them).

- [ ] **Step 2: Remove the node_modules symlinks**, then push and open the PR, with these flags: label `bug` and `accessibility`, assignee `@me`, reviewer `LucasTramonte`, milestone `v0.6.0`. Title: `fix(customer): pre-submission fixes for discovery, choosing charges and demo suggestions`. The body follows `.github/pull_request_template.md` and ends with **Human steps before merge**:
  1. After merge, a person runs once: `cd back-end && npx wrangler d1 execute arabica-intake-demo --remote --file scripts/demo-merchant-names.sql`. Until then, production keeps the old names: the code works, and suggestions just keep missing. Agents never run `--remote`.
  2. The product video shows the old "… Demo" names; this is cosmetic.
  3. PR review and merge; the normal deploy publishes the client fixes.

- [ ] **Step 3: After merge and the remote update, smoke-test in production** (a person, signed in as Elena): "I can't find it" → "um táxi que não reconheço" → the receipt offers the two Taxi Seguro charges.

---

## Added during execution (user requests, 2026-10-05)

- **AI help panel says "unavailable or the report changed" (Task 5).** The customer route answers 503 while `ASSIST_CUSTOMER_ENABLED` is absent, or for a dataset customer (ADR-016). The client now hides the panel for the session on a 503 (`assistOff`), as Task 1 does for the search button. A non-503 failure keeps the panel and its message. Tests: `customer.page.assist.spec.ts`. Making it answer needs the switch on (a person's change).
- **Every demo account sees the tour again (Task 6).** The "seen" flag lives in each browser's localStorage, so the server cannot reset it. The key moves from `arabica.customer-tour.v1` to `v2`, so every browser is offered the tour once more.
- **Demo accounts start with no reported charges (Task 7).** `back-end/scripts/reset-demo-accounts.sql` deletes only the six demo customers' activity, in foreign-key order: reports, messages, suggestions, feedback, alert answers, email outbox, charge views and sessions. Kept: their charges, context cards and enrolled sign-in emails, and every other customer's activity. Test: `intake-storage.test.js`, "the demo-accounts reset clears only the six demo customers' activity…". A person runs it with `--remote`, after a Time Travel bookmark.

**Review change (fresh reviewer, 2026-10-05).** A 503 also means a provider failure or timeout, not only "switched off". Hiding the button or panel on the first 503 therefore hid a working feature until reload, and the flags survived a change of customer. Both flags were removed. On a 503, the search keeps its button with the accurate `discoveryUnavailable` note, and AI help keeps its panel with `customerAssistOff`: "AI help is not available right now. Your messages to the team still work." Both still allow a retry. The demo reset also deletes assist runs recorded against a completed report's case id.
