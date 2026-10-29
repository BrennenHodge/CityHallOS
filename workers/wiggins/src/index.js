// Serves the Wiggins client preview (hosted in another Cloudflare account) at wiggins.cityhallos.com.
// Every request is passed through to the preview Worker, so redeploying the preview updates this site.
const ORIGIN = 'https://wiggins-preview.peach-bassoon.workers.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);

    const upstream = await fetch(new Request(target, request), { redirect: 'manual' });
    const response = new Response(upstream.body, upstream);

    // Keep redirects (e.g. trailing-slash) on this hostname instead of bouncing to workers.dev.
    const location = response.headers.get('Location');
    if (location) {
      const next = new URL(location, target);
      if (next.origin === ORIGIN) {
        next.protocol = url.protocol;
        next.host = url.host;
        response.headers.set('Location', next.toString());
      }
    }
    return response;
  },
};
