-- Additive and repeatable. Does not grant access or rewrite financial data.
CREATE TABLE IF NOT EXISTS household_transition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  request_digest text NOT NULL,
  preview jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS household_transition_events_actor_idx
  ON household_transition_events(actor_user_id, committed_at);

-- Canonical vocabularies retain stable definition IDs. No category equivalence
-- or financial-row rewrite is inferred, and private guidance remains at source.
CREATE TABLE IF NOT EXISTS category_vocabulary_entries (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id, category_id)
);
INSERT INTO category_vocabulary_entries(owner_user_id,category_id)
  SELECT user_id,id FROM categories ON CONFLICT DO NOTHING;
-- Preserve every existing personal consumer, not merely transaction labels.
-- Discover scalar category foreign keys rather than maintain a lossy allowlist.
DO $$
DECLARE reference record;
BEGIN
 FOR reference IN
   SELECT tc.table_name,kcu.column_name
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu USING (constraint_catalog,constraint_schema,constraint_name)
   JOIN information_schema.constraint_column_usage ccu USING (constraint_catalog,constraint_schema,constraint_name)
   WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
     AND ccu.table_name='categories' AND ccu.column_name='id'
     AND EXISTS (SELECT 1 FROM information_schema.columns own
       WHERE own.table_schema='public' AND own.table_name=tc.table_name AND own.column_name='user_id')
 LOOP
   EXECUTE format('INSERT INTO category_vocabulary_entries(owner_user_id,category_id)
     SELECT DISTINCT user_id,%I FROM %I WHERE %I IS NOT NULL ON CONFLICT DO NOTHING',
     reference.column_name,reference.table_name,reference.column_name);
 END LOOP;
 INSERT INTO category_vocabulary_entries(owner_user_id,category_id)
   SELECT DISTINCT coalesce(m.owner_user_id,e.owner_user_id),e.category_id
   FROM category_vocabulary_entries e LEFT JOIN household_memberships m ON m.member_user_id=e.owner_user_id
   ON CONFLICT DO NOTHING;
END $$;
