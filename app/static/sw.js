/* Cobro Fácil PWA — network-first for shell updates, offline fallback */
const CACHE_VERSION = 'crm-frigorifico-v8.9';
const SHELL_ASSETS = [
  '/login',
  '/manifest.json',
  '/static/enterprise.css',
  '/static/css/auditoria.css',
  '/static/css/perfil-empresa.css',
  '/static/vendor/leaflet.css',
  '/static/vendor/leaflet.js',
  '/static/js/crm-safe.js',
  '/static/js/crm-bus.js',
  '/static/js/crm-format.js',
  '/static/js/crm-ui.js',
  '/static/js/crm-db.js',
  '/static/js/sync-engine.js',
  '/static/js/crm-sync-api.js',
  '/static/js/crm-loader.js',
  '/static/js/crm-delete.js',
  '/static/js/crm-backup.js',
  '/static/js/espejo.js',
  '/static/js/espejo-engine.js',
  '/static/js/nodo.js',
  '/static/js/app.js',
  '/static/js/modulo-panel.js',
  '/static/js/barra/ventas.js',
  '/static/js/barra/cobros.js',
  '/static/js/barra/caja.js',
  '/static/js/barra/mi-empresa.js',
  '/static/js/barra/cartera.js',
  '/static/js/barra/cartera-libro.js',
  '/static/js/barra/auditoria-inventario.js',
  '/static/js/barra/toque.js',
  '/static/js/barra/pedidos.js',
  '/static/js/barra/repartofacil-despacho.js',
  '/static/js/barra/armar.js',
  '/static/vendor/dexie.min.js',
  '/static/vendor/zxing.min.js',
  '/static/js/pos-offline.js',
  '/static/icons/icon-180.png',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

const NETWORK_FIRST_PATHS = [
  '/',
  '/login',
  '/pos',
  '/static/js/espejo.js',
  '/static/js/nodo.js',
  '/static/js/app.js',
  '/static/js/modulo-panel.js',
  '/static/js/crm-sync-api.js',
  '/static/js/crm-loader.js',
  '/static/js/crm-delete.js',
  '/static/enterprise.css',
  '/static/js/crm-safe.js',
  '/static/js/barra/',
];

function cacheKey(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/static/')) {
    return url.origin + url.pathname;
  }
  return request.url;
}

function isNetworkFirst(url) {
  return NETWORK_FIRST_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p));
}

function isApiRequest(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/auth/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('SW precache partial:', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // API y auth: siempre red (nunca cachear — cada usuario/empresa tiene datos distintos)
  if (isApiRequest(url.pathname) || url.pathname === '/health' || url.pathname === '/health/ready') {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: 'Sin conexión', offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  const isNavigate = event.request.mode === 'navigate';
  const isStatic = url.pathname.startsWith('/static/');

  if (isNetworkFirst(url) || isNavigate) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (isStatic) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(cacheKey(event.request), clone);
          });
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(cacheKey(event.request));
        if (cached) return cached;
        if (isNavigate) {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return new Response(
          JSON.stringify({ error: 'Sin conexión', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
  );
});

function esLogin(response) {
  try {
    const path = new URL(response.url).pathname;
    return path === '/login' || path.startsWith('/login/');
  } catch (_) {
    return false;
  }
}

async function olvidarApp(cache) {
  const claves = await cache.keys();
  await Promise.all(claves.map((pedido) => {
    const path = new URL(pedido.url).pathname;
    if (path === '/' || path === '/cartera' || path === '/pos') return cache.delete(pedido);
    return null;
  }));
}

async function guardarRespuesta(cache, request, response) {
  if (!response || !response.ok || esLogin(response)) return;
  await cache.put(cacheKey(request), response.clone());
  if (request.mode === 'navigate') {
    const path = new URL(request.url).pathname || '/';
    if (path !== '/login') await cache.put(path, response.clone());
  }
}

async function shellOffline(request) {
  const cache = await caches.open(CACHE_VERSION);
  const exacta = await cache.match(cacheKey(request));
  if (exacta) return exacta;
  if (request.mode === 'navigate') {
    const path = new URL(request.url).pathname || '/';
    const porRuta = await cache.match(path);
    if (porRuta) return porRuta;
    const raiz = await cache.match('/');
    if (raiz) return raiz;
  }
  return null;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const path = new URL(request.url).pathname || '/';
  try {
    const response = await fetch(new Request(request, { credentials: 'include' }));
    if (request.mode === 'navigate' && esLogin(response) && path !== '/login') {
      const guardada = await shellOffline(request);
      if (guardada && !esLogin(guardada)) return guardada;
    }
    if (request.mode === 'navigate' && path === '/login') await olvidarApp(cache);
    await guardarRespuesta(cache, request, response);
    return response;
  } catch (_) {
    const guardada = await shellOffline(request);
    if (guardada) return guardada;
    throw _;
  }
}

async function staleWhileRevalidate(request) {
  const key = cacheKey(request);
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(key);

  const networkPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  }).catch(() => null);

  return cached || networkPromise || new Response('', { status: 504 });
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'OLVIDAR_APP') {
    event.waitUntil(caches.open(CACHE_VERSION).then((cache) => olvidarApp(cache)));
  }
  if (event.data === 'SYNC_ESPEJO') {
    event.waitUntil(syncEspejoInBackground());
  }
});

async function syncEspejoInBackground() {
  try {
    const res = await fetch('/api/pos/espejo/delta?sello=&_=' + Date.now(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      console.log('[SW] Sync espejo background:', data);
    }
  } catch (err) {
    console.warn('[SW] Sync espejo background error:', err);
  }
}

if ('sync' in self.registration) {
  self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-espejo') {
      event.waitUntil(syncEspejoInBackground());
    }
  });
}
