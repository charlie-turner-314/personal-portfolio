-- Legacy equal category_id/category_system_id rows may be unreviewed AI imports.
-- Do not backfill verification from category_id or updated_at.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_verified_at timestamp;
