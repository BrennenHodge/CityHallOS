"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, the Public Works dispatcher, the AI City Clerk and the audit log.

Usage: python -I test_api.py <origin> <key_file>
  python -I platform/scripts/test_api.py http://127.0.0.1:8787 platform/.dev.vars
  python -I platform/scripts/test_api.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Each run creates two throwaway test cities with their own staff and archives them at the end, so it
never touches a real city. It refuses to run against production.
"""
import datetime, http.cookiejar, json, re, secrets, sys, urllib.error, urllib.parse, urllib.request
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


def raw(c, method, path, body=None, headers=None):
    """A request whose body or response isn't JSON (photo uploads and downloads)."""
    req = urllib.request.Request(f'{ORIGIN}/api{path}', data=body, method=method, headers={'User-Agent': 'CityHallOS-scripts/1.0', **(headers or {})})
    try:
        with c.opener.open(req, timeout=60) as r:
            return r.status, r.headers.get('Content-Type', ''), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read()


def upload_photo(c, path, kind):
    png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2219bc30000000049454e44ae426082')
    b = 'chos' + secrets.token_hex(8)
    body = (f'--{b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n{kind}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="photo"; filename="{kind}.png"\r\nContent-Type: image/png\r\n\r\n').encode() + png + f'\r\n--{b}--\r\n'.encode()
    s, _, data = raw(c, 'POST', path, body, {'Content-Type': f'multipart/form-data; boundary={b}'})
    return s, json.loads(data or b'{}')


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
        email = f"{role}-{name.split()[0].lower()}-{RUN}@example.test"
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

    # Public Works dispatcher: crews, the dispatch board and its suggestions, work orders, the field view and the map.
    s, r = admin.call('POST', f'/{A}/staff', {'name': 'Sam Water', 'department_id': 'water-sewer', 'title': 'Operator'})
    water_staff = r['staff']
    s, r = works.call('POST', f'/{A}/crews', {'name': 'Street Crew', 'members': [works_staff['id']], 'lead_id': works_staff['id']})
    crew = r.get('crew') or {}
    ok(s == 201 and crew.get('department_id') == 'public-works' and [m['name'] for m in crew['members']] == ['Pat Works'], 'department staff create a crew in their own department')
    s, _ = works.call('POST', f'/{A}/crews', {'name': 'Not mine', 'department_id': 'water-sewer'})
    ok(s == 403, "department staff can't create another department's crew")
    s, r = admin.call('POST', f'/{A}/crews', {'name': 'Water Crew', 'department_id': 'water-sewer', 'members': [water_staff['id']]})
    wcrew = r['crew']
    s, _ = works.call('PATCH', f"/{A}/crews/{wcrew['id']}", {'name': 'Taken over'})
    ok(s == 403, "department staff can't change another department's crew")
    s, r = works.call('PATCH', f"/{A}/crews/{crew['id']}", {'members': [works_staff['id'], admin_staff['id']]})
    ok(s == 200 and len(r['crew']['members']) == 2, 'crews are made of people from the staff directory')
    s, _ = viewer.call('POST', f'/{A}/crews', {'name': 'Viewers'})
    ok(s == 403, "viewers can't manage crews")

    s, near1 = anon.call('POST', f'/{A}/requests', {'category': 'pothole', 'description': 'Pothole by the school, kids walk past it', 'location': 'GPS 30.86000, -89.13000',
                                                     'name': 'Ann Resident', 'contact': 'ann@example.test'})
    s, near2 = anon.call('POST', f'/{A}/requests', {'category': 'pothole', 'description': 'Big hole in the road', 'location': 'GPS 30.86010, -89.13005', 'contact': '601-555-0144'})
    s, nowhere = anon.call('POST', f'/{A}/requests', {'category': 'sign', 'description': 'Stop sign bent over', 'location': 'Behind the old feed store'})
    s, b = works.call('GET', f'/{A}/dispatch/board')
    today = datetime.date.fromisoformat(b['today'])
    tomorrow, later = (today + datetime.timedelta(days=1)).isoformat(), (today + datetime.timedelta(days=2)).isoformat()
    refs = {x['ref'] for x in b['unscheduled']}
    ok(s == 200 and {near1['ref'], near2['ref'], 'TST-1001'} <= refs and 'TST-1002' not in refs, "the board shows my department's unscheduled requests only")
    ok([d['id'] for d in b['departments']] == ['public-works'] and [c['name'] for c in b['crews']] == ['Street Crew'], 'department staff dispatch only their own crews')
    sug = {(x['ref'], x['kind']): x for x in b['suggestions']}
    dup = sug.get((near2['ref'], 'duplicate'))
    ok(dup and dup['data']['ref'] == near1['ref'] and dup['data']['metres'] < 20, f"the dispatcher flags a likely duplicate near the same spot ({dup and dup['reason']})")
    pri = sug.get((near1['ref'], 'priority'))
    ok(pri and pri['value'] == 'high', 'the dispatcher suggests a higher priority for a safety concern')
    crew_sug = sug.get((near1['ref'], 'crew'))
    ok(crew_sug and crew_sug['value'] == crew['id'] and crew_sug['data']['date'] > b['today'], 'the dispatcher suggests a crew and a day')
    s, r = viewer.call('GET', f'/{A}/dispatch/board')
    ok(s == 200 and all(x['contact'] in (None, 'Hidden') for x in r['unscheduled']), 'viewers see the board without resident contact details')
    s, _ = editor.call('GET', f'/{A}/dispatch/board')
    ok(s == 403, "knowledge editors don't see the dispatch board")
    s, r = admin.call('GET', f'/{A}/dispatch/board')
    ok({'public-works', 'water-sewer'} <= {d['id'] for d in r['departments']}, 'administrators dispatch for every department')
    wsug = next((x for x in r['suggestions'] if x['ref'] == 'TST-1002' and x['kind'] == 'crew'), None)
    s, _ = works.call('POST', f"/{A}/dispatch/suggestions/{wsug['id']}", {'decision': 'accept'})
    ok(s == 403, "department staff can't act on another department's suggestions")

    s, r = works.call('POST', f"/{A}/dispatch/suggestions/{dup['id']}", {'decision': 'accept'})
    s2, t = anon.call('GET', f"/{A}/track/{near2['ref']}")
    ok(s == 200 and t['status'] == 'closed' and any(near1['ref'] in (u['note'] or '') for u in t['updates']), 'accepting a duplicate closes it and tells the resident which report covers it')
    s, r = works.call('POST', f"/{A}/dispatch/suggestions/{pri['id']}", {'decision': 'accept'})
    s, r = works.call('GET', f'/{A}/requests')
    ok(next(x for x in r['requests'] if x['ref'] == near1['ref'])['priority'] == 'high', 'accepting a priority suggestion changes the priority')
    old = next((x for x in b['suggestions'] if x['ref'] == 'TST-1001' and x['kind'] == 'priority'), None)
    s, _ = works.call('POST', f"/{A}/dispatch/suggestions/{old['id']}", {'decision': 'dismiss'})
    s, b = works.call('GET', f'/{A}/dispatch/board')
    ok(not any(x['ref'] == 'TST-1001' and x['kind'] == 'priority' for x in b['suggestions']), 'a dismissed suggestion is not made again')
    s, _ = works.call('POST', f"/{A}/dispatch/suggestions/{dup['id']}", {'decision': 'dismiss'})
    ok(s == 400, 'a suggestion can only be decided once')

    s, r = works.call('POST', f"/{A}/dispatch/suggestions/{crew_sug['id']}", {'decision': 'accept', 'date': tomorrow})
    wo_near = r.get('workOrder') or {}
    ok(s == 200 and wo_near.get('ref') == 'WO-1001' and wo_near['scheduled_date'] == tomorrow and wo_near['crew'] == 'Street Crew', 'accepting a crew suggestion schedules a work order')
    s, t = anon.call('GET', f"/{A}/track/{near1['ref']}")
    ok(t['status'] == 'assigned' and t['scheduled_for'] == tomorrow and any((u['note'] or '').startswith('Scheduled for') for u in t['updates']),
       'residents tracking the request see "scheduled for" the date')
    s, r = works.call('POST', f'/{A}/work-orders', {'request_id': pid, 'crew_id': crew['id'], 'scheduled_date': b['today'], 'materials': '2 bags cold patch', 'labor_notes': 'Two people, one hour'})
    wo = r.get('workOrder') or {}
    ok(s == 201 and wo.get('materials') == '2 bags cold patch' and wo['status'] == 'scheduled', 'department staff schedule a work order with materials and labor notes')
    s, _ = works.call('POST', f'/{A}/work-orders', {'request_id': water['id'], 'scheduled_date': b['today']})
    ok(s == 403, "department staff can't schedule another department's work")
    s, _ = admin.call('POST', f'/{A}/work-orders', {'request_id': pid, 'crew_id': wcrew['id']})
    ok(s == 400, "a work order can't go to another department's crew")
    s, _ = works.call('POST', f'/{A}/work-orders', {'request_id': pid, 'scheduled_date': '2026-02-30'})
    ok(s == 400, 'work orders need a real date')

    s, f = works.call('GET', f'/{A}/field')
    ok(s == 200 and f['mine'] and [w['ref'] for w in f['workOrders']] == [wo['ref']], "the field view shows my crew's work today")
    s, f = works.call('GET', f'/{A}/field?date={tomorrow}')
    ok({w['ref'] for w in f['workOrders']} == {wo['ref'], wo_near['ref']}, "tomorrow's field view includes unfinished work from today")
    s, mp = works.call('GET', f'/{A}/dispatch/map')
    pts = {x['ref']: x for x in mp['located']}
    ok(near1['ref'] in pts and pts[near1['ref']]['located_by'] == 'gps' and pts[near1['ref']]['workOrders'][0]['ref'] == wo_near['ref'], 'the map places GPS reports with their work orders')
    spot = next((x for x in mp['located'] + mp['unlocated'] if x['ref'] == nowhere['ref']), None)
    ok(spot and spot['located_by'] in ('pending', 'not_found', 'geocoded') and 'TST-1002' not in pts, 'typed addresses are geocoded or listed without a location')

    s, r = works.call('PATCH', f"/{A}/work-orders/{wo['id']}", {'status': 'done'})
    ok(s == 400, 'a job needs a photo or a note to be marked done')
    s, r = works.call('PATCH', f"/{A}/work-orders/{wo['id']}", {'status': 'in_progress', 'labor_hours': 1.5})
    ok(s == 200 and r['workOrder']['status'] == 'in_progress' and r['workOrder']['labor_hours'] == 1.5, 'crews start a job')
    s, r = upload_photo(works, f"/{A}/work-orders/{wo['id']}/photos", 'after')
    ok(s == 201 and r['workOrder']['photo_list'][0]['kind'] == 'after', 'crews add an after photo')
    photo = r['workOrder']['photo_list'][0]['id']
    s, r = works.call('PATCH', f"/{A}/work-orders/{wo['id']}", {'status': 'done'})
    s2, t = anon.call('GET', f'/{A}/track/TST-1001')
    ok(s == 200 and t['status'] == 'resolved' and t['updates'][-1]['note'].startswith('Completed'), 'finishing the only job resolves the request, and residents see "completed"')
    s, ctype, data = raw(viewer, 'GET', f"/{A}/work-orders/{wo['id']}/photos/{photo}")
    ok(s == 200 and ctype == 'image/png' and data[:4] == b'\x89PNG', 'staff see the crew photos')
    s, _, _ = raw(editor, 'GET', f"/{A}/work-orders/{wo['id']}/photos/{photo}")
    ok(s == 403, "roles without the dispatch board can't see crew photos")

    s, r = works.call('PATCH', f"/{A}/work-orders/{wo_near['id']}", {'scheduled_date': later})
    s2, t = anon.call('GET', f"/{A}/track/{near1['ref']}")
    ok(t['scheduled_for'] == later and t['updates'][-1]['note'].startswith('Rescheduled for'), 'residents see a new date when work is rescheduled')
    s, r = admin.call('POST', f'/{A}/work-orders', {'request_id': water['id'], 'crew_id': wcrew['id'], 'scheduled_date': b['today'], 'title': 'Dig and repair'})
    first = r['workOrder']
    s, r = admin.call('POST', f'/{A}/work-orders', {'request_id': water['id'], 'crew_id': wcrew['id'], 'scheduled_date': later, 'title': 'Restore pavement'})
    second = r['workOrder']
    admin.call('PATCH', f"/{A}/work-orders/{first['id']}", {'status': 'done', 'completion_note': 'Replaced 4 ft of service line'})
    s, t = anon.call('GET', f'/{A}/track/TST-1002')
    ok(t['status'] == 'in_progress', 'a request with unfinished work orders stays in progress')
    admin.call('PATCH', f"/{A}/work-orders/{second['id']}", {'status': 'done', 'completion_note': 'Patched'})
    s, t = anon.call('GET', f'/{A}/track/TST-1002')
    ok(t['status'] == 'resolved', 'the request is resolved when all of its work orders are done')
    s, r = works.call('GET', f"/{A}/work-orders?request_id={water['id']}")
    ok(s == 404, "department staff can't open another department's work orders")

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
    text, done = chat(A, 'I want to build a detached garage behind my house')
    ok(done['flags'].get('offerPermit'), 'describing building work offers the permit application')

    # Permit applications: the resident's side, with only the secret link.
    def upload(path, token, kind, name='deed.pdf'):
        boundary = 'chos' + secrets.token_hex(8)
        pdf = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n{kind}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/pdf\r\n\r\n').encode() + pdf + f'\r\n--{boundary}--\r\n'.encode()
        req = urllib.request.Request(f'{ORIGIN}/api{path}', data=body, method='POST', headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}', 'X-Permit-Token': token, 'User-Agent': 'CityHallOS-scripts/1.0'})
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read())

    s, app = anon.call('POST', f'/{A}/permits', {'opening': 'I want to build a 24 by 30 foot detached garage behind my house'})
    ok(s == 201 and app['token'] and app['status'] == 'draft', 'a resident starts a permit application without an account')
    ok(app['data'].get('construction_type') == 'new' and app['data'].get('width') == 24 and app['data'].get('occupancy') == 'garage',
       'the opening message fills in the type, size and use')
    pid, tok = app['id'], {'X-Permit-Token': app['token']}
    s, _ = anon.call('GET', f'/{A}/permits/{pid}', headers={'X-Permit-Token': 'not-the-token'})
    ok(s == 404, 'an application cannot be opened without its secret link')
    s, _ = anon.call('GET', f'/{B}/permits/{pid}', headers=tok)
    ok(s == 404, "one city's application link doesn't open in another city")
    s, r = anon.call('POST', f'/{A}/permits/{pid}/message', {'text': 'Yes', 'ask': 'work_started'}, tok)
    ok(s == 200 and r['data'].get('work_started') is True, 'a chat answer is saved to the right field')
    s, r = anon.call('PATCH', f'/{A}/permits/{pid}', {'data': {'owner_email': 'not-an-email', 'valuation': '$18,500'}}, tok)
    ok(s == 200 and r['data']['valuation'] == 18500 and any(c['field'] == 'owner_email' and c['level'] == 'error' for c in r['checks']),
       'form edits autosave, amounts are cleaned and bad emails are flagged')
    s, r = anon.call('POST', f'/{A}/permits/{pid}/submit', {}, tok)
    ok(s == 400 and any(c['level'] == 'error' for c in r.get('checks', [])), "an incomplete application can't be submitted")
    s, r = anon.call('PATCH', f'/{A}/permits/{pid}', {'data': {
        'job_address': '412 Pine St', 'applicant_role': 'owner', 'owner_name': 'Jane Resident', 'owner_same_mailing': False,
        'owner_address': '9 Oak Ave', 'owner_city': 'Testville', 'owner_state': 'ms', 'owner_zip': '39577', 'owner_cell': '601-555-0142',
        'owner_email': 'jane@example.test', 'contact_pref': 'email', 'builder': 'owner', 'owner_exemption': 'remodel_under_10k', 'owner_ack': True,
        'stories': 1, 'length': 30, 'height': 14, 'zoning': 'R-1', 'design_pro': 'none', 'hazmat_ack': True, 'certify': True, 'signature_name': 'Jane Resident'}}, tok)
    ok(r['data']['owner_state'] == 'MS' and r['data'].get('signed_at') and r['data']['area_under_roof'] == 720, 'state is normalized, signing is dated and the area is worked out')
    ok(any(c['field'] == 'owner_exemption' and c['level'] == 'error' for c in r['checks']), "an owner-builder exception that doesn't fit the project is caught")
    anon.call('PATCH', f'/{A}/permits/{pid}', {'data': {'owner_exemption': 'principal_residence'}}, tok)
    s, r = upload(f'/{A}/permits/{pid}/files', app['token'], 'ownership_proof')
    ok(s == 200 and r['files'][0]['kind'] == 'ownership_proof', 'proof of ownership uploads to the application')
    s, r = anon.call('POST', f'/{A}/permits/{pid}/submit', {}, tok)
    ok(s == 200 and r['status'] == 'submitted' and r['ref'] == 'TST-BP-1001', f"a submitted application gets its number ({r.get('ref') or r.get('error')})")
    s, r = anon.call('PATCH', f'/{A}/permits/{pid}', {'data': {'valuation': 1}}, tok)
    ok(s == 400, "a submitted application can't be changed online")
    s, t = anon.call('GET', f'/{A}/track/tst-bp-1001')
    ok(s == 200 and t['status'] == 'submitted' and 'data' not in t and 'contact' not in t, 'permit tracking shows status without personal details')

    # Permit applications: City Hall's side.
    planner, _, _, _ = onboard('Pia Planning', 'department', 'planning-building')
    s, r = planner.call('GET', f'/{A}/permits')
    ok(s == 200 and [x['ref'] for x in r['permits']] == ['TST-BP-1001'], 'permit staff see submitted applications, not drafts')
    s, r = editor.call('GET', f'/{A}/permits/{pid}')
    ok(s == 200 and r['data']['owner_email'] == 'Hidden' and not r['canEdit'], "roles without resident contact access see the application with contact details hidden")
    s, _ = works.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'accept', 'fee': 50})
    ok(s == 403, "another department's staff can't decide permits")
    s, _ = planner.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'issue', 'permit_number': 'X-1'})
    ok(s == 400, "a permit can't be issued before the application is complete and paid")
    s, r = planner.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'request_info', 'items': ['Add the side and rear setbacks']})
    ok(s == 200 and r['status'] == 'needs_info', 'staff send an application back with a list of changes')
    s, r = anon.call('GET', f'/{A}/permits/{pid}', headers=tok)
    ok(r['editable'] and r['corrections']['items'] == ['Add the side and rear setbacks'], 'the applicant sees exactly what to change')
    anon.call('PATCH', f'/{A}/permits/{pid}', {'data': {'setback_front': 40, 'setback_side': 10, 'setback_rear': 15, 'applicant_note': 'Setbacks added'}}, tok)
    s, r = anon.call('POST', f'/{A}/permits/{pid}/submit', {}, tok)
    ok(s == 200 and r['ref'] == 'TST-BP-1001', 'a resubmitted application keeps its number')
    s, r = planner.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'accept', 'fee': 120.5})
    ok(r['status'] == 'fees_due' and r['fee_assessed'] == 120.5, 'staff mark the application complete and set the fee')
    s, r = planner.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'payment', 'amount': 120.5, 'receipt': 'R-77'})
    ok(r['status'] == 'in_review', 'recording the payment starts the review')
    s, r = planner.call('POST', f'/{A}/permits/{pid}/actions', {'action': 'issue', 'permit_number': f'TST-{RUN}-1001', 'conditions': 'Call for footing inspection'})
    ok(r['status'] == 'issued' and r['permit_number'] == f'TST-{RUN}-1001', 'staff issue the permit')
    for path, label in [(f'/{A}/permits/{pid}/pdf', 'application'), (f'/{A}/permits/{pid}/permit.pdf', 'permit')]:
        req = urllib.request.Request(f'{ORIGIN}/api{path}', headers={'X-Permit-Token': app['token'], 'User-Agent': 'CityHallOS-scripts/1.0'})
        with urllib.request.urlopen(req, timeout=60) as res:
            ok(res.headers['Content-Type'] == 'application/pdf' and res.read(5) == b'%PDF-', f'the applicant downloads the {label} PDF')
    s, r = planner.call('GET', f'/{A}/permits/{pid}')
    subjects = ' | '.join(o['subject'] for o in r['outbox'])
    ok(all(x in subjects for x in ['needs a few changes', 'fee due', 'has been issued']) and all(o['channel'] == 'email' for o in r['outbox']),
       'the applicant is told at each step on their chosen channel, and every message is logged')

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
              'staff.create', 'access.role', 'access.revoke', 'access.setup_link', 'settings.update',
              'permit.submit', 'permit.needs_info', 'permit.resubmit', 'permit.fees_due', 'permit.in_review', 'permit.issued',
              'crew.create', 'crew.update', 'work_order.create', 'work_order.update', 'work_order.photo', 'dispatch.suggest', 'dispatch.accept', 'dispatch.dismiss']:
        ok(a in acts, f'audit log records {a}')
    e = next(e for e in r['events'] if e['action'] == 'work_order.update' and (e['changes'] or {}).get('status') == ['in_progress', 'done'])
    ok(e['actor_name'] == 'Pat Works', 'work order changes are audited with who and the before and after values')
    ok(all(e['actor_type'] == 'ai' for e in r['events'] if e['action'] == 'dispatch.suggest'), "the dispatcher's suggestions are recorded as the AI's")
    e = next(e for e in r['events'] if e['action'] == 'document.update')
    ok(e['actor_name'] == 'Eddie Editor' and e['changes']['verification'] == ['verified_current', 'historical'], 'audit entries name the person and the before and after values')
    s, _ = works.call('GET', f'/{A}/audit')
    ok(s == 403, "department staff can't read the audit log")
    s, r = admin.call('GET', f'/{A}/export')
    ok(s == 200 and 'audit_log' in r and len(r['requests']) >= 2 and len(r['work_orders']) == 4, 'admins export the whole city')
finally:
    for slug in (A, B):
        operator.call('PUT', f'/platform/cities/{slug}/status', {'status': 'archived'})

print(f"\n{'All checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
