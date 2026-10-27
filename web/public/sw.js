// Fleet's service worker. It exists so Edge/Chrome can install Fleet as an app, and so the app window shows a
// "server is not running" page instead of the browser's error page when the local server is down. It caches nothing:
// every request goes to the server, so a fresh build is live on the next load.
const offline = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fleet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: light-dark(#f4f4f1, #090b0e); color: light-dark(#13151a, #eceef3);
         font: 13.5px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; }
  div { max-width: 420px; text-align: center; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  p { margin: 0 0 4px; color: light-dark(#565c68, #a2aab8); }
  code { font-family: "Cascadia Code", Consolas, ui-monospace, monospace; }
</style></head><body><div>
  <h1>Fleet's server is not running</h1>
  <p>Start it with <code>npm run restart</code> in the Fleet folder. This window reconnects by itself.</p>
  <p>Checking again in a few seconds…</p>
</div><script>
  setInterval(() => fetch('/api/config', { cache: 'no-store' }).then(r => { if (r.ok) location.reload(); }).catch(() => {}), 3000);
</script></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(offline, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
