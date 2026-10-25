ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_confidence integer
  CHECK (category_confidence BETWEEN 0 AND 100);
