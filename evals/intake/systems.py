"""Plug-in point for learned systems scored next to the checklist (ADR-006).

A system is a fact extractor: ``extract(message, session_language, as_of, vocabulary)`` returns
``{"extracted": {...}, "usage": {...}}`` where ``extracted`` follows the spec schema in
``frozen_es_pt_v1/POLICY.md`` (intent, stated_facts, invalid, demand, injection). The model never
receives the customer's purchases: the written policy (``frozen_es_pt_v1/label_rules.py``, the same
rules that define gold) turns the extracted facts into an action against the purchases. So the
comparison with the checklist measures how each system reads the message.

Invariants: an unauthenticated session is answered without calling the model; invalid output falls
back to ``clarify``; a timeout becomes a ``technical_handoff``; predictions have the exact shape
``baseline.score`` checks, so safety is scored the same way for every system.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

from .baseline import EVIDENCE_FIELDS

_spec = importlib.util.spec_from_file_location("frozen_label_rules", Path(__file__).with_name("frozen_es_pt_v1") / "label_rules.py")
POLICY = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(POLICY)

ACTION_NAMES = {"A": "authenticate", "T": "technical_handoff", "R": "route", "H": "complete_handoff",
                "F": "confirm", "C": "clarify"}
HANDOFFS = {"technical_handoff", "complete_handoff"}
INTENTS = {"report", "confirm", "unsupported_language"} | {f"out_of_scope:{k}" for k in (
    "balance", "non_purchase_movement", "recognized_dispute", "stolen_card", "human_request",
    "third_party_card", "injection_only")}
FACT_KEYS = {"merchant", "category", "amount", "currency", "date", "card", "country", "abroad"}
DEMANDS = {None, "refund", "card_block", "fraud_verdict"}
# Closed merchant/category vocabulary from the design window (DATA_QUALITY.md, DF-006). No customer data.
_BY_CATEGORY = {
    "Entertainment": ["Cine Premium", "Conciertos Live", "Streaming Music", "Teatro Nacional"],
    "Food": ["Mercado Central", "Restaurante El Buen Sabor", "Super Ahorro", "Tienda Don José"],
    "Health": ["Clínica Médica", "Farmacia Salud", "Laboratorio Central", "Óptica Visión"],
    "Other": ["Boutique Moda", "Centro Comercial", "Ferretería", "Tienda General"],
    "Services": ["Cable TV", "Empresa Telefónica", "Internet Plus", "Servicios Públicos"],
    "Transport": ["Estación de Servicio", "Gasolinera Express", "Taxi Seguro", "Uber"],
}
VOCABULARY = {
    "merchants": {m: c for c, ms in _BY_CATEGORY.items() for m in ms},  # merchant name -> category
    "categories": sorted(_BY_CATEGORY),
    "currencies": ["ARS", "COP", "USD"],
    "card_types": ["Tarjeta Crédito", "Tarjeta Débito"],
}


def validate_extraction(extracted: dict) -> dict:
    """Reject anything outside the spec schema; the policy must never see free-form keys."""
    if not isinstance(extracted, dict) or set(extracted) != {"intent", "stated_facts", "invalid", "demand", "injection"}:
        raise ValueError("invalid extraction keys")
    if extracted["intent"] not in INTENTS:
        raise ValueError(f"invalid intent {extracted['intent']!r}")
    facts = extracted["stated_facts"]
    if not isinstance(facts, dict) or set(facts) - FACT_KEYS:
        raise ValueError("invalid stated_facts keys")
    if extracted["demand"] not in DEMANDS:
        raise ValueError("invalid demand")
    if type(extracted["injection"]) is not bool:
        raise ValueError("invalid injection flag")
    if extracted["invalid"] is not None and not isinstance(extracted["invalid"], str):
        raise ValueError("invalid 'invalid' field")
    return extracted


def customers_from(corpus: dict) -> list[dict]:
    """Customer profiles for the policy; derived from transactions when a corpus carries none."""
    if corpus.get("customers"):
        return corpus["customers"]
    profiles: dict[str, dict] = {}
    for t in corpus["transactions"]:
        p = profiles.setdefault(t["customer_id"], {"customer_id": t["customer_id"], "country": t.get("transaction_country"), "cards": []})
        card = {"product_type": t.get("product_type"), "last4": t.get("last4"), "currency": t["currency"]}
        if card not in p["cards"]:
            p["cards"].append(card)
    return list(profiles.values())


def _prediction(case: dict, action: str, candidates: list[dict], system: str) -> dict:
    authenticated = case.get("authenticated") is True
    p = {"case_id": case["case_id"], "action": action, "candidates": candidates, "complete": action == "complete_handoff",
         "missing_information": [], "tool_calls": 0 if action in ("authenticate", "route") else 1,
         "requested_action": "human_review" if action in HANDOFFS else None,
         "customer_statement": case["message"], "baseline": system}
    if authenticated:
        p["customer_id"] = case["customer_id"]
    if action == "complete_handoff":
        p["confirmed_facts"] = ["authenticated_session", "customer_confirmed_transaction", "source_evidence_retrieved"]
    return p


def policy_prediction(case: dict, extracted: dict, records: list[dict], customers: list[dict], system: str) -> dict:
    """Apply the written policy to extracted facts and return a prediction ``baseline.score`` accepts."""
    # Session fields come last, so no extracted key could ever override identity or session state.
    spec = {**extracted, "customer_id": case["customer_id"], "authenticated": case.get("authenticated") is True,
            "tool_failure": case.get("tool_failure", False), "confirmed_id": case.get("confirmed_id"),
            "as_of": case.get("as_of")}
    result = POLICY.evaluate(spec, {"customers": customers, "transactions": records})
    by_id = {r["transaction_id"]: r for r in records}
    candidates = [{k: by_id[i].get(k) for k in EVIDENCE_FIELDS} for i in result["candidate_ids"]]
    return _prediction(case, ACTION_NAMES[result["action"]], candidates, system)


class FactExtractorSystem:
    """Wrap an ``extract`` callable into a system the runner can score."""

    def __init__(self, name: str, extract):
        self.name = name
        self.extract = extract

    def __call__(self, case: dict, records: list[dict], customers: list[dict]) -> tuple[dict, dict]:
        """Return ``(prediction, meta)``; meta carries usage, the extraction and any error."""
        if case.get("authenticated") is not True:
            return _prediction(case, "authenticate", [], self.name), {"usage": {}, "extracted": None, "error": None}
        try:
            out = self.extract(case["message"], case.get("session_language", case.get("language")), case.get("as_of"), VOCABULARY)
            extracted = validate_extraction(out["extracted"])
        except TimeoutError as exc:
            return _prediction(case, "technical_handoff", [], self.name), {"usage": {}, "extracted": None, "error": f"timeout: {exc}"}
        except (ValueError, KeyError, TypeError) as exc:
            return _prediction(case, "clarify", [], self.name), {"usage": {}, "extracted": None, "error": f"invalid output: {exc}"}
        return (policy_prediction(case, extracted, records, customers, self.name),
                {"usage": out.get("usage", {}), "extracted": extracted, "error": None})
