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
DO $$ BEGIN
  ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "investment_income_events" ADD CONSTRAINT "investment_income_events_reinvestment_trade_id_broker_trades_id_fk" FOREIGN KEY ("reinvestment_trade_id") REFERENCES "public"."broker_trades"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_income_events_user_pay_date" ON "investment_income_events" USING btree ("user_id", "pay_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_investment_income_events_holding_pay_date" ON "investment_income_events" USING btree ("holding_id", "pay_date");
