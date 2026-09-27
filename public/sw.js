// Xiaoyu Web Push Service Worker
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Xiaoyu', body: event.data ? event.data.text() : '小愈想你了。' };
  }
  const options = {
    body: data.body || '小愈想你了。',
    // 通知图标跟随用户当前皮肤（服务端把皮肤 icon 放进 payload）；缺省回退到品牌字标
    icon: data.icon || '/xiaoyu-logo.png',
    badge: data.badge || '/xiaoyu-logo.png',
    tag: data.tag || 'xiaoyu',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Xiaoyu', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 已有标签页：导航到目标地址并聚焦；否则新开窗口
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
