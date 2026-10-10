-- Provider-neutral income reconciliation and auditable AMIT/AMMA cost-base adjustments.
ALTER TABLE "csv_import_profiles" ADD COLUMN IF NOT EXISTS "profile_variant" varchar(32) NOT NULL DEFAULT 'default';
UPDATE "csv_import_profiles" SET "profile_variant" = 'cash_activity'
WHERE "import_kind" = 'investments' AND "profile_variant" = 'default';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csv_import_profiles_scope_unique'
      AND pg_get_constraintdef(oid) NOT ILIKE '%profile_variant%'
  ) THEN
    ALTER TABLE "csv_import_profiles" DROP CONSTRAINT "csv_import_profiles_scope_unique";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csv_import_profiles_scope_unique') THEN
    ALTER TABLE "csv_import_profiles" ADD CONSTRAINT "csv_import_profiles_scope_unique"
      UNIQUE ("user_id", "account_id", "import_kind", "provider", "profile_variant");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "tfn_withholding" numeric(18, 2);
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "reconciliation_status" varchar(20) NOT NULL DEFAULT 'provisional';
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "user_confirmed_at" timestamp;
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "matched_transaction_id" uuid;
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "component_sources" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "annual_statement_reference" varchar(255);
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "created_by_activity_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investment_income_events_reconciliation_status_check') THEN
    ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_reconciliation_status_check"
      CHECK ("reconciliation_status" IN ('provisional', 'confirmed', 'conflict'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investment_income_events_matched_transaction_uq') THEN
    ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_matched_transaction_uq"
      UNIQUE ("matched_transaction_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investment_income_events_matched_transaction_id_transactions_id') THEN
    ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_matched_transaction_id_transactions_id"
      FOREIGN KEY ("matched_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investment_income_events_created_by_activity_id_investment_acti') THEN
    ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_created_by_activity_id_investment_acti"
      FOREIGN KEY ("created_by_activity_id") REFERENCES "investment_activities"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_income_enrichments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "income_event_id" uuid NOT NULL REFERENCES "investment_income_events"("id") ON DELETE CASCADE,
  "source_activity_id" uuid NOT NULL REFERENCES "investment_activities"("id") ON DELETE CASCADE,
  "previous_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "applied_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "investment_income_enrichments_activity_uq" UNIQUE ("source_activity_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_income_enrichments_event"
  ON "investment_income_enrichments" ("income_event_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_cost_base_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id") ON DELETE CASCADE,
  "income_event_id" uuid REFERENCES "investment_income_events"("id") ON DELETE SET NULL,
  "source_activity_id" uuid NOT NULL REFERENCES "investment_activities"("id") ON DELETE CASCADE,
  "effective_date" date NOT NULL,
  "currency" char(3) NOT NULL,
  "amount_native" numeric(28, 8) NOT NULL,
  "amount_aud" numeric(28, 8),
  "valuation_source" varchar(64),
  "valuation_timestamp" timestamp,
  "calculation_version" varchar(32) NOT NULL DEFAULT 'amit-v1',
  "assumptions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "investment_cost_base_adjustments_activity_uq" UNIQUE ("source_activity_id"),
  CONSTRAINT "investment_cost_base_adjustments_nonzero_check" CHECK ("amount_native" <> 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_cost_base_adjustments_holding_date"
  ON "investment_cost_base_adjustments" ("holding_id", "effective_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_reconciliation_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source_activity_id" uuid NOT NULL REFERENCES "investment_activities"("id") ON DELETE CASCADE,
  "income_event_id" uuid REFERENCES "investment_income_events"("id") ON DELETE SET NULL,
  "kind" varchar(32) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "reason" text NOT NULL,
  "candidate_income_event_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "candidate_transaction_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "resolution" jsonb,
  "resolved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  "updated_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "investment_reconciliation_items_activity_kind_uq" UNIQUE ("source_activity_id", "kind"),
  CONSTRAINT "investment_reconciliation_items_kind_check" CHECK ("kind" IN ('cash_match', 'annual_statement', 'component_conflict')),
  CONSTRAINT "investment_reconciliation_items_status_check" CHECK ("status" IN ('pending', 'resolved', 'ignored'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_reconciliation_items_user_status"
  ON "investment_reconciliation_items" ("user_id", "status");
--> statement-breakpoint
DO $$
DECLARE constraint_name text;
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'investment_income_enrichments',
    'investment_cost_base_adjustments',
    'investment_reconciliation_items'
  ] LOOP
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute attr ON attr.attrelid = rel.oid AND attr.attnum = ANY(con.conkey)
    WHERE rel.relname = table_name
      AND con.contype = 'f'
      AND attr.attname = 'source_activity_id'
      AND con.confdeltype <> 'c'
    LIMIT 1;
    IF constraint_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, constraint_name);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (source_activity_id) REFERENCES investment_activities(id) ON DELETE CASCADE',
        table_name,
        constraint_name
      );
    END IF;
    constraint_name := NULL;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "instrument_type" varchar(20) NOT NULL DEFAULT 'equity';
ALTER TABLE "cgt_allocations" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "cost_base_adjustment_native" numeric(28, 8) NOT NULL DEFAULT 0;
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "cost_base_adjustment_aud" numeric(28, 8);
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "adjustment_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "cgt_allocations" ALTER COLUMN "calculation_version" SET DEFAULT 'fifo-v2';
--> statement-breakpoint
UPDATE "cgt_allocations" AS allocation
SET "instrument_type" = trade."instrument_type"
FROM "broker_trades" AS trade
WHERE allocation."acquisition_trade_id" = trade."id"
  AND allocation."instrument_type" = 'equity'
  AND trade."instrument_type" <> 'equity';
