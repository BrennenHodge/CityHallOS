# CityHallOS.com

Marketing site for **City Hall OS**, the AI operating system for local government.

A static site with no build step. Everything served lives in [`public/`](public):

| File | Purpose |
|---|---|
| `index.html` | All page content and sections |
| `styles.css` | Design tokens, layout and components |
| `app.js` | Nav, scroll reveals, hero animation, role tabs, contact form, and the interactive AI City Clerk demo |
| `_headers` | Cloudflare Pages security and cache headers |

## Run locally

```bash
python -m http.server 5173 --directory public
```

Then open http://localhost:5173.

## Deploy

Hosted on Cloudflare Workers static assets (Worker `cityhallos`), served at https://cityhallos.com and
https://www.cityhallos.com. Config lives in [`wrangler.jsonc`](wrangler.jsonc); Cloudflare manages the
DNS records and certificates for both custom domains.

```bash
npx wrangler deploy
```

The social share image is `public/og-image.png` (1200×630). Favicons: `favicon.ico`, `favicon.svg`,
`favicon-32.png`, `apple-touch-icon.png`, plus `icon-192.png` / `icon-512.png` for the web manifest.

## The live demo

The demo in the "Live demo" section runs entirely in the browser with scripted responses for the
fictional Town of Cedar Bend. It shows the core flow: a resident reports an issue, a structured
request is created and routed, staff work it in the console, and the resident is updated. It also shows
source-cited answers, refusing to guess (human triage), and emergency redirection to 911.

## The platform (`platform/`)

The working product: one Cloudflare Worker (`cityhallos-platform`) at **https://app.cityhallos.com** that every
city and every channel shares. Data is scoped by city slug, so a new city is a new tenant, not a new app.

| Path | What it is |
|---|---|
| `/` | Staff dashboard: overview, knowledge base (drag-and-drop uploads), assistant test console, conversations, service requests, channels, settings |
| `/wiggins/` | Full-page resident portal for Wiggins |
| `/embed.js` | The AI City Clerk chat. One line on any website: `<script src="https://app.cityhallos.com/embed.js" data-city="wiggins" async></script>` |
| `/api/{city}/…` | Chat (streams cited answers), service requests and tracking, forms, knowledge base, conversations, settings |

How it works (details in [`platform/ARCHITECTURE.md`](platform/ARCHITECTURE.md)):

- **Storage.** The D1 database `cityhallos` ([`platform/schema.sql`](platform/schema.sql)) holds the city registry, staff accounts and roles. Each city's records live in that city's own SQLite database, a Durable Object ([`platform/src/store.js`](platform/src/store.js)). Original files go to the R2 bucket `cityhallos-files` under the city's id.
- **Ingestion.** Uploaded files, web pages and staff-written answers become text. The dashboard reads PDFs in the browser, the Worker falls back to `unpdf` or Workers AI `toMarkdown`. Text is split into passages and indexed with SQLite FTS5.
- **Answering.** Retrieval is BM25 search plus the `bge-reranker-base` reranker. Answers cite numbered sources, and each source carries a verification label (verified current, official but not confirmed current, historical, secondary, unverified). Unanswered questions are flagged for staff, emergencies go straight to 911 guidance, and reported problems start a guided intake that creates a tracked request.
- **Model.** Workers AI Llama 3.3 70B by default. Set an Anthropic key and it answers with Claude instead:
  `cd platform && npx wrangler secret put ANTHROPIC_API_KEY`
