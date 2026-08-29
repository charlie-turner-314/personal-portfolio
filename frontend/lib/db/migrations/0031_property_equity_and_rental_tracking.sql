ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "is_rental" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "valuation_date" date;
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "valuation_source" varchar(100);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "notes" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "property_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transactions_property" ON "transactions" USING btree ("property_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_transactions_user_property_booked" ON "transactions" USING btree ("user_id","property_id","booked_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property_liability_links" (
	"property_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "property_liability_links_property_id_account_id_pk" PRIMARY KEY("property_id","account_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_liability_links" ADD CONSTRAINT "property_liability_links_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_liability_links" ADD CONSTRAINT "property_liability_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_liability_links" ADD CONSTRAINT "property_liability_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_property_liability_links_user" ON "property_liability_links" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_property_liability_links_account" ON "property_liability_links" USING btree ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "property_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"valuation_date" date NOT NULL,
	"value" numeric(15, 2) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"source" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_property_valuations_property_date" ON "property_valuations" USING btree ("property_id","valuation_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_property_valuations_user" ON "property_valuations" USING btree ("user_id");
