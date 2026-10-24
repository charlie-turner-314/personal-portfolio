-- No implicit sharing: retain all original account ownership and private records.
CREATE TABLE IF NOT EXISTS household_account_shares (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, member_user_id),
  CONSTRAINT household_account_shares_not_self CHECK (member_user_id <> granted_by_user_id)
);
CREATE INDEX IF NOT EXISTS household_account_shares_member_idx ON household_account_shares(member_user_id);
CREATE TABLE IF NOT EXISTS household_net_worth_shares (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, member_user_id),
  CONSTRAINT household_net_worth_shares_not_self CHECK (owner_user_id <> member_user_id)
);
CREATE INDEX IF NOT EXISTS household_net_worth_shares_member_idx ON household_net_worth_shares(member_user_id);

-- Stable person identity preserves economic ownership when membership ends.
-- This confers no resource access; account grants remain explicit.
ALTER TABLE people ADD COLUMN IF NOT EXISTS linked_user_id text REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS people_linked_user_idx ON people(linked_user_id);
UPDATE people SET linked_user_id = user_id WHERE kind = 'self' AND linked_user_id IS NULL;
UPDATE people p SET linked_user_id = m.member_user_id
FROM household_memberships m WHERE m.person_id = p.id AND p.linked_user_id IS NULL;
