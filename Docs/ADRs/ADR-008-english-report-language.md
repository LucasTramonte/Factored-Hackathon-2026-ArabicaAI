# ADR-008 — English as a report language

- **Status:** Proposed
- **Date:** 2026-10-02
- **Deciders:** Lucas Tramonte, Roberto Z, Manoella R
- **Supersedes:** [ADR-002](ADR-002-v1-workflow-unrecognized-charge-intake.md) decision 3, for English only

## Context

Under ADR-002 decision 3, unsupported languages are out of scope, and the service took reports in Spanish and Portuguese only. The interface already offered English, but an English-speaking customer still had to write the report in Spanish or Portuguese. Feedback from a live session was that this is confusing: the English interface is there, but the customer still can't report in English. The challenge brief requires Spanish and Portuguese. English goes beyond the brief. The frozen evaluation set (`evals/intake/frozen_es_pt_v1`) and all dataset text are Spanish or Portuguese only.

## Decision

1. **English is a report language end to end**, just like Spanish and Portuguese. The report-language choice lists Español, Português and English, and an English interface defaults to English. The server accepts and stores `language = 'en'` (migration 0014 rebuilds `intake_episodes` because SQLite can't alter a CHECK). The `received` and `update` emails use the English templates, events carry `language: "en"`, and the episode scorer summarises `en` separately.
2. Every other language stays out of scope, as ADR-002 decision 3 says.

## Consequences

- **+** An English-speaking customer can file a report in English instead of being told the language is not supported.
- **−** **English results have no evaluation set.** The frozen set and the dataset text are Spanish and Portuguese only, so we can't make a quality claim about English reports. The learned extractor's prompt is Spanish/Portuguese, but it stays off online (ADR-006). The guided flow is deterministic, so English uses the same checklist and the same confirmation step.
- **−** A table-rebuild migration (0014). It has to be applied to remote D1 before the code that ships with it is deployed (`AGENTS.md`).

## Alternatives considered

- **Keep Spanish and Portuguese only, with a clearer message for English speakers.** This needs no migration and leaves the evaluation scope unchanged. Rejected by the decider (Roberto Z, 2026-10-02): the English interface should let people report in English. This could be reopened if English reports turn out to be unsafe and an English evaluation set can't be built.
