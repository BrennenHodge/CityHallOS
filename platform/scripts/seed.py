"""Load the Wiggins research pack and crawl into the City Hall OS knowledge base.

Usage: python -I seed.py <api_base> <key_file> <data_dir> <pack_dir>
"""
import json, re, sys, uuid, urllib.request, csv
from pathlib import Path

API, KEY_FILE, DATA, PACK = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
KEY = KEY_FILE.read_text().strip()
BASE = 'https://www.cityofwiggins.gov'


def call(method, path, body=None, files=None, fields=None):
    headers = {'Authorization': f'Bearer {KEY}', 'User-Agent': 'CityHallOS-seed/1.0'}
    data = None
    if files is not None:
        b = uuid.uuid4().hex
        parts = []
        for k, v in (fields or {}).items():
            if v is None: continue
            parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for name, (fn, content, ctype) in files.items():
            parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{name}"; filename="{fn}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + content + b'\r\n')
        parts.append(f'--{b}--\r\n'.encode())
        data = b''.join(parts)
        headers['Content-Type'] = f'multipart/form-data; boundary={b}'
    elif body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return {'error': f'{e.code} {e.read()[:300]!r}'}


def report(res, label):
    for d in res.get('documents', []) or [res]:
        print(f"{d.get('status', 'ERR'):8} {d.get('chunks', 0):4} chunks  {label[:70]}  {d.get('error') or res.get('error') or ''}")


# Remove anything already loaded, so the seed can be re-run.
for d in call('GET', '/documents').get('documents', []):
    call('DELETE', f"/documents/{d['id']}")

PAGE_CATS = {
    'City Hall & Government': ['1', '9', '27', '142', '146', '193', '194', '195', '196', '197', '206', '226', '230', '232', 'Directory', 'm'],
    'City Services': ['31', '199'],
    'Public Safety': ['200', '204'],
    'Municipal Court': ['203'],
    'Permits & Forms': ['201'],
    'Utilities & Payments': ['144', '211', '227'],
    'Parks & Community': ['198', '202', '219'],
    'Economic Development': ['205', '207', '208', '209'],
    'Planning & Zoning': ['218'],
}
NOISE = re.compile(r'^(>|Directory|Directions|-|##|OK|Arrow Left|Arrow Right)$|Training|Patti Plus|John Smith|785-587-1853|123-456-7890|Assistant Administrator|email.protected|Slideshow')


def page_category(path):
    head = path.strip('/').split('/')[0].replace('.aspx', '')
    for cat, keys in PAGE_CATS.items():
        if head in keys: return cat
    return 'Community'


# 1. City website pages.
for f in sorted((DATA / 'pages').glob('*.json')):
    p = json.loads(f.read_text(encoding='utf-8'))
    lines = [l for l in p['text'].split('\n') if not NOISE.search(l.strip())]
    text = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()
    title = re.sub(r'\s*[•|].*$', '', p['title']).strip()
    if title.lower() in ('staff directory', 'city directory') or p['path'] in ('/Directory.aspx', '/m/directory'):
        title = 'City staff directory'
    if len(text) < 120: print('skip short page', p['path']); continue
    text = f"# {title}\n\nCity of Wiggins website page: {p['url']}\n\n{text}"
    report(call('POST', '/documents', {'title': f'{title} (city website)', 'text': text, 'category': page_category(p['path']),
                                       'source_url': p['url'], 'authority': 'official-city', 'as_of': 'Website, Oct 2026'}), title)

# 2. Official PDFs.
sources = {r['url']: r for r in csv.DictReader((PACK / 'sources.csv').open(encoding='utf-8'))}
manifest = json.loads((DATA / 'manifest.json').read_text())
PDF_CATS = {72: 'Planning & Zoning', 73: 'Planning & Zoning', 74: 'Planning & Zoning', 75: 'Permits & Forms', 221: 'Utilities & Payments',
            302: 'Utilities & Payments', 232: 'Plans & Studies', 242: 'Plans & Studies'}
PDF_DATES = {221: '2016 report', 302: '2024 report (released 2025)', 232: '2006', 242: '2006', 292: 'Rev. Aug 2022', 296: 'Rev. Jan 2021',
             299: 'Rev. Jun 2022', 294: '2018'}
for f in manifest['files']:
    i = f['id']
    if not str(f['file']).endswith('.pdf') or not isinstance(i, int) or i == 250: continue
    url = f['url']
    src = sources.get(url, {})
    title = src.get('title') or f['name'].replace(' PDF', '').strip()
    cat = PDF_CATS.get(i, 'Permits & Forms')
    tx = DATA / 'transcripts' / f'doc-{i}.md'
    fields = {'title': title, 'category': cat, 'source_url': url, 'authority': 'official-city', 'as_of': PDF_DATES.get(i),
              'notes': src.get('summary') or None, 'text': tx.read_text(encoding='utf-8') if tx.exists() else None}
    content = (DATA / f['file']).read_bytes()
    report(call('POST', '/documents', files={'file': (f'{re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")}.pdf', content, 'application/pdf')}, fields=fields), title)