- **Staff access.** Each staff member has their own account with a role (administrator, knowledge editor, department staff or viewer). Administrators add people under Staff & access and send them a one-time setup link. Every change is recorded in the city's audit log, shown under Activity. City Hall OS support signs in with the `ADMIN_KEY` Worker secret.
- **Permit applications.** Residents apply for a construction permit in the chat: say "I want to build a garage" and the chat grows into a full-screen workspace, with the conversation on the left and the city's application on the right, filling in as they answer. One definition ([`platform/src/permits/construction.js`](platform/src/permits/construction.js)) drives the questions, the form, the completeness checks and the fee estimate, so every answer is entered once and reused: on the city's own PDF form ([`pdf.js`](platform/src/permits/pdf.js) fills Wiggins' fillable 2018 form), on the page 3 owner certification, in the staff review and in every message. Answers autosave; a secret link (`/{city}/#permit=…`) reopens the application on any device. Addresses are screened automatically against U.S. Census city limits and FEMA flood zones. Before submission the AI reads the answers and uploaded documents like a permit technician (owner name on the deed, missing plans) and copies blank details printed on documents, such as the parcel number. Staff work the queue under **Permit applications**: mark complete and set the fee, record payment, issue the permit (a printable permit to post at the site) or send it back with an AI-drafted list of changes. Residents are told at each step by email, text or phone call (`RESEND_API_KEY` + `NOTIFY_FROM_EMAIL`, `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM`); without those secrets messages are logged as not sent. A daily cron reminds residents about unfinished drafts and requested changes. The AI never approves anything. A city's fees, form and options live in `settings.permits` (see [`platform/cities/wiggins.json`](platform/cities/wiggins.json)).
- **Local development.** Put a test code in `platform/.dev.vars` (gitignored) and run `npx wrangler dev` from `platform/`. Durable Objects, D1 and R2 run locally; Workers AI always runs remotely.

`wiggins.cityhallos.com` ([`workers/wiggins`](workers/wiggins)) serves the Wiggins site and adds the embed line to every
page, the same way a city would add it to its own site. `/admin` redirects to the dashboard and `/ask` to the portal.

Deploy with `npx wrangler deploy` from `platform/`. Platform database changes go in `platform/migrations/`; city store changes go in the `MIGRATIONS` list in `store.js` and apply themselves.

## Contact form

The "Book a walkthrough" form shows a success state but **does not send anywhere yet**. To collect
leads, set a `data-endpoint` attribute on `<form id="contactForm">` to any endpoint that accepts a JSON
POST (Formspree, a Cloudflare Pages Function, a CRM webhook, and so on).

### Development workflow

Three environments run the same code, each with its own data and its own access code:

| Environment | Where | Data | Access code |
|---|---|---|---|
| Local | http://127.0.0.1:8787 | Rebuilt on your computer from public city documents | `ADMIN_KEY` in `platform/.dev.vars` |
| Staging | https://staging.cityhallos.com | Its own database and files | `.secrets/staging-admin-key.txt` |
| Production | https://app.cityhallos.com | Real residents and staff | `.secrets/wiggins-admin-key.txt` |

Everything runs on Cloudflare's own runtime, locally too (`wrangler dev` simulates D1, R2 and Durable Objects on disk under
`platform/.wrangler/state`), so there is no Docker. Workers AI is always remote, even locally.

From `platform/`:

```bash
npm run reset           # wipe local data and rebuild every city in cities/ from seed-data/ (stop the server first)
npm run dev             # start the local server on port 8787
npm test                # run the end-to-end checks against the local server
npm run deploy:staging  # deploy to staging, then: npm run test:staging
npm run deploy          # deploy to production
npm run eval            # grade the assistant's answers against evals/wiggins.json (uses the AI model)
```

After a reset, sign in locally as `DEV_ADMIN_EMAIL` with `DEV_ADMIN_PASSWORD` from `platform/.dev.vars`
(copy `.dev.vars.example` the first time). The test suite creates throwaway cities, archives them afterward and
refuses to run against production.

### Connecting text messages and calls

1. In Twilio, buy a local number for the city.
2. Set the number's **A message comes in** webhook to `https://app.cityhallos.com/api/<city>/twilio/sms` and
   **A call comes in** to `https://app.cityhallos.com/api/<city>/twilio/voice` (HTTP POST). The dashboard's Channels
   page shows both addresses.
3. Once for the platform: `npx wrangler secret put TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`
   (from `platform/`). Without `TWILIO_AUTH_TOKEN` the webhooks refuse traffic.

Locally, `TWILIO_ALLOW_UNSIGNED=1` in `.dev.vars` lets you post test texts and calls without Twilio.

### Loading a city's knowledge

Each city is defined in `platform/cities/<slug>.json` (name, county, request prefix, assistant settings). Its source
documents live in `platform/seed-data/<slug>/` (gitignored): `data/` from `scripts/crawl.py` and `pack/` from the
research pack. `scripts/load_city.py` adds the city to any environment and loads its knowledge base:

```bash
python -I platform/scripts/load_city.py https://staging.cityhallos.com .secrets/staging-admin-key.txt platform/cities/wiggins.json
```

It won't overwrite a city that already has documents unless you pass `--replace-knowledge`. `scripts/ask.py` runs test
questions against an assistant.
