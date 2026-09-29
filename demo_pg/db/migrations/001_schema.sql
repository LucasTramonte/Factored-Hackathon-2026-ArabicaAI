CREATE SCHEMA IF NOT EXISTS intake_demo;
CREATE TABLE IF NOT EXISTS intake_demo.customers (
    customer_id text PRIMARY KEY,
    display_name text NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_demo.transactions (
    transaction_id text PRIMARY KEY,
    customer_id text NOT NULL REFERENCES intake_demo.customers(customer_id),
    occurred_at timestamptz,
    source_occurred_at timestamp without time zone,
    merchant_name text NOT NULL,
    amount numeric(15,2) NOT NULL CHECK (amount > 0),
    currency text NOT NULL CHECK (length(currency) = 3),
    UNIQUE (customer_id, transaction_id),
    CONSTRAINT transaction_date_exactly_one CHECK (num_nonnulls(occurred_at, source_occurred_at) = 1)
);
CREATE TABLE IF NOT EXISTS intake_demo.cases (
    case_id uuid PRIMARY KEY,
    customer_id text NOT NULL,
    transaction_id text NOT NULL,
    idempotency_key uuid NOT NULL,
    customer_statement text NOT NULL CHECK (length(btrim(customer_statement)) BETWEEN 10 AND 2000),
    customer_confirmed boolean NOT NULL CHECK (customer_confirmed),
    status text NOT NULL DEFAULT 'accepted' CHECK (status = 'accepted'),
    accepted_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (customer_id, transaction_id)
        REFERENCES intake_demo.transactions(customer_id, transaction_id),
    UNIQUE (customer_id, idempotency_key)
);
