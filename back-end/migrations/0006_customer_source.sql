-- Where each demo customer comes from. Dataset customers are listed from D1 at login, so their IDs
-- and names never need to be committed; fictitious ones stay in identities.json.
ALTER TABLE customers ADD COLUMN source TEXT NOT NULL DEFAULT 'fictitious' CHECK (source IN ('fictitious', 'dataset'));
ALTER TABLE customers ADD COLUMN country TEXT;
-- A customer with Gold provenance came from the dataset (the one-day slice loaded before this migration).
UPDATE customers SET source = 'dataset'
WHERE customer_id IN (SELECT t.customer_id FROM sample_provenance p JOIN transactions t ON t.transaction_id = p.transaction_id);
