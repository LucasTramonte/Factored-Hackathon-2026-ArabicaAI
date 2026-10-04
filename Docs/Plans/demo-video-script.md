# Demo video and slides: the launch pitch

For Lucas and Roberto, who own the video and the slides. A draft to cut down, not a final script.

## What the organizers asked for

- **Kickoff deck:** the video is "short" and mandatory, and shows the working solution and the core architecture decisions. The deck has 4–6 slides. No length limit is set. "First and foremost our solution should work" (judging, p. 20).
- **André R (organizers), 2026-10-03:** "Pitch it like you're in front of a bank investor. You're not presenting a technical project. You're selling a product that solves a real problem."
  - **Video: 90% product and creativity, 10% technical.** Why → What → How. Editing and delivery carry the most weight. Not a screen recording with narration: animations, transitions, mockups. It should feel like a product launch.
  - **Slides: 60% product, 40% technical.** Show architecture, data and models, always tied back to the value delivered.

We also follow Y Combinator's "A Guide to Demo Day Presentations" (Geoff Ralston, 2016):
- say what it is in the first sentence;
- build on 3–4 memorable points;
- size the opportunity bottom-up;
- one point per slide, few words;
- **never exaggerate**;
- practice until it's smooth;
- one presenter.

## The four points everyone should remember (the "vertebrae")

1. **"I don't recognize this charge" is the most anxious moment in banking, and today it waits in line.** In the challenge's synthetic bank data, 11 such complaints a day are handled exactly like any other complaint: a first answer after about a day, and three in four recorded as Open, In Process or Escalated.
2. **ArabicaAI aims to turn that moment into one minute** (a design target, not a measured average). The customer picks the charge from their own list, confirms it, and gets a reference before they close the app. A person reviews every report.
3. **The bank speaks first.** When the bank's fraud system flags a charge, the customer is asked before they have to go looking (in the demo the flag is an illustration we set on demo customers). We tested the obvious trigger, "big amount", and the data showed it doesn't work.
4. **AI where it earns its place, and nowhere else.** A model passed every gate we set in advance on development cases; its comparison on held-out cases is pending. Every result is published, including the ones that didn't go our way.

Answers to YC's four questions:

| YC question | Our answer |
|---|---|
| What are we building, and for whom? | A guided "unrecognized charge" report for a LATAM bank's customers, in Spanish and Portuguese, and the agent queue that receives it |
| Why hasn't this been done? | Banks treat it as one more complaint. The data shows the same handling, SLA and outcome as everything else |
| Why is it hard? | Security (one customer must never see another), the bank's liability (nothing may refund, block or decide fraud on its own), two languages, and knowing when AI helps |
| Why now? | Customers expect self-service in seconds, and the channel exists; what's missing is a flow designed for this moment |

## Video: about 2½ minutes, Why → What → How

