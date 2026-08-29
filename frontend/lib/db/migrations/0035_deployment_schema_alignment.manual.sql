-- Keep clean Compose deployments aligned with feature migrations that were
-- committed without corresponding Drizzle journal entries.
CREATE TABLE IF NOT EXISTS "super_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "fund_name" varchar(255) NOT NULL,
  "investment_option" varchar(255),
  "include_in_net_worth" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "super_accounts_account_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "super_contribution_caps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "financial_year_start" integer NOT NULL,
  "concessional_cap" numeric(15, 2),
  "non_concessional_cap" numeric(15, 2),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "super_contribution_caps_user_fy_unique" UNIQUE("user_id", "financial_year_start"),
  CONSTRAINT "super_contribution_caps_fy_check" CHECK ("financial_year_start" BETWEEN 1900 AND 9998),
  CONSTRAINT "super_contribution_caps_concessional_positive" CHECK ("concessional_cap" IS NULL OR "concessional_cap" >= 0),
  CONSTRAINT "super_contribution_caps_non_concessional_positive" CHECK ("non_concessional_cap" IS NULL OR "non_concessional_cap" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "super_contributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "super_account_id" uuid NOT NULL,
  "date" date NOT NULL,
  "amount" numeric(15, 2) NOT NULL,
  "currency" char(3) DEFAULT 'AUD' NOT NULL,
  "kind" varchar(40) NOT NULL,
  "notes" text,
  "source_import_id" uuid,
  "source_row_hash" varchar(64),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "super_contributions_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "super_contributions_kind_check" CHECK ("kind" IN ('employer_sg', 'salary_sacrifice', 'personal_concessional', 'personal_non_concessional', 'fee', 'insurance'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_income_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "holding_id" uuid NOT NULL,
  "event_type" varchar(20) NOT NULL,
  "pay_date" date NOT NULL,
  "ex_date" date,
  "currency" char(3) NOT NULL,
  "cash_received" numeric(18, 2) NOT NULL,
  "franked_amount" numeric(18, 2),
  "unfranked_amount" numeric(18, 2),
  "franking_credit" numeric(18, 2),
  "foreign_income" numeric(18, 2),
  "foreign_tax_paid" numeric(18, 2),
  "amit_amma_components" jsonb,
  "is_drp" boolean DEFAULT false NOT NULL,
  "drp_quantity" numeric(28, 8),
  "drp_price" numeric(28, 8),
  "reinvestment_trade_id" uuid,
  "source_id" varchar(255),
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "investment_income_events_type_check" CHECK ("event_type" IN ('dividend', 'distribution')),
  CONSTRAINT "investment_income_events_cash_received_check" CHECK ("cash_received" >= 0),
  CONSTRAINT "investment_income_events_drp_check" CHECK ("is_drp" = false OR ("drp_quantity" > 0 AND "drp_price" >= 0)),
  CONSTRAINT "investment_income_events_account_source_uq" UNIQUE("account_id", "source_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cgt_allocations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "acquisition_trade_id" uuid NOT NULL REFERENCES "broker_trades"("id") ON DELETE CASCADE,
  "disposal_trade_id" uuid NOT NULL REFERENCES "broker_trades"("id") ON DELETE CASCADE,
  "symbol" varchar(64) NOT NULL,
  "acquisition_date" date NOT NULL,
  "disposal_date" date NOT NULL,
  "quantity" numeric(28, 8) NOT NULL,
  "currency" varchar(3) NOT NULL,
  "cost_base_native" numeric(28, 8) NOT NULL,
  "proceeds_native" numeric(28, 8) NOT NULL,
  "gain_native" numeric(28, 8) NOT NULL,
  "cost_base_aud" numeric(28, 8),
  "proceeds_aud" numeric(28, 8),
  "gain_aud" numeric(28, 8),
  "fx_missing" boolean NOT NULL DEFAULT false,
  "discount_eligible" boolean NOT NULL DEFAULT false,
  "calculation_version" varchar(32) NOT NULL DEFAULT 'fifo-v1',
  "assumptions" json NOT NULL DEFAULT '[]'::json,
  "created_at" timestamp NOT NULL DEFAULT current_timestamp,
  "updated_at" timestamp NOT NULL DEFAULT current_timestamp,
  CONSTRAINT "cgt_allocations_trade_pair_uq" UNIQUE ("acquisition_trade_id", "disposal_trade_id")
);
--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN IF NOT EXISTS "provider_symbol" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_accounts_user" ON "super_accounts" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_contributions_user_date" ON "super_contributions" ("user_id", "date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_contributions_account_date" ON "super_contributions" ("super_account_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "super_contributions_import_row_unique" ON "super_contributions" ("source_import_id", "source_row_hash") WHERE "source_import_id" IS NOT NULL AND "source_row_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_income_events_user_pay_date" ON "investment_income_events" ("user_id", "pay_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_income_events_holding_pay_date" ON "investment_income_events" ("holding_id", "pay_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cgt_allocations_account_disposal" ON "cgt_allocations" ("account_id", "disposal_date");
