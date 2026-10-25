-- Nullable/defaulted additions preserve earlier suggestions without inventing history.
ALTER TABLE categorization_suggestions ADD COLUMN IF NOT EXISTS config_fingerprint varchar(64);
ALTER TABLE categorization_suggestions ADD COLUMN IF NOT EXISTS inference_status varchar(30) NOT NULL DEFAULT 'legacy';
ALTER TABLE categorization_suggestions ADD COLUMN IF NOT EXISTS record jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE categorization_suggestions ADD COLUMN IF NOT EXISTS shown_at timestamp;

-- Captures manual assignments from every writer, including direct frontend SQL.
-- This is an observation, not proof that every manual choice is correct.
CREATE TABLE IF NOT EXISTS categorization_feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    suggestion_id uuid REFERENCES categorization_suggestions(id) ON DELETE SET NULL,
    source varchar(40) NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS categorization_feedback_user_transaction_idx ON categorization_feedback(user_id, transaction_id, created_at);

CREATE OR REPLACE FUNCTION record_categorization_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous_category uuid;
    previous_verified timestamp;
    linked_suggestion uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        previous_category := OLD.category_id;
        previous_verified := OLD.category_verified_at;
        IF NEW.category_id IS NOT DISTINCT FROM OLD.category_id AND NEW.category_verified_at IS NOT DISTINCT FROM OLD.category_verified_at THEN
            RETURN NEW;
        END IF;
    ELSIF NEW.category_id IS NULL THEN
        RETURN NEW;
    END IF;
    -- Only link a panel context when it belongs to this transaction and owner.
    SELECT id INTO linked_suggestion FROM categorization_suggestions
      WHERE id::text = current_setting('app.categorization_suggestion_id', true)
        AND user_id = NEW.user_id AND transaction_id = NEW.id;
    INSERT INTO categorization_feedback(user_id, transaction_id, suggestion_id, source, snapshot)
    VALUES (NEW.user_id, NEW.id, linked_suggestion,
      CASE WHEN linked_suggestion IS NULL THEN 'manual_assignment' ELSE 'suggestion_review' END,
      jsonb_build_object(
        'schema_version', 1, 'operation', TG_OP,
        'target', jsonb_build_object('id', NEW.id, 'account_id', NEW.account_id,
          'description', NEW.description, 'merchant', NEW.merchant, 'amount', NEW.amount,
          'currency', NEW.currency, 'transaction_type', NEW.transaction_type,
          'booked_at', NEW.booked_at, 'creditor', NEW.creditor, 'debtor', NEW.debtor,
          'categorization_instructions', NEW.categorization_instructions),
        'previous_category_id', previous_category, 'category_id', NEW.category_id,
        'system_category_id', NEW.category_system_id,
        'previous_verified_at', previous_verified, 'verified_at', NEW.category_verified_at,
        'categories', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
          'category_type', c.category_type, 'description', c.description,
          'categorization_instructions', c.categorization_instructions)), '[]'::jsonb)
          FROM categories c WHERE c.user_id = NEW.user_id
          AND c.id IN (previous_category, NEW.category_id, NEW.category_system_id))
      ));
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS categorization_feedback_write ON transactions;
CREATE TRIGGER categorization_feedback_write AFTER INSERT OR UPDATE OF category_id, category_verified_at ON transactions
    FOR EACH ROW EXECUTE FUNCTION record_categorization_feedback();
