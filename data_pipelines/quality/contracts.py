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
    # Business-key uniqueness the data dictionary declares (e.g. "NOT NULL, UNIQUE") but that
    # isn't the table's primary key -- duplicate_primary_keys only covers `key`/`key_fields`, so
    # a field like customers.document_number or products.product_number needs its own check.
    unique_fields: tuple[str, ...] = ()



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
        domains={"customer_status": frozenset({"Active", "Inactive", "Suspended", "Closed"})},
        foreign_keys=(ForeignKey("registration_branch_id", "branches", "branch_id"),),
        unique_fields=("document_number",),
    ),
    "products": _contract(
        "products", "products.csv", "product_id",
        "product_id customer_id product_type product_number currency product_status opening_channel has_linked_app last_transaction_date",
        "product_id customer_id product_type currency product_status",
        domains={"product_status": frozenset({"Active", "Closed", "Blocked", "Suspended"})},
        foreign_keys=(
            ForeignKey("customer_id", "customers", "customer_id"),
            ForeignKey("opening_branch_id", "branches", "branch_id"),
        ),
        unique_fields=("product_number",),
    ),
    "branches": _contract("branches", "branches.csv", "branch_id", "branch_id branch_code country branch_status", "branch_id country branch_status", unique_fields=("branch_code",)),
    "service_agents": _contract(
        "service_agents", "service_agents.csv", "agent_id",
        "agent_id employee_code native_accent agent_type experience_level assigned_branch_id agent_status work_shift",
        "agent_id agent_status",
        domains={
            "native_accent": frozenset({"mexican", "colombian", "argentine"}),
            "agent_type": frozenset({"Phone", "In-Person", "Digital", "Hybrid"}),
            "experience_level": frozenset({"Junior", "Mid-Senior", "Senior", "Specialist"}),
            "agent_status": frozenset({"Active", "Vacation", "Leave", "Inactive"}),
            "work_shift": frozenset({"Morning", "Afternoon", "Night", "Rotating"}),
        },
        foreign_keys=(ForeignKey("assigned_branch_id", "branches", "branch_id"),),
        unique_fields=("employee_code",),
    ),
    "marketing_campaigns": _contract(
        "marketing_campaigns", "marketing_campaigns.csv", "campaign_id",
        "campaign_id campaign_name campaign_type campaign_objective promoted_product target_segment target_country start_date end_date campaign_status",
        "campaign_id campaign_status",
        domains={
            "campaign_type": frozenset({"Email", "SMS", "Push", "WhatsApp", "Voice", "Mix"}),
            "campaign_objective": frozenset({"Acquisition", "Retention", "Cross-sell", "Up-sell", "Reactivation"}),
            "campaign_status": frozenset({"Planned", "Active", "Paused", "Completed"}),
        },
    ),
    "daily_exchange_rates": _contract(
        "daily_exchange_rates", "daily_exchange_rates.csv", "date",
        "date source_currency target_currency exchange_rate",
        "date source_currency target_currency exchange_rate",
        key_fields=("date", "source_currency", "target_currency"),
        domains={
            "source_currency": frozenset({"MXN", "COP", "ARS", "USD"}),
            "target_currency": frozenset({"MXN", "COP", "ARS", "USD"}),
        },
    ),
    "call_center_interactions": _contract(
        "call_center_interactions", "call_center_interactions", "interaction_id",
        "interaction_id interaction_date process_date customer_id agent_id interaction_type channel contact_reason reason_category was_resolved requires_followup was_escalated has_transcript has_recording detected_sentiment",
        "interaction_id interaction_date process_date customer_id interaction_type channel contact_reason reason_category requires_followup was_escalated has_transcript has_recording",
        partition_field="process_date", date_field="interaction_date",
        domains={
            "channel": frozenset({"Phone", "Web Chat", "WhatsApp", "Email", "App", "Web"}),
            "interaction_type": frozenset({"Inbound Call", "Outbound Call", "Chat", "Email", "Video"}),
            "reason_category": frozenset({"Transaccional", "Producto", "Queja", "Técnico", "Comercial", "Retención"}),
            "detected_sentiment": frozenset({"Neutral", "Negativo", "Positivo", "Muy Negativo", "Muy Positivo"}),
        },
        foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id")),
    ),
    "call_transcripts": _contract(
        "call_transcripts", "call_transcripts", "transcript_id",
        "transcript_id interaction_id process_date customer_id agent_id full_text detected_language transcription_model audio_quality",
        "transcript_id interaction_id process_date customer_id agent_id full_text detected_language transcription_model",
        partition_field="process_date",
        domains={
            "audio_quality": frozenset({"High", "Medium", "Low"}),
        },
        foreign_keys=(ForeignKey("interaction_id", "call_center_interactions", "interaction_id"), ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id")),
    ),
    "satisfaction_surveys": _contract(
        "satisfaction_surveys", "satisfaction_surveys", "survey_id",
        "survey_id survey_date process_date interaction_id customer_id agent_id survey_type send_channel main_score nps_category comment_sentiment",
        "survey_id survey_date process_date customer_id survey_type send_channel main_score",
        partition_field="process_date", date_field="survey_date",
        domains={
            "survey_type": frozenset({"CSAT", "NPS", "CES"}),
            "send_channel": frozenset({"Email", "SMS", "App", "IVR", "Web"}),
            "comment_sentiment": frozenset({"Positive", "Neutral", "Negative"}),
            "nps_category": frozenset({"Promoter", "Passive", "Detractor"}),
        },
        foreign_keys=(ForeignKey("interaction_id", "call_center_interactions", "interaction_id"), ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("agent_id", "service_agents", "agent_id")),
    ),
    "complaints": _contract(
        "complaints", "complaints", "complaint_id",
        "complaint_id creation_date process_date customer_id case_type category subcategory reception_channel affected_product_id origin_interaction_id description priority status claimed_amount currency sla_breached is_repeat_complainer resolution_date",
        "complaint_id creation_date process_date customer_id case_type category reception_channel description priority status sla_breached is_repeat_complainer",
        partition_field="process_date", date_field="creation_date",
        domains={
            "case_type": frozenset({"Complaint", "Claim", "Request", "Suggestion"}),
            "category": frozenset({"Transactions", "Fees", "Technical", "Branch", "Service"}),
            "reception_channel": frozenset({"Call Center", "Email", "Web", "App", "Branch", "Regulator"}),
            "priority": frozenset({"Low", "Medium", "High", "Critical"}),
            "status": frozenset({"Open", "In Process", "Escalated", "Resolved", "Closed", "Rejected"}),
            "currency": frozenset({"MXN", "COP", "ARS", "USD"}),
        },
        foreign_keys=(
            ForeignKey("customer_id", "customers", "customer_id"),
            ForeignKey("affected_product_id", "products", "product_id"),
            ForeignKey("origin_interaction_id", "call_center_interactions", "interaction_id"),
            ForeignKey("related_branch_id", "branches", "branch_id"),
            ForeignKey("assigned_agent_id", "service_agents", "agent_id"),
        ),
    ),
    "campaign_sends": _contract("campaign_sends", "campaign_sends", "send_id", "send_id send_date process_date campaign_id customer_id send_channel send_status was_delivered was_opened was_clicked had_conversion send_cost", "send_id send_date process_date campaign_id customer_id send_channel send_status was_delivered had_conversion", partition_field="process_date", date_field="send_date", foreign_keys=(ForeignKey("campaign_id", "marketing_campaigns", "campaign_id"), ForeignKey("customer_id", "customers", "customer_id"))),
    "digital_events": _contract(
        "digital_events", "digital_events", "event_id",
        "event_id event_date process_date customer_id session_id event_type event_category channel platform product_id action utm_campaign is_mobile",
        "event_id event_date process_date session_id event_type event_category channel is_mobile",
        partition_field="process_date", date_field="event_date",
        domains={
            "event_type": frozenset({"PageView", "Click", "Login", "Logout", "FormSubmit", "Error", "Purchase"}),
            "event_category": frozenset({"Authentication", "Navigation", "Product", "Transaction"}),
            "channel": frozenset({"Android App", "iOS App", "Desktop Web", "Mobile Web"}),
            "platform": frozenset({"Android", "iOS", "Windows", "Linux", "MacOS"}),
        },
        foreign_keys=(ForeignKey("customer_id", "customers", "customer_id"), ForeignKey("product_id", "products", "product_id")),
    ),
    "transactions": _contract(
        "transactions", "transactions", "transaction_id",
        "transaction_id transaction_date process_date product_id customer_id transaction_type transaction_category amount currency amount_usd channel transaction_country transaction_status is_fraud",
        "transaction_id transaction_date process_date product_id customer_id transaction_type amount currency channel transaction_country transaction_status is_fraud",
        partition_field="process_date", date_field="transaction_date",
        domains={
            "transaction_type": frozenset({"Purchase", "Withdrawal", "Transfer", "Payment", "Deposit", "Adjustment"}),
            "transaction_category": frozenset({"Food", "Services", "Other", "Transport", "Entertainment", "Health"}),
            "channel": frozenset({"POS", "ATM", "Web", "App", "Branch", "Transfer"}),
            "transaction_status": frozenset({"Approved", "Declined", "Pending", "Reversed"}),
        },
        foreign_keys=(
            ForeignKey("customer_id", "customers", "customer_id"),
            ForeignKey("product_id", "products", "product_id"),
            ForeignKey("branch_id", "branches", "branch_id"),
        ),
    ),
}
