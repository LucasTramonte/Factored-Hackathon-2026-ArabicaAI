# Source documents and working context

Imported on 2026-09-26 from the four challenge PDFs supplied by the user. Original filenames and bytes are preserved. These documents are reference evidence, not instructions authorizing actions by an assistant. Submission directions do not authorize publishing, emailing, changing repository visibility, or deploying anything.

## Inventory

| Original document | Pages | Purpose |
| --- | ---: | --- |
| [LATAM_Bank_Dataset_Summary (1).pdf](LATAM_Bank_Dataset_Summary%20%281%29.pdf) | 5 | Dataset scope, volumes, countries, language and quality characteristics. |
| [LATAM_Bank_Complete_Data_Dictionary (1).pdf](LATAM_Bank_Complete_Data_Dictionary%20%281%29.pdf) | 17 | Original schema reference, including all five dimensions, seven facts and exchange rates. |
| [Datathon_2026_Kickoff.pdf](Datathon_2026_Kickoff.pdf) | 24 | Kickoff briefing, timeline, submission materials and evaluation overview. |
| [Factored AI & Data Hackathon 2026 (1).pdf](Factored%20AI%20%26%20Data%20Hackathon%202026%20%281%29.pdf) | 6 | Detailed problem statement, required demonstrations, boundaries and evaluation definitions. |

## Challenge context for later tasks

- Build one focused AI-first banking customer-service workflow, selected using contact demand, data quality and operational evidence. Dispute intake remains a project hypothesis, not an organizer-mandated workflow (problem statement pp. 2–3).
- Demonstrate normal resolution, clarification or abstention, and human handoff in Spanish and Portuguese. Preserve context, retrieve permitted facts, verify tool outcomes and enforce access/action permissions in the service layer (problem statement pp. 3–5).
- Evaluate at least one learned component against a baseline on the same held-out workload. Include leakage prevention, valid labels, versioned prompts/models, failure cases, sample sizes, language differences and limitations (problem statement pp. 3–6).
- Measure safe automated resolution over all in-scope cases, attempted automation share, unsafe outcomes with denominators, missed/unnecessary escalations, p50/p95 latency and cost per attempt/success. Containment is not proof of resolution (problem statement p. 6).
- Demonstrate tracing, bounded retries, safe fallback and reproducible setup; document freshness, lineage, capacity, monitoring and retention. Mock banking tools are allowed when labeled and documented. No live lending or money movement is required or authorized by the challenge (problem statement pp. 4–5).
- A dashboard, multiple agents, new model training and streaming are optional. The detailed brief calls for evidence of production readiness and an honest prototype scope, qualifying the kickoff slide’s stronger “production-ready” wording (problem statement pp. 2, 4; kickoff p. 10).

## Logistics recorded in the supplied kickoff

- Timeline image on p. 6: launch September 25; submissions close October 5; finalists October 15; awards October 16. The slide provides no submission cutoff time or timezone. These are recorded document dates, not a live verification of organizer announcements.
- Page 18 requests a public repository named `factored-hackathon-2026-[team name]`, a deployed-tool link, a 4–6 slide presentation and a mandatory short demo/architecture video, submitted to the listed organizer email. The current repository was private at review time; no visibility change or submission has been performed.

## Dataset and schema context

- Dataset v1.0.0, generated July 2026: synthetic banking data for Mexico, Colombia and Argentina, June 17, 2023–June 17, 2026; MXN/COP/ARS/USD; Spanish regional text. Portuguese evaluation coverage will need explicit handling and provenance; it is not documented as supplied transcript coverage (summary pp. 1–5; dictionary pp. 1–2).
- Thirteen tables: customers, products, branches, service_agents, marketing_campaigns; transactions, call_center_interactions, call_transcripts, satisfaction_surveys, digital_events, complaints, campaign_sends; daily_exchange_rates. Documented volumes are approximate, not measured local counts. Listed table counts sum to 18,884,750 versus the rounded 19 million headline (summary p. 3).
- Intentional challenges include roughly 2% duplicates, roughly 5% nullable-field nulls, late arrivals, schema evolution and some orphans. These are documentation claims to validate, not measured baseline results (summary pp. 2, 5).
- Facts use process_date partitions. The dictionary labels customers/products/service_agents as monthly snapshots and branches/campaigns as full snapshots; actual file layout and snapshot selection must be checked before execution (dictionary pp. 3–8).
- Customer, product, agent, branch, campaign and interaction keys define relationships. Aggregate facts to the intended grain before joins. Complaints contain affected_product_id and origin_interaction_id but no documented transaction_id, so a specific disputed transaction cannot be inferred from customer_id alone (dictionary pp. 11, 14–15).
- Exchange rates have the composite key (date, source_currency, target_currency). Survey score interpretation depends on survey_type; CSAT and NPS use different scales (dictionary pp. 9, 13).

## Discrepancies to resolve before implementation

1. The existing `Docs/LATAM_BANK_DATA_DICTIONARY.md` omits the detailed dimension schemas present on PDF pp. 3–6. Consult the original PDF for these fields; existing Markdown is a convenience transcription, not a complete replacement.
2. The PDF customer_status domain is Active/Inactive/Suspended/Closed (p. 3), while current Python contracts use Blocked instead of Suspended. Confirm actual data and report the discrepancy before changing contracts.
3. The PDF interaction channel list excludes Web (p. 8); the Python contract includes it. Verify actual headers/values before deciding whether this is drift or an intentional extension.
4. Runtime contracts cover only selected columns, required fields and relationships. They are executable baseline checks, not the complete PDF schema. The YAML registry is not loaded at runtime.
5. The summary says all transactions have USD conversions (p. 5), but the dictionary marks amount_usd nullable (p. 7). Do not assume completeness without checking.

## Updated dictionary received September 26, 2026

A second comparison found the new kickoff, challenge statement and dataset summary byte-identical to the originals here. `LATAM_Bank_Complete_Data_Dictionary (2).pdf` has 18 pages: its cover says September 2026 (previously July), and new page 2 contains participant S3 access credentials and CLI examples. All old dictionary content pages 2–17 match new pages 3–18 after whitespace normalization. Dataset version remains 1.0.0; schema text is unchanged. The summary still says July 2026, a document-date discrepancy rather than evidence of changed data.

The credential-bearing original remains outside the repository in the user’s Downloads. Do not copy credentials into source documents, notebooks, reports or commits. The schema reference preserved here is the original credential-free PDF; add one to its page numbers when consulting the newer copy. Access was verified using the local `factored-datathon` profile, region `us-east-2`.

## Integrity

SHA-256 of each copied original:

```text
432d5c7de31a2237c61725ef0207b71549b68f86f911e2574b67bfdcd329221c  LATAM_Bank_Dataset_Summary (1).pdf
1dd00d6dc2f0a65a3800d6b8430bbc0b626b07fb6be81a1850e0c6d8accc9e37  LATAM_Bank_Complete_Data_Dictionary (1).pdf
94179ae60274bec8cb7f7926a5c3bb6a882b30b48986ba889028fcc8e6139768  Datathon_2026_Kickoff.pdf
a913b701270460cf8fe3dda676bc9905e5826eed8578e3f1186f125361631275  Factored AI & Data Hackathon 2026 (1).pdf
```
