CREATE TABLE IF NOT EXISTS "budget_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"month" date NOT NULL,
	"planned_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "budget_limits_user_month_category" UNIQUE("user_id","month","category_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "budget_limits" ADD CONSTRAINT "budget_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "budget_limits" ADD CONSTRAINT "budget_limits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_budget_limits_user_month" ON "budget_limits" USING btree ("user_id","month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_budget_limits_category" ON "budget_limits" USING btree ("category_id");
