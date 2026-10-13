-- Auditable crypto swaps, rewards, network fees, and owned-wallet lot transfers.
ALTER TABLE "investment_activities" ADD COLUMN IF NOT EXISTS "fee_aud_value" numeric(38, 18);
ALTER TABLE "investment_activities" ADD COLUMN IF NOT EXISTS "fee_valuation_source" varchar(64);
ALTER TABLE "investment_activities" ADD COLUMN IF NOT EXISTS "fee_valuation_timestamp" timestamp;
ALTER TABLE "investment_activities" DROP CONSTRAINT IF EXISTS "investment_activities_amount_check";
ALTER TABLE "investment_activities" ADD CONSTRAINT "investment_activities_amount_check" CHECK (
  ("gross_amount" IS NULL OR "gross_amount" >= 0)
  AND ("fee_amount" IS NULL OR "fee_amount" >= 0)
  AND ("tax_amount" IS NULL OR "tax_amount" >= 0)
  AND ("aud_value" IS NULL OR "aud_value" >= 0)
  AND ("fee_aud_value" IS NULL OR "fee_aud_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "acquisition_date" date;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "economic_type" varchar(32) NOT NULL DEFAULT 'trade';
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "taxable_disposal" boolean NOT NULL DEFAULT true;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "aud_value" numeric(38, 18);
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "valuation_source" varchar(64);
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "valuation_timestamp" timestamp;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "valuation_missing" boolean NOT NULL DEFAULT false;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "assumptions" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "source_activity_id" uuid;
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "event_group_id" varchar(255);
ALTER TABLE "broker_trades" ADD COLUMN IF NOT EXISTS "source_acquisition_trade_id" uuid;
UPDATE "broker_trades"
SET "occurred_at" = "trade_date"::timestamp,
    "acquisition_date" = "trade_date"
WHERE "occurred_at" IS NULL OR "acquisition_date" IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broker_trades_economic_type_check') THEN
    ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_economic_type_check"
      CHECK ("economic_type" IN ('trade', 'swap_disposal', 'swap_acquisition', 'reward_acquisition', 'network_fee', 'transfer_out', 'transfer_in'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broker_trades_source_activity_fk') THEN
    ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_source_activity_fk"
      FOREIGN KEY ("source_activity_id") REFERENCES "investment_activities"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'broker_trades_source_acquisition_trade_fk') THEN
    ALTER TABLE "broker_trades" ADD CONSTRAINT "broker_trades_source_acquisition_trade_fk"
      FOREIGN KEY ("source_acquisition_trade_id") REFERENCES "broker_trades"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idx_broker_trades_source_activity" ON "broker_trades" ("source_activity_id");
CREATE INDEX IF NOT EXISTS "idx_broker_trades_event_group" ON "broker_trades" ("event_group_id");
--> statement-breakpoint
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "acquisition_valuation_source" varchar(64);
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "disposal_valuation_source" varchar(64);
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "acquisition_valuation_timestamp" timestamp;
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "disposal_valuation_timestamp" timestamp;
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "acquisition_economic_type" varchar(32) NOT NULL DEFAULT 'trade';
ALTER TABLE "cgt_allocations" ADD COLUMN IF NOT EXISTS "disposal_economic_type" varchar(32) NOT NULL DEFAULT 'trade';
UPDATE "cgt_allocations" AS allocation
SET "acquisition_valuation_source" = acquisition."valuation_source",
    "disposal_valuation_source" = disposal."valuation_source",
    "acquisition_valuation_timestamp" = acquisition."valuation_timestamp",
    "disposal_valuation_timestamp" = disposal."valuation_timestamp",
    "acquisition_economic_type" = acquisition."economic_type",
    "disposal_economic_type" = disposal."economic_type"
FROM "broker_trades" AS acquisition, "broker_trades" AS disposal
WHERE allocation."acquisition_trade_id" = acquisition."id"
  AND allocation."disposal_trade_id" = disposal."id";
--> statement-breakpoint
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "asset_quantity" numeric(38, 18);
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "aud_market_value" numeric(38, 18);
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "valuation_source" varchar(64);
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "valuation_timestamp" timestamp;
ALTER TABLE "investment_income_events" ADD COLUMN IF NOT EXISTS "valuation_missing" boolean NOT NULL DEFAULT false;
ALTER TABLE "investment_income_events" DROP CONSTRAINT IF EXISTS "investment_income_events_type_check";
ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_type_check"
  CHECK ("event_type" IN ('dividend', 'distribution', 'interest', 'staking_reward', 'airdrop'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_crypto_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "source_activity_id" uuid NOT NULL REFERENCES "investment_activities"("id") ON DELETE CASCADE,
  "matched_transfer_id" uuid,
  "direction" varchar(8) NOT NULL,
  "asset_symbol" varchar(64) NOT NULL,
  "quantity" numeric(38, 18) NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "transaction_hash" varchar(255),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "match_method" varchar(32),
  "reason" text,
  "assumptions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  "updated_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "investment_crypto_transfers_activity_uq" UNIQUE ("source_activity_id"),
  CONSTRAINT "investment_crypto_transfers_direction_check" CHECK ("direction" IN ('in', 'out', 'internal')),
  CONSTRAINT "investment_crypto_transfers_status_check" CHECK ("status" IN ('pending', 'matched', 'ambiguous', 'internal')),
  CONSTRAINT "investment_crypto_transfers_quantity_check" CHECK ("quantity" > 0)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investment_crypto_transfers_matched_transfer_fk') THEN
    ALTER TABLE "investment_crypto_transfers" ADD CONSTRAINT "investment_crypto_transfers_matched_transfer_fk"
      FOREIGN KEY ("matched_transfer_id") REFERENCES "investment_crypto_transfers"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idx_investment_crypto_transfers_match"
  ON "investment_crypto_transfers" ("user_id", "asset_symbol", "status");
CREATE INDEX IF NOT EXISTS "idx_investment_crypto_transfers_account"
  ON "investment_crypto_transfers" ("account_id", "occurred_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_crypto_transfer_lots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_out_id" uuid NOT NULL REFERENCES "investment_crypto_transfers"("id") ON DELETE CASCADE,
  "transfer_in_id" uuid NOT NULL REFERENCES "investment_crypto_transfers"("id") ON DELETE CASCADE,
  "source_broker_trade_id" uuid NOT NULL REFERENCES "broker_trades"("id") ON DELETE CASCADE,
  "destination_broker_trade_id" uuid NOT NULL REFERENCES "broker_trades"("id") ON DELETE CASCADE,
  "original_acquisition_trade_id" uuid REFERENCES "broker_trades"("id") ON DELETE SET NULL,
  "quantity" numeric(38, 18) NOT NULL,
  "acquisition_date" date NOT NULL,
  "source_currency" varchar(3) NOT NULL,
  "unit_cost_native" numeric(38, 18) NOT NULL,
  "cost_base_aud" numeric(38, 18),
  "valuation_source" varchar(64),
  "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "investment_crypto_transfer_lots_quantity_check" CHECK ("quantity" > 0)
);
CREATE INDEX IF NOT EXISTS "idx_investment_crypto_transfer_lots_pair"
  ON "investment_crypto_transfer_lots" ("transfer_out_id", "transfer_in_id");
