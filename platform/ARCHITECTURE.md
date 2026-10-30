# City Hall OS data architecture

One Worker serves every city and every channel (dashboard, embedded chat, resident portal, voice, SMS).
Data is split in two:

```
                       ┌──────────────────────────────────────────┐
  dashboard, embed,    │  Worker: cityhallos-platform             │
  portal, voice, SMS ─▶│  HTTP, auth, AI calls, file uploads      │
                       └──────┬──────────────┬──────────────┬─────┘
                              │              │              │
             ┌────────────────▼───┐   ┌──────▼───────┐   ┌──▼──────────────────┐
             │ Platform database  │   │ City stores  │   │ R2: cityhallos-files │
             │ D1 "cityhallos"    │   │ one SQLite   │   │ {city id}/documents/ │
             │ cities, users,     │   │ database per │   │ {city id}/requests/  │
             │ memberships,       │   │ city         │   └──────────────────────┘
             │ sessions           │   │ (CityStore)  │
             └────────────────────┘   └──────────────┘
```

## Platform database (D1, `schema.sql`)

The control plane. It answers "which cities exist" and "who may do what in which city".

| Table | Holds |
|---|---|
| `cities` | Permanent `id` (`ms-wiggins`), public `slug` (`wiggins`), name, state, county, timezone, status, assistant settings |
| `users` | One account per person, by email. A person can work for several cities. Passwords are PBKDF2-SHA256 |
| `memberships` | A person's role in a city, and their department for department staff |
| `sessions`, `auth_tokens` | Signed-in browsers and one-time password setup links, stored as SHA-256 hashes |
| `platform_audit` | Sign-ins and cities added |

## City stores (Durable Objects with SQLite, `src/store.js`)

Every city gets its own SQLite database, named after the city's permanent id. The Worker can only reach a
city's records through `storeFor(env, city)`, so a query for one city can't return another city's rows. There
is no shared table to forget a `WHERE city = ?` on.

Each store holds that city's departments, request types, staff directory, knowledge base (documents, passages and
the full-text index), conversations, citations, service requests with their timelines, permit applications (`permits`,
`permit_files`, `permit_events`), the `outbox` of every email, text and call sent to a resident, and the audit log.

Why one database per city:

- **Isolation.** Records are separated by database, not by a column.
- **Restore and export per city.** A store can be rolled back to any point in the last 30 days without touching
  other cities, and `GET /api/{city}/export` hands a city all of its data.
- **Scale.** Each city has its own 10 GB and its own write throughput, so a big city doesn't slow small ones and
  there is no single database to outgrow.
- **Numbering.** Request numbers are per city: every city's first request is `{prefix}-1001`, and its first permit application
  `{prefix}-BP-1001`.

Schema changes go in the `MIGRATIONS` list in `src/store.js`. Each store applies the ones it hasn't run the next
time it starts, so every city stays on the same schema without a coordinated migration.

## Roles

Defined in `src/auth.js`. Every staff API route names the permission it needs.

| Role | Can |
|---|---|
| Administrator | Everything: staff accounts, roles, settings, export |
| Knowledge editor | Add and change documents, review conversations, read the audit log, see permit applications |
| Department staff | See and work only their department's requests, log phone and counter requests, dispatch their department's crews and work orders; staff of the permit department (Planning & Building by default) decide permit applications |
| Viewer | See the dashboard, dispatch board and permit applications; resident names and contact details are hidden |

City Hall OS support signs in with the `ADMIN_KEY` access code and acts as an administrator in every city.
Scripts can send the same code as a bearer token.

New staff get a one-time setup link (valid 7 days) from an administrator to choose their password. Removing
someone's access takes effect on their next request.

## Permit applications

Code in `src/permits/`. A resident needs no account: each application has a secret link, and its token (an HMAC of the
application id, so City Hall can send the link again) is checked against a hash. Drafts are visible only to whoever holds
the link; staff see an application once it is submitted.

```
draft → submitted → (needs_info ⇄ submitted) → fees_due → in_review → issued → closed
                                                  denied, or withdrawn by the applicant
```

| File | What it does |
|---|---|
| `construction.js` | The application: fields, show-if rules, the guided questions, completeness checks, derived values, fee tiers |
| `converse.js` | Reads chat answers: rules for simple answers, the AI for free-form ones, filling only what the resident said |
| `screen.js` | Census geocoder (inside city limits?) and FEMA flood zone for the job address |
| `pdf.js` | Fills the city's own fillable PDF (field map per template) and draws the permit to post at the site |
| `routes.js` | Resident and staff API, the AI completeness review, notifications, daily reminders |

