-- PPF-51: scope reusable CSV mappings by workflow and provider.
ALTER TABLE "broker_trades"
  ADD COLUMN IF NOT EXISTS "instrument_type" varchar(20) DEFAULT 'equity' NOT NULL;
--> statement-breakpoint
ALTER TABLE "csv_import_profiles"
  ADD COLUMN IF NOT EXISTS "import_kind" varchar(24) DEFAULT 'transactions' NOT NULL;
--> statement-breakpoint
ALTER TABLE "csv_import_profiles"
  ADD COLUMN IF NOT EXISTS "provider" varchar(64) DEFAULT 'generic' NOT NULL;
--> statement-breakpoint
ALTER TABLE "csv_import_profiles"
  DROP CONSTRAINT IF EXISTS "csv_import_profiles_user_account_unique";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csv_import_profiles_import_kind_check'
  ) THEN
    ALTER TABLE "csv_import_profiles"
      ADD CONSTRAINT "csv_import_profiles_import_kind_check"
      CHECK ("import_kind" IN ('transactions', 'investments'));
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'csv_import_profiles_scope_unique'
  ) THEN
    ALTER TABLE "csv_import_profiles"
      ADD CONSTRAINT "csv_import_profiles_scope_unique"
      UNIQUE ("user_id", "account_id", "import_kind", "provider");
  END IF;
END;
$$;
