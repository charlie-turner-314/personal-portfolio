ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "liability_interest_rate" numeric(7, 4);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "liability_repayment_amount" numeric(15, 2);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "liability_repayment_frequency" varchar(20);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "liability_loan_term_months" integer;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "liability_secured" boolean;
