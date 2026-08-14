#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose --env-file deploy/compose/.env.ci -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.local.yml)

"${compose[@]}" exec -T postgres psql -U financeuser -d finance_db -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  required_tables text[] := ARRAY['users', 'super_accounts', 'investment_income_events', 'cgt_allocations', 'holdings'];
  required_columns text[] := ARRAY['users.country_code', 'users.locale', 'holdings.provider_symbol'];
  entry text;
  target_table text;
  target_column text;
BEGIN
  FOREACH entry IN ARRAY required_tables LOOP
    IF to_regclass('public.' || entry) IS NULL THEN
      RAISE EXCEPTION 'required table public.% is missing', entry;
    END IF;
  END LOOP;

  FOREACH entry IN ARRAY required_columns LOOP
    target_table := split_part(entry, '.', 1);
    target_column := split_part(entry, '.', 2);
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target_table AND column_name = target_column
    ) THEN
      RAISE EXCEPTION 'required column public.% is missing', entry;
    END IF;
  END LOOP;
END $$;
SQL