After submission the AI review runs in the background. If a city turns on `autoReturn`, an application with problems
the applicant didn't explain is sent back automatically, once; after that staff decide. Fees, the form template and
payment instructions are in the city's `settings.permits.construction`.

## Audit log

Every change is written to the city's `audit_log`: who (staff member, resident, AI, support or system), what,
when, and the before and after values of changed fields. Triggers reject any UPDATE or DELETE on the table.
Staff see it under **Activity** in the dashboard.

Service requests also keep a `request_events` timeline. Status changes are shown to the resident on the
tracking page; staff notes are not.

## Channels

Every channel uses the same reply logic (`src/reply.js`): the same knowledge base, emergency and report rules,
and conversation log.

- **Website chat and portal:** `public/embed.js`, streaming from `POST /api/{city}/chat`.
- **Text messages and calls:** `src/phone.js`. Each city's Twilio number sends texts to `POST /api/{city}/twilio/sms`
  and calls to `POST /api/{city}/twilio/voice`. Requests are checked against Twilio's signature (`TWILIO_AUTH_TOKEN`).
  Residents can ask questions, report a problem (the reply walks them through location and details and returns a
  reference number), check a request by texting its number, and ask for a person. Callers are transferred to City Hall
  during office hours. Report and call state lives in `conversations.flow`.

## Routing and office hours

Each city sets its office hours and, per request type, who gets told about new requests during hours and after hours,
and who new requests are assigned to (Settings in the dashboard; `request_types` in the city store). With nobody listed,
everyone in the department with contact details is told.

## Keeping knowledge current

Each city store has an alarm that re-fetches a few of its documents' original web pages and files every hour, so
every source is checked about once a week. A change is flagged under **Needs review** on the knowledge page; nothing
is replaced automatically. Staff re-import the document and mark it **confirmed current**, which records who and when.
Documents confirmed more than a year ago are listed for review again.

## Measuring answers and results

- `platform/evals/<city>.json` holds resident questions with what a good answer must do (cite the right source,
  include or avoid phrases, end as an answer, a staff hand-off, an emergency redirect or a report).
  `scripts/eval.py` grades the assistant against them. Run it after changing prompts, search or models.
- The **Results** page reports questions answered without staff, estimated staff time saved (from the minutes per call
  set in Settings), requests by type and department, and median time to first staff action and to resolution.

## Public Works dispatcher

Turns service requests into scheduled field work (`src/dispatch.js` for the API, `src/dispatch-store.js` for the data,
`public/dispatch.js` for the dashboard pages). It builds on requests rather than replacing them:

- **Crews** are named groups of people from the staff directory, one department each.
- **Work orders** (`WO-1001`, …) belong to a request: crew, date, materials, labor notes and status (scheduled, in progress,
  done, cancelled). A request can have several. Its status follows them: any scheduled → assigned, any started → in progress,
  all done → resolved. Marking a job done needs a before/after photo or a note. Photos are in R2 under `{city id}/work-orders/`.
- **Residents** tracking a request see "Scheduled for <date>", "Rescheduled for <date>" and "Completed on <date>", and are sent
  the same through `notify.js`.
- **The dispatch board** shows today's and this week's work by crew and everything not scheduled yet; **the map** (Leaflet with
  OpenStreetMap tiles) shows open requests and their work; **My work** is the phone view for crews.
- **The dispatcher** suggests: likely duplicates (an earlier open report of the same problem within 80 m, or the same typed
  address), a higher priority (hazard wording, several reports of one spot, a long wait), and a crew and day (work already
  booked nearby, experience with the job, the lightest schedule). Staff accept or dismiss each one; a dismissed suggestion
  isn't made again. Suggestions are recorded in the audit log as the AI's, decisions as the staff member's.
- **Typed addresses** are placed on the map with the free US Census Bureau geocoder, falling back to OpenStreetMap's Nominatim.
  Requests with GPS keep their own coordinates; anything that can't be placed is listed under "No location".

## Adding a city

```bash
curl -X POST https://app.cityhallos.com/api/platform/cities \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"City of Poplarville","state":"MS","county":"Pearl River County","requestPrefix":"POP"}'
```

This creates the city as `onboarding` with default departments and request types. Then load its knowledge
(`scripts/crawl.py`, `scripts/seed.py`), fill in Settings, add its first administrator under Staff & access, and
set the status to `active` with `PUT /api/platform/cities/{slug}/status`.
