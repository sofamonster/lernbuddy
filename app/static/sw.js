const CACHE_NAME = "lernbuddy-shell-__CACHE_VERSION__";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon.svg"
];

const OFFLINE_HTML = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LernBuddy – Offline</title>
  <style>
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#f6f5f0; color:#1f2430; display:grid; place-items:center; min-height:100vh; padding:24px; }
    .card { max-width:420px; background:#fff; border:1px solid #e3e1d8; border-radius:16px; padding:28px; text-align:center; box-shadow:0 4px 16px rgba(0,0,0,0.06); }
    button { margin-top:16px; background:#4338ca; color:#fff; border:none; border-radius:10px; padding:12px 20px; font-weight:600; font-size:1rem; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:3rem;">📚</div>
    <h1 style="margin:10px 0 6px;">Gerade offline</h1>
    <p style="color:#5f6677; margin:0;">LernBuddy kann deinen Server gerade nicht erreichen. Prüfe kurz dein WLAN oder Tailscale und versuche es nochmal.</p>
    <button onclick="location.reload()">Erneut versuchen</button>
  </div>
</body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API calls or protected uploads (always live data & auth)
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for HTML navigations & static assets so updates always appear immediately
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          return new Response(OFFLINE_HTML, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        throw new Error("Offline");
      })
  );
});
