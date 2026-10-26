-- Add provenance without guessing the origin or units of historical values.
-- Archive exact original rows before adding columns; repeated execution is inert.
CREATE TABLE IF NOT EXISTS account_balance_revisions (
 id bigserial PRIMARY KEY,
 balance_row_id uuid NOT NULL,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 snapshot_hash text NOT NULL,
 snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(balance_row_id,snapshot_hash)
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='account_balances' AND column_name='balance_source') THEN
  INSERT INTO account_balance_revisions(balance_row_id,account_id,snapshot_hash,snapshot)
   SELECT id,account_id,md5(to_jsonb(ab)::text),to_jsonb(ab) FROM account_balances ab
   ON CONFLICT DO NOTHING;
 END IF;
END $$;
ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS balance_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS account_currency varchar(3);
ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS functional_currency varchar(3);
ALTER TABLE account_balances ALTER COLUMN balance_in_account_currency DROP NOT NULL;
ALTER TABLE account_balances ALTER COLUMN balance_in_functional_currency DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_balances_source_check' AND conrelid='account_balances'::regclass) THEN
  ALTER TABLE account_balances ADD CONSTRAINT account_balances_source_check
   CHECK(balance_source IN ('legacy','calculated','bank','statement','manual','valuation'));
 END IF;
END $$;
-- Every replacement has a recoverable original, including writes after upgrade.
CREATE OR REPLACE FUNCTION archive_account_balance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW)
   AND EXISTS (SELECT 1 FROM accounts WHERE id=OLD.account_id) THEN
  INSERT INTO account_balance_revisions(balance_row_id,account_id,snapshot_hash,snapshot)
   VALUES(OLD.id,OLD.account_id,md5(to_jsonb(OLD)::text),to_jsonb(OLD)) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_balance_revision ON account_balances;
CREATE TRIGGER account_balance_revision BEFORE UPDATE ON account_balances
 FOR EACH ROW EXECUTE FUNCTION archive_account_balance_revision();
-- Competing writers serialize on the account. A derived row cannot replace a
-- supplied observation or create a second cache entry for its calendar day.
CREATE OR REPLACE FUNCTION protect_recorded_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM accounts WHERE id=NEW.account_id FOR UPDATE;
 IF NEW.balance_source IN ('calculated','valuation') THEN
  IF TG_OP='UPDATE' AND OLD.balance_source NOT IN ('calculated','valuation') THEN
   RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM account_balances ab WHERE ab.account_id=NEW.account_id
    AND ab.date::date=NEW.date::date AND ab.id<>NEW.id
    AND ab.balance_source NOT IN ('calculated','valuation')) THEN
   RETURN NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_balance_derived_guard ON account_balances;
CREATE TRIGGER account_balance_derived_guard BEFORE INSERT OR UPDATE ON account_balances
 FOR EACH ROW EXECUTE FUNCTION protect_recorded_account_balance();
