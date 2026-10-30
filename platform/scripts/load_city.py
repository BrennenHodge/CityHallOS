"""Add a city to a City Hall OS environment and load its knowledge base.

Usage: python -I load_city.py <origin> <key_file> <city_json> [--replace-knowledge]
  origin       http://127.0.0.1:8787, https://staging.cityhallos.com or https://app.cityhallos.com
  key_file     a file holding that environment's access code, or platform/.dev.vars for local
  city_json    e.g. platform/cities/wiggins.json

Creates the city if it doesn't exist yet. If seed data exists in platform/seed-data/<slug>/ (data/ from
crawl.py and pack/ from the research pack), loads it into a city with an empty knowledge base. A city that
already has documents is left alone unless --replace-knowledge is given, because seeding replaces every document.
"""
import json, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chos import PLATFORM, Api, read_key  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith('--')]
if len(args) != 3:
    sys.exit(__doc__)
origin, key_file, city_file = args
replace = '--replace-knowledge' in sys.argv
city = json.loads(Path(city_file).read_text(encoding='utf-8'))
api = Api(origin, read_key(key_file))

status, existing = api.call('GET', '/platform/cities')
if status != 200:
    sys.exit(f'Could not sign in to {origin}: {existing.get("error")}')
if any(c['slug'] == city['slug'] for c in existing['cities']):
    print(f"{city['name']} already exists on {origin}")
else:
    status, res = api.call('POST', '/platform/cities', {**city, 'status': 'active'})
    if status != 201:
        sys.exit(f"Could not add {city['name']}: {res.get('error')}")
    print(f"Added {city['name']} ({res['city']['id']}) on {origin}")

seed = PLATFORM / 'seed-data' / city['slug']
if not (seed / 'data').exists() or not (seed / 'pack').exists():
    print(f'No seed data in {seed}, so the knowledge base was not loaded.')
    sys.exit(0)
_, docs = api.call('GET', f"/{city['slug']}/documents")
if docs.get('documents') and not replace:
    print(f"{len(docs['documents'])} documents already loaded. Pass --replace-knowledge to reload them.")
    sys.exit(0)
print(f'Loading the knowledge base from {seed}...')
subprocess.run([sys.executable, '-I', str(Path(__file__).parent / 'seed.py'), f"{origin.rstrip('/')}/api/{city['slug']}",
                key_file, str(seed / 'data'), str(seed / 'pack')], check=True)
