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
the full-text index), conversations, citations, service requests with their timelines, and the audit log.

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
| Administrator | Everything: staff accounts, roles, settings, export |
| Knowledge editor | Add and change documents, review conversations, read the audit log |
| Department staff | See and work only their department's requests, log phone and counter requests, dispatch their department's crews and work orders |
| Viewer | See the dashboard and dispatch board; resident names and contact details are hidden |

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
