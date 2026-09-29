-- Fixture only: wall-time representation, not a production dataset import.
INSERT INTO customers(customer_id,display_name)
VALUES ('CLI-U53R5AZVLET0','Dataset customer (synthetic)');
INSERT INTO transactions(transaction_id,customer_id,occurred_at,source_occurred_at,merchant_name,amount,currency)
VALUES ('TRX-SAMPLE','CLI-U53R5AZVLET0',NULL,'2026-02-26T13:21:51','Fixture merchant','29763.49','ARS');
INSERT INTO context_cards(customer_id,card_version,snapshot_at,card_json)
VALUES ('CLI-U53R5AZVLET0',1,'2026-09-29T00:00:00+00:00',
        '{"first_name":"Ana","locale_hint":"es-AR","products":[{"product_type":"Credit card","last4":"4444","currency":"ARS"}]}');
