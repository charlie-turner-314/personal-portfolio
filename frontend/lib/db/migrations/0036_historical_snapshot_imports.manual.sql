-- This migration is intentionally manual because the Drizzle journal predates
-- several deployed schema migrations. The production runner applies manual
-- files on every boot, so each statement must be idempotent.
CREATE TABLE IF NOT EXISTS "historical_snapshot_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "file_name" varchar(255) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_historical_snapshot_imports_user" ON "historical_snapshot_imports" USING btree ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "historical_snapshot_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "import_id" uuid NOT NULL REFERENCES "historical_snapshot_imports"("id") ON DELETE CASCADE,
  "snapshot_date" date NOT NULL,
  "net_worth" numeric(15,2) NOT NULL,
  "metric_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "historical_snapshot_values_user_date" UNIQUE("user_id", "snapshot_date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_historical_snapshot_values_user_date" ON "historical_snapshot_values" USING btree ("user_id", "snapshot_date");
