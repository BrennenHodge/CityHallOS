"""Shared helpers for the City Hall OS scripts: reading the access code and calling the API."""
import json, re, urllib.error, urllib.request
from pathlib import Path

PLATFORM = Path(__file__).resolve().parent.parent
PRODUCTION = 'app.cityhallos.com'


def read_vars(path):
    """KEY=value lines from a .dev.vars file."""
    out = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        m = re.match(r'\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$', line)
        if m: out[m.group(1)] = m.group(2)
    return out


def read_key(path):
    """The operator access code, from a key file or from ADMIN_KEY in a .dev.vars file."""
    p = Path(path)
    return read_vars(p)['ADMIN_KEY'] if p.name == '.dev.vars' else p.read_text(encoding='utf-8').strip()


class Api:
    def __init__(self, origin, key=None, opener=None):
        self.origin = origin.rstrip('/')
        self.key = key
        self.opener = opener or urllib.request.build_opener()

    def call(self, method, path, body=None, headers=None, timeout=300):
        h = {'User-Agent': 'CityHallOS-scripts/1.0', **(headers or {})}
        if self.key: h['Authorization'] = f'Bearer {self.key}'
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.origin + '/api' + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            raw = e.read()
            try: return e.code, json.loads(raw or b'{}')
            except ValueError: return e.code, {'error': raw[:300].decode(errors='replace')}
