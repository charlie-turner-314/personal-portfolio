ALTER TABLE user_ai_settings ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'openai';
ALTER TABLE user_ai_settings ADD COLUMN IF NOT EXISTS model text;
