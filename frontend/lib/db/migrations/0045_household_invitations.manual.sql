-- Additive: no existing identities, ownership records or financial data change.
CREATE TABLE IF NOT EXISTS household_memberships (
  member_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT household_member_not_owner CHECK (member_user_id <> owner_user_id)
);
CREATE INDEX IF NOT EXISTS household_memberships_owner_idx ON household_memberships(owner_user_id);
CREATE TABLE IF NOT EXISTS household_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS household_invitations_owner_idx ON household_invitations(owner_user_id);
