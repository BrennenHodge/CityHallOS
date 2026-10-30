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
| Department staff | See and work only their department's requests, log phone and counter requests |
| Viewer | See the dashboard; resident names and contact details are hidden |

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

## Adding a city

```bash
curl -X POST https://app.cityhallos.com/api/platform/cities \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"City of Poplarville","state":"MS","county":"Pearl River County","requestPrefix":"POP"}'
```

This creates the city as `onboarding` with default departments and request types. Then load its knowledge
(`scripts/crawl.py`, `scripts/seed.py`), fill in Settings, add its first administrator under Staff & access, and
set the status to `active` with `PUT /api/platform/cities/{slug}/status`.

## Business licenses

City business (privilege) licenses under Miss. Code Ann. § 27-17 (the sections are cited in `src/licensing-rules.js`).

| Piece | Where |
|---|---|
| Rules: fees by class and employees, license periods, proration, late penalties, renewal-notice dates | `src/licensing-rules.js` |
| Records in each city's store: `license_settings`, `license_applications`, `license_events`, `licenses` | `src/licensing-store.js` (mixed into `CityStore`) |
| API under `/api/{city}/licenses`, guided intake, certificate PDF, renewal notices | `src/licensing.js` |
| Chat and portal add-on | `public/embed-licensing.js` (loaded by `embed.js` from `/config` `modules`) |
| Staff page: review queue, registry, settings | `public/licensing.js` (registers with `window.CHOS`) |
| Public lookup and application tracking | `public/licenses.html?city={slug}&ref={ref}` |

License classes, fees, the term and the wording are each city's own settings, edited under Business licenses > Settings.
The § 27-17-9 schedule is offered as a template. The AI collects the application and explains the rules; staff review,
assess the fee, take payment and issue or deny. Applications are numbered `{prefix}-BL-1001`, licenses `{prefix}-LIC-1001`.
A daily cron sends renewal notices from the first day of the month before a license expires (§ 27-17-465).

Permissions: `licenses.view` (every role), `licenses.manage` (administrators, and department staff of the licensing
department, City Hall unless the city sets another), `licenses.settings` (administrators).

## Online payments

`src/payments.js` charges and refunds cards for anything a resident pays for online. No processor is connected yet, so
the `test` provider is the only one: it accepts the standard test cards (4242 4242 4242 4242), declines the standard
decline cards, and refuses every other number, so no real card is ever reported as charged. Card numbers are never stored
or logged; only the last four digits, the brand and the payment id are kept. Stripe goes in as another provider there.
