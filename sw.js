const CACHE = 'minha-saude-v4';
const FILES = [
  '/minha-saude/',
  '/minha-saude/index.html',
  '/minha-saude/manifest.json',
  '/minha-saude/css/style.css',
  '/minha-saude/js/app.js',
  '/minha-saude/js/firebase.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
