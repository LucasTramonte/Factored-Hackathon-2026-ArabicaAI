"""Raw and typed table contracts for the DuckDB quality gate."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ForeignKey:
    """Describe a child-column reference to a parent table key."""

    field: str
    parent_table: str
    parent_key: str


@dataclass(frozen=True)
class TableContract:
    """Declare the schema, keys, domains, and partition behavior of a table."""

    name: str
    relative_path: str
    key: str
    required: tuple[str, ...]
    expected_columns: tuple[str, ...]
    key_fields: tuple[str, ...] = ()
    partition_field: str | None = None
    date_field: str | None = None
    domains: dict[str, frozenset[str]] = field(default_factory=dict)
    foreign_keys: tuple[ForeignKey, ...] = ()



def _contract(name: str, relative_path: str, key: str, columns: str, required: str, **kwargs) -> TableContract:
    return TableContract(
        name=name,
        relative_path=relative_path,
        key=key,
        key_fields=kwargs.pop("key_fields", (key,)),
        required=tuple(required.split()),
        expected_columns=tuple(columns.split()),
        **kwargs,
    )


CONTRACTS = {
    "customers": _contract(
        "customers", "customers.csv", "customer_id",
        "customer_id document_number country segment customer_status accepts_marketing registration_branch_id",
        "customer_id country customer_status",
        domains={"customer_status": frozenset({"Active", "Inactive", "Blocked", "Closed"})},
        foreign_keys=(ForeignKey("registration_branch_id", "branches", "branch_id"),),
    ),
    "products": _contract(
        "products", "products.csv", "product_id",
        "product_id customer_id product_type currency product_status opening_channel has_linked_app last_transaction_date",
        "product_id customer_id product_type currency product_status",
        domains={"product_status": frozenset({"Active", "Closed", "Blocked", "Suspended"})},
        foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"),),
    ),
    "branches": _contract("branches", "branches.csv", "branch_id", "branch_id country branch_status", "branch_id country branch_status"),
    "service_agents": _contract("service_agents", "service_agents.csv", "agent_id", "agent_id assigned_branch_id agent_status", "agent_id agent_status", foreign_keys=(ForeignKey("assigned_branch_id", "branches", "branch_id"),)),
    "marketing_campaigns": _contract("marketing_campaigns", "marketing_campaigns.csv", "campaign_id", "campaign_id campaign_type campaign_objective promoted_product target_segment target_country start_date end_date campaign_status", "campaign_id campaign_status"),
    "daily_exchange_rates": _contract("daily_exchange_rates", "daily_exchange_rates.csv", "date", "date source_currency target_currency exchange_rate", "date source_currency target_currency exchange_rate", key_fields=("date", "source_currency", "target_currency")),
    "call_center_interactions": _contract(
        "call_center_interactions", "call_center_interactions", "interaction_id",
        "interaction_id interaction_date process_date customer_id agent_id interaction_type channel contact_reason reason_category was_resolved requires_followup was_escalated has_transcript",
        "interaction_id interaction_date process_date customer_id interaction_type channel contact_reason reason_category requires_followup was_escalated has_transcript",
        partition_field="process_date", date_field="interaction_date",
        domains={"channel": frozenset({"Phone", "Web Chat", "WhatsApp", "Email", "App", "Web"})},
        foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id")),
    ),
    "call_transcripts": _contract("call_transcripts", "call_transcripts", "transcript_id", "transcript_id interaction_id process_date customer_id agent_id full_text detected_language", "transcript_id interaction_id process_date customer_id agent_id full_text detected_language", partition_field="process_date", foreign_keys=(ForeignKey("interaction_id", "call_center_interactions", "interaction_id"), ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id"))),
    "satisfaction_surveys": _contract("satisfaction_surveys", "satisfaction_surveys", "survey_id", "survey_id survey_date process_date interaction_id customer_id agent_id survey_type main_score", "survey_id survey_date process_date customer_id survey_type main_score", partition_field="process_date", date_field="survey_date", foreign_keys=(ForeignKey("interaction_id", "call_center_interactions", "interaction_id"), ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id"))),
    "complaints": _contract("complaints", "complaints", "complaint_id", "complaint_id creation_date process_date customer_id case_type category subcategory reception_channel affected_product_id origin_interaction_id priority status claimed_amount currency sla_breached resolution_date", "complaint_id creation_date process_date customer_id case_type category reception_channel priority status sla_breached", partition_field="process_date", date_field="creation_date", foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("affected_product_id", "products", "product_id"), ForeignKey("origin_interaction_id", "call_center_interactions", "interaction_id"))),
    "campaign_sends": _contract("campaign_sends", "campaign_sends", "send_id", "send_id send_date process_date campaign_id customer_id send_channel send_status was_delivered was_opened was_clicked had_conversion send_cost", "send_id send_date process_date campaign_id customer_id send_channel send_status was_delivered had_conversion", partition_field="process_date", date_field="send_date", foreign_keys=(ForeignKey("campaign_id", "marketing_campaigns", "campaign_id"), ForeignKey("customer_id", "customers", "customer_id"))),
    "digital_events": _contract("digital_events", "digital_events", "event_id", "event_id event_date process_date customer_id session_id event_type event_category channel product_id action utm_campaign", "event_id event_date process_date session_id event_type event_category channel", partition_field="process_date", date_field="event_date", foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("product_id", "products", "product_id"))),
    "transactions": _contract("transactions", "transactions", "transaction_id", "transaction_id transaction_date process_date product_id customer_id transaction_type amount currency amount_usd channel transaction_status is_fraud", "transaction_id transaction_date process_date product_id customer_id transaction_type amount currency channel transaction_status is_fraud", partition_field="process_date", date_field="transaction_date", foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("product_id", "products", "product_id"))),
}
