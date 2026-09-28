-- Upgrade the earlier local demo schema without replacing transactions or cases.
ALTER TABLE intake_demo.transactions ADD COLUMN IF NOT EXISTS source_occurred_at timestamp without time zone;
ALTER TABLE intake_demo.transactions ALTER COLUMN occurred_at DROP NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'transaction_date_exactly_one'
                   AND conrelid = 'intake_demo.transactions'::regclass) THEN
        ALTER TABLE intake_demo.transactions ADD CONSTRAINT transaction_date_exactly_one
            CHECK (num_nonnulls(occurred_at, source_occurred_at) = 1);
    END IF;
END $$;
