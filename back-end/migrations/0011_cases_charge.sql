-- One open report per charge: the confirm check reads only this customer's cases for that charge, not their whole history.
CREATE INDEX cases_customer_transaction ON cases(customer_id, transaction_id);