# 3. State audits.
for fn, title, url, asof in [
    ('audit-2024.pdf', 'FY2024 City of Wiggins audited financial statements (State Auditor)', 'https://www.osa.ms.gov/sites/default/files/osa/files/reports/24m2024%20Wiggins-cpa.pdf', 'FY2024'),
    ('audit-2023.pdf', 'FY2023 City of Wiggins audited financial statements (State Auditor)', 'https://www.osa.ms.gov/sites/default/files/osa/files/reports/23m2023%20Wiggins-cpa.pdf', 'FY2023'),
]:
    p = DATA / 'files' / fn
    if p.exists():
        report(call('POST', '/documents', files={'file': (fn, p.read_bytes(), 'application/pdf')},
                    fields={'title': title, 'category': 'Budget & Finance', 'source_url': url, 'authority': 'state-public-record', 'as_of': asof}), title)

# 4. Code of Ordinances index (links only; Municode's compilation is not copied).
chapters = [json.loads(l) for l in (PACK / 'sources.jsonl').open(encoding='utf-8') if '"ordinance_chapter"' in l]
code = ['# City of Wiggins Code of Ordinances: chapter index',
        'The official Code of Ordinances is published online by Municode at https://library.municode.com/ms/wiggins. '
        'The online code is codified through the ordinance of June 18, 2015 (online supplement May 2016). Ordinances adopted after that date '
        'may not appear yet, so confirm current law with the City Clerk at City Hall (601-928-7221).',
        'Appendix A is the 2013 Land Development Code, covering zoning districts and the use table, permitting and review procedures, '
        'variances, conditional uses, floodplain management, inspections, signs, subdivisions and site plans.', '## Chapters']
code += [f"- {c['title'].replace(chr(8212), '-').replace('—', '-')}" for c in chapters]
report(call('POST', '/documents', {'title': 'Code of Ordinances: chapter index and how to read the code', 'text': '\n'.join(code),
                                   'category': 'Ordinances & Code', 'source_url': 'https://library.municode.com/ms/wiggins',
                                   'authority': 'official-third-party', 'as_of': 'Codified through Jun 18, 2015'}), 'Code index')

# 5. Curated research cards.
for l in (PACK / 'knowledge_cards.jsonl').open(encoding='utf-8'):
    c = json.loads(l)
    text = f"# {c['title']}\n\nTopic: {c['category']}\n\n{c['text']}\n\nSources: " + ', '.join(c['source_urls'])
    report(call('POST', '/documents', {'title': c['title'], 'text': text, 'category': 'Research notes', 'authority': 'curated-research',
                                       'source_url': c['source_urls'][0] if c['source_urls'] else None, 'as_of': c.get('verified_as_of')}), c['title'])

# 6. Permit workflows (staff-facing checklists).
wf = json.loads((PACK / 'permit_workflows.json').read_text(encoding='utf-8'))
for w in wf:
    fmt = lambda xs: '\n'.join(f'- {x.replace("_", " ")}' for x in xs)
    text = (f"# Permit workflow: {w['name']}\n\n## Information to collect from the applicant\n{fmt(w.get('fields', []))}\n\n"
            f"## What the AI City Clerk can do\n{fmt(w.get('ai_tasks', []))}\n\n## Decisions only City staff can make\n{fmt(w.get('human_approvals', []))}\n\n"
            f"## Cautions\n{fmt(w.get('warnings', []))}")
    report(call('POST', '/documents', {'title': f"Permit workflow: {w['name']}", 'text': text, 'category': 'Permit workflows',
                                       'authority': 'curated-research', 'visibility': 'internal', 'as_of': '2026-10-30'}), w['name'])

# 7. Staff-only guidance from the research pack.
for fn, title in [('CITYHALLOS_AGENT_INSTRUCTIONS.md', 'AI answer rules for Wiggins (staff guidance)'),
                  ('CITY_VERIFICATION_REQUESTS.md', 'Documents to confirm with City officials before launch')]:
    report(call('POST', '/documents', {'title': title, 'text': (PACK / fn).read_text(encoding='utf-8'), 'category': 'Staff guidance',
                                       'authority': 'staff-note', 'visibility': 'internal', 'as_of': '2026-10-30'}), title)

# 8. Local news meeting recaps (unofficial).
for url, date in [('https://wigginsms.com/news/city-of-wiggins-board-of-aldermen-recap-august-18-2026/', '2026-08-18'),
                  ('https://wigginsms.com/civic-notes/wiggins-board-of-aldermen-recap-september-1-2026/', '2026-09-01'),
                  ('https://wigginsms.com/civic-notes/city-of-wiggins-board-of-aldermen-recap-october-6-2026/', '2026-10-06')]:
    title = f'Board of Aldermen meeting recap, {date} (WigginsMS.com news, unofficial)'
    report(call('POST', '/documents', {'url': url, 'title': title, 'category': 'Meetings & Minutes', 'authority': 'media-report', 'as_of': date}), title)

print('done')
