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
the full-text index), conversations, citations, service requests with their timelines, boards and meetings (agendas,
minutes, action items), and the audit log.

Why one database per city:

- **Isolation.** Records are separated by database, not by a column.
- **Restore and export per city.** A store can be rolled back to any point in the last 30 days without touching
  other cities, and `GET /api/{city}/export` hands a city all of its data.
- **Scale.** Each city has its own 10 GB and its own write throughput, so a big city doesn't slow small ones and
  there is no single database to outgrow.
- **Numbering.** Request numbers are per city: every city's first request is `{prefix}-1001`.

Schema changes go in the `MIGRATIONS` list in `src/store.js`. Each store applies the ones it hasn't run the next
time it starts, so every city stays on the same schema without a coordinated migration.

## Roles

Defined in `src/auth.js`. Every staff API route names the permission it needs.

| Role | Can |
|---|---|
| Administrator | Everything: staff accounts, roles, settings (including public notice rules), export |
| Knowledge editor | Add and change documents, review conversations, read the audit log; keep boards, agendas and minutes, and approve publishing them (the City Clerk's role) |
| Department staff | See and work only their department's requests, log phone and counter requests; submit agenda items and update action items assigned to them |
| Viewer | See the dashboard, including meetings; resident names and contact details are hidden |

City Hall OS support signs in with the `ADMIN_KEY` access code and acts as an administrator in every city.
Scripts can send the same code as a bearer token.

New staff get a one-time setup link (valid 7 days) from an administrator to choose their password. Removing
someone's access takes effect on their next request.

## Audit log

Every change is written to the city's `audit_log`: who (staff member, resident, AI, support or system), what,
when, and the before and after values of changed fields. Triggers reject any UPDATE or DELETE on the table.
Staff see it under **Activity** in the dashboard.

Service requests also keep a `request_events` timeline. Status changes are shown to the resident on the
tracking page; staff notes are not.

## Meetings (`src/meetings.js`, `src/meetings-store.js`)

The Meeting secretary keeps each city's boards (Board of Aldermen, planning commission…) and their members, and their
meetings: regular, special and work sessions.

- **Agendas.** Staff submit items (`meetings.submit`); the clerk accepts, returns and orders them (`meetings.manage`); a
  person with `meetings.approve` publishes. Publishing after the notice deadline is refused until the approver confirms and
  gives a reason, and the agenda is marked late. Deadlines are per-city settings (`meetings/settings`); Mississippi cities
  default to the Open Meetings Act (Miss. Code Ann. § 25-41-13 notice, § 25-41-11 minutes within 30 days), cited in
  `meetings.js`.
- **Minutes.** Recordings upload to R2 (`{city id}/meetings/{meeting id}/`) in multipart parts and are transcribed with
  Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`) one segment per request, so long meetings show progress and
  resume: MP3 is read from R2 in 2 MB byte ranges; other audio and video is decoded in the dashboard into two-minute
  16 kHz WAV segments. The AI drafts minutes from the transcript or the clerk's typed notes (attendance, motions with
  mover and seconder, votes by name, action items) and lists what to double-check. The clerk edits; a person approves.
- **Publishing.** Residents see only published agendas and approved minutes, at `/{city}/meetings`. Both are snapshots, so
  a revision in progress never changes what is public. Each is also added to the knowledge base (category
  "Meetings & Minutes", verified current), so the AI City Clerk can cite the board's decisions.
- **Action items** from a meeting are assigned to staff; the assignee updates the status.

Every change is in the audit log under the meeting (`entity_type = 'meeting'`).

## Adding a city

```bash
curl -X POST https://app.cityhallos.com/api/platform/cities \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"City of Poplarville","state":"MS","county":"Pearl River County","requestPrefix":"POP"}'
```

This creates the city as `onboarding` with default departments and request types. Then load its knowledge
(`scripts/crawl.py`, `scripts/seed.py`), fill in Settings, add its first administrator under Staff & access, and
set the status to `active` with `PUT /api/platform/cities/{slug}/status`.
