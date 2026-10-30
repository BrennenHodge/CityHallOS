"""Add past public meetings to a city's Meetings from the WigginsMS.com Civic Notes recaps.

Usage: python -I import_civic_notes.py <origin> <key_file> [--city wiggins] [--dry-run]
  python -I platform/scripts/import_civic_notes.py http://127.0.0.1:8793 platform/.dev.vars --dry-run
  python -I platform/scripts/import_civic_notes.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Reads every post in https://wigginsms.com/category/civic-notes/, keeps the meeting recaps (Board of Aldermen, Stone County
Board of Supervisors, School Board, Sheriff's Office town halls) and skips other articles. Each recap becomes a past
meeting with the full recap as its meeting notes, labeled as a WigginsMS.com account, not official minutes. County
bodies are added as another government's boards. Safe to run again: meetings are matched by board and date, and their
notes are replaced with the current text of the post.
"""
import argparse, html, re, sys, time, urllib.request
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chos import Api, read_key  # noqa: E402

SITE = 'https://wigginsms.com'
CATEGORY = f'{SITE}/category/civic-notes/'
SOURCE = 'WigginsMS.com Civic Notes'
UA = 'Mozilla/5.0 (CityHallOS meeting records import)'
MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'

# Which body a recap is about, from its title. Times and places are used when the recap doesn't state them.
BODIES = [
    (re.compile(r'aldermen', re.I), {'name': 'Board of Aldermen', 'kind': 'board', 'external': False, 'location': 'Wiggins City Hall', 'time': '17:00',
                                     'description': 'The Mayor and Board of Aldermen, the governing body of the City of Wiggins.'}),
    (re.compile(r'board of supervisors', re.I), {'name': 'Stone County Board of Supervisors', 'kind': 'board', 'external': True,
                                                 'location': 'Stone County Courthouse, Wiggins', 'time': '09:00',
                                                 'description': 'The governing body of Stone County. Meets in Wiggins, the county seat.'}),
    (re.compile(r'school board', re.I), {'name': 'Stone County School Board', 'kind': 'board', 'external': True, 'location': None, 'time': '18:00',
                                         'description': 'The board of the Stone County School District.'}),
    (re.compile(r'sheriff', re.I), {'name': "Stone County Sheriff's Office town halls", 'kind': 'other', 'external': True, 'location': None, 'time': '18:00',
                                    'description': "Community town hall meetings held by the Stone County Sheriff's Office."}),
]


def get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=40) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001
            if attempt == 2: raise
            print('  retrying', url, e)
            time.sleep(3)


