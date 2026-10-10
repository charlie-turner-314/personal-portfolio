#!/usr/bin/env python3
"""Hash existing core-table columns without exposing financial or auth values."""
import hashlib
import json
import subprocess
import sys


def sql(query):
    return subprocess.check_output([
        'docker', 'exec', '-i', 'personal-portfolio-postgres', 'sh', '-c',
        'exec psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" "$POSTGRES_DB"',
    ], input=query, text=True).strip()


tables = ['users', 'auth_accounts', 'accounts', 'transactions', 'holdings', 'broker_trades']
before = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
result = {}
for table in tables:
    columns = before[table]['columns'] if before else sql(
        "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) "
        f"FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}';")
    if not columns:
        continue
    rows = sql(f'SELECT row_to_json(t)::text FROM (SELECT {columns} FROM "{table}") t ORDER BY row_to_json(t)::text;')
    result[table] = {'columns': columns, 'sha256': hashlib.sha256(rows.encode()).hexdigest(),
                     'count': sql(f'SELECT count(*) FROM "{table}";')}
print(json.dumps(result, indent=2))
if before and result != before:
    raise SystemExit('Existing data changed: inspect evidence before restarting writers.')
