"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, public records requests, the AI City Clerk and the audit log.

Usage: python -I test_api.py <origin> <key_file>
  python -I platform/scripts/test_api.py http://127.0.0.1:8787 platform/.dev.vars
  python -I platform/scripts/test_api.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Each run creates two throwaway test cities with their own staff and archives them at the end, so it
never touches a real city. It refuses to run against production.
"""
import http.cookiejar, json, secrets, sys, urllib.error, urllib.request
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


def raw(api, path):
    """GET a non-JSON response: (status, body bytes, headers)."""
    h = {'User-Agent': 'CityHallOS-scripts/1.0', **({'Authorization': f'Bearer {api.key}'} if api.key else {})}
    try:
        with api.opener.open(urllib.request.Request(ORIGIN + '/api' + path, headers=h), timeout=60) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def upload(api, path, name, data):
    """POST one file as multipart/form-data."""
    boundary = 'chos' + secrets.token_hex(8)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: text/plain\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    h = {'User-Agent': 'CityHallOS-scripts/1.0', 'Content-Type': f'multipart/form-data; boundary={boundary}', **({'Authorization': f'Bearer {api.key}'} if api.key else {})}
    try:
        with api.opener.open(urllib.request.Request(ORIGIN + '/api' + path, data=body, method='POST', headers=h), timeout=120) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


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

    # Public records requests (Mississippi rules: 7 working days, 14 with a written explanation).
    s, rs = admin.call('GET', f'/{A}/records/settings')
    ok(s == 200 and rs['statute'] == 'Miss. Code Ann. § 25-61-5' and rs['responseDays'] == 7 and rs['extensionDays'] == 14 and rs['confirmed'],
       'Mississippi cities start with the Public Records Act deadline')
    s, a = anon.call('POST', f'/{A}/records/assist', {'records': 'all emails'})
    ok(s == 200 and not a['clear'] and len(a['questions']) >= 2, 'vague records requests get narrowing questions')
    s, a = anon.call('POST', f'/{A}/records/assist', {'records': 'Minutes of Board of Aldermen meetings about the water tower', 'date_from': '2025-01-01', 'date_to': '2025-06-30'})
    ok(s == 200 and a['clear'], 'specific records requests pass the scope check')
    s, _ = anon.call('POST', f'/{A}/records', {'records': 'Water tower contracts', 'name': 'No Contact'})
    ok(s == 400, 'records requests need a way to reach the requester')
    s, pr = anon.call('POST', f'/{A}/records', {'records': 'Minutes and contracts about the water tower repairs', 'date_from': '2025-01-01', 'date_to': '2025-12-31',
                                                 'format': 'electronic', 'name': 'Rhonda Requester', 'email': 'rhonda@example.test', 'phone': '555-0142'})
    ok(s == 201 and pr.get('ref') == 'TST-PRR-1001' and pr.get('key') and '/records?city=' in pr.get('trackUrl', ''), f"records requests are numbered TST-PRR-1001 ({pr.get('ref')})")
    s, t = anon.call('GET', f'/{A}/records/track/TST-PRR-1001')
    ok(s == 200 and t['status'] == 'new' and 'records' not in t and 'letters' not in t and t['due_date'] == pr['due'], 'tracking by number alone shows status and due date only')
    s, t = anon.call('GET', f"/{A}/records/track/TST-PRR-1001?key={pr['key']}")
    ok(s == 200 and t['verified'] and t['records'].startswith('Minutes'), "the requester's private link shows the full request")
    s, _ = anon.call('GET', f'/{B}/records/track/TST-PRR-1001')
    ok(s == 404, "one city's records requests don't resolve in another")

    # Deadlines count working days and skip weekends and Mississippi holidays (Memorial Day, Confederate Memorial Day).
    def log_request(who, received, **extra):
        return who.call('POST', f'/{A}/records', {'records': 'Police incident reports for 100 Pine Street', 'name': 'Mail Requester', 'address': '1 Main St',
                                                   'source': 'mail', 'received': received, **extra})
    s, m1 = log_request(editor, '2026-05-22')
    ok(s == 201 and m1['due'] == '2026-06-03', f"7 working days from Fri 2026-05-22 skip Memorial Day: due {m1.get('due')}")
    s, m2 = log_request(editor, '2026-04-24')
    ok(m2.get('due') == '2026-05-06', f"Confederate Memorial Day is not a working day: due {m2.get('due')}")
    s, _ = log_request(editor, '2099-01-05')
    ok(s == 400, "a request can't be dated in the future")
    s, _ = works.call('GET', f'/{A}/records')
    ok(s == 403, "department staff don't see records requests")
    s, r = viewer.call('GET', f'/{A}/records')
    row = next(x for x in r['requests'] if x['ref'] == 'TST-PRR-1001')
    ok(s == 200 and row['name'] == 'Hidden' and row['email'] == 'Hidden', 'viewers see the queue without requester contact details')
    s, _ = viewer.call('PATCH', f"/{A}/records/{row['id']}", {'status': 'in_progress'})
    ok(s == 403, "viewers can't work records requests")
    s, r = editor.call('GET', f'/{A}/records')
    mail = next(x for x in r['requests'] if x['ref'] == m1['ref'])
    ok(mail['deadline']['state'] == 'overdue' and mail['deadline']['left'] < 0, 'requests past their due date show as overdue')
    s, _ = editor.call('POST', f"/{A}/records/{mail['id']}/extend", {'reason': 'Too short'})
    ok(s == 400, 'an extension needs a written explanation')
    s, _ = editor.call('POST', f"/{A}/records/{mail['id']}/extend", {'reason': 'The reports are archived off site and must be reviewed for exempt information.', 'due': '2026-07-30'})
    ok(s == 400, 'extending past 14 working days needs the requester to agree')
    s, r = editor.call('POST', f"/{A}/records/{mail['id']}/extend", {'reason': 'The reports are archived off site and must be reviewed for exempt information.'})
    ok(s == 200 and r['request']['extended_due'] == '2026-06-12' and any(l['kind'] == 'extension' and l['status'] == 'sent' for l in r['letters']),
       'extensions default to 14 working days from receipt and send the written explanation')

    # Working a request: assign, AI suggestions, files with redaction checks, fees, letters, release.
    rid = row['id']
    s, r = editor.call('PATCH', f'/{A}/records/{rid}', {'assignee_id': admin_staff['id'], 'status': 'in_progress', 'note': 'Check with Public Works'})
    ok(s == 200 and r['request']['assignee'] == 'Avery Admin' and r['request']['status'] == 'in_progress', 'knowledge editors (the clerk\'s office) work records requests')
    s, r = anon.call('GET', f"/{A}/records/track/TST-PRR-1001?key={pr['key']}")
    ok(not any('Public Works' in (u['note'] or '') for u in r['updates']), 'staff notes stay off the tracking page')
    s, r = editor.call('POST', f'/{A}/documents', {'title': 'Water tower repair contract 2025', 'category': 'Budget & Finance', 'visibility': 'internal',
                                                    'text': '# Water tower repair contract\n\nThe Board of Aldermen approved the water tower repair contract with Gulf Tank Co. '
                                                            'on March 4, 2025. Vendor contact: 601-555-0188, billing@gulftank.example. Account number: 4400123987.'})
    tower = r['documents'][0]
    s, r = editor.call('POST', f'/{A}/records/{rid}/find')
    sug = next((x for x in r.get('suggestions', []) if x['payload']['docId'] == tower['id']), None)
    ok(s == 200 and sug and sug['status'] == 'pending', 'the AI suggests likely responsive documents from the knowledge base')
    s, r = editor.call('POST', f"/{A}/records/{rid}/suggestions/{sug['id']}", {'decision': 'accepted'})
    kb = next((f for f in r.get('files', []) if f['doc_id'] == tower['id']), None)
    labels = {x['label'] for x in (kb or {}).get('flags', [])}
    ok(s == 200 and kb and kb['status'] == 'review' and {'Email address', 'Phone number', 'Account or routing number', 'Staff-only document in the knowledge base'} <= labels,
       f'accepted suggestions become files flagged for redaction review ({sorted(labels)})')
    s, _ = editor.call('PATCH', f"/{A}/records/{rid}/files/{kb['id']}", {'status': 'approved'})
    ok(s == 400, "a file can't be approved until every possible redaction is resolved")
    editor.call('PATCH', f"/{A}/records/{rid}/files/{kb['id']}", {'status': 'withheld'})
    s, r = upload(editor, f'/{A}/records/{rid}/files', 'tower-minutes.txt',
                  b'Minutes, March 4 2025. The board approved the water tower contract. Resident John Doe, SSN 123-45-6789, spoke in favor.')
    up = next((f for f in r.get('files', []) if f['name'] == 'tower-minutes.txt'), None)
    ok(s == 200 and up and any(x['label'] == 'Social Security number' and '6789' in x['examples'][0] and '123-45' not in x['examples'][0] for x in up['flags']),
       'uploaded files are checked for Social Security numbers, shown masked')
    s, r = editor.call('PATCH', f"/{A}/records/{rid}/files/{up['id']}", {'status': 'approved', 'flags': ['redacted' for _ in up['flags']]})
    ok(s == 200 and next(f for f in r['files'] if f['id'] == up['id'])['status'] == 'approved', 'staff resolve the redactions and approve the file')

    s, _ = editor.call('PUT', f'/{A}/records/settings', {'fees': {'searchHourly': 20}})
    ok(s == 403, "only administrators change the records rules and fee schedule")
    s, rs = admin.call('PUT', f'/{A}/records/settings', {'fees': {'searchHourly': 20, 'perPage': 0.25}, 'closures': ['2026-12-24']})
    ok(s == 200 and rs['fees']['searchHourly'] == 20 and rs['closures'] == ['2026-12-24'], 'administrators set the fee schedule and closure days')
    s, r = editor.call('POST', f'/{A}/records/{rid}/fee', {'searchHours': 1.5, 'pages': 10})
    fee_letter = next((l for l in r.get('letters', []) if l['kind'] == 'fee_estimate'), None)
    ok(s == 200 and r['request']['fee_cents'] == 3250 and r['request']['fee_status'] == 'estimated' and fee_letter and '$32.50' in fee_letter['body'],
       'fees are the actual cost: 1.5 hours search at $20 plus 10 pages at $0.25 = $32.50')
    s, _ = editor.call('POST', f"/{A}/records/{rid}/letters/{fee_letter['id']}/send")
    ok(s == 400, 'letters must be approved before they are sent')
    editor.call('PATCH', f"/{A}/records/{rid}/letters/{fee_letter['id']}", {'status': 'approved'})
    s, r = editor.call('POST', f"/{A}/records/{rid}/letters/{fee_letter['id']}/send")
    ok(s == 200 and r['request']['fee_status'] == 'requested' and r['request']['status'] == 'awaiting_payment', 'sending the fee letter requests payment')

    s, r = editor.call('POST', f'/{A}/records/{rid}/draft', {'kind': 'response'})
    resp = next((l for l in r.get('letters', []) if l['kind'] == 'response'), None)
    ok(s == 200 and resp and resp['status'] == 'draft' and 'TST-PRR-1001' in resp['body'], 'the assistant drafts the response letter for staff review')
    s, r = editor.call('POST', f'/{A}/records/{rid}/release', {'outcome': 'fulfilled', 'letterId': resp['id']})
    ok(s == 400 and 'letter' in r.get('error', ''), 'records are not released until the response letter is approved')
    editor.call('PATCH', f"/{A}/records/{rid}/letters/{resp['id']}", {'status': 'approved'})
    s, r = editor.call('POST', f'/{A}/records/{rid}/release', {'outcome': 'fulfilled', 'letterId': resp['id']})
    ok(s == 400 and 'payment' in r.get('error', ''), 'records are not released before the fee is paid')
    s, r = editor.call('POST', f'/{A}/records/{rid}/fee', {'action': 'paid', 'amount': '32.50', 'note': 'Check 1042'})
    ok(s == 200 and r['request']['fee_status'] == 'paid' and r['request']['status'] == 'in_progress', 'staff record the payment')
    s, r = editor.call('POST', f'/{A}/records/{rid}/release', {'outcome': 'fulfilled', 'letterId': resp['id']})
    ok(s == 200 and r['request']['status'] == 'closed' and r['request']['outcome'] == 'fulfilled', 'staff release the approved records and close the request')
    s, t = anon.call('GET', f"/{A}/records/track/TST-PRR-1001?key={pr['key']}")
    ok([f['name'] for f in t['files']] == ['tower-minutes.txt'] and any(l['subject'] == resp['subject'] for l in t['letters']),
       'the requester sees only the released file and the letters sent to them')
    s, body, _ = raw(anon, f"/{A}/records/download/TST-PRR-1001/{up['id']}?key={pr['key']}")
    ok(s == 200 and b'water tower contract' in body, 'the requester downloads released files with their link')
    s, _, _ = raw(anon, f"/{A}/records/download/TST-PRR-1001/{up['id']}")
    ok(s == 404, 'downloads need the private link')
    s, _, _ = raw(anon, f"/{A}/records/download/TST-PRR-1001/{kb['id']}?key={pr['key']}")
    ok(s == 404, 'withheld files are never downloadable')
    s, _ = upload(editor, f'/{A}/records/{rid}/files', 'late.txt', b'Added after closing, should be refused.')
    ok(s == 400, 'closed requests take no more files')

    # Denials cite the exemption, in writing.
    did = mail['id']
    s, r = editor.call('POST', f'/{A}/records/{did}/draft', {'kind': 'denial', 'exemptions': ['Miss. Code Ann. § 25-61-12: law enforcement investigative records'], 'reason': 'The investigation is open.'})
    den = next(l for l in r['letters'] if l['kind'] == 'denial')
    ok('25-61-12' in den['body'], 'denial letters cite the exemption')
    editor.call('PATCH', f"/{A}/records/{did}/letters/{den['id']}", {'status': 'approved'})
    s, _ = editor.call('POST', f'/{A}/records/{did}/release', {'outcome': 'denied', 'letterId': den['id']})
    ok(s == 400, 'a denial must cite the specific exemption')
    s, r = editor.call('POST', f'/{A}/records/{did}/release', {'outcome': 'denied', 'letterId': den['id'], 'exemptions': ['Miss. Code Ann. § 25-61-12: law enforcement investigative records']})
    ok(s == 200 and r['request']['outcome'] == 'denied' and r['request']['exemptions'], 'denials are recorded with the cited exemption')

    s, csv, headers = raw(editor, f'/{A}/records/export')
    ok(s == 200 and b'TST-PRR-1001' in csv and b'denied' in csv and 'text/csv' in headers.get('Content-Type', ''), 'the records log exports as CSV with outcomes')
    s, r = admin.call('GET', f'/{A}/audit?type=records_request')
    acts = {e['action'] for e in r['events']}
    for act in ['records.create', 'records.update', 'records.extend', 'records.suggestion_accepted', 'records.file_add', 'records.file_review',
                'records.fee_estimated', 'records.fee_requested', 'records.fee_paid', 'records.letter_sent', 'records.close', 'records.export']:
        ok(act in acts, f'audit log records {act}')
    e = next(e for e in r['events'] if e['action'] == 'records.fee_paid')
    ok(e['actor_name'] == 'Eddie Editor' and e['changes']['fee_status'] == ['requested', 'paid'], 'records audit entries carry before and after values')

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
    text, done = chat(A, 'How do I make a public records request for police reports?')
    ok(done['flags'].get('offerRecords') and 'Request public records' in text, 'asking for public records in the chat offers the records request')

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
    ok(s == 200 and 'audit_log' in r and len(r['requests']) == 2, 'admins export the whole city')
finally:
    for slug in (A, B):
        operator.call('PUT', f'/platform/cities/{slug}/status', {'status': 'archived'})

print(f"\n{'All checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
