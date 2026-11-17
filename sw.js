// Service worker : permet d'ouvrir l'app sans réseau.
// Il ne garde QUE le code de l'app (pages, styles, scripts), jamais vos données.
// Vos données sont gérées à part par Firebase : une mise à jour de l'app ne peut pas les effacer.

const VERSION = 'maison-1.2.0';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './theme-init.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('maison-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Code de l'app : d'abord le réseau (pour avoir la dernière version), sinon la copie locale
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  // Bibliothèques Firebase (fichiers figés par version) : copie locale d'abord
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
  // Tout le reste (dont les échanges avec la base de données) passe sans être touché.
});
