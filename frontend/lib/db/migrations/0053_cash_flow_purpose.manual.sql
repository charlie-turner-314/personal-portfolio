-- Add reporting metadata without changing amounts, ownership or category selections.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='categories' AND column_name='cash_flow_kind') THEN
  ALTER TABLE categories ADD COLUMN cash_flow_kind varchar(20);
  UPDATE categories SET cash_flow_kind='investment'
   WHERE name='Investment Transfer' AND category_type='expense';
 END IF;
END $$;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_flow_kind varchar(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_flow_allocation_amount numeric(15,2);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transactions_cash_flow_kind_check') THEN
  ALTER TABLE transactions ADD CONSTRAINT transactions_cash_flow_kind_check
   CHECK (cash_flow_kind IS NULL OR cash_flow_kind IN ('activity','investment','loan_principal'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='categories_cash_flow_kind_check') THEN
  ALTER TABLE categories ADD CONSTRAINT categories_cash_flow_kind_check
   CHECK (cash_flow_kind IS NULL OR cash_flow_kind IN ('investment','loan_principal'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transactions_cash_flow_allocation_check') THEN
  ALTER TABLE transactions ADD CONSTRAINT transactions_cash_flow_allocation_check
   CHECK (cash_flow_allocation_amount IS NULL OR
    (cash_flow_kind IS NOT NULL AND cash_flow_kind IN ('investment','loan_principal') AND cash_flow_allocation_amount > 0
     AND cash_flow_allocation_amount <= abs(amount)));
 END IF;
END $$;
