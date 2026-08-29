ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "country_code" char(2);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" varchar(35);
