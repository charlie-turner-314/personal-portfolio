CREATE TABLE IF NOT EXISTS "planned_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"category_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"recurrence_type" varchar(20) NOT NULL,
	"custom_interval_months" integer,
	"sinking_fund_target_amount" numeric(15, 2) NOT NULL,
	"sinking_fund_start_date" date DEFAULT CURRENT_DATE NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "planned_expenses_amount_positive" CHECK ("amount" > 0),
	CONSTRAINT "planned_expenses_sinking_target_positive" CHECK ("sinking_fund_target_amount" > 0),
	CONSTRAINT "planned_expenses_recurrence_type_check" CHECK ("recurrence_type" IN ('one_off', 'monthly', 'quarterly', 'annual', 'custom')),
	CONSTRAINT "planned_expenses_custom_interval_check" CHECK ("recurrence_type" <> 'custom' OR "custom_interval_months" BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planned_expense_transaction_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"planned_expense_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"occurrence_due_date" date NOT NULL,
	"amount_applied" numeric(15, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "planned_expense_link_occurrence_unique" UNIQUE("planned_expense_id","transaction_id","occurrence_due_date"),
	CONSTRAINT "planned_expense_link_transaction_unique" UNIQUE("transaction_id"),
	CONSTRAINT "planned_expense_links_amount_positive" CHECK ("amount_applied" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expenses" ADD CONSTRAINT "planned_expenses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expense_transaction_links" ADD CONSTRAINT "planned_expense_transaction_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expense_transaction_links" ADD CONSTRAINT "planned_expense_transaction_links_planned_expense_id_planned_expenses_id_fk" FOREIGN KEY ("planned_expense_id") REFERENCES "public"."planned_expenses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "planned_expense_transaction_links" ADD CONSTRAINT "planned_expense_transaction_links_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expenses_user_active_due" ON "planned_expenses" USING btree ("user_id","is_active","due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expenses_category" ON "planned_expenses" USING btree ("category_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expenses_account" ON "planned_expenses" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expense_links_user" ON "planned_expense_transaction_links" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expense_links_expense_occurrence" ON "planned_expense_transaction_links" USING btree ("planned_expense_id","occurrence_due_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_planned_expense_links_transaction" ON "planned_expense_transaction_links" USING btree ("transaction_id");
