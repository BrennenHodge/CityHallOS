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
| Department staff | See and work only their department's requests, log phone and counter requests; staff of the permit department (Planning & Building by default) decide permit applications |
| Viewer | See the dashboard and permit applications; resident names and contact details are hidden |

City Hall OS support signs in with the `ADMIN_KEY` access code and acts as an administrator in every city.
Scripts can send the same code as a bearer token.

New staff get a one-time setup link (valid 7 days) from an administrator to choose their password. Removing
someone's access takes effect on their next request.

## Applications (permits, certificates, Planning Commission requests)

Code in `src/permits/`. Every city form residents fill out online is one definition in `forms/`, run by one engine
(`engine.js`), so the chat, the on-screen form, completeness checks, fees, PDFs, the staff queue and notifications work the
same for all of them. The chatbot never links to a PDF form: it offers the online application instead.

| Form | Kind | Number | Replaces Wiggins PDF |
|---|---|---|---|
| Construction permit | `construction` | `{prefix}-BP-1001` | DocumentCenter/View/288 (fills the city's own fillable PDF) |
| Sign permit | `sign` | `SG` | 298 |
| Residential / commercial certificate of occupancy | `co_residential` / `co_commercial` | `CO` / `CC` | 289 / 287 |
| Construction permit exemption certification | `exemption` | `EX` | 297 and 294 |
| Utility connection inspection | `utility_inspection` | `UI` | 296 (approval: 292) |
| Variance, conditional use, zoning amendment | `variance`, `conditional_use`, `rezoning` | `VA`, `CU`, `RZ` | 290, 286, 291 |
| Utility site plan review | `utility_site_plan` | `US` | 299 |

A resident needs no account: each application has a secret link, and its token (an HMAC of the application id, so City
Hall can send the link again) is checked against a hash. Drafts are visible only to whoever holds the link; staff see an
application once it is submitted. Residents who sign in with their phone number (below) also find every application
under My applications.

```
draft → submitted → (needs_info ⇄ submitted) → fees_due → in_review → issued → closed
                                                  denied, or withdrawn by the applicant
```

| File | What it does |
|---|---|
| `engine.js` | `defineForm()`: turns a definition into coercion, show-if rules, checks, progress, the next question, the fee and the public schema. Shared field groups (owner, applicant, hearing representative, signature, notary) |
| `forms/*.js` | One per form: fields, the guided questions, extra checks, derived values, fee, what gets issued. `forms/index.js` lists them and picks the right one from a chat message |
| `converse.js` | Reads chat answers by field type, uses the AI for free-form ones (filling only what the resident said), and answers questions mid-application from the field's explanation and the city's documents |
| `screen.js` | Census geocoder (inside city limits?) and FEMA flood zone for the property address |
| `pdf.js` | Fills the city's own fillable construction PDF, prints any application (with a notary signature page where the city requires one), and draws what City Hall issues |
| `routes.js` | Resident and staff API, the AI completeness review, notifications, daily reminders |

To add a form, add a file to `forms/` and list it in `forms/index.js`. After submission the AI review runs in the
background. If a city turns on `autoReturn` for a form, an application with problems the applicant didn't explain is sent
back automatically, once; after that staff decide. Fees, templates and payment instructions are in the city's
`settings.permits.{kind}` (see `cities/wiggins.json`).

## Resident accounts

`src/residents.js`. Residents sign in with a phone number and a 6-digit texted code (10 minutes, 5 tries, 5 codes an hour
per number); no passwords. City store migration #4 adds `residents`, `resident_codes` and `resident_sessions` (codes and
session tokens stored as SHA-256 hashes) and `permits.resident_id`. A signed-in resident's applications follow them to
any device, and their name, email and mailing address fill in new applications. Sign-in codes are never written to the
outbox. Without Twilio the sign-in is unavailable and applications still work by secret link; locally,
`DEV_SHOW_CODES=1` shows the code on screen instead.

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

## Adding a city

```bash
curl -X POST https://app.cityhallos.com/api/platform/cities \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"City of Poplarville","state":"MS","county":"Pearl River County","requestPrefix":"POP"}'
```

This creates the city as `onboarding` with default departments and request types. Then load its knowledge
(`scripts/crawl.py`, `scripts/seed.py`), fill in Settings, add its first administrator under Staff & access, and
set the status to `active` with `PUT /api/platform/cities/{slug}/status`.
