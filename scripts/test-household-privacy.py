#!/usr/bin/env python3
"""Exercise privacy in a disposable, schema-only local release-lab database."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import uuid
import os
import tempfile
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--template-database', help='Reuse only a disposable privacy-test schema, never production data')
    parser.add_argument('--frontend-only', action='store_true')
    parser.add_argument('--backend-regressions', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'syllogic-release-lab-[a-f0-9]{10}', args.project):
        parser.error('An isolated local release-lab project is required')
    if args.template_database and not re.fullmatch(r'household_privacy_test_[a-f0-9]{12}', args.template_database):
        parser.error('Only a previously disposable privacy-test database may be a template')
    containers = {}
    for service in ('postgres', 'app', 'backend'):
        names = run(['docker', 'ps', '-a', '--filter', f'label=com.docker.compose.project={args.project}', '--filter', f'label=com.docker.compose.service={service}', '--format', '{{.Names}}']).stdout.decode().splitlines()
        if len(names) != 1:
            raise SystemExit(f'Expected exactly one running isolated {service} container')
        containers[service] = names[0]
    config = json.loads(run(['docker', 'inspect', containers['postgres']]).stdout)[0]
    env = dict(item.split('=', 1) for item in config['Config']['Env'] if '=' in item)
    user = env.get('POSTGRES_USER', 'postgres')
    source_database = env.get('POSTGRES_DB', user)
    dbname = 'household_privacy_test_' + uuid.uuid4().hex[:12]
    temporary_root = '/tmp/' + dbname

    def sql(database, statement):
        return run(['docker', 'exec', '-i', containers['postgres'], 'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'], input=statement.encode())

    print('Creating disposable schema-only database', flush=True)
    template = f' TEMPLATE {args.template_database}' if args.template_database else ''
    sql(source_database, f'CREATE DATABASE {dbname}{template}')
    try:
        if not args.template_database:
            schema = run(['docker', 'exec', containers['postgres'], 'pg_dump', '-U', user, '-d', source_database, '--schema-only', '--no-owner', '--no-acl']).stdout
            run(['docker', 'exec', '-i', containers['postgres'], 'psql', '-U', user, '-d', dbname, '-v', 'ON_ERROR_STOP=1'], input=schema)
        print('Applying additive privacy migration twice', flush=True)
        for filename in ('0046_household_financial_privacy.manual.sql', '0051_household_property_sharing.manual.sql', '0052_up_canonical_accounts.manual.sql'):
            migration = (ROOT / 'frontend/lib/db/migrations' / filename).read_text()
            for _ in range(2):
                sql(dbname, migration)
        bundle = ROOT / '.release-lab/household-privacy-integration.cjs'
        run([str(ROOT / 'frontend/node_modules/.bin/esbuild'), 'frontend/scripts/test-household-financial-privacy.ts', '--bundle', '--platform=node', '--format=cjs', f'--outfile={bundle}', '--tsconfig=frontend/tsconfig.json'], cwd=ROOT)
        def test_runner(service, entrypoint, command, files):
            prototype = json.loads(run(['docker', 'inspect', containers[service]]).stdout)[0]
            runner = dbname + '-' + service
            network = next(iter(prototype['NetworkSettings']['Networks']))
            environment = dict(item.split('=', 1) for item in prototype['Config']['Env'] if '=' in item)
            url = urlsplit(environment['DATABASE_URL'])
            environment['DATABASE_URL'] = urlunsplit((url.scheme, url.netloc, '/' + dbname, url.query, url.fragment))
            environment['HOUSEHOLD_TEST_ISOLATED'] = 'yes'
            environment['NODE_ENV'] = 'test'
            with tempfile.NamedTemporaryFile(mode='w', dir=ROOT / '.release-lab', prefix='privacy-test-', suffix='.env') as private_env:
                os.fchmod(private_env.fileno(), 0o600)
                private_env.write(''.join(key + '=' + value + '\n' for key, value in environment.items()))
                private_env.flush()
                run(['docker', 'create', '--name', runner, '--network', network, '--workdir', temporary_root, '--env-file', private_env.name, '--entrypoint', entrypoint, prototype['Image'], *command])
            try:
                for source, target in files:
                    run(['docker', 'cp', str(source), runner + ':' + target])
                try:
                    result = run(['docker', 'start', '-a', runner])
                except subprocess.CalledProcessError as error:
                    log = ROOT / '.release-lab/privacy-last-failure.log'
                    log.write_bytes((error.stdout or b'') + (error.stderr or b''))
                    log.chmod(0o600)
                    raise
                print(result.stdout.decode().strip(), flush=True)
                state = json.loads(run(['docker', 'inspect', runner]).stdout)[0]['State']
                if state['ExitCode'] != 0:
                    print(result.stderr.decode(errors='replace'), flush=True)
                    raise RuntimeError(f'{service} privacy checks failed with exit {state["ExitCode"]}')
            finally:
                run(['docker', 'rm', '-f', runner])

        print('Running frontend grant and aggregate checks against PostgreSQL', flush=True)
        test_runner('app', 'node', [temporary_root + '/check.cjs'], [(bundle, temporary_root + '/check.cjs')])
        if not args.frontend_only:
            print('Running backend API and personal Up-connection checks', flush=True)
            test_runner('backend', 'python', [temporary_root + '/check.py'], [
                (ROOT / 'backend/app', temporary_root + '/app'),
                (ROOT / 'backend/tests/household_privacy_integration.py', temporary_root + '/check.py'),
                (ROOT / 'backend/tests/up_canonical_integration.py', temporary_root + '/up_canonical_integration.py'),
                (ROOT / 'backend/celery_app.py', temporary_root + '/celery_app.py'),
                (ROOT / 'backend/tasks', temporary_root + '/tasks'),
            ])
        if args.backend_regressions:
            print('Running backend regression suite in an ephemeral container', flush=True)
            test_runner('backend', 'python', [temporary_root + '/run-regressions.py'], [
                (ROOT / 'backend/app', temporary_root + '/app'),
                (ROOT / 'backend/tests/run_household_regressions.py', temporary_root + '/run-regressions.py'),
                (ROOT / 'backend/tests', temporary_root + '/regression-tests'),
                (ROOT / 'backend/celery_app.py', temporary_root + '/celery_app.py'),
                (ROOT / 'backend/tasks', temporary_root + '/tasks'),
            ])
        print('Privacy integration checks passed', flush=True)
    except subprocess.CalledProcessError as error:
        # These commands never receive secrets on their command line or print credentials.
        print(error.stdout.decode(errors='replace') if isinstance(error.stdout, bytes) else error.stdout or '', flush=True)
        print(error.stderr.decode(errors='replace') if isinstance(error.stderr, bytes) else error.stderr or '', flush=True)
        raise
    finally:
        print('Removing only the disposable test database', flush=True)
        sql(source_database, f'DROP DATABASE {dbname} WITH (FORCE)')


if __name__ == '__main__':
    main()
