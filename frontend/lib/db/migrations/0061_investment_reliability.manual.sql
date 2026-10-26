-- Additive investment provenance; legacy values retain their historical amount.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS archived_at timestamp;
ALTER TABLE holding_valuations ADD COLUMN IF NOT EXISTS value_currency varchar(3);
ALTER TABLE holding_valuations ADD COLUMN IF NOT EXISTS quote_currency varchar(3);
ALTER TABLE holding_valuations ADD COLUMN IF NOT EXISTS quote_date date;
ALTER TABLE holding_valuations ADD COLUMN IF NOT EXISTS quote_source varchar(64);
-- Legacy currency identity remains unknown. Do not infer historical currency
-- from mutable user settings. A fresh valuation records explicit provenance.
ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS account_currency varchar(3);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS investment_sync_state jsonb;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS investment_creation_key varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_investment_creation_key_uq
ON accounts(user_id, investment_creation_key) WHERE investment_creation_key IS NOT NULL;
-- Retain the index name so earlier idempotent migrations cannot recreate
-- the old two-column key on a subsequent migration run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE c.relname = 'price_snapshots_symbol_date_uq' AND i.indnkeyatts = 2) THEN
    ALTER TABLE price_snapshots DROP CONSTRAINT IF EXISTS price_snapshots_symbol_date_uq;
    DROP INDEX IF EXISTS price_snapshots_symbol_date_uq;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS price_snapshots_symbol_date_uq ON price_snapshots(symbol, date, provider);
ALTER TABLE price_snapshots ADD COLUMN IF NOT EXISTS source_label varchar(64);
