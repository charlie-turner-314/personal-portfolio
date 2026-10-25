CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_key_encrypted text,
  automatic boolean NOT NULL DEFAULT true,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_categorization_jobs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  categorized integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT ai_job_status CHECK (status IN ('queued','running','completed','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_one_active_user ON ai_categorization_jobs(user_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS ai_jobs_user_created ON ai_categorization_jobs(user_id, created_at DESC);
