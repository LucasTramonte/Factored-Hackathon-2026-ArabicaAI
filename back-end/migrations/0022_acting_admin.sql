-- An act-as session remembers the customer id the admin signed in as (ADR-007, decision 10), so an update the admin
-- asks for while acting is emailed to the admin's own address on file. Never returned. Additive: other sessions read NULL.
ALTER TABLE sessions ADD COLUMN acting_admin_customer_id TEXT;
