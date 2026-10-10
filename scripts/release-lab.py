#!/usr/bin/env python3
"""Isolated source-build UAT and upgrade rehearsal; secrets stay in .release-lab/."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.release-lab'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args):
    return subprocess.check_output(args, text=True).strip()


def save(name, data):
    path = STATE / name
    with open(path, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as f:
        f.write(data)


def logged(name, args):
    print(f'Running {name}; log: {STATE / name}', flush=True)
    with open(STATE / name, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as f:
        run(args, stdout=f, stderr=subprocess.STDOUT)


def compose(*args):
    return ['docker', 'compose', '-p', 'syllogic-release-lab', '-f', str(STATE / 'compose.json'), *args]


def env_of(container):
    obj = json.loads(output(['docker', 'inspect', container]))[0]
    return dict(x.split('=', 1) for x in obj['Config']['Env'])


def sql(container, query):
    return output(['docker', 'exec', container, 'sh', '-c',
                   'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"', 'sh', query])


def snapshot(container):
    result = {}
    for table in ['users', 'auth_accounts', 'accounts', 'transactions', 'holdings', 'broker_trades']:
        cols = sql(container, "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) "
                   f"FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}'")
        if cols:
            rows = sql(container, f'SELECT row_to_json(t)::text FROM (SELECT {cols} FROM "{table}") t ORDER BY row_to_json(t)::text')
            result[table] = {'columns': cols, 'sha256': hashlib.sha256(rows.encode()).hexdigest(),
                             'count': sql(container, f'SELECT count(*) FROM "{table}"')}
    return result


def prepare(args):
    if (STATE / 'compose.json').exists():
        raise SystemExit('Lab already prepared; use up/verify. Use a separate checkout for a new rehearsal.')
    STATE.mkdir(mode=0o700, exist_ok=True)
    source = env_of(args.source_app)
    if not source.get('BETTER_AUTH_SECRET'):
        raise SystemExit('Source BETTER_AUTH_SECRET is required to decrypt restored JWKS signing keys.')
    password = secrets.token_urlsafe(24)
    env = {'POSTGRES_PASSWORD': password, 'DATABASE_URL': f'postgresql://financeuser:{password}@postgres:5432/finance_db',
           'BETTER_AUTH_SECRET': source['BETTER_AUTH_SECRET'], 'INTERNAL_AUTH_SECRET': secrets.token_urlsafe(32),
           'APP_URL': f'http://localhost:{args.port}', 'HTTP_PORT': str(args.port)}
    for key in ['DATA_ENCRYPTION_KEY_CURRENT', 'DATA_ENCRYPTION_KEY_PREVIOUS', 'DATA_ENCRYPTION_KEY_ID']:
        env[key] = source.get(key, '')
    save('.env', ''.join(f'{k}={v}\n' for k, v in env.items()))
    command = ['docker', 'compose', '--env-file', str(STATE / '.env'), '-f', str(ROOT / 'deploy/compose/docker-compose.yml'),
               '-f', str(ROOT / 'deploy/compose/docker-compose.local.yml'), 'config', '--format', 'json']
    config = json.loads(output(command))
    config['name'] = 'syllogic-release-lab'
    # No workers or scheduler: restored bank credentials must never trigger sync.
    config['services'] = {k: v for k, v in config['services'].items() if k in ['postgres', 'redis', 'uploads-init', 'migrate', 'backend', 'app']}
    for name, service in config['services'].items():
        service.pop('container_name', None)
        service.pop('ports', None)
        service['restart'] = 'no'
        if name in ['app', 'migrate']:
            service['image'] = 'syllogic-release-lab-frontend:local'
        elif name == 'backend':
            service['image'] = 'syllogic-release-lab-backend:local'
    config['services']['app']['ports'] = [f'127.0.0.1:{args.port}:3000']
    # Compose config expands volume names; explicitly isolate them as well.
    for key, volume in config['volumes'].items():
        volume['name'] = f'syllogic-release-lab_{key}'
    for key, network in config.get('networks', {}).items():
        network['name'] = f'syllogic-release-lab_{key}'
    save('compose.json', json.dumps(config, indent=2))
    before = snapshot(args.source_db)
    save('before.json', json.dumps(before, indent=2))
    dump = STATE / 'source.dump'
    with open(dump, 'wb', opener=lambda p, f: os.open(p, f, 0o600)) as f:
        run(['docker', 'exec', args.source_db, 'sh', '-c', 'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"'], stdout=f)
    save('manifest.json', json.dumps({'source_db': args.source_db, 'source_app': args.source_app,
         'candidate': output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']), 'port': args.port}, indent=2))
    print('Prepared isolated lab and database backup. Run up next.')


def restore():
    run(compose('up', '-d', '--wait', 'postgres', 'redis'))
    if not (STATE / 'restored').exists():
        with (STATE / 'source.dump').open('rb') as f:
            run(compose('exec', '-T', 'postgres', 'sh', '-c',
                'exec pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"'), stdin=f)
        save('restored', 'yes\n')


def up():
    logged('build.log', compose('build', 'app', 'backend'))
    restore()
    logged('migration-first.log', compose('run', '--rm', 'migrate'))
    logged('migration-second.log', compose('run', '--rm', 'migrate'))
    run(compose('up', '-d', '--wait', 'backend', 'app'))
    if (STATE / 'test-accounts.json').exists():
        print('Test accounts already present; retaining the pre-test preservation report. Rehearse from a fresh backup for new release evidence.')
    else:
        verify()
    save('runtime.json', json.dumps({'mode': 'source-build',
         'revision': output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'])}, indent=2))


def rehearse(cached_image):
    """Exercise candidate SQL with a cached Node runtime when builds are blocked."""
    restore()
    config = json.loads((STATE / 'compose.json').read_text())
    service = config['services']['migrate']
    service['image'] = cached_image
    service['volumes'] = [f'{ROOT}/frontend/scripts:/app/scripts:ro',
                          f'{ROOT}/frontend/lib/db/migrations:/app/lib/db/migrations:ro']
    save('migration-only.json', json.dumps(config, indent=2))
    command = ['docker', 'compose', '-p', 'syllogic-release-lab', '-f', str(STATE / 'migration-only.json'),
               'run', '--rm', '--no-deps', 'migrate']
    logged('migration-first.log', command)
    logged('migration-second.log', command)
    verify()
    print('Migration-only rehearsal passed; this does not certify a candidate application build.')


def verify():
    db = output(compose('ps', '-q', 'postgres'))
    before = json.loads((STATE / 'before.json').read_text())
    report = {}
    for table, expected in before.items():
        cols = expected['columns']
        rows = sql(db, f'SELECT row_to_json(t)::text FROM (SELECT {cols} FROM "{table}") t ORDER BY row_to_json(t)::text')
        report[table] = {'preserved': hashlib.sha256(rows.encode()).hexdigest() == expected['sha256'],
                         'before': expected['count'], 'after': sql(db, f'SELECT count(*) FROM "{table}"')}
    save('verification.json', json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if not all(x['preserved'] for x in report.values()):
        raise SystemExit('Existing values changed: review verification.json before promotion.')


def accounts():
    credentials = STATE / 'test-accounts.json'
    accounts = json.loads(credentials.read_text()) if credentials.exists() else [
                {'email': 'demo-uat@example.test', 'name': 'UAT Demo', 'password': secrets.token_urlsafe(20)},
                {'email': 'fresh-uat@example.test', 'name': 'UAT Fresh', 'password': secrets.token_urlsafe(20)}]
    save('test-accounts.json', json.dumps(accounts, indent=2))
    # Use the app container to avoid a dependency on host HTTP tooling.
    for account in accounts:
        js = """let s='';for await(const c of process.stdin)s+=c;
        const options={method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.APP_URL},body:s};
        async function request(path){for(let i=0;i<4;i++){
          const r=await fetch('http://localhost:3000/api/auth/'+path,options);
          if(r.status!==429 || i===3)return r;
          const delay=Math.min(60,Math.max(10,Number(r.headers.get('retry-after'))||10));
          console.log('Waiting for auth rate limit',delay,'seconds');
          await new Promise(resolve=>setTimeout(resolve,delay*1000));
        }}
        let r=await request('sign-in/email');
        if(r.ok)process.exit(0);
        r=await request('sign-up/email');
        if(!r.ok){console.error('Account preparation failed',r.status);process.exit(1)}
        r=await request('sign-in/email');
        if(!r.ok){console.error('Login verification failed',r.status);process.exit(1)}"""
        run(compose('exec', '-T', 'app', 'node', '--input-type=module', '-e', js), input=json.dumps(account), text=True)
    if not (STATE / 'demo-seeded').exists():
        if (STATE / 'seed-started').exists():
            raise SystemExit('Prior seed did not complete. Inspect seed.log before retrying to avoid duplicates.')
        save('seed-started', 'yes\n')
        logged('seed.log', compose('exec', '-T', 'backend', 'python', 'postgres_migration/seed_demo_data.py',
                    '--user-email', accounts[0]['email'], '--mode', 'seed'))
        save('demo-seeded', 'yes\n')
    smoke()
    print('Prepared populated and fresh accounts. Credentials: .release-lab/test-accounts.json')


def cached_bootstrap():
    """Prepare accounts only; deliberately not candidate UI acceptance."""
    config = json.loads((STATE / 'compose.json').read_text())
    for name in ['app', 'migrate']:
        config['services'][name]['image'] = 'syllogic-frontend:local'
        config['services'][name].pop('build', None)
        config['services'][name].setdefault('volumes', []).extend([
            f'{ROOT}/frontend/scripts:/app/scripts:ro',
            f'{ROOT}/frontend/lib/db/migrations:/app/lib/db/migrations:ro'])
    config['services']['backend']['image'] = 'syllogic-backend:local'
    config['services']['backend'].pop('build', None)
    save('bootstrap.json', json.dumps(config, indent=2))
    run(['docker', 'compose', '-p', 'syllogic-release-lab', '-f', str(STATE / 'bootstrap.json'),
         'up', '-d', '--wait', '--no-build', 'backend', 'app'])
    save('runtime.json', json.dumps({'mode': 'cached-bootstrap', 'candidate_ui_verified': False}, indent=2))
    print('Cached runtime started for account preparation only. Candidate UI has NOT been built.')


def repair_auth():
    """Preserve encrypted JWKS when repairing labs created with a new auth secret."""
    manifest = json.loads((STATE / 'manifest.json').read_text())
    secret = env_of(manifest['source_app']).get('BETTER_AUTH_SECRET')
    if not secret:
        raise SystemExit('Source auth secret unavailable; restore it from the matching backup.')
    for filename in ['compose.json', 'bootstrap.json', 'migration-only.json']:
        path = STATE / filename
        if path.exists():
            config = json.loads(path.read_text())
            config['services']['app']['environment']['BETTER_AUTH_SECRET'] = secret
            save(filename, json.dumps(config, indent=2))
    lines = (STATE / '.env').read_text().splitlines()
    save('.env', '\n'.join('BETTER_AUTH_SECRET=' + secret if line.startswith('BETTER_AUTH_SECRET=') else line for line in lines) + '\n')
    mode = json.loads((STATE / 'runtime.json').read_text())['mode']
    filename = 'bootstrap.json' if mode == 'cached-bootstrap' else 'compose.json'
    run(['docker', 'compose', '-p', 'syllogic-release-lab', '-f', str(STATE / filename),
         'up', '-d', '--no-deps', '--no-build', '--wait', 'app'])
    print('Matching auth secret restored. Sign in again if your browser has an old session cookie.')


def smoke():
    """Exercise cookie-authenticated rendering, not merely the sign-in API."""
    accounts = json.loads((STATE / 'test-accounts.json').read_text())
    js = """let input='';for await(const c of process.stdin)input+=c;
    const accounts=JSON.parse(input);
    for(const account of accounts){
      const login=await fetch('http://localhost:3000/api/auth/sign-in/email',{
        method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.APP_URL},body:JSON.stringify(account)});
      if(!login.ok)throw Error('Sign-in failed: '+login.status);
      const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
      if(!cookie)throw Error('Missing session cookie');
      const session=await fetch('http://localhost:3000/api/auth/get-session',{headers:{cookie}});
      const data=await session.json();
      if(!session.ok || data?.user?.email!==account.email)throw Error('Session verification failed');
      for(const path of account.email.startsWith('demo-')?['/','/transactions','/investments']:['/']){
        const r=await fetch('http://localhost:3000'+path,{headers:{cookie}});
        const html=await r.text();
        if(!r.ok || html.includes('3230111203') || html.includes('a server-side exception') || html.includes('NEXT_HTTP_ERROR_FALLBACK;500') || /\\"digest\\":\\"[0-9]+\\"/.test(html))throw Error('Authenticated render failed: '+path+' '+r.status);
        if(new URL(r.url).pathname==='/login')throw Error('Unexpected login redirect');
        console.log(account.email,path,r.status,new URL(r.url).pathname);
      }
    }"""
    run(compose('exec', '-T', 'app', 'node', '--input-type=module', '-e', js), input=json.dumps(accounts), text=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'up', 'rehearse', 'cached-bootstrap', 'repair-auth', 'smoke', 'verify', 'accounts', 'status', 'stop'])
    parser.add_argument('--cached-image', default='syllogic-frontend:local')
    parser.add_argument('--source-db', default='syllogic-postgres')
    parser.add_argument('--source-app', default='syllogic-app')
    parser.add_argument('--port', type=int, default=8088)
    args = parser.parse_args()
    if args.action == 'prepare': prepare(args)
    elif args.action == 'up': up()
    elif args.action == 'rehearse': rehearse(args.cached_image)
    elif args.action == 'cached-bootstrap': cached_bootstrap()
    elif args.action == 'repair-auth': repair_auth()
    elif args.action == 'smoke': smoke()
    elif args.action == 'verify': verify()
    elif args.action == 'accounts': accounts()
    elif args.action == 'status': run(compose('ps', '-a'))
    elif args.action == 'stop': run(compose('stop'))
