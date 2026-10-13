-- PPF-45: provider-neutral, auditable investment-ingestion foundation.
-- 0037 is intentionally reserved for the in-flight account ownership work.
-- Manual migrations are re-run by the production migration runner, so every
-- top-level statement in this file must remain idempotent.
-- The application has long modelled trade fees, but the one-off backend
-- migration was never part of clean Drizzle deployments. Bring that existing
-- downstream ledger column into schema parity before activities reference it.
ALTER TABLE "broker_trades"
  ADD COLUMN IF NOT EXISTS "fees" numeric(28, 8) DEFAULT 0 NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "investment_ingestion_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" varchar(64) NOT NULL,
  "ingestion_type" varchar(24) NOT NULL,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "source_name" varchar(255),
  "source_hash" char(64),
  "normalization_version" varchar(32) NOT NULL,
  "cursor" jsonb,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  "reverted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "investment_ingestion_runs_type_check" CHECK ("ingestion_type" IN ('csv_import', 'api_sync', 'manual')),
  CONSTRAINT "investment_ingestion_runs_status_check" CHECK ("status" IN ('pending', 'applying', 'completed', 'partial', 'failed', 'reverted'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_ingestion_runs_account_started" ON "investment_ingestion_runs" ("account_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_ingestion_runs_user_status" ON "investment_ingestion_runs" ("user_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "investment_source_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "investment_ingestion_runs"("id") ON DELETE RESTRICT,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" varchar(64) NOT NULL,
  "provider_record_id" varchar(255),
  "idempotency_key" char(64) NOT NULL,
  "payload_hash" char(64) NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "source_payload" jsonb NOT NULL,
  "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "normalization_version" varchar(32) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "investment_source_records_account_provider_key_uq" UNIQUE ("account_id", "provider", "idempotency_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_source_records_run" ON "investment_source_records" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_source_records_account_occurred" ON "investment_source_records" ("account_id", "occurred_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_investment_source_record_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'investment source records are immutable';
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'investment_source_records_immutable'
      AND tgrelid = 'investment_source_records'::regclass
  ) THEN
    CREATE TRIGGER "investment_source_records_immutable"
      BEFORE UPDATE ON "investment_source_records"
      FOR EACH ROW
      EXECUTE FUNCTION "prevent_investment_source_record_update"();
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "investment_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_record_id" uuid NOT NULL REFERENCES "investment_source_records"("id") ON DELETE RESTRICT,
  "run_id" uuid NOT NULL REFERENCES "investment_ingestion_runs"("id") ON DELETE RESTRICT,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "leg_index" integer DEFAULT 0 NOT NULL,
  "activity_type" varchar(32) NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "asset_symbol" varchar(64) NOT NULL,
  "asset_name" varchar(255),
  "asset_type" varchar(24) NOT NULL,
  "quantity" numeric(38, 18),
  "price" numeric(38, 18),
  "gross_amount" numeric(38, 18),
  "net_amount" numeric(38, 18),
  "currency" varchar(16),
  "fee_amount" numeric(38, 18),
  "fee_currency" varchar(16),
  "tax_amount" numeric(38, 18),
  "tax_currency" varchar(16),
  "counter_asset_symbol" varchar(64),
  "counter_quantity" numeric(38, 18),
  "direction" varchar(16),
  "external_group_id" varchar(255),
  "aud_value" numeric(38, 18),
  "valuation_source" varchar(64),
  "valuation_timestamp" timestamp,
  "canonical_hash" char(64) NOT NULL,
  "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "activity_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "broker_trade_id" uuid REFERENCES "broker_trades"("id") ON DELETE SET NULL,
  "income_event_id" uuid REFERENCES "investment_income_events"("id") ON DELETE SET NULL,
  "applied_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "investment_activities_source_leg_uq" UNIQUE ("source_record_id", "leg_index"),
  CONSTRAINT "investment_activities_type_check" CHECK ("activity_type" IN ('buy', 'sell', 'dividend', 'distribution', 'drp', 'deposit', 'withdrawal', 'transfer', 'fee', 'interest', 'staking_reward', 'airdrop', 'crypto_swap')),
  CONSTRAINT "investment_activities_direction_check" CHECK ("direction" IS NULL OR "direction" IN ('in', 'out', 'internal')),
  CONSTRAINT "investment_activities_leg_index_check" CHECK ("leg_index" >= 0),
  CONSTRAINT "investment_activities_quantity_check" CHECK ("quantity" IS NULL OR "quantity" > 0),
  CONSTRAINT "investment_activities_amount_check" CHECK (("gross_amount" IS NULL OR "gross_amount" >= 0) AND ("fee_amount" IS NULL OR "fee_amount" >= 0) AND ("tax_amount" IS NULL OR "tax_amount" >= 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_activities_run" ON "investment_activities" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_activities_account_occurred" ON "investment_activities" ("account_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_activities_external_group" ON "investment_activities" ("external_group_id");
