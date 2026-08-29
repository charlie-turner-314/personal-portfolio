CREATE TABLE IF NOT EXISTS "csv_import_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) DEFAULT 'Default CSV mapping' NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"header_signature" jsonb,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "csv_import_profiles_user_account_unique" UNIQUE("user_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "csv_imports" ADD COLUMN IF NOT EXISTS "import_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "csv_imports" ADD COLUMN IF NOT EXISTS "rows_needing_attention" integer DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "csv_import_profiles" ADD CONSTRAINT "csv_import_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "csv_import_profiles" ADD CONSTRAINT "csv_import_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "csv_imports" ADD CONSTRAINT "csv_imports_import_profile_id_csv_import_profiles_id_fk" FOREIGN KEY ("import_profile_id") REFERENCES "public"."csv_import_profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_csv_import_profiles_user" ON "csv_import_profiles" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_csv_import_profiles_account" ON "csv_import_profiles" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_csv_imports_import_profile" ON "csv_imports" USING btree ("import_profile_id");
