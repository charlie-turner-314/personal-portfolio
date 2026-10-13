#!/usr/bin/env python3
"""Test the real backfill SQL against a temporary table, never application rows."""
import argparse
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--container', required=True)
args = parser.parse_args()
source = (Path(__file__).resolve().parents[1] / 'frontend/lib/db/migrations/0041_crypto_accounting.manual.sql').read_text()
update = re.search(r'UPDATE "broker_trades"\s+SET.*?;', source, re.S).group(0)
sql = '''
BEGIN;
CREATE TEMP TABLE broker_trades (id int, trade_date date, occurred_at timestamp, acquisition_date date);
INSERT INTO broker_trades VALUES
 (1, '2025-01-01', '2025-01-01 12:34:56', NULL),
 (2, '2025-01-01', NULL, '2020-02-03'),
 (3, '2025-01-01', NULL, NULL);
''' + update + '''
DO $$ BEGIN
 IF (SELECT occurred_at FROM broker_trades WHERE id=1) <> '2025-01-01 12:34:56'::timestamp
 OR (SELECT acquisition_date FROM broker_trades WHERE id=2) <> '2020-02-03'::date
 OR EXISTS (SELECT 1 FROM broker_trades WHERE occurred_at IS NULL OR acquisition_date IS NULL)
 THEN RAISE EXCEPTION 'Backfill overwrote known dates or failed to fill missing dates'; END IF;
END $$;
CREATE TEMP TABLE before_repeat AS SELECT * FROM broker_trades;
''' + update + '''
DO $$ BEGIN
 IF EXISTS (SELECT * FROM broker_trades EXCEPT SELECT * FROM before_repeat)
 OR EXISTS (SELECT * FROM before_repeat EXCEPT SELECT * FROM broker_trades)
 THEN RAISE EXCEPTION 'Backfill is not idempotent'; END IF;
END $$;
ROLLBACK;
'''
subprocess.run(['docker', 'exec', '-i', args.container, 'sh', '-c',
                'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'],
               input=sql, text=True, check=True)
print('Trade date preservation and repeated backfill passed (temporary table only).')
