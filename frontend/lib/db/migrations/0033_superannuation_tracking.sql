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
DO $$ BEGIN
  ALTER TABLE "super_accounts" ADD CONSTRAINT "super_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "super_accounts" ADD CONSTRAINT "super_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "super_contribution_caps" ADD CONSTRAINT "super_contribution_caps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "super_contributions" ADD CONSTRAINT "super_contributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "super_contributions" ADD CONSTRAINT "super_contributions_super_account_id_super_accounts_id_fk" FOREIGN KEY ("super_account_id") REFERENCES "public"."super_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "super_contributions" ADD CONSTRAINT "super_contributions_source_import_id_csv_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."csv_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_accounts_user" ON "super_accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_contributions_user_date" ON "super_contributions" USING btree ("user_id", "date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_super_contributions_account_date" ON "super_contributions" USING btree ("super_account_id", "date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "super_contributions_import_row_unique" ON "super_contributions" USING btree ("source_import_id", "source_row_hash") WHERE "source_import_id" IS NOT NULL AND "source_row_hash" IS NOT NULL;
