const CACHE_NAME = 'mailcode-otp-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => console.log('Cache addAll error:', err));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Let external API requests bypass service worker cache
  if (event.request.url.includes('code.yamin.bd') || event.request.url.includes('/api/')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});

// Listen for messages from client page to show heads-up background notification
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, {
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true,
      tag: 'otp-alert-' + Date.now(),
      renotify: true,
      ...options
    });
  }
});

// Handle push notification clicks (auto copy and focus window)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const code = event.notification.data ? event.notification.data.code : '';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if (code) {
            client.postMessage({ type: 'COPY_CODE', code: code });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/').then((windowClient) => {
          if (windowClient && code) {
            setTimeout(() => {
              windowClient.postMessage({ type: 'COPY_CODE', code: code });
            }, 500);
          }
        });
      }
    })
  );
});

