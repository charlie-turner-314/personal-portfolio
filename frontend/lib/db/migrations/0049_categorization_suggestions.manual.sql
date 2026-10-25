CREATE TABLE IF NOT EXISTS categorization_suggestions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    target_fingerprint varchar(64) NOT NULL,
    suggested_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
    reviewed_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
    provider varchar(40) NOT NULL,
    model varchar(100) NOT NULL,
    context_mode varchar(30) NOT NULL DEFAULT 'examples_only',
    evidence jsonb NOT NULL,
    model_score numeric(5,2),
    generation_ms integer NOT NULL,
    review_duration_ms integer,
    review_outcome varchar(20) CHECK (review_outcome IN ('accepted', 'corrected', 'dismissed')),
    created_at timestamp NOT NULL DEFAULT now(),
    reviewed_at timestamp
);
CREATE INDEX IF NOT EXISTS categorization_suggestions_user_idx ON categorization_suggestions(user_id);
CREATE INDEX IF NOT EXISTS categorization_suggestions_transaction_idx ON categorization_suggestions(transaction_id);
