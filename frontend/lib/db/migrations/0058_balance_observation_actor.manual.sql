-- Actor provenance for new supplied observations; never guess historical actors.
ALTER TABLE account_balances ADD COLUMN IF NOT EXISTS recorded_by_user_id text
 REFERENCES users(id) ON DELETE SET NULL;
