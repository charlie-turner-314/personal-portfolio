ALTER TABLE "bank_connections"
  ADD COLUMN IF NOT EXISTS "credentials_encrypted" text;
