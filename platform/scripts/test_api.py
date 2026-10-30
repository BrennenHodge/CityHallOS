"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, the AI City Clerk and the audit log.

Usage: python -I test_api.py <origin> <key_file>
  python -I platform/scripts/test_api.py http://127.0.0.1:8787 platform/.dev.vars
  python -I platform/scripts/test_api.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Each run creates two throwaway test cities with their own staff and archives them at the end, so it
never touches a real city. It refuses to run against production.
"""
import http.cookiejar, json, re, secrets, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chos import PRODUCTION, Api, read_key  # noqa: E402

if len(sys.argv) != 3:
    sys.exit(__doc__)
ORIGIN, KEY = sys.argv[1].rstrip('/'), read_key(sys.argv[2])
if PRODUCTION in ORIGIN:
    sys.exit('Refusing to run the test suite against production.')

RUN = secrets.token_hex(3)
failures = []


def ok(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: failures.append(msg)


def session():
    return Api(ORIGIN, opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())))


def password():
    return 'Test-' + secrets.token_urlsafe(12)


operator = Api(ORIGIN, KEY)
A, B = f'test-{RUN}', f'test-{RUN}-b'
for slug, name, prefix in [(A, f'Town of Testville {RUN}', 'TST'), (B, f'Town of Otherton {RUN}', 'OTH')]:
    s, r = operator.call('POST', '/platform/cities', {'id': f'ms-{slug}', 'slug': slug, 'name': name, 'state': 'MS', 'county': 'Test County',
                                                     'requestPrefix': prefix, 'status': 'active',
                                                     'settings': {'phone': '555-0100', 'policeNonEmergency': '555-0199'}})
    ok(s == 201, f'operator creates test city {slug}')
    if s != 201: sys.exit(f"Can't continue: {r.get('error')}")

try:
    s, me = session().call('POST', '/auth/operator', {'code': KEY})
    ok(s == 200 and me['operator'], 'operator signs in with the access code')

    def onboard(name, role, dept=None):
        email = f'{role}-{RUN}@example.test'
        s, r = operator.call('POST', f'/{A}/staff', {'name': name, 'email': email, 'role': role, 'department_id': dept, 'title': 'Tester'})
        assert s == 201, (s, r)
        token = r['setupUrl'].split('/setup/')[1]
        c, p = session(), password()
        s2, info = c.call('GET', f'/auth/setup?token={token}')
        ok(s2 == 200 and info['email'] == email, f'{role}: setup link opens')
        s3, me = c.call('POST', '/auth/setup', {'token': token, 'password': p})
        ok(s3 == 200 and me['cities'][0]['role'] == role, f'{role}: sets a password and is signed in')
        s4, _ = session().call('POST', '/auth/setup', {'token': token, 'password': p})
        ok(s4 == 400, f'{role}: setup link works only once')
        return c, r['staff'], email, p

    admin, admin_staff, admin_email, admin_pw = onboard('Avery Admin', 'admin')
    works, works_staff, _, _ = onboard('Pat Works', 'department', 'public-works')
    viewer, viewer_staff, _, _ = onboard('Vic Viewer', 'viewer')
    editor, _, _, _ = onboard('Eddie Editor', 'editor')

    s, _ = session().call('POST', '/auth/login', {'email': admin_email, 'password': 'wrong-password'})
    ok(s == 401, 'wrong password is rejected')
    s, me = session().call('POST', '/auth/login', {'email': admin_email.upper(), 'password': admin_pw})
    ok(s == 200 and me['user']['name'] == 'Avery Admin', 'staff sign in, and email is not case-sensitive')

    # Service requests.
    anon = Api(ORIGIN)
    s, pot = anon.call('POST', f'/{A}/requests', {'category': 'pothole', 'description': 'Deep pothole', 'location': 'Pine St', 'name': 'Jane Resident', 'contact': '555-0123'})
    ok(s == 201 and pot.get('ref') == 'TST-1001', f"a city's first request is TST-1001 ({pot.get('ref')})")
    s, wat = anon.call('POST', f'/{A}/requests', {'category': 'water', 'description': 'Water main leak, dangerous', 'location': 'GPS 30.85412, -89.13560'})
    ok(s == 201 and wat.get('department') == 'Water & Sewer', 'requests route to the right department')
    s, t = anon.call('GET', f'/{A}/track/tst-1001')
    ok(s == 200 and t['status'] == 'new' and 'contact' not in t, 'tracking shows status without personal details')
    s, r = works.call('GET', f'/{A}/requests')
    ok([x['ref'] for x in r['requests']] == ['TST-1001'], 'department staff see only their department')
    pid = r['requests'][0]['id']
    s, r = admin.call('GET', f'/{A}/requests')
    water = next(x for x in r['requests'] if x['ref'] == 'TST-1002')
    ok(water['priority'] == 'high' and water['latitude'] == 30.85412, 'hazard wording raises priority; GPS is stored as coordinates')
    s, r = works.call('PATCH', f'/{A}/requests/{pid}', {'status': 'in_progress', 'assignee_id': works_staff['id'], 'note': 'Crew scheduled'})
    ok(s == 200 and r['request']['assignee'] == 'Pat Works', 'department staff work their own requests')
    s, _ = works.call('PATCH', f"/{A}/requests/{water['id']}", {'status': 'resolved'})
    ok(s == 403, "department staff can't change another department's request")
    works.call('PATCH', f'/{A}/requests/{pid}', {'note': 'Internal: waiting on asphalt'})
    s, t = anon.call('GET', f'/{A}/track/TST-1001')
    ok(t['status'] == 'in_progress' and not any('asphalt' in (u['note'] or '') for u in t['updates']), 'residents see status changes but not staff notes')
    s, r = viewer.call('GET', f'/{A}/requests')
    x = next(x for x in r['requests'] if x['ref'] == 'TST-1001')
    ok(x['contact'] == 'Hidden', 'viewers do not see resident contact details')
    for who, label in [(viewer, 'viewer'), (editor, 'knowledge editor')]:
        s, _ = who.call('PATCH', f'/{A}/requests/{pid}', {'status': 'closed'})
        ok(s == 403, f"{label} can't change requests")
    s, _ = viewer.call('POST', f'/{A}/documents', {'text': 'x' * 50, 'title': 'Nope'})
    ok(s == 403, "viewer can't add documents")

    # Knowledge base.
    s, r = editor.call('POST', f'/{A}/documents', {'title': 'When does the Board of Aldermen meet?', 'category': 'FAQs', 'authority': 'staff-note',
                                                    'text': '# Board meetings\n\nThe Board of Aldermen meets the first and third Tuesday of each month at 6 pm at City Hall.'})
    doc = r['documents'][0]
    ok(s == 201 and doc['status'] == 'ready', 'editor adds a staff answer and it is indexed')
    s, r = editor.call('GET', f'/{A}/search?q=aldermen%20meeting%20tuesday')
    ok(bool(r.get('results')) and r['results'][0]['docId'] == doc['id'], 'the new answer is the top search result')
    s, r = editor.call('PATCH', f"/{A}/documents/{doc['id']}", {'verification': 'historical', 'title': 'Board of Aldermen meeting schedule'})
    ok(s == 200 and r['document']['title'] == 'Board of Aldermen meeting schedule', 'editor updates a document')
    s, r = editor.call('GET', f'/{A}/search?q=aldermen%20schedule')
    ok(bool(r.get('results')) and r['results'][0]['title'] == 'Board of Aldermen meeting schedule', 'search follows the rename')
    s, r = operator.call('GET', f'/{B}/search?q=aldermen%20meeting%20tuesday')
    ok(s == 200 and not r['results'], "another city's search can't find it")
    s, _ = editor.call('DELETE', f"/{A}/documents/{doc['id']}")
    s, r = editor.call('GET', f'/{A}/search?q=aldermen%20schedule%20tuesday')
    ok(all(x['docId'] != doc['id'] for x in r['results']), 'deleted documents leave search')
    s, _ = editor.call('PUT', f'/{A}/settings', {'hours': '9-5'})
    ok(s == 403, "editor can't change settings")
    s, _ = editor.call('POST', f'/{A}/staff', {'name': 'X'})
    ok(s == 403, "editor can't manage staff")

    # Managing access.
    s, _ = admin.call('PATCH', f"/{A}/staff/{admin_staff['id']}", {'role': 'viewer'})
    ok(s == 400, "admins can't change their own role")
    s, _ = admin.call('PATCH', f"/{A}/staff/{viewer_staff['id']}", {'role': 'editor'})
    s, _ = viewer.call('POST', f'/{A}/documents', {'title': 'Now allowed', 'text': 'y' * 60})
    ok(s == 201, 'role changes take effect immediately')
    admin.call('PATCH', f"/{A}/staff/{viewer_staff['id']}", {'role': ''})
    s, _ = viewer.call('GET', f'/{A}/overview')
    ok(s == 401, 'removing access locks the person out at once')
    s, r = admin.call('POST', f"/{A}/staff/{works_staff['id']}/setup-link")
    ok(s == 200 and '/setup/' in r['setupUrl'], 'admins create password reset links')
    s, r = admin.call('PUT', f'/{A}/settings', {'hours': 'Monday-Friday, 8 am to 5 pm'})
    ok(s == 200 and r['hours'].startswith('Monday'), 'admins change settings')
    s, _ = admin.call('PUT', f'/{A}/settings', {'hours': 'x'}, {'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'})
    ok(s == 403, 'cross-site changes with a session cookie are blocked')

    # Isolation between cities.
    s, _ = admin.call('GET', f'/{B}/overview')
    ok(s == 401, "staff of one city can't open another")
    s, r = anon.call('POST', f'/{B}/requests', {'category': 'pothole', 'description': 'Hole'})
    ok(r.get('ref') == 'OTH-1001', 'each city numbers its own requests')
    s, _ = anon.call('GET', f'/{B}/track/TST-1001')
    ok(s == 404, "one city's reference numbers don't resolve in another")

    # The AI City Clerk: the rules that run before any model.
    def chat(slug, message):
        s, _ = 0, None
        req = urllib.request.Request(f'{ORIGIN}/api/{slug}/chat', data=json.dumps({'message': message}).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'User-Agent': 'CityHallOS-scripts/1.0'})
        events = {}
        with urllib.request.urlopen(req, timeout=120) as res:
            for block in res.read().decode().split('\n\n'):
                lines = dict(l.split(': ', 1) for l in block.split('\n') if ': ' in l)
                if 'event' in lines: events.setdefault(lines['event'], []).append(json.loads(lines['data']))
        return ''.join(d['t'] for d in events.get('delta', [])), events['done'][0]
    text, done = chat(A, 'I smell gas in my kitchen')
    ok(done['flags']['emergency'] and '911' in text and '555-0199' in text, 'emergencies get 911 guidance with the city\'s own numbers')
    text, done = chat(A, 'There is a big pothole on Pine Street')
    ok(done['reportType'] == 'pothole' and 'Public Works' in text, 'reported problems open the report form')
    text, done = chat(A, 'What are the rules for raising goats inside city limits?')
    ok(done['flags']['needsStaff'], 'questions with no documents are flagged for staff')

    # Text messages and phone calls (only where the webhooks accept test traffic: local with TWILIO_ALLOW_UNSIGNED=1).
    def twilio(path, **form):
        req = urllib.request.Request(f'{ORIGIN}/api/{A}/twilio/{path}', data=urllib.parse.urlencode(form).encode(), method='POST',
                                     headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CityHallOS-scripts/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return res.status, res.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
    s, body = twilio('sms', From='+15555550142', Body='There is a pothole on Oak Street')
    if s == 200:
        ok('address' in body, 'a text about a problem starts a report')
        twilio('sms', From='+15555550142', Body='Oak St and 2nd')
        s, body = twilio('sms', From='+15555550142', Body='SKIP')
        ref = (re.search(r'TST-\d+', body) or [None])[0]
        ok(bool(ref), f'the texted report gets a reference number ({ref})')
        s, body = twilio('sms', From='+15555550142', Body=ref or 'x')
        ok(ref and ref in body and 'new' in body, 'texting the reference number returns its status')
        s, body = twilio('voice', From='+15555550199', CallSid='CAtest')
        ok('<Gather' in body and 'emergency' in body, 'calls are greeted and told to dial 911 for emergencies')
        s, body = twilio('voice/turn', From='+15555550199', CallSid='CAtest', SpeechResult="that's all")
        ok('<Hangup/>' in body, 'callers can end the call')
        s, r = admin.call('GET', f'/{A}/conversations')
        ok({'sms', 'voice'} <= {c['channel'] for c in r['conversations']}, 'texts and calls are logged as conversations')
    else:
        print(f'SKIP text and phone checks (webhooks answered {s}: {body[:60]})')

    # Audit log.
    s, r = admin.call('GET', f'/{A}/audit')
    acts = {e['action'] for e in r['events']}
    for a in ['city.create', 'request.create', 'request.update', 'document.create', 'document.update', 'document.delete',
              'staff.create', 'access.role', 'access.revoke', 'access.setup_link', 'settings.update']:
        ok(a in acts, f'audit log records {a}')
    e = next(e for e in r['events'] if e['action'] == 'document.update')
    ok(e['actor_name'] == 'Eddie Editor' and e['changes']['verification'] == ['verified_current', 'historical'], 'audit entries name the person and the before and after values')
    s, _ = works.call('GET', f'/{A}/audit')
    ok(s == 403, "department staff can't read the audit log")
    s, r = admin.call('GET', f'/{A}/export')
    ok(s == 200 and 'audit_log' in r and len(r['requests']) >= 2, 'admins export the whole city')
finally:
    for slug in (A, B):
        operator.call('PUT', f'/platform/cities/{slug}/status', {'status': 'archived'})

print(f"\n{'All checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
