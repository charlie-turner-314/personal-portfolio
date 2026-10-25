-- Explicit permission only: economic ownership never grants property access.
CREATE TABLE IF NOT EXISTS household_property_shares (
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, member_user_id),
  CONSTRAINT household_property_shares_not_self CHECK (member_user_id <> granted_by_user_id)
);
CREATE INDEX IF NOT EXISTS household_property_shares_member_idx ON household_property_shares(member_user_id);
