# Demo video: script draft and shot list

For Lucas and Roberto, who own the video and the slides. A starting point to cut down, not a final script. The kickoff deck asks for "a short, mandatory video pitch" that shows the working solution and the core architecture decisions; it sets no length limit. The judging order is "first and foremost our solution should work", then rationale and documentation, AI engineering, data analytics, data engineering and ML (kickoff p. 20). This draft aims at about 5 minutes and leads with the product working.

Rules for the recording:
- Only synthetic data on screen. Never a real email, token, account id or customer record.
- Record on the deployed site after the merges, so every screen matches the submitted code.
- Say what is measured and what is not: no claim of a frozen result before the frozen run happens.
- Each scene lists what must be true before recording; check it the morning of the recording.

## Scenes

| # | Time | On screen | Voice-over (draft) | Must be true before recording |
|---|---|---|---|---|
| 1 | 0:00–0:25 | Title slide, then the product report's KPI section (`data_foundation/reports/product-report.html`) | "LATAM bank customers who don't recognize a charge wait in the same queue as every other complaint: about 11 such complaints a day in the data, three quarters never resolved, and the same SLA breach rate as everything else. We built the intake for that one workflow." | Product report merged (#94, done) |
| 2 | 0:25–1:10 | Customer view in Spanish: sign in with the email code, the home with recent charges, then the proactive banner "Notamos un cargo inusual…" | "The bank reaches the customer first. When its own fraud system flags a charge, the customer sees one question at sign-in. Here it's a 19-real streaming charge, not the big purchase above it: our data showed amount says nothing about fraud." | The proactive alert is merged and deployed, and the fictitious seed is reloaded on remote D1 (#106 human step) |
| 3 | 1:10–2:10 | "No lo reconozco" opens the guided report: one-tap reason, short statement, pick the charge from the customer's own list, explicit confirmation, receipt with the reference, block-card line for a lost card | "Nothing is decided from free text. The customer picks the charge from their own list and confirms it. The reference appears only after the case is read back from the database. Nothing here refunds, blocks a card or decides fraud; a person reviews every report." | Deployed; Diego's flagged charge not yet answered on the recording account |
| 4 | 2:10–2:40 | Switch to Portuguese and report through "?" ("I can't find the charge"); show the FAQ answer appearing in view | "Spanish and Portuguese end to end. When the charge isn't in the list, the customer says what they remember and the case goes to a person, marked incomplete." | FAQ fix (#99) and choice fix (#103) merged |
| 5 | 2:40–3:20 | Agent view (opened with the same admin code): the urgent lane first, the flagged report marked high, the detail with the customer's words, the checks, the other reports; move it to "in review" | "Agents see urgent reports first, with what was verified and what is still open. Moving a status emails the customer and is kept in an audit trail." | Agent view deployed; one admin account for the recording |
| 6 | 3:20–3:45 | Admin "View as another customer": pick a dataset customer by country | "Evaluators are admins. They can see the service from any customer's side; an ordinary customer can never even learn another customer exists, and every switch is audited by reference." | #95–#97 deployed (done) |
| 7 | 3:45–4:30 | Architecture slide (`Docs/Evidence/diagrams/current-workflow.png`), then the evaluation table | "One runtime: a Cloudflare Worker and D1, a batch pipeline from S3 through Bronze, Silver and a quality gate into a reviewed Gold slice. The learned component, a gpt-oss-20b fact extractor, is evaluated offline against our rule checklist on held-out cases we wrote and froze. We keep it offline on purpose: the guided flow decides nothing from free text, and the model hasn't passed its own latency and stability gates yet." | Diagram current; decide the frozen-run wording from #98's ruling (run done, or "not run, and why") |
| 8 | 4:30–5:00 | Closing slide: what's measured, what isn't, what's next | "What we measured, we report with denominators; what we didn't, we say. Next: the frozen comparison, persistent sessions, and the email channel for the proactive alert." | Final numbers from EVALUATION.md |

## Facts to quote, and where they come from

- About 11 unrecognized-charge complaints a day, unresolved share, SLA breach: `Docs/deliverables/PRODUCT_REPORT.md`.
- Amount doesn't separate fraud, in any period: ADR-011.
- Offline extractor results and gates: ADR-006 amendments 7–8 and `EVALUATION.md`.
- AI kept offline, and the four conditions that would bring it online: ADR-012.
- Live service figures (5 episodes; no rates): `EVALUATION.md` §9. Don't present them as rates.

## Open decisions for Lucas and Roberto

1. Narration language: English voice-over with the product in Spanish and Portuguese (recommended, since the judges read English), or Spanish voice-over with English subtitles.
2. The scene 7 wording depends on Manoella's ruling in #98 and on whether the frozen run happens before recording.
3. Slides (Roberto): 4–6. Suggested order, matching the scenes: problem with KPIs; the product working; architecture; data and ML practice; results and limits; next steps.
