"""Crawl public City of Wiggins web pages and Document Center files.

Usage: python -I crawl.py <out_dir> <pack_dir>
Writes <out_dir>/pages/*.json, <out_dir>/files/*.pdf and <out_dir>/manifest.json.
"""
import json, re, sys, time, urllib.request, urllib.error, html
from html.parser import HTMLParser
from pathlib import Path

OUT = Path(sys.argv[1]); PACK = Path(sys.argv[2])
(OUT / 'pages').mkdir(parents=True, exist_ok=True); (OUT / 'files').mkdir(exist_ok=True)
BASE = 'https://www.cityofwiggins.gov'
UA = 'Mozilla/5.0 (CityHallOS knowledge import; public documents)'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url, follow=True):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=40) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), b''
    except Exception as e:  # noqa: BLE001
        print('ERR', url, e)
        return 0, {}, b''


class TextOf(HTMLParser):
    """Collect visible text from the CivicPlus content area, keeping block breaks."""
    SKIP = {'script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'form', 'select', 'button'}
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table'}

    def __init__(self):
        super().__init__(); self.out = []; self.skip = 0; self.links = []; self.title = ''; self._t = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP: self.skip += 1
        if tag == 'title': self._t = True
        if tag == 'a' and a.get('href'): self.links.append(a['href'])
        if tag in self.BLOCK: self.out.append('\n')
        if tag in ('h1', 'h2', 'h3') and not self.skip: self.out.append('## ')
        if tag == 'li' and not self.skip: self.out.append('- ')

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip: self.skip -= 1
        if tag == 'title': self._t = False
        if tag in self.BLOCK: self.out.append('\n')

    def handle_data(self, d):
        if self._t: self.title += d
        if not self.skip: self.out.append(d)

    def text(self):
        t = html.unescape(''.join(self.out))
        t = re.sub(r'[ \t\r\f\v]+', ' ', t)
        t = re.sub(r'\n\s*\n+', '\n\n', t)
        return '\n'.join(l.strip() for l in t.split('\n')).strip()


def main_html(raw):
    s = raw.decode('utf-8', 'replace')
    # CivicPlus pages put the page body between these markers.
    m = re.search(r'id="moduleContent"(.*?)(id="footer"|class="siteFooter"|<footer)', s, re.S)
    return (m.group(1) if m else s), s


manifest = {'pages': [], 'files': []}
seen_docs = set()

# 1. Pages from the site map, plus pages listed in the research pack.
_, _, sm = get(BASE + '/sitemap')
paths = set(re.findall(r'href="(/\d+/[^"#?]+)"', sm.decode('utf-8', 'replace')))
paths |= {'/Directory.aspx', '/m/directory'}
for line in (PACK / 'source_urls.txt').read_text(encoding='utf-8').split():
    if line.startswith(BASE) and 'DocumentCenter' not in line:
        p = line[len(BASE):] or '/'
        if p not in ('/', '/sitemap'): paths.add(p)
paths.add('/1/Home')

for p in sorted(paths):
    st, hd, body = get(BASE + p)
    if st != 200 or not body: print('skip page', st, p); continue
    frag, full = main_html(body)
    tp = TextOf(); tp.feed(frag)
    tt = TextOf(); tt.feed(full)
    title = re.sub(r'\s*\|.*$', '', tt.title.strip()) or p
    txt = tp.text()
    for href in set(tt.links):
        m = re.search(r'/DocumentCenter/View/(\d+)', href)
        if m: seen_docs.add(int(m.group(1)))
    slug = re.sub(r'[^a-zA-Z0-9]+', '-', p).strip('-') or 'home'
    rec = {'path': p, 'url': BASE + p, 'title': title, 'text': txt}
    (OUT / 'pages' / f'{slug}.json').write_text(json.dumps(rec, ensure_ascii=False), encoding='utf-8')
    manifest['pages'].append({'path': p, 'title': title, 'chars': len(txt), 'file': f'pages/{slug}.json'})
    print('page', p, title, len(txt))
    time.sleep(0.4)

# 2. Probe the Document Center for every public file id.
for i in range(1, 460):
    st, hd, _ = get(f'{BASE}/DocumentCenter/View/{i}', follow=False)
    loc = hd.get('location') or hd.get('Location') or ''
    if st in (301, 302) and '/DocumentCenter/View/' in loc:
        seen_docs.add(i)
    time.sleep(0.15)
print('doc ids', sorted(seen_docs))

for i in sorted(seen_docs):
    st, hd, _ = get(f'{BASE}/DocumentCenter/View/{i}', follow=False)
    loc = hd.get('location') or hd.get('Location') or f'/DocumentCenter/View/{i}'
    name = re.sub(r'\?.*$', '', loc.rsplit('/', 1)[-1]).replace('-', ' ').strip() or f'Document {i}'
    st, hd, body = get(BASE + loc if loc.startswith('/') else loc)
    ctype = (hd.get('Content-Type') or hd.get('content-type') or '').lower()
    if st != 200 or not body: print('fail doc', i, st); continue
    ext = 'pdf' if body[:4] == b'%PDF' else ('jpg' if 'jpeg' in ctype else 'png' if 'png' in ctype else 'docx' if 'officedocument.word' in ctype else 'bin')
    fn = f'doc-{i}.{ext}'
    (OUT / 'files' / fn).write_bytes(body)
    manifest['files'].append({'id': i, 'name': name, 'url': f'{BASE}/DocumentCenter/View/{i}', 'file': f'files/{fn}', 'bytes': len(body), 'type': ctype})
    print('file', i, name, ext, len(body))
    time.sleep(0.4)

# 3. State and county PDFs named in the pack (audits, county handouts).
import csv
with (PACK / 'sources.csv').open(encoding='utf-8', newline='') as f:
    for r in csv.DictReader(f):
        if r['format'] != 'pdf' or 'cityofwiggins.gov' in r['url']: continue
        st, hd, body = get(r['url'])
        if st == 200 and body[:4] == b'%PDF':
            fn = f"{r['id']}.pdf"; (OUT / 'files' / fn).write_bytes(body)
            manifest['files'].append({'id': r['id'], 'name': r['title'], 'url': r['url'], 'file': f'files/{fn}', 'bytes': len(body), 'type': 'application/pdf'})
            print('ext file', r['id'], r['title'], len(body))
        else:
            print('ext fail', st, r['url'])
        time.sleep(1)

(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
print('done', len(manifest['pages']), 'pages', len(manifest['files']), 'files')
