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

How it works:

- **Storage.** D1 database `cityhallos` (schema in [`platform/schema.sql`](platform/schema.sql)) and R2 bucket `cityhallos-files` for original files.
- **Ingestion.** Uploaded files, web pages and staff-written answers become text. The dashboard reads PDFs in the browser, the Worker falls back to `unpdf` or Workers AI `toMarkdown`. Text is split into passages and indexed with SQLite FTS5.
- **Answering.** Retrieval is BM25 search plus the `bge-reranker-base` reranker. Answers cite numbered sources, and each source carries a verification label (verified current, official but not confirmed current, historical, secondary, unverified). Unanswered questions are flagged for staff, emergencies go straight to 911 guidance, and reported problems start a guided intake that creates a tracked request.
- **Model.** Workers AI Llama 3.3 70B by default. Set an Anthropic key and it answers with Claude instead:
  `cd platform && npx wrangler secret put ANTHROPIC_API_KEY`
- **Staff access.** The dashboard uses one access code, the `ADMIN_KEY` Worker secret. For local development, put a test code in `platform/.dev.vars` (gitignored) and run `npx wrangler dev --remote` from `platform/`.

`wiggins.cityhallos.com` ([`workers/wiggins`](workers/wiggins)) serves the Wiggins site and adds the embed line to every
page, the same way a city would add it to its own site. `/admin` redirects to the dashboard and `/ask` to the portal.

Deploy with `npx wrangler deploy` from `platform/`. Schema changes: `npx wrangler d1 execute cityhallos --remote --file schema.sql`.

## Contact form

The "Book a walkthrough" form shows a success state but **does not send anywhere yet**. To collect
leads, set a `data-endpoint` attribute on `<form id="contactForm">` to any endpoint that accepts a JSON
POST (Formspree, a Cloudflare Pages Function, a CRM webhook, and so on).

### Loading a city's knowledge

[`platform/scripts`](platform/scripts) holds the repeatable import used for Wiggins:
`crawl.py` downloads the city website's pages and Document Center files, `seed.py` loads them (plus a research pack)
through the documents API, and `ask.py` runs test questions against the live assistant.
