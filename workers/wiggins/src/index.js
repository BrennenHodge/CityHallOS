// wiggins.cityhallos.com: serves the Wiggins site from its preview Worker and adds the
// City Hall OS AI City Clerk, the same one-line embed any city would paste into its own site.
const ORIGIN = 'https://wiggins-preview.peach-bassoon.workers.dev';
const PLATFORM = 'https://app.cityhallos.com';
const EMBED = `<script src="${PLATFORM}/embed.js" data-city="wiggins" async></script>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Shortcuts to the staff dashboard and the full-page resident portal.
    if (url.pathname === '/admin' || url.pathname === '/dashboard') return Response.redirect(`${PLATFORM}/`, 302);
    if (url.pathname === '/ask') return Response.redirect(`${PLATFORM}/wiggins/`, 302);

    const target = new URL(url.pathname + url.search, ORIGIN);
    const upstream = await fetch(new Request(target, request), { redirect: 'manual' });
    let response = new Response(upstream.body, upstream);

    const location = response.headers.get('Location');
    if (location) {
      const next = new URL(location, target);
      if (next.origin === ORIGIN) {
        next.protocol = url.protocol;
        next.host = url.host;
        response.headers.set('Location', next.toString());
      }
    }

    if ((response.headers.get('Content-Type') || '').includes('text/html')) {
      response = new HTMLRewriter()
        .on('body', { element(el) { el.append(EMBED, { html: true }); } })
        .transform(response);
    }
    return response;
  },
};
