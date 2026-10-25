-- Consolidation is an explicit application action, never a migration-time merge.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS consolidated_into_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS up_account_sources (
  connection_id uuid NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last_synced_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, account_id)
);
CREATE INDEX IF NOT EXISTS up_account_sources_account_idx ON up_account_sources(account_id);
INSERT INTO up_account_sources(connection_id,account_id,last_synced_at)
SELECT connection.id,account.id,account.last_synced_at FROM accounts account
JOIN bank_connections connection ON connection.id=account.bank_connection_id
WHERE account.provider='up' AND connection.provider='up' AND account.user_id=connection.user_id
  AND account.consolidated_into_account_id IS NULL
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS up_account_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  canonical_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  source_snapshot jsonb NOT NULL,
  canonical_snapshot jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS up_account_reconciliations_actor_idx ON up_account_reconciliations(actor_user_id);

-- A request validated before consolidation must not append fresh business rows
-- to the retired account after waiting for the merge's parent-row lock.
CREATE OR REPLACE FUNCTION up_reject_consolidated_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_value uuid; redirect uuid;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>TG_ARGV[0]) IS NOT DISTINCT FROM (to_jsonb(NEW)->>TG_ARGV[0]) THEN RETURN NEW; END IF;
  account_value := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF account_value IS NULL THEN RETURN NEW; END IF;
  SELECT consolidated_into_account_id INTO redirect FROM accounts WHERE id=account_value FOR KEY SHARE;
  IF redirect IS NOT NULL THEN
    RAISE EXCEPTION 'Account was consolidated; use its canonical shared record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE reference record;
BEGIN
  FOR reference IN
    SELECT kcu.table_name,kcu.column_name FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
    WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND ccu.table_schema='public'
      AND ccu.table_name='accounts' AND ccu.column_name='id'
      AND kcu.table_name NOT IN ('accounts','account_balances','account_owners','account_ownership_allocations','up_account_reconciliations')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'up_active_reference_'||reference.column_name, reference.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW EXECUTE FUNCTION up_reject_consolidated_reference(%L)',
      'up_active_reference_'||reference.column_name, reference.column_name, reference.table_name, reference.column_name);
  END LOOP;
END;
$$;
