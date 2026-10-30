"""Rebuild local development data from scratch.

Usage (from the project folder, with the local server stopped):
  python -I platform/scripts/dev_reset.py

Wipes platform/.wrangler/state, creates the platform database, adds every city in platform/cities/,
loads each city's knowledge base from platform/seed-data/, and creates a local administrator from
DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD in platform/.dev.vars. No live data is copied.
"""
import json, os, shutil, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chos import PLATFORM, Api, read_vars  # noqa: E402

PORT = int(os.environ.get('CHOS_PORT', 8787))  # another port when several checkouts run at once
ORIGIN = f'http://127.0.0.1:{PORT}'
DEV_VARS = PLATFORM / '.dev.vars'


def port_open():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', PORT)) == 0


def run(cmd):
    subprocess.run(cmd, cwd=PLATFORM, shell=True, check=True, stdout=subprocess.DEVNULL)


if port_open():
    sys.exit(f'Something is running on port {PORT}. Stop the local server first, then run this again.')
if not DEV_VARS.exists():
    shutil.copy(PLATFORM / '.dev.vars.example', DEV_VARS)
    print('Created platform/.dev.vars from .dev.vars.example')
env = read_vars(DEV_VARS)
missing = [k for k in ('ADMIN_KEY', 'DEV_ADMIN_EMAIL', 'DEV_ADMIN_PASSWORD') if not env.get(k)]
if missing:
    sys.exit(f"Add {', '.join(missing)} to platform/.dev.vars (see .dev.vars.example).")

print('Wiping local data...')
shutil.rmtree(PLATFORM / '.wrangler' / 'state', ignore_errors=True)
run('npx wrangler d1 execute cityhallos --local --file schema.sql')

print('Starting a temporary local server...')
log = open(PLATFORM / '.wrangler' / 'dev_reset.log', 'w')
server = subprocess.Popen(f'npx wrangler dev --port {PORT} --inspector-port {PORT + 500}', cwd=PLATFORM, shell=True, stdout=log, stderr=subprocess.STDOUT)
try:
    for _ in range(90):
        try:
            urllib.request.urlopen(f'{ORIGIN}/api/auth/me', timeout=2)
        except urllib.error.HTTPError:
            break  # the API answered (401 when signed out)
        except OSError:
            time.sleep(1)
    else:
        sys.exit('The local server did not start. See platform/.wrangler/dev_reset.log')

    cities = sorted((PLATFORM / 'cities').glob('*.json'))
    for f in cities:
        subprocess.run([sys.executable, '-I', str(Path(__file__).parent / 'load_city.py'), ORIGIN, str(DEV_VARS), str(f)], check=True)

    # One local administrator with access to every city.
    api = Api(ORIGIN, env['ADMIN_KEY'])
    link = None
    for f in cities:
        slug = json.loads(f.read_text(encoding='utf-8'))['slug']
        status, res = api.call('POST', f'/{slug}/staff', {'name': 'Local Admin', 'title': 'Local development', 'email': env['DEV_ADMIN_EMAIL'], 'role': 'admin'})
        if status != 201:
            sys.exit(f"Could not add the local admin to {slug}: {res.get('error')}")
        link = res.get('setupUrl') or link
    if link:
        status, res = Api(ORIGIN).call('POST', '/auth/setup', {'token': link.split('/setup/')[1], 'password': env['DEV_ADMIN_PASSWORD']})
        if status != 200:
            sys.exit(f"Could not set the local admin's password: {res.get('error')}")
finally:
    if os.name == 'nt':
        subprocess.run(f'taskkill /T /F /PID {server.pid}', shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        server.terminate()
    log.close()

print(f"""
Local data is ready. Start the local server (npx wrangler dev in platform/) and open {ORIGIN}
  Staff sign-in:        {env['DEV_ADMIN_EMAIL']} with DEV_ADMIN_PASSWORD from platform/.dev.vars
  City Hall OS support: ADMIN_KEY from platform/.dev.vars""")