class Markdown(HTMLParser):
    """A WordPress post body as Markdown: headings, paragraphs, lists and bold, which is what the minutes view reads."""
    SKIP = {'script', 'style', 'noscript', 'svg', 'figure', 'form', 'button', 'iframe'}
    BLOCK = {'p', 'div', 'ul', 'ol', 'table', 'tr', 'blockquote', 'section'}

    def __init__(self):
        super().__init__(convert_charrefs=True); self.out = []; self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP: self.skip += 1; return
        if self.skip: return
        if tag in ('h1', 'h2'): self.out.append('\n\n## ')
        elif tag in ('h3', 'h4', 'h5', 'h6'): self.out.append('\n\n### ')
        elif tag == 'li': self.out.append('\n- ')
        elif tag == 'br': self.out.append('\n')
        elif tag in ('strong', 'b'): self.out.append('**')
        elif tag in self.BLOCK: self.out.append('\n\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP: self.skip = max(0, self.skip - 1); return
        if self.skip: return
        if tag in ('strong', 'b'): self.out.append('**')
        elif tag in self.BLOCK or tag[:1] == 'h' and tag[1:].isdigit(): self.out.append('\n\n')

    def handle_data(self, d):
        if not self.skip: self.out.append(d.replace('\xa0', ' '))

    def text(self):
        t = re.sub(r'[ \t]+', ' ', ''.join(self.out))
        lines = []
        for line in re.sub(r' *\n *', '\n', t).split('\n'):
            # Bold that WordPress opened in one block and closed in another leaves stray markers; headings need none.
            if line.startswith('#') or line.count('**') % 2:
                line = line.replace('**', '')
            line = re.sub(r'\*\*(\s*)(.+?)(\s*)\*\*', r'\1**\2**\3', line).replace('****', '')
            lines.append(line.rstrip())
        return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()


def posts():
    """Every post in the category, newest first: (title, url)."""
    out, page, url = [], 1, CATEGORY
    while url:
        doc = get(url)
        main = doc.split('<!-- .cm-posts -->')[0]
        for article in re.findall(r'<article\b.*?</article>', main, re.S):
            m = re.search(r'<h[1-6][^>]*>\s*<a href="(https://wigginsms\.com/[^"]+)"[^>]*>(.*?)</a>', article, re.S)
            if m: out.append((html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip(), m.group(1)))
        page += 1
        url = f'{CATEGORY}page/{page}/' if f'/category/civic-notes/page/{page}/' in doc else None
    return list(dict.fromkeys(out))


def read_post(url):
    doc = get(url)
    m = re.search(r'<div class="cm-entry-summary">(.*?)</article>', doc, re.S) or re.search(r'<article\b.*?>(.*?)</article>', doc, re.S)
    p = Markdown(); p.feed(m.group(1) if m else ''); body = p.text()
    published = (re.search(r'<time[^>]*datetime="(\d{4}-\d{2}-\d{2})', doc) or [None, None])[1]
    return body, published


def meeting_of(title, url, body, published):
    """Board, kind, local start time and place, or None if the post isn't a meeting recap."""
    head = body[:600]
    body_def = next((d for rx, d in BODIES if rx.search(title)), None)
    if not body_def: return None
    if not re.search(r'meeting|recap|town hall|aldermen|supervisors|school board', title, re.I): return None
    words = f'{title} {head[:200]}'.lower()
    kind = 'community' if 'town hall' in words else 'special' if 'special meeting' in words else 'work_session' if re.search(r'work ?session|workshop', words) else 'regular'
    # The meeting date: from the title, else the post's address (".../may-4-2026/"), else the recap's first lines, which
    # usually read "Tuesday, October 6, 2026 · 5:00 p.m. · Wiggins City Hall". Dates of earlier minutes come later.
    rx = rf'({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})'
    slug = re.search(rf'({MONTHS.lower()})-(\d{{1,2}})-(\d{{4}})/?$', url)
    date = re.search(rx, title) or (slug and re.match(rx, f'{slug.group(1).title()} {slug.group(2)}, {slug.group(3)}')) \
        or re.search(rx, '\n'.join(head.split('\n')[:3]))
    title_note = None
    if date:
        month = MONTHS.split('|').index(date.group(1)) + 1
        day = f'{date.group(3)}-{month:02d}-{int(date.group(2)):02d}'
    elif published:
        day = published
        title_note = f'Date not stated in the recap; posted {published}'
    else:
        return {'skip': 'no meeting date in the post', **body_def}
    line = next((l for l in head.split('\n') if date and date.group(0) in l), '')
    t = re.search(r'(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b', line, re.I) \
        or re.search(r'called to order at (?:approximately )?\**(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b', body[:3000], re.I)
    hhmm = f'{(int(t.group(1)) % 12) + (12 if t.group(3).lower() == "p" else 0):02d}:{t.group(2) or "00"}' if t else body_def['time']
    parts = [x.strip(' *') for x in re.split(r'[·|]', line) if x.strip(' *')]
    place = parts[2] if len(parts) >= 3 and not re.search(r'\d{4}', parts[2]) else body_def['location']
    return {**body_def, 'kind': kind, 'starts_at': f'{day}T{hhmm}', 'place': place, 'timed': bool(t), 'title': title_note}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('origin'); ap.add_argument('key_file')
    ap.add_argument('--city', default='wiggins'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    api = Api(a.origin, read_key(a.key_file))
    M = f'/{a.city}/meetings'
    boards = {}
    if not a.dry_run:
        s, r = api.call('GET', f'{M}/boards')
        if s != 200: sys.exit(f"Can't read boards: {r.get('error')}")
        boards = {b['name'].lower(): b for b in r['boards']}

    found = posts()
    print(f'{len(found)} posts in Civic Notes')
    added = updated = skipped = 0
    for title, url in reversed(found):
        body, published = read_post(url)
        info = meeting_of(title, url, body, published)
        if not info or 'skip' in info:
            print(f'skip    {title[:70]}  ({info["skip"] if info else "not a meeting recap"})')
            skipped += 1
            continue
        print(f'{"meeting":7} {info["starts_at"]}{"" if info["timed"] else "*"}  {info["kind"]:12} {info["name"][:34]:34} {len(body):>6} chars  {title[:50]}')
        if a.dry_run: continue
        board = boards.get(info['name'].lower())
        if not board:
            s, r = api.call('POST', f'{M}/boards', {'name': info['name'], 'kind': info['kind'] if info['kind'] in ('board', 'other') else 'board',
                                                     'location': info['location'], 'description': info['description'], 'external': info['external']})
            if s != 201: sys.exit(f"Can't add {info['name']}: {r.get('error')}")
            board = boards[info['name'].lower()] = r['board']
        s, r = api.call('GET', f'{M}?board={board["id"]}')
        same = [m for m in r['meetings'] if m['starts_at'][:10] == info['starts_at'][:10]]
        if same:
            mid = same[0]['id']; updated += 1
        else:
            s, r = api.call('POST', M, {'board_id': board['id'], 'kind': info['kind'], 'starts_at': info['starts_at'], 'location': info['place'], 'historical': True, 'title': info['title']})
            if s != 201: print('  could not add:', r.get('error')); continue
            mid = r['meeting']['id']; added += 1
        s, r = api.call('PUT', f'{M}/{mid}/record', {'text': body, 'source': SOURCE, 'url': url})
        if s != 200: print('  could not save the notes:', r.get('error'))
    print(f'\n{"Would add" if a.dry_run else "Added"} {added} meetings, updated {updated}, skipped {skipped} posts. * = time not stated in the recap; the usual time was used.')


if __name__ == '__main__':
    main()
