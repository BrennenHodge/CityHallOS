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

## Contact form

The "Book a walkthrough" form shows a success state but **does not send anywhere yet**. To collect
leads, set a `data-endpoint` attribute on `<form id="contactForm">` to any endpoint that accepts a JSON
POST (Formspree, a Cloudflare Pages Function, a CRM webhook, and so on).
