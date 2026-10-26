-- Generic portions supersede the provisional single-allocation override.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_flow_parts jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transactions_cash_flow_parts_check') THEN
  ALTER TABLE transactions ADD CONSTRAINT transactions_cash_flow_parts_check
    CHECK (cash_flow_parts IS NULL OR (jsonb_typeof(cash_flow_parts)='array' AND jsonb_array_length(cash_flow_parts) BETWEEN 1 AND 20));
 END IF;
END $$;
-- Convert any provisional overrides once. Old fields are retained for compatible
-- backups but are no longer written by the application.
UPDATE transactions t SET cash_flow_parts =
 CASE WHEN t.cash_flow_kind IN ('investment','loan_principal') THEN
   jsonb_build_array(jsonb_build_object('kind','capital','detail',t.cash_flow_kind,
     'amount',COALESCE(t.cash_flow_allocation_amount,abs(t.amount)))) ||
   CASE WHEN t.cash_flow_allocation_amount IS NOT NULL AND t.cash_flow_allocation_amount < abs(t.amount)
     THEN jsonb_build_array(jsonb_build_object('kind',CASE WHEN (SELECT category_type FROM categories WHERE id=COALESCE(t.category_id,t.category_system_id))='income' THEN 'income' ELSE 'consumption' END,
       'amount',abs(t.amount)-t.cash_flow_allocation_amount)) ELSE '[]'::jsonb END
 ELSE jsonb_build_array(jsonb_build_object('kind',CASE WHEN (SELECT category_type FROM categories WHERE id=COALESCE(t.category_id,t.category_system_id))='income' OR ((SELECT category_type FROM categories WHERE id=COALESCE(t.category_id,t.category_system_id)) IS NULL AND t.amount>0) THEN 'income' ELSE 'consumption' END,'amount',abs(t.amount))) END
WHERE t.cash_flow_kind IS NOT NULL AND t.cash_flow_parts IS NULL AND t.amount<>0;
