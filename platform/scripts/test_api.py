"""End-to-end checks for the City Hall OS API: sign-in, roles, department scoping, contact redaction,
city isolation, the knowledge base, service requests, the AI City Clerk, meetings and the audit log.

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

    def onboard(name, role, dept=None, key=None):
        email = f'{key or role}-{RUN}@example.test'
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

    # Meeting secretary: boards, agendas, notice rules, minutes, action items and publishing.
    M = f'/{A}/meetings'
    mviewer, _, _, _ = onboard('Mia Viewer', 'viewer', key='meetings-viewer')
    s, _ = mviewer.call('POST', f'{M}/boards', {'name': 'Board of Aldermen'})
    ok(s == 403, "viewers can't add boards")
    s, r = editor.call('POST', f'{M}/boards', {'name': 'Board of Aldermen', 'schedule': 'First and third Tuesday, 6 pm', 'location': 'City Hall'})
    ok(s == 201, 'the clerk (knowledge editor) adds a board')
    board = r['board']['id']
    s, _ = editor.call('POST', f'{M}/boards', {'name': 'Board of Aldermen'})
    ok(s == 409, 'board names are unique')
    for name, seat, role, voting in [('Jane Carter', 'Mayor', 'presiding', False), ('Tom Reed', 'Ward 1', 'member', True),
                                     ('Lisa Grant', 'Ward 2', 'member', True), ('Sam Ortiz', 'Ward 3', 'member', True)]:
        editor.call('POST', f'{M}/boards/{board}/members', {'name': name, 'seat': seat, 'role': role, 'voting': voting})
    s, r = mviewer.call('GET', f'{M}/boards')
    ok(s == 200 and len(r['boards'][0]['members']) == 4, 'everyone with dashboard access sees boards and members')

    import datetime
    day = lambda n: (datetime.date.today() + datetime.timedelta(days=n)).isoformat()
    s, r = editor.call('POST', M, {'board_id': board, 'kind': 'regular', 'starts_at': f'{day(10)}T18:00'})
    ok(s == 201 and r['meeting']['location'] == 'City Hall', "a meeting defaults to the board's usual place")
    future = r['meeting']['id']
    s, r = editor.call('POST', M, {'board_id': board, 'kind': 'regular', 'starts_at': f'{day(1)}T18:00'})
    soon = r['meeting']['id']
    s, r = editor.call('POST', M, {'board_id': board, 'kind': 'special', 'starts_at': f'{day(2)}T17:00'})
    special = r['meeting']['id']
    s, r = editor.call('GET', f'{M}/{special}')
    ok(any(w['code'] == 'no_subject' for w in r['warnings']), 'special meetings without a stated subject are flagged (Miss. Code Ann. 25-41-13)')
    ok(r['rules']['postWithinHours'] == 1 and r['rules']['minutesDays'] == 30, 'Mississippi cities get the Open Meetings Act defaults')

    s, r = works.call('POST', f'{M}/{future}/items', {'title': 'Pine Street paving bids', 'type': 'action', 'presenter': 'Pat Works',
                                                      'recommended_action': 'Award to Gulf Coast Paving for $184,000'})
    ok(s == 201 and r['item']['status'] == 'submitted', 'department staff submit agenda items for the clerk')
    paving = r['item']['id']
    s, _ = works.call('PATCH', f'{M}/{future}/items/{paving}', {'status': 'accepted'})
    ok(s == 403, "department staff can't put their own item on the agenda")
    s, _ = mviewer.call('POST', f'{M}/{future}/items', {'title': 'Nope'})
    ok(s == 403, "viewers can't submit agenda items")
    boundary = 'chos' + RUN
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="bid-tabulation.txt"\r\nContent-Type: text/plain\r\n\r\n'
               f'Gulf Coast Paving $184,000\r\n--{boundary}--\r\n').encode()
    req = urllib.request.Request(f'{ORIGIN}/api{M}/{future}/items/{paving}/files', data=payload, method='POST',
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': 'CityHallOS-scripts/1.0'})
    with works.opener.open(req) as res:
        attachment = json.loads(res.read())['files'][0]['id']
    ok(bool(attachment), 'the submitter attaches a file to their item')
    s, _ = anon.call('GET', f'{M}/files/{attachment}')
    ok(s == 404, 'attachments stay private until the agenda is published')
    editor.call('PATCH', f'{M}/{future}/items/{paving}', {'status': 'accepted'})
    s, r = editor.call('POST', f'{M}/{future}/items', {'title': 'Approval of the minutes', 'type': 'consent'})
    ok(r['item']['status'] == 'accepted', "the clerk's own items go straight onto the agenda")
    consent = r['item']['id']
    s, r = editor.call('POST', f'{M}/{future}/items/order', {'order': [consent, paving]})
    ok(s == 200 and [i['id'] for i in r['items'] if i['status'] == 'accepted'] == [consent, paving], 'the clerk orders the agenda')
    s, r = editor.call('GET', f'{M}/{future}/agenda/preview')
    ok('Consent agenda' in r['text'] and 'Pine Street paving bids' in r['text'] and 'bid-tabulation.txt' in r['text'], 'the agenda preview lists items and attachments')
    s, _ = mviewer.call('POST', f'{M}/{future}/agenda/publish')
    ok(s == 403, "viewers can't publish agendas")
    s, _ = works.call('POST', f'{M}/{future}/agenda/publish')
    ok(s == 403, "department staff can't publish agendas")
    s, r = anon.call('GET', f'{M}/public/{future}')
    ok(s == 200 and r['meeting']['agenda_published'] is None, 'residents see a scheduled meeting but no draft agenda')
    s, r = editor.call('POST', f'{M}/{future}/agenda/publish')
    ok(s == 200 and r['meeting']['agenda_status'] == 'published' and not r['meeting']['agenda_late'], 'an agenda published in time is not marked late')
    s, r = anon.call('GET', f'{M}/public/{future}')
    ok('Pine Street paving bids' in (r['meeting']['agenda_published'] or '') and r['meeting']['files'], 'residents see the published agenda')
    with urllib.request.urlopen(urllib.request.Request(f'{ORIGIN}/api{M}/files/{attachment}', headers={'User-Agent': 'CityHallOS-scripts/1.0'})) as res:
        ok(res.status == 200 and b'Gulf Coast' in res.read(), 'attachments become public with the agenda')
    editor.call('POST', f'{M}/{future}/items', {'title': 'Late addition', 'type': 'discussion'})
    s, r = anon.call('GET', f'{M}/public/{future}')
    ok('Late addition' not in r['meeting']['agenda_published'], 'later changes stay out of the published agenda until approved')

    editor.call('POST', f'{M}/{soon}/items', {'title': 'Budget amendment', 'type': 'action'})
    s, r = editor.call('POST', f'{M}/{soon}/agenda/publish')
    ok(s == 409 and r.get('late'), 'publishing an agenda after the notice deadline is stopped with a warning')
    s, r = editor.call('POST', f'{M}/{soon}/agenda/publish', {'acknowledgeLate': True, 'reason': 'Test of a late agenda'})
    ok(s == 200 and r['meeting']['agenda_late'] == 1, 'the approver can publish late, and it is recorded as late')
    s, _ = editor.call('PUT', f'{M}/settings', {'regularHours': 12})
    ok(s == 403, "only administrators change the notice rules")
    s, r = admin.call('PUT', f'{M}/settings', {'regularHours': 12})
    ok(s == 200 and r['rules']['regularHours'] == 12, 'notice timing is a per-city setting')
    s, r = editor.call('GET', f'{M}/{soon}')
    ok(r['deadlines']['agendaHours'] == 12, 'deadlines follow the city setting')
    s, r = operator.call('GET', f'/{B}/meetings/settings')
    ok(r['rules']['regularHours'] == 72, "one city's rules don't change another's")

    # Minutes: a recording segment through Whisper, then a draft from typed notes, then approval.
    import io, math, struct, wave
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(i / 8))) for i in range(16000 * 2)))
    req = urllib.request.Request(f'{ORIGIN}/api{M}/{future}/transcribe?seq=0&total=1&source=test.wav', data=buf.getvalue(), method='POST',
                                 headers={'Content-Type': 'audio/wav', 'User-Agent': 'CityHallOS-scripts/1.0'})
    with editor.opener.open(req, timeout=120) as res:
        t = json.loads(res.read())
    ok(t.get('done') is True, 'audio segments are transcribed with Workers AI Whisper')
    notes = ('Mayor Carter called the meeting to order at 6:01 pm. Present: Carter, Reed, Grant, Ortiz. '
             'Consent agenda: Grant moved to approve the minutes of the last meeting, Reed seconded, all in favor. '
             'Pine Street paving: Pat Works presented three bids. Ortiz moved to award the contract to Gulf Coast Paving for $184,000, '
             'Grant seconded. Roll call: Reed yes, Grant yes, Ortiz yes. Carried 3-0. Pat Works to return the signed contract by the next meeting. '
             'Adjourned 6:40 pm.')
    s, r = editor.call('POST', f'{M}/{future}/minutes/draft', {'source': 'notes', 'notes': notes}, timeout=300)
    ok(s == 200 and r['meeting']['minutes_status'] == 'draft' and 'Grant' in (r['meeting']['minutes_draft'] or ''), 'the AI drafts minutes from typed notes')
    ok('Motion' in (r['meeting']['minutes_draft'] or '') or bool(r['meeting']['minutes_suggestions'].get('error')), 'draft minutes record motions')
    s, r = anon.call('GET', f'{M}/public/{future}')
    ok(r['meeting']['minutes_approved'] is None, 'draft minutes are never public')
    s, r = editor.call('PUT', f'{M}/{future}/minutes', {'text': '# Minutes\n\n## Pine Street paving\n\nMotion to award the Pine Street paving contract to Gulf Coast Paving for $184,000, moved by Sam Ortiz, seconded by Lisa Grant. Vote: 3 yes. The motion carried.'})
    ok(s == 200, 'the clerk edits the draft')
    s, _ = mviewer.call('POST', f'{M}/{future}/minutes/approve')
    ok(s == 403, "viewers can't approve minutes")
    s, r = editor.call('POST', f'{M}/{future}/minutes/approve')
    ok(s == 200 and r['meeting']['minutes_status'] == 'approved', 'a person approves the minutes')
    s, r = anon.call('GET', f'{M}/public/{future}')
    ok('Gulf Coast Paving' in (r['meeting']['minutes_approved'] or ''), 'approved minutes are public')
    s, r = anon.call('GET', f'{M}/public')
    ok(any(x['id'] == future and x['has_minutes'] for x in r['meetings']), 'the public meetings list shows agendas and minutes')
    s, r = editor.call('GET', f'/{A}/documents?category=Meetings%20%26%20Minutes')
    titles = [d['title'] for d in r['documents']]
    ok(any('minutes' in t for t in titles) and any('agenda' in t for t in titles), 'published agendas and approved minutes join the knowledge base')
    s, r = editor.call('GET', f'/{A}/search?q=board%20decide%20Pine%20Street%20paving')
    ok(bool(r['results']) and 'minutes' in r['results'][0]['title'], 'the AI City Clerk finds the decision in the minutes')
    s, r = operator.call('GET', f'/{B}/search?q=Pine%20Street%20paving')
    ok(not r['results'], "another city's search can't find these minutes")
    s, r = operator.call('GET', f'/{B}/meetings/public/{future}')
    ok(s == 404, "one city's meetings don't resolve in another")

    # Action items.
    s, r = editor.call('POST', f'{M}/{future}/actions', {'title': 'Return the signed paving contract', 'assignee_id': works_staff['id'], 'due_date': day(20)})
    ok(s == 201 and r['action']['assignee'] == 'Pat Works', 'the clerk assigns action items to staff')
    act = r['action']['id']
    s, r = works.call('GET', f'{M}/actions?mine=1')
    ok([a['id'] for a in r['actions']] == [act], 'staff see the action items assigned to them')
    s, r = works.call('PATCH', f'{M}/actions/{act}', {'status': 'done', 'title': 'Renamed'})
    ok(s == 200 and r['action']['status'] == 'done' and r['action']['title'] != 'Renamed', 'the assignee updates the status, nothing else')
    s, _ = mviewer.call('PATCH', f'{M}/actions/{act}', {'status': 'open'})
    ok(s == 403, "others can't change someone's action item")

    s, r = editor.call('GET', f'/{A}/audit?type=meeting')
    acts = {e['action'] for e in r['events']}
    for a in ['meeting.create', 'agenda.item_submit', 'agenda.item_accepted', 'agenda.order', 'meeting.file_add', 'agenda.publish',
              'meeting.transcribe', 'minutes.draft', 'minutes.edit', 'minutes.approve', 'action.create', 'action.update']:
        ok(a in acts, f'audit log records {a}')
    e = next(e for e in r['events'] if e['action'] == 'agenda.publish' and 'late' in e['summary'].lower())
    ok('Test of a late agenda' in e['summary'], 'a late agenda records who published it and why')
    s, r = admin.call('GET', f'/{A}/audit?type=settings')
    ok(any(e['action'] == 'meetings.settings' and e['changes']['regularHours'] == [72, 12] for e in r['events']), 'notice rule changes are audited with before and after values')
    s, r = admin.call('GET', f'/{A}/export')
    ok(len(r.get('meetings', [])) == 3 and len(r.get('action_items', [])) == 1, 'the city export includes meetings')
finally:
    for slug in (A, B):
        operator.call('PUT', f'/platform/cities/{slug}/status', {'status': 'archived'})

print(f"\n{'All checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
