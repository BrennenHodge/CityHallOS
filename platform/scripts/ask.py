# Ask the AI City Clerk questions from the command line.
# Usage: python -I ask.py https://app.cityhallos.com/api/wiggins "Question one" "Question two"
import json, sys, urllib.request
api = sys.argv[1]
for q in sys.argv[2:]:
    req = urllib.request.Request(api + '/chat', data=json.dumps({'message': q}).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'ask/1'})
    out, meta, done = '', None, None
    with urllib.request.urlopen(req, timeout=120) as r:
        ev = None
        for line in r.read().decode().split('\n'):
            if line.startswith('event:'): ev = line[6:].strip()
            elif line.startswith('data:'):
                d = json.loads(line[5:])
                if ev == 'delta': out += d['t']
                elif ev == 'meta': meta = d
                elif ev == 'done': done = d
    print('Q:', q); print('A:', out.strip()); print('   sources:', [s['title'][:40] for s in (meta or {}).get('sources', [])][1:4], 'flags:', (done or {}).get('flags')); print()
