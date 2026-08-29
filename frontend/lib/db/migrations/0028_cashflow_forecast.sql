CREATE TABLE IF NOT EXISTS "cashflow_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"expected_date" date NOT NULL,
	"direction" varchar(20) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"description" varchar(255) NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cashflow_overrides_direction_check" CHECK ("direction" IN ('income', 'expense', 'transfer_in', 'transfer_out')),
	CONSTRAINT "cashflow_overrides_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_transaction_schedule_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"recurring_transaction_id" uuid NOT NULL,
	"anchor_date" date NOT NULL,
	"direction" varchar(10) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_schedule_overrides_recurring_unique" UNIQUE("recurring_transaction_id"),
	CONSTRAINT "recurring_schedule_overrides_direction_check" CHECK ("direction" IN ('inflow', 'outflow'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cashflow_overrides" ADD CONSTRAINT "cashflow_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cashflow_overrides" ADD CONSTRAINT "cashflow_overrides_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "cashflow_overrides" ADD CONSTRAINT "cashflow_overrides_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "recurring_transaction_schedule_overrides" ADD CONSTRAINT "recurring_schedule_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "recurring_transaction_schedule_overrides" ADD CONSTRAINT "recurring_schedule_overrides_recurring_transaction_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_transaction_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cashflow_overrides_user_date" ON "cashflow_overrides" USING btree ("user_id","expected_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cashflow_overrides_account" ON "cashflow_overrides" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cashflow_overrides_category" ON "cashflow_overrides" USING btree ("category_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recurring_schedule_overrides_user" ON "recurring_transaction_schedule_overrides" USING btree ("user_id");