Production rules:
- **Product first: about 90% of the time on the customer's and the agent's experience.**
- **No raw screen recording.** Put app captures inside phone and laptop mockups. Animate between states (Keynote Magic Move, Figma Smart Animate, or After Effects). Use kinetic text for the numbers, and music.
- **One narrator, speaking slowly.** Record the voice separately and re-take it until it's smooth. Add subtitles in English.
- **Only synthetic data on screen.** Capture from the deployed site after the merges, so the product shown is the product submitted. On 2026-10-04 that is Worker `d8da20c6` (`main` `a47b2e1`, D1 0001–0023), with Cognito sign-in and server-side per-customer isolation live and tested (`SYSTEM_DESIGN.md`, "Deployed"). Before capture, a person reloads the fictitious seed on remote D1 so the demo flags exist (#106's step).

| # | Time | Beat | Picture (animated) | Voice-over (draft) | Must be true before capture |
|---|---|---|---|---|---|
| 1 | 0:00–0:15 | **Why** (hook) | Black screen. A phone buzzes: "Compra aprobada: 3.150,00 BRL". A thumb hovers. | "You open your bank app and there's a charge you've never seen. What do you do?" | — |
| 2 | 0:15–0:35 | **Why** (the problem in numbers) | Kinetic numbers on a clean background: **11 a day**, **1 day to a first answer**, **3 in 4 still in progress**. Small caption: "Synthetic LATAM bank dataset (challenge data), 2023–2025". | "In the challenge's bank data, that moment happens 11 times a day. It's handled like any other complaint: a first answer after about a day, and three in four still listed as open, in process or escalated." | Product report (#94, merged) |
| 3 | 0:35–0:45 | **What** (the name and promise) | Logo reveal: **ArabicaAI**. Tagline: "Built to report it in a minute. A person takes it from there." (a target, never an achieved time) | "ArabicaAI is built to turn that moment into a minute." | Name decided (open decision 1) |
| 4 | 0:45–1:10 | **What** (the bank speaks first) | Phone mockup: sign in, then the home. The banner slides in: "Notamos un cargo inusual…" over a **19,90 BRL** charge, while the 3.150 BRL charge sits untouched above it. | "Before you even look, the bank asks you: do you recognize this? Not the biggest charge: the one the bank's fraud system flagged. We tested 'flag big amounts', and the data said no." On-screen caption: "Demo: illustrative flag". | #105 and #106 merged and deployed; the fictitious seed reloaded on remote D1 (#106's human step) |
| 5 | 1:10–1:40 | **What** (the report in a minute) | Tap "No lo reconozco": one-tap reason, a short sentence, pick the charge from your own list, confirm, then the **reference** animates in. Switch the language to Portuguese for one shot. | "Pick the reason. Pick the charge from your own purchases. Confirm. You get a reference right away, in Spanish or Portuguese, and the status by email. Nothing is refunded or blocked by a machine: a person reviews every report." | #99 and #103 merged and deployed |
| 6 | 1:40–2:00 | **What** (the agent side) | Laptop mockup: the agent queue, the flagged report at the top in red, the detail with what was verified and what's still open; click "In review". | "On the bank's side, urgent reports come first, already verified: which charge, which customer, what's still open. No re-asking." | Agent view deployed |
| 7 | 2:00–2:20 | **How** (the 10% technical) | One animated architecture line: data lake → quality gate → reviewed slice → one secure service → customer and agent. The model sits in a box to the side marked "tested, not trusted blindly". | "Under the hood: a quality-gated data pipeline, one secure service where each customer only ever sees their own data, and an AI model that passed every gate we set in advance on development cases; its test on cases it has never seen is next, and we publish all of it." | If the frozen comparison has run by recording time (#98 merged, tag, run), replace the last clause with its result |
| 8 | 2:20–2:35 | **Close** (the bang) | The four points, one by one, three words each: "Seconds, not days." "The bank speaks first." "AI, tested." "A person decides." Then the logo and the link. | "Seconds, not days. The bank speaks first. AI that is tested, not trusted blindly. And a person always decides. ArabicaAI." | Final link and name |

## Slides: 5 slides, 60% product, 40% technical

One point per slide, at most about 7 words of text, large type, a picture doing the work. Each slide is spoken over, never read.

| # | One point (on the slide) | Picture | Spoken (product → technical, tied to value) |
|---|---|---|---|
| 1 | "A strange charge waits in line." | The three numbers from beat 2, huge | The problem and who has it; the data source |
| 2 | "Built to report it in a minute." (target) | Phone mockup of the flow, three frames | The product and the customer; the proactive alert |
| 3 | "One service. Each customer sees only theirs." | The one-line architecture from beat 7 | Security and data engineering: the reviewed slice, the quality gate, the isolation tests |
| 4 | "AI where it earns its place." | Our rules against the model, side by side, held-out cases | ML practice: the pre-registered gates, what passed, what's pending; why the live flow stays deterministic (ADR-012) |
| 5 | "Seconds, not days. A person decides." | Logo, link, team | Next steps and the four points again |

## What we can and cannot claim (YC: "Exaggerating the truth is a fatal error")

| Claim | Status | Source |
|---|---|---|
| 11 unrecognized-charge complaints a day; three in four recorded as Open, In Process or Escalated; first response after about a day (25 h at p50) | Yes, as figures from the challenge's **synthetic** bank data. Never "unresolved forever" or "real customers" | `PRODUCT_REPORT.md` |
| "A reference in seconds" / "one minute" | **Target only.** Five team episodes (four accepted, one routed incomplete) support no rate, so never "on average" or "customers do it in" | `EVALUATION.md` §9 |
| "Big amounts don't mean fraud" | Yes, in this data, in every period | ADR-011 |
| "The bank's fraud flag" in the demo | It's an authored flag on demo customers. Say "when the bank's fraud system flags a charge", not "we detect fraud" | ADR-011 |
| "Tested on cases it never saw" / "AI is X% better" | **No**, until the frozen comparison runs. Today: "passed every pre-registered development gate; held-out comparison pending" | ADR-006 amendments 7–9 |
| Money saved, customers retained, satisfaction raised | **No.** No measured product effect exists | `PRODUCT_REPORT.md`: "every figure is descriptive" |
| Market size in dollars | **No** dollar TAM. Bottom-up per bank: about 4,000 such complaints a year in a bank like the challenge's synthetic one (11.16 × 365). Say exactly that | `PRODUCT_REPORT.md` |
| Traction | Pre-traction: a working, deployed product with tests. Lean on the story and the rigor, as YC advises | — |

## Open decisions for Lucas and Roberto

1. **Name.** Keep **ArabicaAI**, the team name already on the app, the repository and the URL? A name that suggests factoring (for example "BrewFactor") would mislead: the product is dispute intake. Decide before the logo animation.
2. **Narrator.** One voice, in English, with the product shown in Spanish and Portuguese. Pick whoever sounds the most natural; YC says the best presenter, not the most senior.
3. **Scene 7's wording** depends on whether the frozen comparison has run (#98 merged, tag, run) before recording.
4. **Tooling.** Keynote or Figma for the mockups and transitions is the fastest route to "launch event" polish. Budget for two or three takes of the voice.
5. **Practice.** Run the 2½ minutes aloud at least five times before recording, and watch one recording back.
