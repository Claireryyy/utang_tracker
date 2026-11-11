const CACHE = 'utang-shell-v2';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
 
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
 
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
 
// Network first, so updates show right away; the cache is only the offline fallback.
// API calls are never cached.
self.addEventListener('fetch', (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(r, copy));
        }
        return res;
      })
      .catch(() => caches.match(r).then((m) => m || caches.match('/')))
  );
});
 
// Push notification received (works even when the app is closed)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Utang Tracker', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: d.tag,
      data: { url: d.url || '/' },
    })
  );
});
 
// Tapping the notification opens (or focuses) the app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow((e.notification.data && e.notification.data.url) || '/');
    })
  );
});