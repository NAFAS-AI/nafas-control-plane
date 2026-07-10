/**
 * EduOS — sw.js (Service Worker)
 * الخطوة 5 من خطة الأمان: وضع عدم الاتصال
 * Step 5 Security Plan: Offline fallback mode
 *
 * © 2026 NAFAS FOR ARTIFICIAL INTELLIGENCE — CN-6573712
 */

const CACHE_NAME = 'eduos-shell-v1';
const OFFLINE_PAGE = '/apps/eduos-offline/index.html';

// ── Core assets to pre-cache (shell) ──
const SHELL_ASSETS = [
  '/apps/platform-config.js',
  '/apps/platform-lang.js',
  '/apps/platform-design-system.css',
  '/apps/eduos-offline/index.html',
];

// ── Install: pre-cache shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // addAll fails silently per asset — don't let one missing file block install
        Promise.allSettled(SHELL_ASSETS.map(url => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: strategy per request type ──
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // ── Skip: non-GET, API calls, Supabase, cross-origin data ──
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('googleapis.com')) return;
  if (url.protocol === 'chrome-extension:') return;

  // ── Static assets: Cache-First ──
  if (/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|ttf)(\?.*)?$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // ── HTML navigation: Network-First, fallback to offline page ──
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          // Cache successful navigations for offline fallback
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return response;
        })
        .catch(async () => {
          // Try cached version first
          const cached = await caches.match(req);
          if (cached) return cached;
          // Fallback to offline page
          const offline = await caches.match(OFFLINE_PAGE);
          if (offline) return offline;
          return new Response('<h1>لا يوجد اتصال بالإنترنت</h1>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        })
    );
    return;
  }
});
