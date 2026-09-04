self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Class Alert!', body: 'A spot opened up!' };
  
  const options = {
    body: data.body,
    icon: 'https://raw.githubusercontent.com/CSESoc/Circles/master/public/logo192.png',
    badge: 'https://raw.githubusercontent.com/CSESoc/Circles/master/public/logo192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || 'https://my.unsw.edu.au' }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});