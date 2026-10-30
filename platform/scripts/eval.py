"""Grade the AI City Clerk's answers against a set of resident questions.

Usage: python -I eval.py <origin> <key_file> <evals_json> [--out results.json] [--only N]
  python -I platform/scripts/eval.py http://127.0.0.1:8787 platform/.dev.vars platform/evals/wiggins.json

Each case passes when the answer cites an expected source (if any are listed), contains every "include"
phrase, contains no "exclude" phrase, and ends the expected way (answer, needs_staff, emergency or report).
Questions run as staff tests, so they don't show up in the city's conversations or results. Every run uses
the AI model, so it counts against the account's usage. Run it after changing prompts, retrieval or models.
"""
import json, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chos import read_key  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = {a.split('=')[0]: (a.split('=') + [''])[1] for a in sys.argv[1:] if a.startswith('--')}
if len(args) < 3:
    sys.exit(__doc__)
origin, key_file, evals_file = args[0].rstrip('/'), args[1], args[2]
out_file = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == '--out' and i + 1 < len(sys.argv)), None)
key = read_key(key_file)
suite = json.loads(Path(evals_file).read_text(encoding='utf-8'))
cases = suite['cases'][: int(opts['--only'])] if opts.get('--only') else suite['cases']


def ask(question):
    req = urllib.request.Request(f"{origin}/api/{suite['city']}/chat", data=json.dumps({'message': question, 'mode': 'eval'}).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}', 'User-Agent': 'CityHallOS-eval/1.0'})
    events = {}
    with urllib.request.urlopen(req, timeout=180) as res:
        for block in res.read().decode().split('\n\n'):
            lines = dict(l.split(': ', 1) for l in block.split('\n') if ': ' in l)
            if 'event' in lines:
                events.setdefault(lines['event'], []).append(json.loads(lines['data']))
    text = ''.join(d['t'] for d in events.get('delta', []))
    sources = (events.get('meta') or [{}])[0].get('sources', [])
    done = (events.get('done') or [{}])[0]
    return text, sources, done


def outcome(done):
    f = done.get('flags', {})
    return 'emergency' if f.get('emergency') else 'report' if done.get('reportType') else 'needs_staff' if f.get('needsStaff') else 'answer'


results = []
for i, c in enumerate(cases, 1):
    started = time.time()
    try:
        text, sources, done = ask(c['q'])
    except Exception as e:  # noqa: BLE001
        results.append({**c, 'pass': False, 'problems': [f'request failed: {e}']})
        print(f'ERR  {c["q"]}  ({e})')
        continue
    cited = [s['title'] for s in sources if s['n'] in set(done.get('cited', []))]
    low = text.lower()
    problems = []
    if c.get('sources') and not any(any(frag.lower() in t.lower() for t in cited) for frag in c['sources']):
        retrieved = [s['title'] for s in sources if s['n'] > 1]
        found = any(any(frag.lower() in t.lower() for t in retrieved) for frag in c['sources'])
        problems.append('expected source ' + ('retrieved but not cited' if found else 'not retrieved'))
    problems += [f'missing "{p}"' for p in c.get('include', []) if p.lower() not in low]
    problems += [f'said "{p}"' for p in c.get('exclude', []) if p.lower() in low]
    got = outcome(done)
    if c.get('expect') and got != c['expect']:
        problems.append(f'ended as {got}, expected {c["expect"]}')
    ok = not problems
    results.append({**c, 'pass': ok, 'problems': problems, 'outcome': got, 'cited': cited, 'answer': text, 'seconds': round(time.time() - started, 1)})
    print(f"{'PASS' if ok else 'FAIL'} {c['q'][:70]:70}  {'; '.join(problems)}")

passed = sum(r['pass'] for r in results)
print(f'\n{passed} of {len(results)} passed ({round(100 * passed / max(1, len(results)))}%)')
if out_file:
    Path(out_file).write_text(json.dumps({'origin': origin, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'passed': passed, 'total': len(results), 'results': results}, indent=2), encoding='utf-8')
    print(f'Wrote {out_file}')
