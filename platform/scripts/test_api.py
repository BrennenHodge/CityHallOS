"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, business licenses, the AI City Clerk and the audit log.

Usage: python -I test_api.py <origin> <key_file>
  python -I platform/scripts/test_api.py http://127.0.0.1:8787 platform/.dev.vars
  python -I platform/scripts/test_api.py https://staging.cityhallos.com .secrets/staging-admin-key.txt

Each run creates two throwaway test cities with their own staff and archives them at the end, so it
never touches a real city. It refuses to run against production.
"""
import datetime, http.cookiejar, json, secrets, sys, urllib.error, urllib.request
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
        email = f"{name.split()[0].lower()}-{RUN}@example.test"
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
    clerk, _, _, _ = onboard('Cleo Clerk', 'department', 'city-hall')

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

    # Business licenses (Miss. Code Ann. § 27-17).
    def raw(method, path, who=None):
        req = urllib.request.Request(f'{ORIGIN}/api{path}', method=method, headers={'User-Agent': 'CityHallOS-scripts/1.0'})
        try:
            with (who.opener if who else urllib.request.build_opener()).open(req, timeout=60) as res:
                return res.status, res.headers.get('Content-Type', ''), res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get('Content-Type', ''), e.read()
    today = datetime.date.today()
    s, r = clerk.call('GET', f'/{A}/licenses/settings')
    ok(s == 200 and not r['configured'] and r['stateSchedule'], 'licensing clerk opens license settings, with the state schedule as a template')
    schedule = r['stateSchedule']
    s, _ = clerk.call('PUT', f'/{A}/licenses/settings', {'classes': schedule})
    ok(s == 403, "only administrators change license fees")
    s, r = admin.call('PUT', f'/{A}/licenses/settings', {'classes': schedule, 'officerName': 'Cleo Clerk', 'officerTitle': 'City Clerk',
                                                         'requirements': 'Bring a photo ID.', 'homeRules': 'No retail traffic in residential zones.'})
    ok(s == 200 and r['configured'] and len(r['config']['classes']) == 3, 'admins set license classes and fees')
    s, info = anon.call('GET', f'/{A}/licenses/info')
    general = next(c for c in info['classes'] if c['key'] == 'general')
    ok(s == 200 and '$20.00' in general['fee'] and info['requirements'] == 'Bring a photo ID.', 'residents see the classes and fees the city set')
    s, _ = works.call('GET', f'/{A}/licenses/applications')
    ok(s == 403, "staff of other departments can't work licenses")

    # Guided intake: answer only what's asked; nothing already given is asked again.
    answers = {'kind': 'new', 'class_key': 'General business', 'entity_type': 'skip', 'location': '12 Pine St',
               'inside_limits': 'yes', 'home_based': 'yes', 'home_customers': 'no', 'home_workers': 'no', 'home_outside': 'no', 'employees': 'just me',
               'start_date': 'skip', 'sos_id': 'none', 'dor_account': 'applied', 'state_licenses': 'health department food permit',
               'phone': '601-555-0142', 'email': 'skip'}
    draft = {'business_name': 'Sweet Treats Bakery', 'description': 'Home bakery selling cakes', 'owner_name': 'Jane Baker'}
    asked, step = [], {'ask': True}
    s, step = anon.call('POST', f'/{A}/licenses/intake', {'draft': draft})
    ok(s == 200 and step['intro'] and 'approve' in step['intro'], 'intake starts by explaining that City Hall staff decide')
    for _ in range(25):
        if not step.get('ask'): break
        f = step['ask']['field']
        asked.append(f)
        s, step = anon.call('POST', f'/{A}/licenses/intake', {'draft': step['draft'], 'field': f, 'answer': answers.get(f, 'skip')})
    ok(step.get('ready') and not {'business_name', 'description', 'owner_name'} & set(asked), f'intake asks only for what is missing ({len(asked)} questions)')
    ok(len(asked) == len(set(asked)), 'intake never asks the same question twice')
    ok(any('City Hall confirms' in n for n in step['notes']) or any(r[0] == 'License class' for r in step['review']['rows']), 'intake shows the fee estimate from the city schedule')
    s, r = anon.call('POST', f'/{A}/licenses/intake', {'draft': {'kind': 'new'}, 'field': 'inside_limits', 'answer': 'no, out in the county'})
    ok(any('Test County' in n for n in r['notes']), 'outside city limits, intake explains the county issues the license')
    s, r = anon.call('POST', f'/{A}/licenses/applications', {'draft': {'business_name': 'Nope'}})
    ok(s == 400, 'incomplete applications are refused')
    s, sub = anon.call('POST', f'/{A}/licenses/applications', {'draft': step['draft']})
    ok(s == 201 and sub['ref'] == 'TST-BL-1001' and f'ref={sub["ref"]}' in sub['trackUrl'], f"a city's first application is TST-BL-1001 ({sub.get('ref')})")
    s, t = anon.call('GET', f'/{A}/licenses/track/tst-bl-1001')
    ok(s == 200 and t['status'] == 'submitted' and 'phone' not in t, 'tracking shows status without contact details')

    # Staff review queue.
    s, r = clerk.call('GET', f'/{A}/licenses/applications?status=open')
    app_id = r['applications'][0]['id']
    ok(s == 200 and r['applications'][0]['class_label'] == 'General business', 'the licensing clerk sees the application in the queue')
    s, r = editor.call('GET', f'/{A}/licenses/applications/{app_id}')
    ok(s == 200 and r['application']['phone'] == 'Hidden', 'roles without contact access see applications with contact details hidden')
    s, _ = editor.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'review'})
    ok(s == 403, "knowledge editors can't work license applications")
    clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'review'})
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'request_info', 'message': 'Please send a copy of your health department permit.'})
    ok(s == 200 and r['application']['status'] == 'needs_info', 'staff ask the applicant for missing information')
    s, t = anon.call('GET', f'/{A}/licenses/track/TST-BL-1001')
    ok(t['status'] == 'needs_info' and any('health department permit' in (u['note'] or '') for u in t['updates']), 'the applicant sees what is missing')
    s, r = anon.call('POST', f'/{A}/licenses/track/TST-BL-1001/reply', {'message': 'Permit number HD-2291, copy dropped off today.'})
    ok(s == 200 and r['status'] == 'in_review', 'the applicant replies and the application goes back to review')
    s, r = clerk.call('GET', f'/{A}/licenses/applications/{app_id}')
    sug = r['application']['suggested']
    ok(sug['total_cents'] > 0 and sug['period']['end'].endswith('-09-30'), f"fee suggested from the schedule ({sug['total_cents']} cents, through {sug['period']['end']})")
    ok(any('notified' in (h['note'] or '') for h in r['application']['history']), 'the timeline says whether the applicant was notified')
    s, _ = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'payment', 'method': 'cash', 'amount_cents': 2000})
    ok(s == 400, "payment can't be recorded before the fee is assessed")
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'assess', 'lines': sug['lines']})
    fee = r['application']['fee_cents']
    ok(s == 200 and r['application']['status'] == 'awaiting_payment' and fee == sug['total_cents'], 'staff assess the fee')
    s, t = anon.call('GET', f'/{A}/licenses/track/TST-BL-1001')
    ok(t['fee_cents'] == fee and 'cash or check' in t['next'], 'the applicant sees the fee and how to pay')
    s, _ = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'payment', 'method': 'cash', 'amount_cents': fee - 1})
    ok(s == 400, 'a payment that does not match the fee is refused')
    s, _ = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'payment', 'method': 'check', 'amount_cents': fee})
    ok(s == 400, 'a check payment needs the check number')
    s, _ = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'issue'})
    ok(s == 400, "a license can't be issued before payment")
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'payment', 'method': 'check', 'check_number': '1043', 'receipt_no': 'R-77', 'amount_cents': fee})
    ok(s == 200 and r['application']['status'] == 'paid', 'staff record a check payment at the counter')
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{app_id}', {'action': 'issue'})
    lic = r['application']['license']
    ok(s == 200 and r['application']['status'] == 'issued' and lic['number'] == 'TST-LIC-1001' and lic['status'] == 'active', 'staff issue license TST-LIC-1001')
    s, t = anon.call('GET', f'/{A}/licenses/track/TST-BL-1001')
    ok(t['status'] == 'issued' and t['certificate'] and t['license']['number'] == 'TST-LIC-1001', 'the applicant sees the license on the tracking page')
    s, ct, body = raw('GET', f'/{A}/licenses/track/TST-BL-1001/certificate')
    ok(s == 200 and ct == 'application/pdf' and body[:5] == b'%PDF-', f'the applicant downloads the license certificate PDF ({len(body)} bytes)')
    s, ct, body = raw('GET', f"/{A}/licenses/registry/{lic['id']}/certificate", clerk)
    ok(s == 200 and body[:5] == b'%PDF-', 'staff print the certificate from the registry')
    s, r = anon.call('GET', f'/{A}/licenses/lookup?q=sweet')
    hit = r['results'][0] if r.get('results') else {}
    ok(hit.get('status') == 'active' and 'Pine' not in hit.get('location', '') and 'phone' not in hit, 'public lookup shows the license, without a home address or contact details')
    s, r = anon.call('GET', f'/{B}/licenses/lookup?q=sweet')
    ok(s == 200 and not r['results'], "another city's lookup can't find it")

    # Paying by card when sending the application. No processor is connected, so payments run in test mode.
    paid_draft = dict(step['draft'], business_name='Pine Cone Candles')
    s, r = anon.call('POST', f'/{A}/licenses/intake', {'draft': paid_draft, 'field': 'email', 'answer': 'candles@example.test'})
    pay_now = (r.get('review') or {}).get('payNow') or {}
    ok(s == 200 and r['ready'] and pay_now.get('cents', 0) > 0 and r['payments']['testMode'], f"the review shows the fee due now from the city's schedule ({pay_now.get('cents')} cents)")
    paid_draft = r['draft']
    card = {'name': 'Jane Baker', 'number': '4242 4242 4242 4242', 'exp': '12/30', 'cvc': '123', 'zip': '39577'}
    s, r = anon.call('POST', f'/{A}/licenses/applications', {'draft': paid_draft, 'payment': {**card, 'number': '4000 0000 0000 0002'}})
    ok(s == 402 and 'declined' in r['error'], 'a declined card is refused')
    s, r = anon.call('POST', f'/{A}/licenses/applications', {'draft': paid_draft, 'payment': {**card, 'number': '4111 1111 1111 1111'}})
    ok(s == 402 and 'test mode' in r['error'], 'in test mode a real card number is never charged')
    s, r = anon.call('POST', f'/{A}/licenses/applications', {'draft': paid_draft, 'payment': card, 'expectCents': pay_now.get('cents', 0) + 1})
    ok(s == 409, 'the amount charged is the fee the server works out, not one sent by the browser')
    s, paid = anon.call('POST', f'/{A}/licenses/applications', {'draft': paid_draft, 'payment': card, 'expectCents': pay_now.get('cents')})
    ok(s == 201 and paid['paid']['amount_cents'] == pay_now['cents'] and paid['paid']['last4'] == '4242', 'applicants pay by card when they send the application')
    s, t = anon.call('GET', f"/{A}/licenses/track/{paid['ref']}")
    ok(t['paid_cents'] == pay_now['cents'] and '4242 4242' not in json.dumps(t) and any('ending 4242' in (u['note'] or '') for u in t['updates']),
       'tracking shows the payment and never the card number')
    s, r = clerk.call('GET', f"/{A}/licenses/applications?q={paid['ref']}")
    pid = r['applications'][0]['id']
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{pid}', {'action': 'assess', 'lines': [{'label': 'Corrected fee', 'cents': pay_now['cents'] + 1000}]})
    ok(s == 200 and r['application']['status'] == 'awaiting_payment', 'when staff raise the fee, the difference is due')
    s, t = anon.call('GET', f"/{A}/licenses/track/{paid['ref']}")
    ok(t['canPay'] and t['balance_cents'] == 1000, 'the applicant sees the balance due and can pay it online')
    s, r = anon.call('POST', f"/{A}/licenses/track/{paid['ref']}/pay", {'card': card, 'expectCents': 1000})
    ok(s == 200 and r['paid']['amount_cents'] == 1000, 'the applicant pays the balance from the tracking page')
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{pid}', {'action': 'issue'})
    ok(s == 200 and r['application']['status'] == 'issued', 'a license paid online is issued')
    s, paid2 = anon.call('POST', f'/{A}/licenses/applications', {'draft': dict(paid_draft, business_name='Short Lived LLC'), 'payment': card})
    s, r = clerk.call('GET', f"/{A}/licenses/applications?q={paid2['ref']}")
    s, r = clerk.call('PATCH', f"/{A}/licenses/applications/{r['applications'][0]['id']}", {'action': 'deny', 'reason': 'Zoning does not allow this use.'})
    ok(s == 200 and r['application']['refunded_cents'] == pay_now['cents'], 'denying an application paid by card refunds the payment')

    # Denials need a reason, which the applicant sees.
    s, sub2 = anon.call('POST', f'/{A}/licenses/applications', {'draft': {'kind': 'new', 'business_name': 'Late Night Fireworks', 'owner_name': 'Sam Spark',
                                                                          'location': '1 Hwy 49', 'inside_limits': 'yes', 'employees': 2, 'email': 'sam@example.test'}})
    s, r = clerk.call('GET', f'/{A}/licenses/applications?q=fireworks')
    id2 = r['applications'][0]['id']
    s, _ = clerk.call('PATCH', f'/{A}/licenses/applications/{id2}', {'action': 'deny'})
    ok(s == 400, 'denying needs a reason')
    s, r = clerk.call('PATCH', f'/{A}/licenses/applications/{id2}', {'action': 'deny', 'reason': 'Fireworks sales are not allowed at this location.'})
    s, t = anon.call('GET', f"/{A}/licenses/track/{sub2['ref']}")
    ok(t['status'] == 'denied' and 'not allowed' in t['decision_reason'], 'denied applicants see the reason')

    # The registry: earlier licenses, renewals with late penalties, renewal notices, revocation.
    lapsed_on = (today - datetime.timedelta(days=40)).isoformat()
    s, r = clerk.call('POST', f'/{A}/licenses/registry', {'number': 'TST-LIC-0042', 'business_name': 'Pine Street Hardware', 'owner_name': 'Hal Hammer', 'class_key': 'general',
                                                          'location': '200 Pine St', 'email': 'hal@example.test', 'issued_on': (today - datetime.timedelta(days=400)).isoformat(), 'expires_on': lapsed_on})
    old = r.get('license', {})
    ok(s == 201 and old.get('status') == 'expired', 'staff add an earlier license from the paper register, and it shows as expired')
    s, r = anon.call('POST', f'/{A}/licenses/intake', {'draft': {}, 'message': 'I need to renew TST-LIC-0042'})
    ok(r['draft'].get('business_name') == 'Pine Street Hardware' and (r['ask'] or {}).get('field') != 'business_name', 'renewal intake starts from the registry')
    s, r = clerk.call('POST', f"/{A}/licenses/registry/{old['id']}/renew")
    ok(s == 201, 'staff start a renewal at the counter')
    s, _ = clerk.call('POST', f"/{A}/licenses/registry/{old['id']}/renew")
    ok(s == 409, 'only one renewal can be open per license')
    s, ed = clerk.call('PATCH', f"/{A}/licenses/applications/{r['id']}", {'action': 'edit', 'fields': {'employees': 3}})
    ok(s == 200 and ed['application']['employees'] == 3, 'staff correct details on an application')
    s, ren = clerk.call('GET', f"/{A}/licenses/applications/{r['id']}")
    ok(any(l.get('penalty') for l in ren['application']['suggested']['lines']), 'a lapsed renewal is offered the § 27-17-467 late penalty')
    s, r = operator.call('POST', f'/{A}/licenses/notices', {'asOf': f'{int(sug["period"]["end"][:4])}-08-01'})
    ok(s == 200 and r['renewal'] >= 1 and r['notSent'] >= 1, f"renewal notices come due on the first of the month before expiry ({r.get('renewal')} due)")
    s, r = operator.call('POST', f'/{A}/licenses/notices', {'asOf': f'{int(sug["period"]["end"][:4])}-08-01'})
    ok(s == 200 and r['renewal'] == 0, 'each renewal notice goes out once')
    s, r = clerk.call('GET', f'/{A}/licenses/registry?status=active')
    first = next((l for l in r['licenses'] if l['number'] == 'TST-LIC-1001'), {})
    ok('not sent' in (first.get('reminder_result') or ''), 'the registry shows the notice and that messaging is not connected')
    s, _ = clerk.call('PATCH', f"/{A}/licenses/registry/{lic['id']}", {'action': 'revoke'})
    ok(s == 400, 'revoking needs a reason')
    s, r = clerk.call('PATCH', f"/{A}/licenses/registry/{lic['id']}", {'action': 'revoke', 'reason': 'Closed the business'})
    s, look = anon.call('GET', f'/{A}/licenses/lookup?q=TST-LIC-1001')
    ok(look['results'][0]['status'] == 'revoked', 'revoked licenses show as revoked in the lookup')
    s, _, _ = raw('GET', f'/{A}/licenses/track/TST-BL-1001/certificate')
    ok(s == 404, 'a revoked license has no downloadable certificate')
    s, r = clerk.call('PATCH', f"/{A}/licenses/registry/{lic['id']}", {'action': 'reinstate', 'reason': 'Reopened'})
    ok(s == 200 and r['license']['status'] == 'active', 'staff reinstate a license')
    text, done = chat(A, 'How do I get a business license to open a bakery?')
    ok(done['flags'].get('offerLicense'), 'asking the AI City Clerk about a business license offers the application')

    # Audit log.
    s, r = admin.call('GET', f'/{A}/audit')
    acts = {e['action'] for e in r['events']}
    s, lr = admin.call('GET', f'/{A}/audit?type=license')
    for a in ['license.settings', 'license.apply', 'license.in_review', 'license.needs_info', 'license.reply', 'license.awaiting_payment', 'license.paid',
              'license.issue', 'license.issued', 'license.denied', 'license.import', 'license.reminder', 'license.revoke', 'license.reinstate']:
        ok(a in {e['action'] for e in lr['events']}, f'audit log records {a}')
    e = next(e for e in lr['events'] if e['action'] == 'license.awaiting_payment' and e['entity_id'] == 'TST-BL-1001')
    ok(e['actor_name'] == 'Cleo Clerk' and e['changes']['fee_cents'] == [None, fee], 'license audit entries name the person and the before and after values')
    for a in ['city.create', 'request.create', 'request.update', 'document.create', 'document.update', 'document.delete',
              'staff.create', 'access.role', 'access.revoke', 'access.setup_link', 'settings.update']:
        ok(a in acts, f'audit log records {a}')
    e = next(e for e in r['events'] if e['action'] == 'document.update')
    ok(e['actor_name'] == 'Eddie Editor' and e['changes']['verification'] == ['verified_current', 'historical'], 'audit entries name the person and the before and after values')
    s, _ = works.call('GET', f'/{A}/audit')
    ok(s == 403, "department staff can't read the audit log")
    s, r = admin.call('GET', f'/{A}/export')
    ok(s == 200 and 'audit_log' in r and len(r['requests']) == 2 and len(r['licenses']) == 3, 'admins export the whole city')
finally:
    for slug in (A, B):
        operator.call('PUT', f'/platform/cities/{slug}/status', {'status': 'archived'})

print(f"\n{'All checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
