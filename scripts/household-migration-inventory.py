#!/usr/bin/env python3
"""Read-only inventory on an isolated rehearsal DB. Never accepts the live DB.

Detailed identity mappings stay in mode-600 local lab state; stdout contains
only table-level counts. No guidance, transaction descriptions or money values
are selected. IDs are retained, so scalar and JSON consumers need no rewrites.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--allow-synthetic', action='store_true')
    args = parser.parse_args()
    project = subprocess.check_output(['docker', 'inspect', args.container, '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}'], text=True).strip()
    synthetic = args.allow_synthetic and args.container == 'syllogic-household-model-test'
    if not synthetic and not project.startswith('syllogic-release-lab-'):
        raise SystemExit('Refusing a non-lab database; inventory a protected release-lab restore.')
    statement = r"""
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'identityMappings', coalesce(jsonb_agg(jsonb_build_object(
    'sourceCategoryId',id,'destinationCategoryId',id,
    'custodianUserId',user_id,'name',name,'type',category_type,
    'cashFlowPurpose',cash_flow_kind,'parentDefinitionId',parent_id)
    ORDER BY id),'[]'::jsonb),
  'definitionCount',count(*)) FROM categories;
SELECT coalesce(jsonb_agg(conflict),'[]'::jsonb) FROM (
 SELECT lower(btrim(name)) AS label, count(*) AS definitions,
   jsonb_agg(jsonb_build_object('id',id,'type',category_type,'cashFlowPurpose',cash_flow_kind,'parentDefinitionId',parent_id) ORDER BY id) AS preserved_definitions
 FROM categories GROUP BY lower(btrim(name)) HAVING count(*)>1 ORDER BY lower(btrim(name))
) conflict;
SELECT coalesce(jsonb_agg(reference ORDER BY reference.table_name,reference.column_name),'[]'::jsonb) FROM (
 SELECT DISTINCT tc.table_name,kcu.column_name
 FROM information_schema.table_constraints tc
 JOIN information_schema.key_column_usage kcu USING (constraint_catalog,constraint_schema,constraint_name)
 JOIN information_schema.constraint_column_usage ccu USING (constraint_catalog,constraint_schema,constraint_name)
 WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'
 AND ccu.table_name='categories' AND ccu.column_name='id'
) reference;
SELECT jsonb_build_object('accountGrants',count(*)) FROM household_account_shares;
ROLLBACK;
"""
    # Expand only the DB's configured non-secret username/name inside its own
    # container. Never inspect, pass or print the password or full environment.
    command = ['docker', 'exec', '-i', args.container, 'sh', '-c',
        'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"']
    lines = subprocess.check_output(command, input=statement, text=True).strip().splitlines()
    mappings, conflicts, references, grants = map(json.loads, lines)
    report = {
        'mode':'dry-run','project':project,'synthetic':synthetic,
        'policy':'Retain definition IDs, keep conflicts separate, copy no private guidance, grant no account access',
        **mappings,'conflicts':conflicts,'references':references,'beforeAccess':grants,
        'jsonReferences':'Unchanged definition IDs preserve JSON references and audit provenance; no JSON rewrite is needed',
        'recovery':'Additive schema and idempotent vocabulary reconstruction; forward repair preserves post-upgrade writes. Do not drop vocabulary tables or restore an old dump over new writes.',
    }
    state = ROOT/'.release-lab'
    state.mkdir(mode=0o700, exist_ok=True)
    path = state/'household-migration-inventory.json'
    fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as output:
        json.dump(report,output,indent=2)
    print(json.dumps({'mode':'dry-run','definitions':report['definitionCount'],
        'conflictingLabelsRetained':len(conflicts),'categoryReferenceColumns':len(references),
        'proposedFinancialRewrites':0,'proposedAccountGrants':0,
        'detailedReport':str(path)},indent=2))


if __name__ == '__main__':
    main()
