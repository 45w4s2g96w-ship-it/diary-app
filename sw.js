const CACHE_NAME = 'dailynote-v5';
const ASSETS = [
  '/diary-app/',
  '/diary-app/index.html',
  '/diary-app/manifest.json',
  '/diary-app/icon-192.png',
  '/diary-app/icon-512.png'
];

// 설치
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 활성화
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 네트워크 우선, 실패 시 캐시
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// 푸시 알림 수신
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'daily note';
  const options = {
    body: data.body || '오늘의 메시지가 도착했어요.',
    icon: '/diary-app/icon-192.png',
    badge: '/diary-app/icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/diary-app/' },
    actions: [
      { action: 'open', title: '열어보기' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// 알림 클릭
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/diary-app/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('diary-app'));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
