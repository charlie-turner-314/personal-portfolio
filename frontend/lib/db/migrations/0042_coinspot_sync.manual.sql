-- PPF-44: durable read-only CoinSpot sync cursor, retry, and health state.
ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "sync_cursor" jsonb;
--> statement-breakpoint
ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "read_only_verified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp;
--> statement-breakpoint
ALTER TABLE "broker_connections"
  ADD COLUMN IF NOT EXISTS "health_details" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broker_connections_retry"
  ON "broker_connections" ("next_retry_at")
  WHERE "next_retry_at" IS NOT NULL;
