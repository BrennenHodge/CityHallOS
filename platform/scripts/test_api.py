"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, the AI City Clerk and the audit log.

Usage: python -I test_api.py <origin> <key_file>
  python -I platform/scripts/test_api.py http://127.0.0.1:8787 platform/.dev.vars
  python -I platform/scripts/test_api.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Each run creates two throwaway test cities with their own staff and archives them at the end, so it
never touches a real city. It refuses to run against production.
"""
import http.cookiejar, json, secrets, sys, urllib.request
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
    ok(done['flags'].get('offerForm') == 'construction', 'describing building work offers the construction permit application')
    text, done = chat(A, 'How do I get a variance? My carport would be too close to the side property line')
    ok(done['flags'].get('offerForm') == 'variance', 'asking about a variance offers the variance application, not a PDF')
    s, r = anon.call('GET', f'/{A}/forms')
    kinds = [f['kind'] for f in r.get('forms', [])]
    ok(s == 200 and {'construction', 'variance', 'sign', 'co_residential', 'exemption'} <= set(kinds) and all('url' not in f for f in r['forms']),
       f'the forms list is the online applications, with no PDF links ({len(kinds)} forms)')

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

    # Other applications run on the same engine, each with its own number prefix.
    s, va = anon.call('POST', f'/{A}/permits', {'kind': 'variance'})
    ok(s == 201 and va['kind'] == 'variance' and va['ask'], 'a resident starts a variance application')
    vtok = {'X-Permit-Token': va['token']}
    s, r = anon.call('POST', f"/{A}/permits/{va['id']}/message", {'text': 'What is a variance?', 'ask': va['ask']['id']}, vtok)
    ok(s == 200 and r.get('question') and r['reply'] and r['ask']['id'] == va['ask']['id'], 'a question mid-application is answered, then the same question is asked again')
    s, sc = anon.call('GET', f'/{A}/permits/schema/sign')
    ok(s == 200 and sc['kind'] == 'sign' and sc['issue']['noun'] == 'permit' and sc['sections'], 'each form publishes its own schema')
    s, co = anon.call('POST', f'/{A}/permits', {'kind': 'co_residential'})
    s, r = anon.call('POST', f"/{A}/permits/{co['id']}/submit", {}, {'X-Permit-Token': co['token']})
    ok(s == 400 and r.get('checks'), "an incomplete certificate of occupancy application can't be submitted")
    s, r = anon.call('POST', f'/{A}/permits', {'kind': 'not_a_form'})
    ok(s == 400, 'unknown application types are refused')

    # Residents sign in with a phone number; their applications follow them.
    s, r = anon.call('POST', f'/{A}/me/code', {'phone': '601-555-0177'})
    if s == 503:
        print('  (phone sign-in skipped: text messages are not set up here)')
    else:
        ok(s == 200 and r.get('devCode'), 'a sign-in code is sent to a phone number (shown on screen locally)')
        s, bad = anon.call('POST', f'/{A}/me/verify', {'phone': '6015550177', 'code': '000000' if r['devCode'] != '000000' else '111111'})
        ok(s == 400, 'a wrong code is refused')
        s, v = anon.call('POST', f'/{A}/me/verify', {'phone': '(601) 555-0177', 'code': r['devCode']})
        ok(s == 200 and v.get('token') and v['profile']['phone'] == '(601) 555-0177', 'the right code signs the resident in')
        me = {'X-Resident-Token': v['token']}
        s, _ = anon.call('POST', f'/{A}/me/verify', {'phone': '6015550177', 'code': r['devCode']})
        ok(s == 400, 'a sign-in code works only once')
        anon.call('PATCH', f'/{A}/me', {'name': 'Rita Resident', 'email': 'rita@example.test'}, me)
        s, c = anon.call('POST', f'/{A}/me/claim', {'applications': [{'id': va['id'], 'token': va['token']}, {'id': co['id'], 'token': 'wrong'}]}, me)
        ok(s == 200 and c['claimed'] == 1, 'applications started on this device join the account, only with their secret link')
        s, ex = anon.call('POST', f'/{A}/permits', {'kind': 'exemption'}, me)
        s, r = anon.call('PATCH', f"/{A}/permits/{ex['id']}", {'data': {'applicant_role': 'owner'}}, {'X-Permit-Token': ex['token'], **me})
        ok(r['data'].get('owner_name') == 'Rita Resident' and r['data'].get('owner_email') == 'rita@example.test', "the resident's profile fills in their details")
        s, m = anon.call('GET', f'/{A}/me', headers=me)
        ok(s == 200 and {a['id'] for a in m['applications']} >= {va['id'], ex['id']} and all(a['token'] for a in m['applications']), 'My applications lists them on any device')
        s, _ = anon.call('GET', f'/{B}/me', headers=me)
        ok(s == 401, "a resident's sign-in doesn't carry over to another city")
        anon.call('POST', f'/{A}/me/logout', {}, me)
        s, _ = anon.call('GET', f'/{A}/me', headers=me)
        ok(s == 401, 'signing out ends the session')

    # Permit applications: City Hall's side.
    planner, _, _, _ = onboard('Pia Planning', 'department', 'planning-building')
    s, r = planner.call('GET', f'/{A}/permits')
    ok(s == 200 and [x['ref'] for x in r['permits']] == ['TST-BP-1001'] and r['permits'][0]['title'] == 'Construction permit', 'permit staff see submitted applications, not drafts')
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

    # Audit log.
    s, r = admin.call('GET', f'/{A}/audit')
    acts = {e['action'] for e in r['events']}
    for a in ['city.create', 'request.create', 'request.update', 'document.create', 'document.update', 'document.delete',
              'staff.create', 'access.role', 'access.revoke', 'access.setup_link', 'settings.update',
              'permit.submit', 'permit.needs_info', 'permit.resubmit', 'permit.fees_due', 'permit.in_review', 'permit.issued']:
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
