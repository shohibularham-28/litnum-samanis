// Service worker LITNUM SMANIS
// Strategi: "network-first, fallback ke cache" untuk file aplikasi sendiri
// (index.html, app.html, manifest, ikon) supaya versi terbaru selalu dipakai
// kalau ada internet, tapi aplikasi tetap bisa dibuka (shell-nya) saat offline.
// Request ke Supabase (data login, ceklis, rekap, dll) SENGAJA tidak disentuh
// sama sekali oleh service worker ini — selalu langsung ke jaringan, karena
// data itu harus selalu yang terbaru dan tidak boleh "basi" dari cache.

const CACHE_VERSION = 'litnum-shell-v1';
const APP_SHELL = [
  './index.html',
  './app.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Hanya urus request GET yang tujuannya file di domain sendiri (app shell).
  // Semua request lain (POST/PUT, atau ke domain lain seperti Supabase dan
  // Google Fonts) dibiarkan lewat langsung ke jaringan tanpa campur tangan.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./app.html')))
  );
});
